import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Monitor, type MonitorProvider } from '../src/main/monitor'
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
  readonly inspections: string[] = []
  beforeEpisodes?: () => Promise<void>

  add(id: string, title: string, ids: string[] = []): void {
    this.entries.set(id, { title, count: ids.length, seasons: [] })
    this.episodes.set(id, ids)
  }

  async browse(): Promise<BrowsePage> { return { items: [], hasMore: false } }
  async filters(): Promise<FilterRow[]> { return [] }
  async details(id: string): Promise<SeriesDetails> { return this.inspect(id) }

  async inspect(id: string, includeSeasons = true): Promise<Inspection> {
    this.inspections.push(id)
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
  provider.episodes.set(second, [episode2])
  await monitor.checkNow()
  provider.entries.get(second)!.count = 2
  provider.episodes.set(second, [episode2, episode3])
  await monitor.checkNow()
  assert.equal(monitor.snapshot().events.filter((event) => event.kind === 'episodes').length, 2)
  assert.equal(monitor.snapshot().watches[0].knownEpisodeCount, 3)
})

test('a missing season remains monitored, while disabling related-season monitoring checks only the followed season', async (context) => {
  const { monitor, provider } = fixture(context)
  provider.add(first, '第一季', [episode1])
  provider.add(second, '第二季', [episode2])
  provider.entries.get(first)!.seasons = [{ id: second, title: '第二季', index: 2, episodeCount: 1 }]
  await monitor.follow(first)
  provider.entries.get(first)!.seasons = []
  provider.entries.get(second)!.count = 2
  provider.episodes.set(second, [episode2, episode3])
  await monitor.checkNow()
  assert.equal(monitor.snapshot().watches[0].seasonCount, 2)
  assert.match(monitor.snapshot().watches[0].lastError!, /关联季列表不完整/)
  assert.equal(monitor.snapshot().events[0].seriesId, second)

  monitor.updateWatch(first, { watchSeasons: false })
  provider.inspections.length = 0
  await monitor.checkNow()
  assert.deepEqual(provider.inspections, [first])
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
  await monitor.checkNow()
  assert.equal(monitor.snapshot().events.length, 1)
  assert.equal(monitor.snapshot().watches[0].lastError, undefined)
  provider.failures.clear()
  // The upstream count can stay omitted even after episodes become available.
  provider.episodes.set(second, [episode2, episode3])
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
  provider.add(second, '第二季')
  provider.entries.get(second)!.count = undefined
  provider.entries.get(first)!.seasons = [{ id: second, title: '第二季' }]
  await monitor.follow(first)
  assert.equal(monitor.snapshot().watches[0].baselineReady, false)
  provider.episodes.set(second, [episode2, episode3])
  await monitor.checkNow()
  assert.equal(monitor.snapshot().watches[0].baselineReady, true)
  assert.equal(monitor.snapshot().events.length, 0)
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
