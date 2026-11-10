import { createHash, randomUUID } from 'node:crypto'
import type { BrowsePage, BrowseQuery, FilterRow, ScheduledTask, SeasonCard, SeriesDetails, Settings, Snapshot, TaskDraft, UpdateEvent, WatchItem } from '../shared/types'
import { orderedSeasons, releasedSeasonFor, seasonNumber } from '../shared/seasons'
import { Provider, toUserMessage, UserFacingError, validateId, type Inspection } from './provider'
import { Store, updateNotification, type SeasonState, type WatchRecord } from './store'
import { firstStart, taskWindow, validDraft } from './schedule'

function taskPlan(task: ScheduledTask, active: WatchItem[], now: number): { task: ScheduledTask; items: WatchItem[]; nextAt?: number } {
  const window = taskWindow(task, now)
  const due = window.due
  // The migrated daily check keeps the previous per-work catch-up behavior.
  const pending = task.enabled && due !== undefined &&
    ((task.startAt === 0 && task.mode === 'changes') || task.lastRunAt === undefined || task.lastRunAt < due)
  const items = pending ? active.filter(item => task.mode === 'full' ||
    !item.lastCheckedAt || Date.parse(item.lastCheckedAt) < due) : []
  return { task, items, nextAt: task.enabled ? (items.length ? now : window.next) : undefined }
}

/** Never accept a truncated response as the new baseline or notify from it. */
export function compareEpisodes(previous: string[], current: string[]): string[] {
  const next = new Set(current)
  const missing = previous.filter(id => !next.has(id)).length
  if (missing) throw new UserFacingError(`本次分集明细缺少已收录的 ${missing} 个分集编号，已保留原进度。`)
  const known = new Set(previous)
  return [...next].filter((id) => !known.has(id))
}

function eventId(watchId: string, kind: UpdateEvent['kind'], seriesId: string, ids: string[] = []): string {
  return createHash('sha256').update(JSON.stringify([watchId, kind, seriesId, [...ids].sort()])).digest('hex')
}

function isUnavailable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'CONTENT_UNAVAILABLE'
}

function hasPublishedEpisodes(season: SeasonState): boolean {
  return season.episodeIds.length > 0 || (season.episodeCount ?? 0) > 0
}

export type MonitorProvider = Pick<Provider, 'browse' | 'filters' | 'details' | 'inspect' | 'seasonDirectory' | 'episodeIds'>

/** An album can swap a reservation ID for its published ID. Resolve all missing rows
 * before changing any of them, so a partial directory cannot erase watch history. */
function reconcileReservationIds(record: WatchRecord, directory: SeasonCard[], declaredComplete: boolean): boolean {
  const liveIds = new Set(directory.map(season => season.id))
  const hasUnnumberedEntry = directory.some(row => row.id !== record.item.id && row.index === undefined)
  const replacements = new Map<string, SeasonState>()
  const unresolved: SeasonState[] = []
  for (const saved of Object.values(record.seasons)) {
    if (liveIds.has(saved.id)) continue
    if (saved.id === record.item.id || hasPublishedEpisodes(saved)) return false
    const release = releasedSeasonFor(saved, directory)
    if (!release) {
      if (!saved.missingFromDirectory && !(declaredComplete && hasUnnumberedEntry)) return false
      unresolved.push(saved)
      continue
    }
    if (replacements.has(release.id) || release.id === record.item.id) return false
    replacements.set(release.id, saved)
  }
  // The live IDs determine the displayed total. Keep unresolved reservations out of
  // that total without attaching their progress to an unnumbered release by position.
  for (const saved of unresolved) saved.missingFromDirectory = true
  for (const [id, reservation] of replacements) {
    const published = record.seasons[id]
    record.seasons[id] = {
      ...reservation, ...published, id,
      baselineReady: reservation.baselineReady || Boolean(published?.baselineReady),
      seasonNoticePending: reservation.seasonNoticePending,
      // Older versions may already have verified the released ID while waiting for
      // the missing reservation to reappear. Deliver that deferred premiere once.
      firstEpisodesPending: published?.episodeIds.length
        ? published.seasonNoticePending && (reservation.baselineReady || reservation.firstEpisodesPending)
        : reservation.firstEpisodesPending || published?.firstEpisodesPending
    }
    delete record.seasons[reservation.id]
  }
  return true
}

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
      reservationSeasons: Object.values(seasons).filter(season => season.awaitingPremiere && !season.missingFromDirectory)
        .map(({ id, index }) => ({ id, index }))
    }))
    const now = Date.now()
    const active = watches.filter(item => !item.paused)
    const tasks = this.store.tasks().map(task => ({ ...task, nextAt: taskPlan(task, active, now).nextAt }))
    const next = Math.min(...tasks.flatMap(task => task.nextAt === undefined ? [] : [task.nextAt]))
    const nextCheckAt = active.length && Number.isFinite(next) ? new Date(next).toISOString() : undefined
    return { watches, tasks, events: this.store.events(), settings, checking: this.checking, nextCheckAt, dataPath: this.dataPath, ...this.store.checkState() }
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

  assertIdle(): void {
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
          series: { ...inspection.series, episodeCount: undefined },
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
    await this.runChecks(records, id !== undefined)
    return this.snapshot()
  }

  saveTask(input: unknown, id?: string): Snapshot {
    this.assertIdle()
    const draft = input as TaskDraft
    if (!validDraft(draft)) throw new UserFacingError('请检查任务名称、时间和执行频率。')
    const tasks = this.store.tasks()
    const old = tasks.find(t => t.id === id)
    if (id !== undefined && !old) throw new UserFacingError('任务已被删除。')
    const { enabled, mode, time, frequency } = draft
    const unchanged = old && old.enabled === enabled && old.mode === mode && old.time === time &&
      JSON.stringify(old.frequency) === JSON.stringify(frequency)
    const task: ScheduledTask = { id: old?.id ?? randomUUID(), name: draft.name.trim(), enabled, mode, time, frequency,
      startAt: unchanged ? old.startAt : firstStart(draft, Date.now()), lastRunAt: unchanged ? old.lastRunAt : undefined }
    this.store.saveTasks(old ? tasks.map(t => t.id === id ? task : t) : [...tasks, task])
    this.onChanged()
    return this.snapshot()
  }

  removeTask(id: string): Snapshot {
    this.assertIdle()
    this.store.saveTasks(this.store.tasks().filter(task => task.id !== id))
    this.onChanged()
    return this.snapshot()
  }

  private async runChecks(records: WatchRecord[], checkAllSeasons = false, tasks: ScheduledTask[] = []): Promise<void> {
    if (this.checking) return
    this.checking = true
    this.onChanged()
    let failures = 0
    let changes = 0
    let completed = 0
    try {
      for (const record of records) {
        const result = await this.checkRecord(record, undefined, checkAllSeasons)
        completed++
        if (result.failed) failures++
        changes += result.events
        this.onChanged()
      }
      this.store.saveCheckState({
        lastCheckAt: new Date().toISOString(),
        lastCheckSummary: `已检查 ${completed} 部作品，发现 ${changes} 条更新${failures ? `，${failures} 部需要重试` : ''}。`
      })
      if (tasks.length) {
        const completedAt = Date.now()
        const ids = new Set(tasks.map(task => task.id))
        this.store.saveTasks(this.store.tasks().map(task => ids.has(task.id) ? { ...task, lastRunAt: completedAt } : task))
      }
    } finally {
      this.checking = false
      this.onChanged()
    }
  }

  private async inspectForCheck(record: WatchRecord): Promise<Inspection> {
    const { id, series, watchSeasons } = record.item
    const known = Object.keys(record.seasons)
    let directory: Awaited<ReturnType<Provider['seasonDirectory']>>
    try {
      directory = await this.provider.seasonDirectory(id)
    } catch (error) {
      const noAlbum = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ALBUM_UNAVAILABLE'
      if (!noAlbum || (watchSeasons && known.length > 1)) throw error
      directory = { seasons: [] }
    }
    if (!watchSeasons) {
      const root = directory.seasons.find(row => row.id === id) ?? { id, title: series.title }
      return { series, seasons: [root], seasonListAvailable: false }
    }
    if (!directory.seasons.length && known.length <= 1 && (directory.expectedCount ?? 0) <= 1) {
      const single = await this.provider.inspect(id, false)
      return { ...single, seasonListAvailable: !single.isMultiSeason, seasonWarning: single.isMultiSeason ? '关联季列表暂时为空，已保留已有各季。' : undefined }
    }
    const byId = new Map(directory.seasons.map(season => [season.id, season]))
    const seasons = orderedSeasons([...byId.values()])
    const complete = byId.has(id) && byId.size >= (directory.expectedCount ?? 0) &&
      reconcileReservationIds(record, seasons, byId.size === directory.expectedCount)
    return {
      series: { ...series, coverUrl: directory.coverUrl ?? series.coverUrl },
      seasons, seasonListAvailable: complete,
      seasonWarning: complete ? undefined : '本次关联季列表不完整，已保留原有进度，下次检查时重试。'
    }
  }

  private async checkRecord(record: WatchRecord, existingInspection?: Inspection, checkAllSeasons = false): Promise<{ failed: boolean; events: number }> {
    const now = new Date().toISOString()
    const previouslyReady = record.item.baselineReady
    const events: UpdateEvent[] = []
    const errors: string[] = []
    try {
      const inspection = existingInspection ?? await this.inspectForCheck(record)
      const rootBaseline = record.seasons[record.item.id]
      record.item.series = {
        ...inspection.series,
        coverUrl: inspection.series.coverUrl ?? record.item.series.coverUrl,
        episodeCount: rootBaseline?.episodeIds.length || (rootBaseline?.baselineReady ? 0 : undefined)
      }
      if (inspection.seasonWarning) errors.push(inspection.seasonWarning)
      const seasonBaselineReady = record.seasonBaselineReady
      const incoming = record.item.watchSeasons ? inspection.seasons : inspection.seasons.filter((season) => season.id === record.item.id)
      for (const season of incoming) {
        const previous = record.seasons[season.id]
        const index = seasonNumber(season) ?? previous?.index
        if (!previous) {
          const discoveredLater = record.item.watchSeasons && seasonBaselineReady && season.id !== record.item.id
          record.seasons[season.id] = { ...season, index, episodeCount: undefined, episodeIds: [], baselineReady: false, seasonNoticePending: discoveredLater, firstEpisodesPending: discoveredLater }
        } else {
          record.seasons[season.id] = { ...previous, ...season, index, missingFromDirectory: undefined,
            episodeCount: previous.episodeIds.length || (previous.baselineReady ? 0 : undefined) }
        }
      }
      const announcedThisCheck = new Set<string>()
      if (record.item.watchSeasons && inspection.seasonListAvailable) {
        for (const current of incoming) {
          const season = record.seasons[current.id]
          if (season.seasonNoticePending) {
            const verified = season.episodeIds.length
            events.push({ id: eventId(record.item.id, 'season', season.id), watchId: record.item.id, seriesId: season.id, title: season.title, kind: 'season', message: verified ? `发现关联新季，已列出 ${verified} 集。` : '发现关联新季，集数待更新。', createdAt: now, read: false })
            season.seasonNoticePending = false
            if (verified) season.firstEpisodesPending = false
            announcedThisCheck.add(season.id)
          }
        }
        record.seasonBaselineReady = true
      }
      // Only an observed episode ID proves that a season has premiered. Take this
      // snapshot before polling so the plan is independent of directory row order.
      const released = Object.values(record.seasons).filter(s => !s.missingFromDirectory && s.episodeIds.length > 0)
      const latestIndex = Math.max(0, ...released.map(s => s.index ?? 0))
      // The catalogue also supplies context for recognizing a reservation on first follow.
      const latestListedIndex = Math.max(latestIndex, ...incoming.filter(s => (s.episodeCount ?? 0) > 0)
        .map(s => record.seasons[s.id].index ?? 0))
      for (const row of incoming) {
        const season = record.seasons[row.id]
        const directoryCount = row.episodeCount
        const listedUpcoming = inspection.seasonListAvailable && latestListedIndex > 0 && (season.index ?? 0) > latestListedIndex
        const canAwaitPremiere = season.id !== record.item.id && !season.episodeIds.length && !directoryCount &&
          (listedUpcoming || season.awaitingPremiere)
        try {
          // A released season without a number cannot safely be ranked behind the latest.
          const latest = season.episodeIds.length > 0 && (!season.index || season.index === latestIndex)
          const needsDetails = checkAllSeasons || !season.baselineReady || !season.episodeIds.length ||
            directoryCount !== season.episodeIds.length || latest || !record.item.watchSeasons
          const deferredPremiere = season.firstEpisodesPending && season.episodeIds.length > 0 && !season.seasonNoticePending
          if (!needsDetails && !deferredPremiere) continue
          const allowEmpty = Boolean(season.awaitingPremiere || canAwaitPremiere) || (!season.episodeIds.length && (directoryCount === 0 ||
            (directoryCount === undefined && Boolean(season.firstEpisodesPending))))
          const ids = needsDetails ? await this.provider.episodeIds(season.id, allowEmpty) : season.episodeIds
          if (canAwaitPremiere && !ids.length) season.awaitingPremiere = true
          // An omitted count is unknown, not evidence of a zero-episode baseline.
          // Keep the first-publication marker until a nonempty complete response arrives.
          const freshIds = compareEpisodes(season.episodeIds, ids)
          const added = deferredPremiere ? ids : freshIds
          if ((season.baselineReady || season.firstEpisodesPending) && added.length && !season.seasonNoticePending && !announcedThisCheck.has(season.id)) {
            events.push({ id: eventId(record.item.id, 'episodes', season.id, added), watchId: record.item.id, seriesId: season.id, title: season.title, kind: 'episodes', message: `新增 ${added.length} 集，现有 ${ids.length} 集。`, createdAt: now, read: false })
          }
          season.episodeIds = ids
          if (ids.length > 0 || directoryCount !== undefined) season.episodeCount = ids.length
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
              (directoryCount === 0 || (directoryCount === undefined && season.firstEpisodesPending))) {
            season.baselineReady = true
          } else {
            errors.push(`${season.title}：${toUserMessage(error)}`)
          }
        }
        if (season.awaitingPremiere && announcedThisCheck.has(season.id)) {
          const announcement = events.find(event => event.kind === 'season' && event.seriesId === season.id)
          if (announcement) announcement.message = '发现关联新季，红果手机端可预约，正在等待开播。'
        }
      }
      const listedSeasons = Object.values(record.seasons).filter(season => !season.missingFromDirectory)
      record.item.seasonCount = listedSeasons.length
      record.item.knownEpisodeCount = listedSeasons.reduce((sum, season) => sum + season.episodeIds.length, 0)
      record.item.baselineReady = record.item.watchSeasons
        ? record.seasonBaselineReady && listedSeasons.every(season => season.baselineReady)
        : Boolean(record.seasons[record.item.id]?.baselineReady)
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
      for (const event of added) {
        const { title, body } = updateNotification(event)
        try { this.onNotify(title, body) } catch { /* Notification delivery can be disabled by Windows. */ }
      }
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
    const records = this.store.watches().filter(record => !record.item.paused)
    const active = records.map(record => record.item)
    const now = Date.now()
    const due = this.store.tasks().map(task => taskPlan(task, active, now)).filter(plan => plan.items.length)
    if (!due.length) return
    const ids = new Set(due.flatMap(plan => plan.items.map(item => item.id)))
    void this.runChecks(records.filter(record => ids.has(record.item.id)),
      due.some(plan => plan.task.mode === 'full'), due.map(plan => plan.task)).catch((error: unknown) => {
      this.store.saveCheckState({ lastCheckAt: new Date().toISOString(), lastCheckSummary: toUserMessage(error) })
      this.onChanged()
    })
  }
}
