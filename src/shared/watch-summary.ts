import type { SeasonCard, UpdateEvent, WatchItem } from './types'

export function upcomingSeasonIds(seasons: SeasonCard[], previouslyPublished: (id: string) => boolean = () => false): Set<string> {
  const released = seasons.filter(s => s.published || (s.episodeCount ?? 0) > 0 || previouslyPublished(s.id))
  const lastPublished = Math.max(0, ...released.map(s => s.index ?? 0))
  return new Set(lastPublished > 0 ? seasons.filter(s => (s.index ?? 0) > lastPublished).map(s => s.id) : [])
}

export function watchSummary(watch: WatchItem, history: UpdateEvent[]) {
  // Store.events() is newest first. A re-follow starts a new baseline.
  const events = history.filter(event => event.watchId === watch.id && event.createdAt >= watch.addedAt)
  const unread = events.filter(event => !event.read)
  const latestCheckEvent = events.find(event => event.createdAt === watch.lastCheckedAt)
  const highlight = unread[0] ?? latestCheckEvent
  let result = '本次无更新'
  if (watch.lastError) result = '检查未完成'
  else if (!watch.lastCheckedAt) result = '等待首次检查'
  else if (latestCheckEvent) result = '本次发现更新'
  else if (watch.watchSeasons && watch.reservationSeasons?.length) {
    const seasons = watch.reservationSeasons
    result = seasons.length === 1 ? `第 ${seasons[0].index} 季可预约` : `${seasons.length} 季可预约`
  }
  else if (!watch.baselineReady) result = '等待完整进度'
  else if (watch.lastCheckWasBaseline) result = '已记录初始进度'
  return { result, highlight, unread: unread.length }
}
