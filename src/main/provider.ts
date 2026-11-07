import { join } from 'node:path'
import type { Client, Series, SeriesSummary } from 'openhongguo'
import type { BrowsePage, BrowseQuery, FilterRow, OriginalNovel, SeasonCard, SeriesCard, SeriesDetails, SimilarSeries } from '../shared/types'
import { matchingFacets, similarMatches, themes } from './similarity'

export class UserFacingError extends Error {}

const errorMessages: Record<string, string> = {
  AUTHENTICATION_REQUIRED: '这部作品需要登录后查询，目前匿名模式无法读取。',
  ANONYMOUS_LIMITED: '匿名查询暂时受到限制，请稍后再试。',
  RATE_LIMITED: '请求频率受到限制，请稍后再试。',
  TRANSPORT: '连接红果失败，请检查网络后重试。',
  SIGNATURE_REJECTED: '红果暂时拒绝了请求，需要等待数据源适配更新。',
  CHALLENGE_REQUIRED: '红果要求安全验证，当前查询无法继续。',
  DEVICE_REJECTED: '匿名设备暂时不可用，请稍后再试。',
  CONTENT_UNAVAILABLE: '作品暂不可用，已保留上次的记录。',
  ALBUM_UNAVAILABLE: '暂时无法获取关联季，已保留上次的记录。',
  SIGNER_UNAVAILABLE: '数据源未能初始化，请检查应用文件是否完整。',
  INVALID_OPTIONS: '查询条件无效，请调整后重试。',
  PARAM_INVALID: '查询条件暂不被红果接受，请调整后重试。'
}

export function toUserMessage(error: unknown): string {
  if (error instanceof UserFacingError) return error.message
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  return errorMessages[code] ?? '操作未完成，请稍后重试；已有记录不会被清空。'
}

export function validateId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^\d{5,30}$/.test(id)) {
    throw new UserFacingError('作品编号无效。')
  }
}

function text(value: unknown, maxLength = 200): value is string {
  return typeof value === 'string' && value.length <= maxLength
}

function safeCover(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : undefined
  } catch {
    return undefined
  }
}

function card(row: SeriesSummary): SeriesCard {
  validateId(row.id)
  if (!row.title?.trim()) throw new UserFacingError('红果返回的作品信息不完整，请稍后重试。')
  const detail = row as Series
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    coverUrl: safeCover(row.cover_url),
    episodeCount: typeof row.episode_count === 'number' && row.episode_count >= 0 ? row.episode_count : undefined,
    status: detail.status === 1 ? 'completed' : detail.status === 0 || detail.status === 3 ? 'ongoing' : 'unknown',
    tags: [...new Set([row.category, ...(detail.rows ?? []).filter((info) => [3, 9, 40].includes(info.kind)).map((info) => info.text)].filter((value): value is string => Boolean(value)))],
    note: detail.right_text
  }
}

function uniqueCards(rows: SeriesSummary[]): SeriesCard[] {
  return [...new Map(rows.filter((row) => row.id && row.title).map((row) => [row.id, card(row)])).values()]
}

function originalNovel(raw: Series): OriginalNovel | undefined {
  const novel = raw.novel
  const bookId = [novel?.book_id, raw.related_novel_book_id].find(id => id && /^[1-9]\d*$/.test(id))
  const shortTitle = novel?.short_title?.trim()
  const title = novel?.title?.trim() || shortTitle
  const statusLabels: Record<number, string> = { 0: '已完结', 1: '连载中', 3: '今日更新' }
  const result: OriginalNovel = {
    bookId, title, shortTitle: shortTitle !== title ? shortTitle : undefined,
    coverUrl: safeCover(novel?.cover_url),
    statusLabel: novel ? statusLabels[novel.status] : undefined,
    reads: typeof novel?.reads === 'number' && Number.isSafeInteger(novel.reads) && novel.reads >= 0 ? novel.reads : undefined,
    showAtEpisode: typeof novel?.show_at_episode === 'number' && Number.isSafeInteger(novel.show_at_episode) && novel.show_at_episode > 0 ? novel.show_at_episode : undefined,
    tags: [...new Set((novel?.tags ?? []).map(tag => tag.trim()).filter(Boolean))]
  }
  if (bookId || title || result.coverUrl || result.tags.length || result.statusLabel || result.reads !== undefined || result.showAtEpisode) return result
  return undefined
}

export interface Inspection extends SeriesDetails {
  seasonListAvailable: boolean
  genre?: string
}

/** The SDK can return a successful but incomplete album response. */
export function normalizeSeasonList(
  seasons: SeasonCard[],
  root: SeasonCard,
  expectedCount?: number,
  isMultiSeason = false
): Pick<Inspection, 'seasons' | 'seasonListAvailable' | 'seasonWarning'> {
  const byId = new Map(seasons.map(season => [season.id, season]))
  const albumRoot = byId.get(root.id)
  byId.set(root.id, { ...root, index: root.index ?? albumRoot?.index, episodeCount: root.episodeCount ?? albumRoot?.episodeCount })
  const unique = [...byId.values()]
  if (typeof expectedCount === 'number' && Number.isFinite(expectedCount) && expectedCount > unique.length) {
    return {
      seasons: unique,
      seasonListAvailable: false,
      seasonWarning: `关联季列表不完整：已取得 ${unique.length} 季，共 ${expectedCount} 季；已有记录会继续保留。`
    }
  }
  if (!seasons.length && isMultiSeason) {
    return { seasons: unique, seasonListAvailable: false, seasonWarning: '关联季列表暂时为空，已保留已有各季。' }
  }
  return { seasons: unique, seasonListAvailable: true }
}

export class Provider {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly heatCache = new Map<string, { value: number | null; checked: number }>()
  private readonly opened = new Map<string, { details: SeriesDetails; genre: string }>()

  constructor(private readonly dataPath: string, private clientPromise?: Promise<Client>) {}

  private client(): Promise<Client> {
    this.clientPromise ??= import('openhongguo').then(({ createClient }) => createClient({
      profile: join(this.dataPath, 'anonymous.json'),
      timeoutMs: 20_000,
      retryAttempts: 1,
      deviceResets: 0
    })).catch((error: unknown) => {
      this.clientPromise = undefined
      throw error
    })
    return this.clientPromise
  }

  /** The SDK shares an anonymous profile; serialize calls instead of creating competing devices. */
  private request<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => operation(await this.client()))
    this.queue = result.catch(() => undefined)
    return result
  }

  async browse(query: BrowseQuery): Promise<BrowsePage> {
    if (!query || !['discover', 'search', 'rank', 'filter'].includes(query.mode)) {
      throw new UserFacingError('请选择有效的浏览方式。')
    }
    if (query.cursor !== undefined && !text(query.cursor, 65_536)) throw new UserFacingError('分页信息无效，请刷新列表。')
    if (query.genre !== undefined && !['short_play', 'comic_series', 'ai_series'].includes(query.genre)) throw new UserFacingError('作品类型无效。')
    if (query.content !== undefined && !text(query.content)) throw new UserFacingError('榜单条件无效。')
    if (query.board !== undefined && !text(query.board)) throw new UserFacingError('榜单条件无效。')
    if (query.mode === 'search' && (!text(query.query) || !query.query.trim())) throw new UserFacingError('请先输入作品名称。')
    if (query.selections !== undefined) {
      if (typeof query.selections !== 'object' || query.selections === null || Array.isArray(query.selections) || Object.keys(query.selections).length > 25) throw new UserFacingError('筛选条件无效。')
      for (const [key, values] of Object.entries(query.selections)) {
        if (!text(key) || !Array.isArray(values) || values.length > 40 || values.some((value) => !text(value))) throw new UserFacingError('筛选条件无效。')
      }
    }
    return this.request(async (client) => {
      if (query.mode === 'rank') {
        const page = await client.shortRank({ content: query.content, board: query.board, cursor: query.cursor })
        const items = page.items.filter((row) => row.series_id && row.title).map((row) => ({
          ...card({ id: row.series_id!, title: row.title!, cover_url: row.cover_url, episode_count: row.episode_count }),
          note: row.score
        }))
        return {
          items: [...new Map(items.map((item) => [item.id, item])).values()],
          hasMore: page.has_more && Boolean(page.cursor),
          cursor: page.cursor,
          contents: page.contents.filter((content) => !content.name.includes('演员')).map((content) => ({
            id: content.id,
            name: content.name,
            boards: content.boards.map((board) => ({ id: board.id, name: board.name }))
          })),
          content: page.content,
          board: page.board
        }
      }
      const filters: Record<string, string> = {
        short_play: 'content_type_short_play',
        comic_series: 'content_type_dynamic_comic',
        ai_series: 'content_type_ai_dynamic_comic'
      }
      const page = query.mode === 'search'
        ? await client.search(query.query!.trim(), { cursor: query.cursor, pageSize: 20, filters: query.genre ? [filters[query.genre]] : Object.values(filters) })
        : query.mode === 'filter'
          ? await client.shortFilter({ cursor: query.cursor, selections: { ...query.selections, ...(query.genre ? { genre: [query.genre] } : {}) } })
          : await client.discover({ cursor: query.cursor })
      return { items: uniqueCards(page.items), cursor: page.cursor, hasMore: page.has_more && Boolean(page.cursor) }
    })
  }

  async filters(genre: string): Promise<FilterRow[]> {
    if (!['short_play', 'comic_series', 'ai_series'].includes(genre)) throw new UserFacingError('作品类型无效。')
    return this.request(async (client) => (await client.shortFilterPanel(genre)).map((row) => ({
      key: row.key, name: row.name, options: row.options.map((option) => ({ name: option.name, value: option.value }))
    })))
  }

  async inspect(id: string, includeSeasons = true): Promise<Inspection> {
    validateId(id)
    const raw = await this.request((client) => client.getSeries(id))
    if (raw.id !== id) throw new UserFacingError('返回的作品编号不一致，已保留原有记录。')
    const series = card(raw)
    const heat = this.rememberHeat(raw)
    const root: SeasonCard = { id, title: series.title, index: raw.season_index, episodeCount: series.episodeCount, heat: heat ?? undefined }
    const genre = series.tags.some(tag => /AI漫剧|AI剧/i.test(tag)) ? 'ai_series'
      : raw.content_type === 1004 || series.tags.some(tag => /漫剧|动态漫/.test(tag)) ? 'comic_series' : 'short_play'
    if (!includeSeasons) return { series, seasons: [root], seasonListAvailable: false }
    const metadata = { series, genre, originalNovel: originalNovel(raw) }
    try {
      const album = await this.request((client) => client.seasons(id))
      const seasons = (album.seasons ?? []).map((season): SeasonCard => {
        validateId(season.series_id)
        return { id: season.series_id, title: season.title || `第 ${season.index ?? '?'} 季`, index: season.index, episodeCount: season.episode_count }
      })
      return { ...metadata, ...normalizeSeasonList(seasons, root, album.season_count, Boolean(raw.is_multi_season || raw.related_album_id)) }
    } catch (error) {
      const isSingle = !raw.is_multi_season && !raw.related_album_id
      const unavailable = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ALBUM_UNAVAILABLE'
      return { ...metadata, seasons: [root], seasonListAvailable: isSingle && unavailable, seasonWarning: isSingle && unavailable ? undefined : toUserMessage(error) }
    }
  }

  async details(id: string): Promise<SeriesDetails> {
    const result = await this.inspect(id)
    const details = { series: result.series, originalNovel: result.originalNovel, seasons: result.seasons.map(season => ({
      ...season, heat: season.heat ?? this.cachedHeat(season.id) ?? undefined
    })), seasonWarning: result.seasonWarning }
    this.opened.delete(id)
    this.opened.set(id, { details, genre: result.genre ?? 'short_play' })
    if (this.opened.size > 16) this.opened.delete(this.opened.keys().next().value!)
    return details
  }

  private rememberHeat(raw: Series): number | null {
    const value = typeof raw.heat === 'number' && Number.isFinite(raw.heat) && raw.heat >= 0 ? raw.heat : null
    return this.cacheHeat(raw.id, value)
  }

  private cacheHeat(id: string, value: number | null): number | null {
    this.heatCache.delete(id)
    this.heatCache.set(id, { value, checked: Date.now() })
    if (this.heatCache.size > 256) this.heatCache.delete(this.heatCache.keys().next().value!)
    return value
  }

  private cachedHeat(id: string): number | null | undefined {
    const item = this.heatCache.get(id)
    if (item && Date.now() - item.checked < 5 * 60_000) return item.value
    return undefined
  }

  async seasonHeat(id: string): Promise<number | null> {
    validateId(id)
    const cached = this.cachedHeat(id)
    if (cached !== undefined) return cached
    let raw: Series
    try { raw = await this.request(client => client.getSeries(id)) }
    catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error &&
          ['ANONYMOUS_LIMITED', 'CONTENT_UNAVAILABLE', 'AUTHENTICATION_REQUIRED'].includes(String(error.code))) return this.cacheHeat(id, null)
      throw error
    }
    if (raw.id !== id) throw new UserFacingError('热度所属作品不一致。')
    return this.rememberHeat(raw)
  }

  async similarSeries(id: string): Promise<SimilarSeries[]> {
    validateId(id)
    if (!this.opened.has(id)) await this.details(id)
    const context = this.opened.get(id)!
    const tags = themes(context.details.series.tags)
    if (!tags.length) return []
    const groups: { items: SeriesCard[]; tag?: string }[] = []
    let filterError: unknown
    try {
      const rows = await this.filters(context.genre)
      const pages = await Promise.allSettled(matchingFacets(tags, rows).map(async facet => {
        const page = await this.browse({ mode: 'filter', genre: context.genre, selections: { [facet.key]: [facet.value] } })
        return { items: page.items, tag: facet.tag }
      }))
      for (const page of pages) {
        if (page.status === 'fulfilled') groups.push(page.value)
        else filterError = page.reason
      }
    } catch (error) {
      filterError = error
    }
    const matches = similarMatches(context.details, groups)
    if (matches.length) return matches
    // Anonymous recommendations are generic. Use only items with a matching subject.
    const page = await this.request(client => client.seriesRecommend(id))
    const fallback = similarMatches(context.details, [{ items: uniqueCards(page.items) }])
    if (!fallback.length && filterError) throw filterError
    return fallback
  }

  async episodeIds(id: string, allowEmpty: boolean): Promise<string[]> {
    validateId(id)
    const ids = new Set<string>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = await this.request((client) => client.listEpisodes(id, { cursor, pageSize: 1000 }))
      if (!Array.isArray(page.items)) throw new UserFacingError('分集列表不完整，已保留上次结果。')
      for (const episode of page.items) {
        validateId(episode.id)
        if (episode.series_id !== id) throw new UserFacingError('分集所属作品不一致，已保留上次结果。')
        ids.add(episode.id)
      }
      if (!page.has_more) {
        if (ids.size === 0 && !allowEmpty) throw new UserFacingError('分集列表暂时为空，已保留上次结果。')
        return [...ids]
      }
      if (!page.cursor || cursors.has(page.cursor)) throw new UserFacingError('分集列表分页不完整，已保留上次结果。')
      cursors.add(page.cursor)
      cursor = page.cursor
    }
    throw new UserFacingError('分集列表超过本次检查上限，已保留上次结果。')
  }
}
