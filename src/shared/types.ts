export type Result<T> = { ok: true; value: T } | { ok: false; error: string }
export type ThemeMode = 'dark' | 'light'
export type WatchView = 'list' | 'grid'
export interface ImportSummary { watches: number; events: number; view: WatchView }
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
  heat?: number
}

export interface SimilarSeries {
  series: SeriesCard
  matchedTags: string[]
}

export interface OriginalNovel {
  bookId?: string
  title?: string
  shortTitle?: string
  coverUrl?: string
  statusLabel?: string
  reads?: number
  showAtEpisode?: number
  tags: string[]
}

export interface SeriesDetails {
  series: SeriesCard
  seasons: SeasonCard[]
  /** The catalogue returned its declared number of distinct rows, including the selected work. */
  directoryComplete?: boolean
  seasonWarning?: string
  originalNovel?: OriginalNovel
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
  reservationSeasons?: Pick<SeasonCard, 'id' | 'index'>[]
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

export interface QqPushConfig {
  enabled: boolean
  endpoint: string
  targetType: 'private' | 'group'
  targetId: string
}
export interface QqPushDraft extends QqPushConfig {
  /** Omitted keeps the saved token; an empty string clears it. */
  token?: string
}
export type DeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'unknown' | 'skipped'
export interface PushDelivery {
  id: string
  title: string
  body: string
  recipient: string
  createdAt: string
  status: DeliveryStatus
  detail: string
}
export interface PushPanel {
  qq: QqPushConfig & { hasToken: boolean }
  deliveries: PushDelivery[]
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

export interface CacheUsage {
  updates: number
  covers: number
  web: number
  updatesBusy: boolean
  skipped: number
}

export interface CacheCleanup {
  freed: number
  skipped: number
  usage: CacheUsage
}

export interface HongguoAPI {
  exportBackup(password: string, view: WatchView): Promise<Result<string | null>>
  importBackup(password: string): Promise<Result<ImportSummary | null>>
  cacheUsage(): Promise<Result<CacheUsage>>
  clearCache(): Promise<Result<CacheCleanup>>
  pushPanel(): Promise<Result<PushPanel>>
  saveQqPush(config: QqPushDraft): Promise<Result<PushPanel>>
  checkQqConnection(): Promise<Result<string>>
  testQqPush(): Promise<Result<PushPanel>>
  retryQqPush(id: string): Promise<Result<PushPanel>>
  onPushChanged(listener: () => void): () => void
  appUpdateStatus(): Promise<Result<AppUpdate>>
  checkAppUpdate(): Promise<Result<AppUpdate>>
  installAppUpdate(): Promise<Result<void>>
  onAppUpdate(listener: (update: AppUpdate) => void): () => void
  snapshot(): Promise<Result<Snapshot>>
  browse(query: BrowseQuery): Promise<Result<BrowsePage>>
  searchCovers(ids: string[]): Promise<Result<Record<string, string>>>
  filters(genre: string): Promise<Result<FilterRow[]>>
  details(id: string): Promise<Result<SeriesDetails>>
  similarSeries(id: string): Promise<Result<SimilarSeries[]>>
  seasonHeat(id: string): Promise<Result<number | null>>
  follow(id: string): Promise<Result<Snapshot>>
  updateWatch(id: string, changes: { paused?: boolean; watchSeasons?: boolean }): Promise<Result<Snapshot>>
  removeWatch(id: string): Promise<Result<Snapshot>>
  checkNow(id?: string): Promise<Result<Snapshot>>
  markRead(): Promise<Result<Snapshot>>
  saveSettings(settings: Settings): Promise<Result<Snapshot>>
  onChanged(listener: () => void): () => void
  windowAction(action: 'minimize' | 'maximize' | 'close'): void
}
