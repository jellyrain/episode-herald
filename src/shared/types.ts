export type Result<T> = { ok: true; value: T } | { ok: false; error: string }
export type ThemeMode = 'dark' | 'light'
export type BrowseMode = 'discover' | 'search' | 'rank' | 'filter'

export interface SeriesCard {
  id: string
  title: string
  description?: string
  coverUrl?: string
  episodeCount?: number
  status?: 'ongoing' | 'completed' | 'unknown'
  tags: string[]
  note?: string
}

export interface SeasonCard {
  id: string
  title: string
  index?: number
  episodeCount?: number
}

export interface SeriesDetails {
  series: SeriesCard
  seasons: SeasonCard[]
  seasonWarning?: string
}

export interface FilterRow {
  key: string
  name: string
  options: { name: string; value: string }[]
}

export interface RankContent {
  id: string
  name: string
  boards: { id: string; name: string }[]
}

export interface BrowseQuery {
  mode: BrowseMode
  query?: string
  cursor?: string
  genre?: string
  selections?: Record<string, string[]>
  content?: string
  board?: string
}

export interface BrowsePage {
  items: SeriesCard[]
  cursor?: string
  hasMore: boolean
  contents?: RankContent[]
  content?: string
  board?: string
}

export interface WatchItem {
  id: string
  series: SeriesCard
  paused: boolean
  watchSeasons: boolean
  addedAt: string
  lastCheckedAt?: string
  lastCheckWasBaseline?: boolean
  lastError?: string
  baselineReady: boolean
  seasonCount: number
  knownEpisodeCount: number
}

export interface UpdateEvent {
  id: string
  watchId: string
  seriesId: string
  title: string
  kind: 'episodes' | 'season'
  message: string
  createdAt: string
  read: boolean
}

export interface Settings {
  theme: ThemeMode
  autoCheck: boolean
  checkTime: string
  desktopNotifications: boolean
  closeToTray: boolean
}

export interface Snapshot {
  watches: WatchItem[]
  events: UpdateEvent[]
  settings: Settings
  checking: boolean
  lastCheckAt?: string
  nextCheckAt?: string
  lastCheckSummary?: string
  dataPath: string
}

export interface AppUpdate {
  phase: 'development' | 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'installing' | 'error'
  portable: boolean
  currentVersion: string
  version?: string
  percent?: number
}

export interface HongguoAPI {
  appUpdateStatus(): Promise<Result<AppUpdate>>
  checkAppUpdate(): Promise<Result<AppUpdate>>
  installAppUpdate(): Promise<Result<void>>
  onAppUpdate(listener: (update: AppUpdate) => void): () => void
  snapshot(): Promise<Result<Snapshot>>
  browse(query: BrowseQuery): Promise<Result<BrowsePage>>
  filters(genre: string): Promise<Result<FilterRow[]>>
  details(id: string): Promise<Result<SeriesDetails>>
  follow(id: string): Promise<Result<Snapshot>>
  updateWatch(id: string, changes: { paused?: boolean; watchSeasons?: boolean }): Promise<Result<Snapshot>>
  removeWatch(id: string): Promise<Result<Snapshot>>
  checkNow(id?: string): Promise<Result<Snapshot>>
  markRead(): Promise<Result<Snapshot>>
  saveSettings(settings: Settings): Promise<Result<Snapshot>>
  onChanged(listener: () => void): () => void
  windowAction(action: 'minimize' | 'maximize' | 'close'): void
}
