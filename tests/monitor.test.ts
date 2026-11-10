import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Monitor, type MonitorProvider } from '../src/main/monitor'
import { Store } from '../src/main/store'
import { watchSummary } from '../src/shared/watch-summary'
import { normalizeSeasonList, UserFacingError, type Inspection } from '../src/main/provider'
import type { BrowsePage, FilterRow, SeasonCard, SeriesDetails } from '../src/shared/types'

const first = '7690163276214176792'
const second = '7690163276214176793'
const third = '7690163276214176794'
const episode1 = '7690163276214000001'
const episode2 = '7690163276214000002'
const episode3 = '7690163276214000003'

test('the watch card distinguishes a baseline, an unread change, a failed recheck and a new follow', async (context) => {
  const { monitor, provider } = fixture(context)
  const initialTime = new Date(2026, 10, 7, 8).getTime()
  context.mock.timers.enable({ apis: ['Date'], now: initialTime })
  const summary = () => {
    const { watches, events } = monitor.snapshot()
    return watchSummary(watches[0], events)
  }

  provider.add(first, '作品一', [episode1])
  await monitor.follow(first)
  assert.equal(summary().result, '已记录初始进度')
  context.mock.timers.setTime(initialTime + 60_000)
  provider.episodes.set(first, [episode1, episode2])
  await monitor.checkNow()
  assert.equal(summary().unread, 1)
  assert.match(summary().highlight!.message, /新增 1 集/)

  context.mock.timers.setTime(initialTime + 120_000)
  provider.failures.set(first, new UserFacingError('暂时连接失败。'))
  await monitor.checkNow()
  assert.equal(summary().result, '检查未完成')
  assert.equal(summary().unread, 1)
  provider.failures.clear()
  context.mock.timers.setTime(initialTime + 180_000)
  await monitor.checkNow()
  assert.equal(summary().result, '本次无更新')
  assert.equal(summary().unread, 1)
  monitor.removeWatch(first)
  context.mock.timers.setTime(initialTime + 240_000)
  await monitor.follow(first)
  assert.equal(summary().unread, 0)
  assert.equal(summary().result, '已记录初始进度')
})

/** Supplies only directory metadata; no SDK runtime or network transport is created. */
class FakeProvider implements MonitorProvider {
  readonly entries = new Map<string, { title: string; count?: number; seasons: SeasonCard[]; seasonCount?: number }>()
  readonly episodes = new Map<string, string[]>()
  readonly failures = new Map<string, Error>()
  readonly detailFailures = new Map<string, Error>()
  readonly directoryFailures = new Map<string, Error>()
  readonly inspections: string[] = []
  readonly directoryCalls: string[] = []
  readonly episodeCalls: string[] = []
  beforeEpisodes?: () => Promise<void>

  add(id: string, title: string, ids: string[] = []): void {
    this.entries.set(id, { title, count: ids.length, seasons: [] })
    this.episodes.set(id, ids)
  }

  async browse(): Promise<BrowsePage> { return { items: [], hasMore: false } }
  async filters(): Promise<FilterRow[]> { return [] }
  async details(id: string): Promise<SeriesDetails> { return this.inspect(id) }

  async seasonDirectory(id: string) {
    this.directoryCalls.push(id)
    const failure = this.directoryFailures.get(id)
    if (failure) throw failure
    const entry = this.entries.get(id)!
    const root = { id, title: entry.title, episodeCount: entry.count }
    return { seasons: entry.seasons.length || entry.seasonCount ? [root, ...entry.seasons] : [], expectedCount: entry.seasonCount }
  }

  async inspect(id: string, includeSeasons = true): Promise<Inspection> {
    this.inspections.push(id)
    const failure = this.detailFailures.get(id)
    if (failure) throw failure
    const entry = this.entries.get(id)
    assert.ok(entry, `Unexpected inspection of ${id}`)
    const root = { id, title: entry.title, episodeCount: entry.count }
    return {
      series: { id, title: entry.title, episodeCount: entry.count, tags: [] },
      ...(includeSeasons
        ? normalizeSeasonList([root, ...entry.seasons], root, entry.seasonCount)
        : { seasons: [root], seasonListAvailable: false })
    }
  }

  async episodeIds(id: string, allowEmpty: boolean): Promise<string[]> {
    this.episodeCalls.push(id)
    await this.beforeEpisodes?.()
    const failure = this.failures.get(id)
    if (failure) throw failure
    const ids = [...(this.episodes.get(id) ?? [])]
    if (!ids.length && !allowEmpty) throw new UserFacingError('分集列表暂时为空，已保留上次结果。')
    return ids
  }
}

function fixture(context: TestContext): { monitor: Monitor; provider: FakeProvider; notices: string[]; dataPath: string } {
  const dataPath = mkdtempSync(join(__dirname, 'hongguo-monitor-test-'))
  const provider = new FakeProvider()
  const notices: string[] = []
  const monitor = new Monitor(dataPath, () => undefined, (title) => notices.push(title), provider)
  context.after(() => {
    monitor.dispose()
    rmSync(dataPath, { recursive: true, force: true })
  })
  return { monitor, provider, notices, dataPath }
}

async function finishScheduledCheck(monitor: Monitor): Promise<void> {
  for (let attempt = 0; attempt < 100 && monitor.snapshot().checking; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.equal(monitor.snapshot().checking, false, 'Scheduled check should finish')
}

test('overlapping daily and full tasks catch a hidden older-season change once and persist completion', async context => {
  const { monitor, provider, dataPath, notices } = fixture(context)
  const start = new Date(2026, 10, 9, 8)
  context.mock.timers.enable({ apis: ['Date'], now: start })
  provider.add(first, '作品第一季', [episode1])
  provider.add(second, '作品第二季', [episode2])
  provider.entries.get(first)!.seasons.push({ id: second, title: '作品第二季', index: 2, episodeCount: 1 })
  await monitor.follow(first)
  monitor.saveTask({ name: '全量', enabled: true, time: '09:00', frequency: { kind: 'daily' }, mode: 'full' })
  monitor.start()
  provider.episodeCalls.length = 0
  provider.directoryCalls.length = 0
  provider.episodes.set(first, [episode1, episode3])
  context.mock.timers.setTime(new Date(2026, 10, 12, 12).getTime())
  monitor.resume()
  await finishScheduledCheck(monitor)
  assert.deepEqual(provider.directoryCalls, [first])
  assert.deepEqual(provider.episodeCalls.sort(), [first, second])
  assert.equal(notices.length, 1)
  assert.equal(monitor.snapshot().events.length, 1)
  monitor.stop()
  const reopened = new Monitor(dataPath, () => {}, () => {}, provider)
  try {
    reopened.start()
    await finishScheduledCheck(reopened)
    assert.equal(provider.directoryCalls.length, 1)
    for (const task of reopened.snapshot().tasks) reopened.removeTask(task.id)
    assert.deepEqual(reopened.snapshot().tasks, [])
    assert.equal(reopened.snapshot().nextCheckAt, undefined)
  } finally { reopened.dispose() }
})

test('following establishes a persisted baseline and notifies only genuinely new episode IDs once', async (context) => {
  const { monitor, provider, notices, dataPath } = fixture(context)
  provider.add(first, '作品一', [episode1])
  await monitor.follow(first)
  assert.equal(monitor.snapshot().watches[0].baselineReady, true)
  assert.equal(monitor.snapshot().watches[0].knownEpisodeCount, 1)
  assert.equal(monitor.snapshot().events.length, 0)
  assert.equal(notices.length, 0)

  provider.episodes.set(first, [episode1, episode2])
  provider.entries.get(first)!.count = 2
  await monitor.checkNow()
  await monitor.checkNow()
  assert.equal(monitor.snapshot().events.length, 1)
  assert.equal(monitor.snapshot().events[0].kind, 'episodes')
  assert.match(monitor.snapshot().events[0].message, /新增 1 集/)
  assert.equal(notices.length, 1)

  const reopened = new Monitor(dataPath, () => undefined, () => assert.fail('Reading a database must not notify'), provider)
  try {
    assert.equal(reopened.snapshot().watches[0].knownEpisodeCount, 2)
    assert.equal(reopened.snapshot().events.length, 1)
    await reopened.checkNow()
    assert.equal(reopened.snapshot().events.length, 1)
  } finally { reopened.dispose() }
})

test('empty, truncated and failed episode responses preserve the baseline and do not create false events', async (context) => {
  const { monitor, provider, notices } = fixture(context)
  provider.add(first, '作品一', [episode1, episode2])
  await monitor.follow(first)
  for (const incomplete of [[], [episode1, episode3]]) {
    provider.episodes.set(first, incomplete)
    await monitor.checkNow()
    assert.equal(monitor.snapshot().watches[0].knownEpisodeCount, 2)
    assert.ok(monitor.snapshot().watches[0].lastError)
    assert.equal(monitor.snapshot().events.length, 0)
  }
  provider.failures.set(first, new UserFacingError('暂时连接失败。'))
  await monitor.checkNow()
  assert.equal(monitor.snapshot().watches[0].knownEpisodeCount, 2)
  assert.equal(notices.length, 0)

  provider.failures.clear()
  provider.episodes.set(first, [episode1, episode2, episode3])
  provider.entries.get(first)!.count = 3
  await monitor.checkNow()
  assert.equal(monitor.snapshot().watches[0].lastError, undefined)
  assert.equal(monitor.snapshot().events.length, 1)
  assert.match(monitor.snapshot().events[0].message, /新增 1 集/)
})

test('an announced season is recorded once, then its first published episodes and subsequent episodes are detected', async (context) => {
  const { monitor, provider } = fixture(context)
  provider.add(first, '第一季', [episode1])
  await monitor.follow(first)

  provider.add(second, '第二季')
  provider.entries.get(first)!.seasons = [{ id: second, title: '第二季', index: 2, episodeCount: 0 }]
  await monitor.checkNow()
  await monitor.checkNow()
  assert.equal(monitor.snapshot().events.length, 1)
  assert.equal(monitor.snapshot().events[0].kind, 'season')
  assert.equal(monitor.snapshot().watches[0].lastError, undefined)
  assert.equal(monitor.snapshot().watches[0].seasonCount, 2)

  provider.entries.get(second)!.count = 1
  provider.entries.get(first)!.seasons[0].episodeCount = 1
  provider.episodes.set(second, [episode2])
  await monitor.checkNow()
  provider.entries.get(second)!.count = 2
  provider.entries.get(first)!.seasons[0].episodeCount = 2
  provider.episodes.set(second, [episode2, episode3])
  await monitor.checkNow()
  assert.equal(monitor.snapshot().events.filter((event) => event.kind === 'episodes').length, 2)
  assert.equal(monitor.snapshot().watches[0].knownEpisodeCount, 3)
})

test('a missing season keeps its progress and is checked on return; disabling related seasons checks only the followed season', async (context) => {
  const { monitor, provider } = fixture(context)
  provider.add(first, '第一季', [episode1])
  provider.add(second, '第二季', [episode2])
  provider.entries.get(first)!.seasons = [{ id: second, title: '第二季', index: 2, episodeCount: 1 }]
  await monitor.follow(first)
  provider.entries.get(first)!.seasons = []
  provider.entries.get(first)!.seasonCount = 2
  provider.episodeCalls.length = 0
  provider.entries.get(second)!.count = 2
  provider.episodes.set(second, [episode2, episode3])
  await monitor.checkNow()
  assert.equal(monitor.snapshot().watches[0].seasonCount, 2)
  assert.match(monitor.snapshot().watches[0].lastError!, /关联季列表不完整/)
  assert.deepEqual(provider.episodeCalls, [])
  assert.equal(monitor.snapshot().watches[0].knownEpisodeCount, 2)
  provider.entries.get(first)!.seasons = [{ id: second, title: '第二季', index: 2, episodeCount: 2 }]
  await monitor.checkNow()
  assert.equal(monitor.snapshot().events[0].seriesId, second)

  monitor.updateWatch(first, { watchSeasons: false })
  provider.inspections.length = 0
  provider.episodeCalls.length = 0
  provider.directoryCalls.length = 0
  await monitor.checkNow()
  assert.deepEqual(provider.directoryCalls, [first])
  assert.deepEqual(provider.inspections, [])
  assert.deepEqual(provider.episodeCalls, [first])
  assert.equal(monitor.snapshot().watches[0].seasonCount, 2)
})

test('manual checking of one work does not postpone other daily checks; failed checks are not retried every tick', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 5, 10, 0) })
  const { monitor, provider } = fixture(context)
  provider.add(first, '作品一', [episode1])
  provider.add(second, '作品二', [episode2])
  await monitor.follow(first)
  await monitor.follow(second)
  context.mock.timers.setTime(new Date(2026, 10, 6, 10, 0).getTime())
  await monitor.checkNow(first)
  provider.inspections.length = 0
  provider.failures.set(second, new UserFacingError('暂时连接失败。'))
  monitor.start()
  await finishScheduledCheck(monitor)
  assert.deepEqual(provider.inspections, [second])
  assert.ok(monitor.snapshot().watches.find((item) => item.id === second)?.lastError)
  monitor.resume()
  await finishScheduledCheck(monitor)
  assert.deepEqual(provider.inspections, [second])
})

test('paused works do not run automatically and an overdue work catches up once after resuming', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 5, 10, 0) })
  const { monitor, provider } = fixture(context)
  provider.add(first, '作品一', [episode1])
  await monitor.follow(first)
  monitor.updateWatch(first, { paused: true })
  context.mock.timers.setTime(new Date(2026, 10, 8, 8, 0).getTime())
  provider.inspections.length = 0
  monitor.start()
  assert.equal(monitor.snapshot().checking, false)
  assert.equal(provider.inspections.length, 0)
  monitor.updateWatch(first, { paused: false })
  monitor.resume()
  await finishScheduledCheck(monitor)
  assert.deepEqual(provider.inspections, [first])
  monitor.resume()
  assert.deepEqual(provider.inspections, [first])
  assert.equal(new Date(monitor.snapshot().nextCheckAt!).getHours(), 9)
})

test('removal cannot race an active check and a removed work is never recreated by the scheduler', async (context) => {
  const { monitor, provider } = fixture(context)
  provider.add(first, '作品一', [episode1])
  await monitor.follow(first)
  let release!: () => void
  provider.beforeEpisodes = () => new Promise<void>((resolve) => { release = resolve })
  const pending = monitor.checkNow(first)
  assert.throws(() => monitor.removeWatch(first), /正在检查/)
  for (let attempt = 0; attempt < 20 && !release; attempt++) await new Promise<void>((resolve) => setImmediate(resolve))
  assert.ok(release)
  release()
  await pending
  provider.beforeEpisodes = undefined
  monitor.removeWatch(first)
  provider.inspections.length = 0
  monitor.start()
  monitor.resume()
  assert.equal(monitor.snapshot().watches.length, 0)
  assert.equal(provider.inspections.length, 0)
  await assert.rejects(monitor.checkNow(first), /没有可检查/)
})

test('failed initial baseline retries without announcing old episodes as updates', async (context) => {
  const { monitor, provider, notices } = fixture(context)
  provider.add(third, '作品三', [episode1, episode2])
  provider.failures.set(third, new UserFacingError('暂时连接失败。'))
  await monitor.follow(third)
  assert.equal(monitor.snapshot().watches[0].baselineReady, false)
  provider.failures.clear()
  await monitor.checkNow()
  assert.equal(monitor.snapshot().watches[0].baselineReady, true)
  assert.equal(monitor.snapshot().events.length, 0)
  assert.equal(notices.length, 0)
})

test('a reported album total prevents a partial initial list from turning historical seasons into new-season events', async (context) => {
  const { monitor, provider, notices } = fixture(context)
  provider.add(first, '第一季', [episode1])
  provider.add(second, '第二季', [episode2])
  provider.add(third, '第三季', [episode3])
  provider.entries.get(first)!.seasonCount = 3
  // Duplicates must not satisfy the reported number of distinct seasons.
  provider.entries.get(first)!.seasons = [
    { id: first, title: '第一季', episodeCount: 1 },
    { id: first, title: '第一季', episodeCount: 1 }
  ]
  const partial = await provider.inspect(first)
  assert.equal(partial.seasonListAvailable, false)
  assert.match(partial.seasonWarning!, /1 季，共 3 季/)
  await monitor.follow(first)
  assert.equal(monitor.snapshot().watches[0].baselineReady, false)
  assert.equal(monitor.snapshot().events.length, 0)

  provider.entries.get(first)!.seasons = [
    { id: second, title: '第二季', episodeCount: 1 },
    { id: third, title: '第三季', episodeCount: 1 }
  ]
  await monitor.checkNow()
  assert.equal(monitor.snapshot().watches[0].seasonCount, 3)
  assert.equal(monitor.snapshot().watches[0].baselineReady, true)
  assert.equal(monitor.snapshot().events.length, 0)
  assert.equal(notices.length, 0)
})

test('a newly discovered season with an omitted count reports first publication after empty or unavailable responses', async (context) => {
  const { monitor, provider } = fixture(context)
  provider.add(first, '第一季', [episode1])
  await monitor.follow(first)
  provider.add(second, '第二季')
  provider.entries.get(second)!.count = undefined
  provider.entries.get(first)!.seasons = [{ id: second, title: '第二季' }]
  await monitor.checkNow()
  assert.equal(monitor.snapshot().events.length, 1)
  assert.equal(monitor.snapshot().events[0].kind, 'season')
  assert.equal(monitor.snapshot().watches[0].lastError, undefined)

  provider.failures.set(second, Object.assign(new Error('Not released yet'), { code: 'CONTENT_UNAVAILABLE' }))
  provider.episodeCalls.length = 0
  await monitor.checkNow()
  assert.equal(monitor.snapshot().events.length, 1)
  assert.equal(monitor.snapshot().watches[0].lastError, undefined)
  provider.failures.clear()
  provider.episodes.set(second, [episode2, episode3])
  await monitor.checkNow()
  assert.deepEqual(provider.episodeCalls, [first, second, first, second])
  assert.equal(monitor.snapshot().events.length, 2)
  provider.entries.get(first)!.seasons[0].episodeCount = 2
  await monitor.checkNow()
  await monitor.checkNow()
  const episodeEvents = monitor.snapshot().events.filter((event) => event.kind === 'episodes')
  assert.equal(episodeEvents.length, 1)
  assert.match(episodeEvents[0].message, /新增 2 集/)
  assert.equal(monitor.snapshot().watches[0].knownEpisodeCount, 3)
})

test('an initial unknown-count season with an unavailable baseline does not report old episodes on recovery', async (context) => {
  const { monitor, provider } = fixture(context)
  provider.add(first, '第一季', [episode1])
  provider.add(second, '关联番外')
  provider.entries.get(second)!.count = undefined
  provider.entries.get(first)!.seasons = [{ id: second, title: '关联番外' }]
  await monitor.follow(first)
  assert.equal(monitor.snapshot().watches[0].baselineReady, false)
  provider.episodes.set(second, [episode2, episode3])
  await monitor.checkNow()
  assert.equal(monitor.snapshot().watches[0].baselineReady, true)
  assert.equal(monitor.snapshot().events.length, 0)
})

test('a listed reservation is polled with the latest release and reports only verified episodes', async context => {
  const { monitor, provider, notices } = fixture(context)
  const limited = Object.assign(new Error(), { code: 'ANONYMOUS_LIMITED' })
  provider.add(first, '第一季', [episode1])
  provider.add(second, '第二季', [episode2])
  provider.add(third, '第三季')
  const directory: SeasonCard[] = [
    { id: first, title: '第一季', index: 1, episodeCount: 1 },
    { id: second, title: '第二季', index: 2, episodeCount: 1 },
    { id: third, title: '第三季', index: 3 }
  ]
  provider.entries.get(second)!.seasons = directory
  provider.failures.set(third, limited)
  await monitor.follow(second)
  const watch = () => monitor.snapshot().watches[0]
  assert.equal(watch().baselineReady, true)
  assert.equal(watchSummary(watch(), []).result, '第 3 季可预约')
  assert.equal((await monitor.details(second)).seasons.find(s => s.id === third)?.episodeCount, undefined)
  provider.episodeCalls.length = 0
  await monitor.checkNow()
  assert.deepEqual(provider.episodeCalls, [second, third])
  assert.equal(notices.length, 0)

  directory[2].episodeCount = 1
  provider.failures.set(third, Object.assign(new Error(), { code: 'TRANSPORT' }))
  await monitor.checkNow()
  assert.match(watch().lastError!, /第三季.*连接红果失败/)
  assert.equal(watch().knownEpisodeCount, 2)
  provider.failures.set(third, limited)
  await monitor.checkNow()
  assert.match(watch().lastError!, /第三季.*匿名查询/)
  assert.equal(notices.length, 0)
  provider.failures.clear()
  provider.episodes.set(third, [episode3])
  await monitor.checkNow()
  await monitor.checkNow()
  assert.deepEqual(watch().reservationSeasons, [])
  assert.equal(watch().knownEpisodeCount, 3)
  assert.equal(watch().lastError, undefined)
  assert.deepEqual(monitor.snapshot().events.map(e => [e.seriesId, e.kind]), [[third, 'episodes']])
  assert.equal(notices.length, 1)
})

test('a missing count and anonymous restriction on an unnumbered related work do not imply a reservation', async context => {
  const { monitor, provider } = fixture(context)
  provider.add(first, '已上线', [episode1])
  provider.add(second, '尚无集数')
  provider.entries.get(first)!.seasons = [{ id: second, title: '尚无集数' }]
  provider.failures.set(second, Object.assign(new Error(), { code: 'ANONYMOUS_LIMITED' }))
  await monitor.follow(first)
  assert.match(monitor.snapshot().watches[0].lastError!, /匿名查询/)
  assert.deepEqual(monitor.snapshot().watches[0].reservationSeasons, [])
})

test('a v1.0.2 published flag without any episodes cannot hide a numbered reservation on recheck', async context => {
  const { monitor, provider, dataPath } = fixture(context)
  provider.add(first, '作品第五季', [episode1])
  provider.add(second, '作品第六季')
  provider.entries.get(first)!.seasons = [
    { id: first, title: '作品第五季', index: 5, episodeCount: 1 },
    { id: second, title: '作品第六季' }
  ]
  // A season detail may advertise a total before its album has any released episodes.
  provider.entries.get(second)!.count = 80
  provider.failures.set(second, Object.assign(new Error(), { code: 'ANONYMOUS_LIMITED' }))
  await monitor.follow(first)

  const store = new Store(dataPath)
  const legacy = store.watch(first)!
  const pending = legacy.seasons[second]
  delete pending.index
  Object.assign(pending, { published: true, episodeCount: undefined, episodeIds: [], baselineReady: false, awaitingPremiere: false })
  Object.assign(legacy.item, { lastError: '作品第六季：匿名查询暂时受到限制，请稍后再试。', baselineReady: false })
  store.saveWatch(legacy)
  store.close()

  await monitor.checkNow()
  const watch = () => monitor.snapshot().watches[0]
  assert.equal(watch().lastError, undefined)
  assert.equal(watchSummary(watch(), []).result, '第 6 季可预约')
  assert.equal(watch().knownEpisodeCount, 1)
  assert.equal(monitor.snapshot().events.length, 0)
  // Details share the monitor's title fallback and keep an omitted episode count unknown.
  const row = (await monitor.details(first)).seasons.find(s => s.id === second)!
  assert.equal(row.index, 6)
  assert.equal(row.episodeCount, undefined)

  provider.entries.get(first)!.seasons[1].episodeCount = 2
  await monitor.checkNow()
  assert.match(watch().lastError!, /匿名查询/)
  assert.deepEqual(watch().reservationSeasons, [{ id: second, index: 6 }])
  provider.failures.clear()
  provider.entries.get(second)!.count = 2
  provider.episodes.set(second, [episode2, episode3])
  await monitor.checkNow()
  await monitor.checkNow()
  assert.equal(monitor.snapshot().events.length, 1)
  assert.match(monitor.snapshot().events[0].message, /新增 2 集/)
})

test('a new season seen first in a partial list is announced once when the list completes', async (context) => {
  const { monitor, provider } = fixture(context)
  provider.add(first, '第一季', [episode1])
  await monitor.follow(first)
  provider.add(second, '第二季', [episode2])
  provider.entries.get(first)!.seasonCount = 3
  provider.entries.get(first)!.seasons = [{ id: second, title: '第二季', episodeCount: 1 }]
  await monitor.checkNow()
  assert.equal(monitor.snapshot().events.length, 0)
  assert.equal(monitor.snapshot().watches[0].seasonCount, 2)

  provider.add(third, '第三季', [episode3])
  provider.entries.get(first)!.seasons.push({ id: third, title: '第三季', episodeCount: 1 })
  await monitor.checkNow()
  await monitor.checkNow()
  const events = monitor.snapshot().events
  assert.equal(events.length, 2)
  assert.deepEqual(new Set(events.map((event) => event.seriesId)), new Set([second, third]))
  assert.ok(events.every((event) => event.kind === 'season'))
})

for (const previousRelease of ['new', 'deferred', 'announced'] as const) {
  test(`a reservation and its released fifth season count once (${previousRelease})`, async context => {
    const { monitor, provider, dataPath, notices } = fixture(context)
    const rows: SeasonCard[] = [1, 2, 3, 4, 5].map(index => {
      const id = String(70000 + index)
      const title = index === 5 ? '重生之绝世仙帝第五季' : '重生之绝世仙帝'
      const episodeCount = index === 5 ? undefined : 1
      provider.add(id, title, episodeCount ? [String(90000 + index)] : [])
      return { id, title, index, episodeCount }
    })
    const root = rows[0].id
    const reservation = rows[4]
    const entry = provider.entries.get(root)!
    entry.seasonCount = 5
    entry.seasons = rows
    await monitor.follow(root)
    assert.deepEqual(monitor.snapshot().watches[0].reservationSeasons, [{ id: reservation.id, index: 5 }])

    const release = { id: '80005', title: reservation.title, index: 0, episodeCount: 131 }
    const ids = Array.from({ length: 131 }, (_, i) => String(81000 + i))
    provider.add(release.id, release.title, ids)
    entry.seasons = [release, ...rows.slice(0, 4)]
    if (previousRelease !== 'new') {
      // Old clients may have saved six rows and either deferred or sent the notice.
      const db = new Store(dataPath)
      try {
        const saved = db.watch(root)!
        const deferred = previousRelease === 'deferred'
        saved.seasons[release.id] = { ...release, episodeIds: ids, baselineReady: true, seasonNoticePending: deferred, firstEpisodesPending: deferred }
        saved.item.seasonCount = 6
        saved.item.lastError = '本次关联季列表不完整'
        db.commitCheck(saved, deferred ? [] : [{
          id: 'prior-season-event', watchId: root, seriesId: release.id, kind: 'season', title: release.title,
          message: '发现关联新季，已列出 131 集。', read: true, createdAt: new Date().toISOString()
        }])
      } finally { db.close() }
    }
    provider.episodeCalls.length = 0
    provider.directoryCalls.length = 0
    await monitor.checkNow()
    const { watches: [watch], events } = monitor.snapshot()
    assert.equal(watch.seasonCount, 5)
    assert.equal(watch.lastError, undefined)
    assert.deepEqual(watch.reservationSeasons, [])
    assert.equal(watch.knownEpisodeCount, 135)
    assert.deepEqual(events.map(e => [e.kind, e.seriesId]), [[previousRelease === 'announced' ? 'season' : 'episodes', release.id]])
    assert.match(events[0].message, /131 集/)
    assert.deepEqual(provider.episodeCalls, previousRelease === 'new' ? [rows[3].id, release.id] : [release.id])
    await monitor.checkNow()
    assert.equal(notices.length, previousRelease === 'announced' ? 0 : 1)
    assert.deepEqual(provider.directoryCalls, [root, root])
    const db = new Store(dataPath)
    try {
      const saved = db.watch(root)!
      assert.equal(saved.seasons[reservation.id], undefined)
      assert.equal(saved.seasons[release.id].index, 5)
      assert.deepEqual(saved.seasons[release.id].episodeIds, ids)
    } finally { db.close() }
  })
}

for (const replacedReservation of [false, true]) {
  test(`an unnumbered release is polled and acquires season tag five without a duplicate push (old reservation: ${replacedReservation})`, async context => {
    const { monitor, provider, notices, dataPath } = fixture(context)
    const rows: SeasonCard[] = [1, 2, 3, 4].map(index => {
      const id = String(71000 + index)
      provider.add(id, '仙途', [String(91000 + index)])
      return { id, title: '仙途', index, episodeCount: 1 }
    })
    const root = rows[0].id
    const entry = provider.entries.get(root)!
    const reservation = { id: '71005', title: '仙途续作', index: 5 }
    if (replacedReservation) provider.add(reservation.id, reservation.title)
    entry.seasons = replacedReservation ? [...rows, reservation] : rows
    entry.seasonCount = entry.seasons.length
    await monitor.follow(root)

    const release: SeasonCard = { id: '82005', title: '归来篇', episodeCount: 2 }
    provider.add(release.id, release.title, [episode1, episode2])
    entry.seasons = [release, ...rows]
    entry.seasonCount = 5
    provider.episodeCalls.length = 0
    await monitor.checkNow()
    const watch = () => monitor.snapshot().watches[0]
    assert.equal(watch().lastError, undefined)
    assert.equal(watch().seasonCount, 5)
    assert.deepEqual(watch().reservationSeasons, [])
    assert.deepEqual(provider.episodeCalls, [rows[3].id, release.id])
    assert.equal(notices.length, 1)
    const before = monitor.snapshot().events
    assert.deepEqual(before.map(e => e.seriesId), [release.id])
    const db = new Store(dataPath)
    try {
      const pending = db.watch(root)!
      assert.equal(pending.seasons[release.id].index, undefined)
      if (replacedReservation) assert.ok(pending.seasons[reservation.id].missingFromDirectory)
      provider.episodeCalls.length = 0
      await monitor.checkNow()
      assert.deepEqual(provider.episodeCalls, [rows[3].id, release.id])
      // The platform can retag the same item without renaming it or changing its episodes.
      release.index = 5
      provider.episodeCalls.length = 0
      const reopened = new Monitor(dataPath, () => {}, () => assert.fail('a tag edit must not notify'), provider)
      try { await reopened.checkNow() } finally { reopened.dispose() }
      const tagged = db.watch(root)!
      assert.equal(tagged.seasons[release.id].index, 5)
      assert.equal(tagged.seasons[reservation.id], undefined)
      assert.deepEqual(tagged.seasons[release.id].episodeIds, [episode1, episode2])
      assert.equal(tagged.item.seasonCount, 5)
      assert.equal(tagged.item.lastError, undefined)
      assert.deepEqual(monitor.snapshot().events, before)
      assert.deepEqual(provider.episodeCalls, [release.id])
      release.episodeCount = 3
      provider.episodes.set(release.id, [episode1, episode2, episode3])
      await monitor.checkNow()
      assert.match(monitor.snapshot().events[0].message, /新增 1 集/)
    } finally { db.close() }
  })
}

test('an unnumbered listing can be tagged before its first episode and still report its premiere exactly once', async context => {
  const { monitor, provider } = fixture(context)
  provider.add(first, '仙途第四季', [episode1])
  provider.add(second, '第五季预告')
  provider.add(third, '归来篇')
  const entry = provider.entries.get(first)!
  entry.seasonCount = 2
  entry.seasons = [{ id: second, title: '第五季预告', index: 5 }]
  await monitor.follow(first)
  const listing: SeasonCard = { id: third, title: '归来篇' }
  entry.seasons = [listing]
  await monitor.checkNow()
  assert.equal(monitor.snapshot().watches[0].lastError, undefined)
  assert.equal(monitor.snapshot().watches[0].seasonCount, 2)
  assert.deepEqual(monitor.snapshot().watches[0].reservationSeasons, [])
  const initial = monitor.snapshot().events
  assert.deepEqual(initial.map(event => event.kind), ['season'])
  listing.index = 5
  await monitor.checkNow()
  assert.deepEqual(monitor.snapshot().events, initial)
  assert.deepEqual(monitor.snapshot().watches[0].reservationSeasons, [{ id: third, index: 5 }])
  listing.episodeCount = 1
  provider.episodes.set(third, [episode2])
  await monitor.checkNow()
  await monitor.checkNow()
  assert.deepEqual(monitor.snapshot().events.map(e => [e.seriesId, e.kind]), [[third, 'episodes'], [third, 'season']])
  assert.equal(monitor.snapshot().watches[0].seasonCount, 2)
})

test('a partial or ambiguous list cannot remove a saved reservation', async context => {
  const { monitor, provider, dataPath } = fixture(context)
  provider.add(first, '作品第一季', [episode1])
  provider.add(second, '作品第二季')
  provider.add(third, '作品第二季', [episode3])
  const entry = provider.entries.get(first)!
  entry.seasons = [{ id: second, title: '作品第二季', index: 2 }]
  await monitor.follow(first)
  entry.seasonCount = 3
  entry.seasons = [{ id: third, title: '作品第二季', episodeCount: 1 }]
  await monitor.checkNow()
  assert.match(monitor.snapshot().watches[0].lastError!, /不完整/)
  provider.add('80002', '另一关联作品', [episode2])
  entry.seasons.push({ id: '80002', title: '另一关联作品', index: 2, episodeCount: 1 })
  await monitor.checkNow()
  assert.match(monitor.snapshot().watches[0].lastError!, /不完整/)
  assert.equal(monitor.snapshot().events.length, 0)
  const db = new Store(dataPath)
  try { assert.ok(db.watch(first)!.seasons[second].awaitingPremiere) }
  finally { db.close() }
})

test('16 seasons: poll the latest release, all pending seasons and both directions of count mismatch once per cycle', async context => {
  const { monitor, provider, dataPath, notices } = fixture(context)
  const rows: SeasonCard[] = Array.from({ length: 16 }, (_, i) => {
    const id = String(80001 + i)
    const count = i === 13 ? 202 : i < 13 ? 1 : undefined
    const title = `万妖图录传 第 ${i + 1} 季`
    provider.add(id, title, Array.from({ length: count ?? 0 }, (_, j) => `${id}${1000 + j}`))
    return { id, title, index: i + 1, episodeCount: count }
  })
  const root = rows[0].id
  const [older, current, reserved15, reserved16] = [rows[1], rows[13], rows[14], rows[15]]
  provider.entries.get(root)!.seasons = rows
  await monitor.follow(root)
  const watch = () => monitor.snapshot().watches[0]
  assert.deepEqual(watch().reservationSeasons?.map(s => s.index), [15, 16])
  async function check(expected: SeasonCard[], instance = monitor, singleWork = false): Promise<void> {
    provider.directoryCalls.length = provider.inspections.length = provider.episodeCalls.length = 0
    await instance.checkNow(singleWork ? root : undefined)
    assert.deepEqual(provider.directoryCalls, [root])
    assert.deepEqual(provider.inspections, [])
    assert.deepEqual(provider.episodeCalls, expected.map(row => row.id))
  }
  const active = [current, reserved15, reserved16]
  await check(active)
  await check(active)
  assert.equal(notices.length, 0)

  // The latest release gains an episode without a directory change; the next run must not repeat the alert.
  provider.episodes.get(current.id)!.push('90001')
  await check(active)
  assert.equal(monitor.snapshot().events[0].seriesId, current.id)
  assert.match(monitor.snapshot().events[0].message, /新增 1 集，现有 203 集/)
  current.episodeCount = 203
  older.episodeCount = 2
  await check([older, ...active])
  await check([older, ...active])
  older.episodeCount = 0
  await check([older, ...active])
  assert.equal(watch().lastError, undefined)
  assert.equal(notices.length, 1)
  older.episodeCount = 1

  // Directory still says both are reservable; 16 premieres before 15.
  provider.episodes.set(reserved16.id, ['90002', '90003'])
  await check(active)
  assert.deepEqual(watch().reservationSeasons?.map(s => s.index), [15])
  assert.equal(monitor.snapshot().events[0].seriesId, reserved16.id)
  assert.match(monitor.snapshot().events[0].message, /新增 2 集/)
  reserved16.episodeCount = 2
  const reopened = new Monitor(dataPath, () => {}, () => assert.fail('the persisted baseline must suppress duplicate updates'), provider)
  try { await check([reserved15, reserved16], reopened) } finally { reopened.dispose() }
  provider.episodes.set(reserved15.id, ['90004'])
  await check([reserved15, reserved16])
  assert.deepEqual(watch().reservationSeasons, [])
  reserved15.episodeCount = 1
  await check([reserved16])
  assert.equal(notices.length, 3)

  const next = { id: '80017', title: '万妖图录传 第 17 季', index: 17 }
  provider.add(next.id, next.title)
  rows.push(next)
  await check([reserved16, next])
  await check([reserved16, next])
  assert.deepEqual(watch().reservationSeasons?.map(s => s.index), [17])
  assert.equal(monitor.snapshot().events.filter(e => e.seriesId === next.id && e.kind === 'season').length, 1)

  provider.directoryFailures.set(root, Object.assign(new Error(), { code: 'RATE_LIMITED' }))
  await check([])
  assert.match(watch().lastError!, /请求频率/)
  provider.directoryFailures.clear()
  await check(rows, monitor, true)
  assert.equal(watch().lastError, undefined)
  assert.equal(notices.length, 4)
})

for (const count of [69, 113]) {
  test(`a persistent ${count + 1}/${count} discrepancy is checked every time, without treating the directory count as an episode`, async context => {
    const { monitor, provider, notices } = fixture(context)
    const ids = Array.from({length: count}, (_, i) => String(90000 + i))
    provider.add(first, '作品第一季', ids)
    provider.add(second, '作品第二季', [episode1])
    const directory = provider.entries.get(first)!
    directory.count = count + 1
    directory.seasons = [{id: second, title: '作品第二季', index: 2, episodeCount: 1}]
    await monitor.follow(first)
    for (let i = 0; i < 2; i++) {
      provider.episodeCalls.length = 0
      await monitor.checkNow()
      assert.deepEqual(provider.episodeCalls, [first, second])
      const [watch] = monitor.snapshot().watches
      assert.equal(watch.series.episodeCount, count)
      assert.equal(watch.lastError, undefined)
      assert.equal(notices.length, 0)
    }
    provider.episodes.set(first, [...ids.slice(1), episode2])
    await monitor.checkNow()
    assert.match(monitor.snapshot().watches[0].lastError!, /缺少已收录的 1 个分集编号/)
    assert.equal(notices.length, 0)
    provider.episodes.set(first, [...ids, episode2])
    await monitor.checkNow()
    assert.match(monitor.snapshot().events[0].message, new RegExp(`新增 1 集，现有 ${count + 1} 集`))
    assert.equal(monitor.snapshot().watches[0].lastError, undefined)
    provider.episodeCalls.length = 0
    await monitor.checkNow()
    assert.deepEqual(provider.episodeCalls, [second])
    assert.equal(notices.length, 1)
  })
}

test('the visible root episode count follows validated episodes, retaining it when later metadata is unverified', async (context) => {
  const { monitor, provider } = fixture(context)
  provider.add(first, '作品一', [episode1])
  await monitor.follow(first)
  // Metadata is still 1, but the full list already contains the second episode.
  provider.episodes.set(first, [episode1, episode2])
  await monitor.checkNow()
  assert.equal(monitor.snapshot().watches[0].series.episodeCount, 2)
  assert.equal(monitor.snapshot().events.length, 1)

  provider.entries.get(first)!.count = 3
  provider.episodes.set(first, [])
  await monitor.checkNow()
  assert.equal(monitor.snapshot().watches[0].series.episodeCount, 2)
  assert.equal(monitor.snapshot().watches[0].knownEpisodeCount, 2)
  assert.ok(monitor.snapshot().watches[0].lastError)
})
