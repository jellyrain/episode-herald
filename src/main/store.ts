import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SeasonCard, Settings, UpdateEvent, WatchItem } from '../shared/types'

export interface SeasonState extends SeasonCard {
  awaitingPremiere?: boolean
  episodeIds: string[]
  baselineReady: boolean
  /** Discovered after the initial complete season list, but not yet confirmed in a complete response. */
  seasonNoticePending?: boolean
  /** A later-discovered season may have no published episode metadata yet. */
  firstEpisodesPending?: boolean
}

export interface WatchRecord {
  item: WatchItem
  seasons: Record<string, SeasonState>
  seasonBaselineReady: boolean
}

export interface CheckState {
  lastCheckAt?: string
  lastCheckSummary?: string
}

export const defaultSettings: Settings = {
  theme: 'dark',
  autoCheck: true,
  checkTime: '09:00',
  desktopNotifications: true,
  closeToTray: true
}

export class Store {
  private readonly db: DatabaseSync

  constructor(readonly dataPath: string) {
    mkdirSync(dataPath, { recursive: true })
    this.db = new DatabaseSync(join(dataPath, 'hongguo.sqlite'))
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
    if (version > 1) {
      this.db.close()
      throw new Error('This database was created by a newer application version.')
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS watches (
        id TEXT PRIMARY KEY,
        added_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS preferences (
        key TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `)
  }

  watches(): WatchRecord[] {
    return this.db.prepare('SELECT payload FROM watches ORDER BY added_at DESC').all()
      .map((row) => JSON.parse(String(row.payload)) as WatchRecord)
  }

  watch(id: string): WatchRecord | undefined {
    const row = this.db.prepare('SELECT payload FROM watches WHERE id = ?').get(id)
    return row ? JSON.parse(String(row.payload)) as WatchRecord : undefined
  }

  saveWatch(record: WatchRecord): void {
    this.db.prepare('INSERT INTO watches (id, added_at, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload')
      .run(record.item.id, record.item.addedAt, JSON.stringify(record))
  }

  removeWatch(id: string): void {
    this.db.prepare('DELETE FROM watches WHERE id = ?').run(id)
  }

  events(): UpdateEvent[] {
    return this.db.prepare('SELECT payload FROM events ORDER BY created_at DESC, rowid DESC').all()
      .map((row) => JSON.parse(String(row.payload)) as UpdateEvent)
  }

  private preference<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT payload FROM preferences WHERE key = ?').get(key)
    return row ? JSON.parse(String(row.payload)) as T : fallback
  }

  private setPreference(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO preferences (key, payload) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload')
      .run(key, JSON.stringify(value))
  }

  settings(): Settings {
    return { ...defaultSettings, ...this.preference<Partial<Settings>>('settings', {}) }
  }

  saveSettings(settings: Settings): void {
    this.setPreference('settings', settings)
  }

  checkState(): CheckState {
    return this.preference<CheckState>('checkState', {})
  }

  saveCheckState(state: CheckState): void {
    this.setPreference('checkState', state)
  }

  /** Snapshots and their notifications advance together, including across a crash. */
  commitCheck(record: WatchRecord, events: UpdateEvent[]): void {
    this.transaction(() => {
      this.saveWatch(record)
      const insert = this.db.prepare('INSERT OR IGNORE INTO events (id, created_at, payload) VALUES (?, ?, ?)')
      for (const event of events) insert.run(event.id, event.createdAt, JSON.stringify(event))
    })
  }

  markRead(): void {
    this.transaction(() => {
      const update = this.db.prepare('UPDATE events SET payload = ? WHERE id = ?')
      for (const event of this.events()) {
        if (!event.read) update.run(JSON.stringify({ ...event, read: true }), event.id)
      }
    })
  }

  private transaction(operation: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      operation()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.db.close()
  }
}
