import { createHash } from 'node:crypto'
import type { BrowsePage, BrowseQuery, FilterRow, SeriesDetails, Settings, Snapshot, UpdateEvent } from '../shared/types'
import { Provider, toUserMessage, UserFacingError, validateId, type Inspection } from './provider'
import { Store, type SeasonState, type WatchRecord } from './store'

/** Last scheduled local time, including the previous day before today's scheduled hour. */
export function latestDueTime(now: Date, time: string): Date {
  const [hours, minutes] = time.split(':').map(Number)
  const due = new Date(now)
  due.setHours(hours, minutes, 0, 0)
  if (due.getTime() > now.getTime()) due.setDate(due.getDate() - 1)
  return due
}

/** Never accept a truncated response as the new baseline or notify from it. */
export function compareEpisodes(previous: string[], current: string[], expectedCount?: number): string[] {
  const next = new Set(current)
  if ((expectedCount !== undefined && next.size < expectedCount) || previous.some((id) => !next.has(id))) {
    throw new UserFacingError('分集列表不完整，已保留上次结果。')
  }
  const known = new Set(previous)
  return [...next].filter((id) => !known.has(id))
}

function eventId(watchId: string, kind: UpdateEvent['kind'], seriesId: string, ids: string[] = []): string {
  return createHash('sha256').update(JSON.stringify([watchId, kind, seriesId, [...ids].sort()])).digest('hex')
}

function isUnavailable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'CONTENT_UNAVAILABLE'
}

// Some album rows omit the index but retain an explicit season number in the title.
function seasonIndexFromTitle(title: string): number | undefined {
  const match = /第\s*(\d{1,3}|[一二三四五六七八九十]{1,3})\s*季(?=\s*(?:$|[:·(—-]))/u.exec(title.normalize('NFKC'))
  if (!match) return undefined
  const number = match[1]
  if (/^\d+$/.test(number)) return Number(number) || undefined
  const digits = '零一二三四五六七八九'
  if (number.length === 1 && number !== '十') return digits.indexOf(number)
  const tens = /^([一二三四五六七八九]?)十([一二三四五六七八九]?)$/.exec(number)
  if (!tens) return undefined
  return (tens[1] ? digits.indexOf(tens[1]) : 1) * 10 + (tens[2] ? digits.indexOf(tens[2]) : 0)
}

function hasPublishedEpisodes(season: SeasonState): boolean {
  return season.episodeIds.length > 0 || (season.episodeCount ?? 0) > 0
}

function upcomingSeasonIds(seasons: SeasonState[]): Set<string> {
  const released = seasons.filter(hasPublishedEpisodes)
  const lastPublished = Math.max(0, ...released.map(s => s.index ?? 0))
  return new Set(lastPublished > 0 ? seasons.filter(s => (s.index ?? 0) > lastPublished).map(s => s.id) : [])
}

export type MonitorProvider = Pick<Provider, 'browse' | 'filters' | 'details' | 'inspect' | 'episodeIds'>

export class Monitor {
  private readonly provider: MonitorProvider
  private checking = false
  private timer?: ReturnType<typeof setInterval>
  private stopped = true

  constructor(
    readonly dataPath: string,
    private readonly onChanged: () => void,
    private readonly onNotify: (title: string, body: string) => void,
    provider?: MonitorProvider,
    private readonly store = new Store(dataPath),
    private readonly onNewEvents?: () => void
  ) {
    this.provider = provider ?? new Provider(dataPath)
  }

  snapshot(): Snapshot {
    const settings = this.store.settings()
    const watches = this.store.watches().map(({ item, seasons }) => ({
      ...item,
      reservationSeasons: Object.values(seasons).filter(season => season.awaitingPremiere)
        .map(({ id, index }) => ({ id, index }))
    }))
    let nextCheckAt: string | undefined
    if (settings.autoCheck && watches.some((item) => !item.paused)) {
      const now = new Date()
      const due = latestDueTime(now, settings.checkTime)
      const overdue = watches.some((item) => !item.paused && (!item.lastCheckedAt || new Date(item.lastCheckedAt) < due))
      if (overdue && !this.checking) nextCheckAt = now.toISOString()
      else {
        due.setDate(due.getDate() + 1)
        nextCheckAt = due.toISOString()
      }
    }
    return { watches, events: this.store.events(), settings, checking: this.checking, nextCheckAt, dataPath: this.dataPath, ...this.store.checkState() }
  }

  browse(query: BrowseQuery): Promise<BrowsePage> {
    return this.provider.browse(query)
  }

  filters(genre: string): Promise<FilterRow[]> {
    return this.provider.filters(genre)
  }

  details(id: string): Promise<SeriesDetails> {
    return this.provider.details(id)
  }

  private assertIdle(): void {
    if (this.checking) throw new UserFacingError('正在检查更新，请完成后再修改追更列表。')
  }

  async follow(id: string): Promise<Snapshot> {
    validateId(id)
    this.assertIdle()
    if (this.store.watch(id)) return this.snapshot()
    this.checking = true
    this.onChanged()
    try {
      const inspection = await this.provider.inspect(id)
      const record: WatchRecord = {
        item: {
          id,
          series: inspection.series,
          paused: false,
          watchSeasons: true,
          addedAt: new Date().toISOString(),
          baselineReady: false,
          seasonCount: 1,
          knownEpisodeCount: 0
        },
        seasons: {},
        seasonBaselineReady: false
      }
      this.store.saveWatch(record)
      this.onChanged()
      await this.checkRecord(record, inspection)
    } finally {
      this.checking = false
      this.onChanged()
    }
    return this.snapshot()
  }

  updateWatch(id: string, changes: { paused?: boolean; watchSeasons?: boolean }): Snapshot {
    validateId(id)
    this.assertIdle()
    if (!changes || typeof changes !== 'object' || (changes.paused !== undefined && typeof changes.paused !== 'boolean') || (changes.watchSeasons !== undefined && typeof changes.watchSeasons !== 'boolean')) throw new UserFacingError('追更设置无效。')
    const record = this.store.watch(id)
    if (!record) throw new UserFacingError('这部作品已不在追更列表中。')
    if (changes.paused !== undefined) record.item.paused = changes.paused
    if (changes.watchSeasons !== undefined) {
      // Existing related seasons remain stored when monitoring them is disabled.
      record.item.watchSeasons = changes.watchSeasons
    }
    this.store.saveWatch(record)
    this.onChanged()
    return this.snapshot()
  }

  removeWatch(id: string): Snapshot {
    validateId(id)
    this.assertIdle()
    this.store.removeWatch(id)
    this.onChanged()
    return this.snapshot()
  }

  markRead(): Snapshot {
    this.store.markRead()
    this.onChanged()
    return this.snapshot()
  }

  saveSettings(settings: Settings): Snapshot {
    if (!settings || !['dark', 'light'].includes(settings.theme) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(settings.checkTime) || ['autoCheck', 'desktopNotifications', 'closeToTray'].some((key) => typeof settings[key as keyof Settings] !== 'boolean')) {
      throw new UserFacingError('设置无效，请检查每天的检查时间。')
    }
    this.store.saveSettings({
      theme: settings.theme,
      autoCheck: settings.autoCheck,
      checkTime: settings.checkTime,
      desktopNotifications: settings.desktopNotifications,
      closeToTray: settings.closeToTray
    })
    this.onChanged()
    return this.snapshot()
  }

  async checkNow(id?: string): Promise<Snapshot> {
    this.assertIdle()
    if (id !== undefined) validateId(id)
    const records = id ? [this.store.watch(id)].filter((record): record is WatchRecord => Boolean(record)) : this.store.watches().filter((record) => !record.item.paused)
    if (!records.length) throw new UserFacingError('暂时没有可检查的作品，请先添加追更。')
    await this.runChecks(records)
    return this.snapshot()
  }

  private async runChecks(records: WatchRecord[]): Promise<void> {
    if (this.checking) return
    this.checking = true
    this.onChanged()
    let failures = 0
    let changes = 0
    let completed = 0
    try {
      for (const record of records) {
        const result = await this.checkRecord(record)
        completed++
        if (result.failed) failures++
        changes += result.events
        this.onChanged()
      }
      this.store.saveCheckState({
        lastCheckAt: new Date().toISOString(),
        lastCheckSummary: `已检查 ${completed} 部作品，发现 ${changes} 条更新${failures ? `，${failures} 部需要重试` : ''}。`
      })
    } finally {
      this.checking = false
      this.onChanged()
    }
  }

  private async checkRecord(record: WatchRecord, existingInspection?: Inspection): Promise<{ failed: boolean; events: number }> {
    const now = new Date().toISOString()
    const previouslyReady = record.item.baselineReady
    const events: UpdateEvent[] = []
    const errors: string[] = []
    try {
      let inspection: Inspection
      try {
        inspection = existingInspection ?? await this.provider.inspect(record.item.id, record.item.watchSeasons)
      } catch (error) {
        // A temporary error on the originally followed season must not stop checking
        // already discovered seasons that are still independently available.
        errors.push(toUserMessage(error))
        inspection = { series: record.item.series, seasons: Object.values(record.seasons), seasonListAvailable: false }
      }
      const rootBaseline = record.seasons[record.item.id]
      record.item.series = {
        ...inspection.series,
        coverUrl: inspection.series.coverUrl ?? record.item.series.coverUrl,
        episodeCount: rootBaseline?.baselineReady ? rootBaseline.episodeIds.length : record.item.series.episodeCount
      }
      if (inspection.seasonWarning) errors.push(inspection.seasonWarning)
      const seasonBaselineReady = record.seasonBaselineReady
      const knownSeasons = new Set(Object.keys(record.seasons))
      const incoming = record.item.watchSeasons ? inspection.seasons : inspection.seasons.filter((season) => season.id === record.item.id)
      const numberedAlbum = incoming.some(season => (season.index ?? 0) > 0)
      for (const season of incoming) {
        const previous = record.seasons[season.id]
        const index = season.index || previous?.index || (numberedAlbum ? seasonIndexFromTitle(season.title) : undefined)
        if (!previous) {
          const discoveredLater = record.item.watchSeasons && seasonBaselineReady && season.id !== record.item.id
          record.seasons[season.id] = { ...season, index, episodeIds: [], baselineReady: false, seasonNoticePending: discoveredLater, firstEpisodesPending: discoveredLater }
        } else {
          record.seasons[season.id] = { ...previous, ...season, index, episodeCount: season.episodeCount ?? previous.episodeCount }
        }
      }
      const announcedThisCheck = new Set<string>()
      if (record.item.watchSeasons && inspection.seasonListAvailable) {
        if ([...knownSeasons].some((id) => !incoming.some((season) => season.id === id))) errors.push('本次关联季列表不完整，缺失的季仍会继续检查。')
        for (const current of incoming) {
          const season = record.seasons[current.id]
          if (season.seasonNoticePending) {
            events.push({ id: eventId(record.item.id, 'season', season.id), watchId: record.item.id, seriesId: season.id, title: season.title, kind: 'season', message: `发现关联新季${season.episodeCount ? `，已列出 ${season.episodeCount} 集` : '，集数待更新'}。`, createdAt: now, read: false })
            season.seasonNoticePending = false
            announcedThisCheck.add(season.id)
          }
        }
        record.seasonBaselineReady = true
      }
      const seasons = Object.values(record.seasons).filter((season) => record.item.watchSeasons || season.id === record.item.id)
      // SDK 0.2 does not expose the mobile reservation button. Require a listed
      // later season after a known release as well as a pending endpoint response.
      const candidates = inspection.seasonListAvailable ? upcomingSeasonIds(incoming.map(s => record.seasons[s.id])) : new Set<string>()
      for (const season of seasons) {
        let expectedCount = season.episodeCount
        const listedUpcoming = inspection.seasonListAvailable ? candidates.has(season.id) : Boolean(season.awaitingPremiere)
        const canAwaitPremiere = season.id !== record.item.id && !hasPublishedEpisodes(season) && listedUpcoming
        if (!canAwaitPremiere) season.awaitingPremiere = false
        try {
          if (season.id !== record.item.id) {
            const latest = await this.provider.inspect(season.id, false)
            season.title = latest.series.title
            expectedCount = latest.series.episodeCount ?? expectedCount
          }
          const allowEmpty = canAwaitPremiere || (!season.episodeIds.length && (expectedCount === 0 ||
            (expectedCount === undefined && Boolean(season.firstEpisodesPending))))
          const ids = await this.provider.episodeIds(season.id, allowEmpty)
          if (canAwaitPremiere && !ids.length) season.awaitingPremiere = true
          // An omitted count is unknown, not evidence of a zero-episode baseline.
          // Keep the first-publication marker until a nonempty complete response arrives.
          if (!ids.length && expectedCount === undefined && season.firstEpisodesPending && !season.awaitingPremiere) continue
          const added = compareEpisodes(season.episodeIds, ids, season.awaitingPremiere && !ids.length ? 0 : expectedCount)
          if ((season.baselineReady || season.firstEpisodesPending) && added.length && !season.seasonNoticePending && !announcedThisCheck.has(season.id)) {
            events.push({ id: eventId(record.item.id, 'episodes', season.id, added), watchId: record.item.id, seriesId: season.id, title: season.title, kind: 'episodes', message: `新增 ${added.length} 集，现有 ${ids.length} 集。`, createdAt: now, read: false })
          }
          season.episodeIds = ids
          season.episodeCount = ids.length
          season.baselineReady = true
          if (ids.length) {
            season.awaitingPremiere = false
            if (!season.seasonNoticePending) season.firstEpisodesPending = false
          }
          if (season.id === record.item.id) record.item.series.episodeCount = ids.length
          const announcement = events.find((event) => event.kind === 'season' && event.seriesId === season.id)
          if (announcement && ids.length) announcement.message = `发现关联新季，已列出 ${ids.length} 集。`
        } catch (error) {
          const limited = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ANONYMOUS_LIMITED'
          if (canAwaitPremiere && (limited || isUnavailable(error))) {
            season.awaitingPremiere = true
            season.baselineReady = true
          } else if (!hasPublishedEpisodes(season) && isUnavailable(error) &&
              (expectedCount === 0 || (expectedCount === undefined && season.firstEpisodesPending))) {
            if (expectedCount === 0) season.baselineReady = true
          } else {
            errors.push(`${season.title}：${toUserMessage(error)}`)
          }
        }
        if (season.awaitingPremiere && announcedThisCheck.has(season.id)) {
          const announcement = events.find(event => event.kind === 'season' && event.seriesId === season.id)
          if (announcement) announcement.message = '发现关联新季，红果手机端可预约，正在等待开播。'
        }
      }
      record.item.seasonCount = Object.keys(record.seasons).length
      record.item.knownEpisodeCount = Object.values(record.seasons).reduce((sum, season) => sum + season.episodeIds.length, 0)
      record.item.baselineReady = seasons.every((season) => season.baselineReady) && (!record.item.watchSeasons || record.seasonBaselineReady)
    } catch (error) {
      errors.push(toUserMessage(error))
    }
    record.item.lastCheckedAt = now
    record.item.lastCheckWasBaseline = !previouslyReady && record.item.baselineReady && events.length === 0
    record.item.lastError = errors.length ? [...new Set(errors)].join(' ') : undefined
    const added = this.store.commitCheck(record, events)
    if (added.length) this.onNewEvents?.()
    if (added.length && this.store.settings().desktopNotifications) {
      // The persistent event list is authoritative; a failed OS toast cannot roll it back.
      try { this.onNotify(`${record.item.series.title} 有更新`, added.map((event) => `${event.title}：${event.message}`).join('\n').slice(0, 350)) } catch { /* Notification delivery can be disabled by Windows. */ }
    }
    return { failed: errors.length > 0, events: added.length }
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.timer = setInterval(() => this.resume(), 30_000)
    this.timer.unref()
    this.resume()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  dispose(): void {
    this.assertIdle()
    this.stop()
    this.store.close()
  }

  resume(): void {
    if (this.stopped || this.checking) return
    const settings = this.store.settings()
    if (!settings.autoCheck) return
    const due = latestDueTime(new Date(), settings.checkTime)
    const records = this.store.watches().filter((record) => !record.item.paused && (!record.item.lastCheckedAt || new Date(record.item.lastCheckedAt) < due))
    if (!records.length) return
    void this.runChecks(records).catch((error: unknown) => {
      this.store.saveCheckState({ lastCheckAt: new Date().toISOString(), lastCheckSummary: toUserMessage(error) })
      this.onChanged()
    })
  }
}
