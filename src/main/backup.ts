import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import type { QqPushConfig, WatchView } from '../shared/types'
import type { BackupRecords, Store } from './store'
import { normalizeQq, type TokenStorage } from './qq-push'
import { UserFacingError } from './provider'

// Version 1: magic | 16-byte salt | 12-byte IV | 16-byte GCM tag | encrypted UTF-8 JSON.
const magic = Buffer.from('EpisodeHerald\x00\x01')
const maxBytes = 192 * 1024 * 1024
const thumb = /^[a-f0-9]{64}\.thumb$/
function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((accept, reject) => scrypt(password, salt, 32,
    { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
    (error, key) => error ? reject(error) : accept(key)))
}

interface BackupData extends BackupRecords {
  view: WatchView
  qq: QqPushConfig & { token: string }
  covers: Record<string, string>
}

const object = (value: unknown): boolean => !!value && typeof value === 'object' && !Array.isArray(value)
const string = (value: unknown): value is string => typeof value === 'string'
const id = (value: unknown): boolean => string(value) && /^\d{5,30}$/.test(value)
const date = (value: unknown): boolean => string(value) && Number.isFinite(Date.parse(value))
const count = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const bool = (value: unknown): boolean => typeof value === 'boolean'
const optional = (value: unknown, check: (v: unknown) => boolean): boolean => value === undefined || check(value)

function valid(data: BackupData): boolean {
  if (!object(data) || !['list', 'grid'].includes(data.view) || !object(data.settings) ||
      !object(data.checkState) || !object(data.covers) || !object(data.qq) || !string(data.qq.token)) return false
  const s = data.settings
  if (!['light', 'dark'].includes(s.theme) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.checkTime) ||
      ![s.autoCheck, s.desktopNotifications, s.closeToTray].every(bool) ||
      !optional(data.checkState.lastCheckAt, date) || !optional(data.checkState.lastCheckSummary, string)) return false
  if (!Array.isArray(data.watches) || !data.watches.every(({ item, seasons, seasonBaselineReady }) =>
    object(item) && object(seasons) && bool(seasonBaselineReady) && id(item.id) && item.series.id === item.id &&
    string(item.series.title) && Array.isArray(item.series.tags) && item.series.tags.every(string) &&
    [item.series.description, item.series.coverUrl, item.series.note, item.lastError].every(v => optional(v, string)) &&
    optional(item.series.episodeCount, count) && date(item.addedAt) && optional(item.lastCheckedAt, date) &&
    [item.paused, item.watchSeasons, item.baselineReady].every(bool) && [item.seasonCount, item.knownEpisodeCount].every(count) &&
    Object.entries(seasons).every(([key, row]) => id(key) && key === row.id && string(row.title) &&
      bool(row.baselineReady) && optional(row.episodeCount, count) && optional(row.index, count) &&
      [row.awaitingPremiere, row.firstEpisodesPending, row.seasonNoticePending, row.missingFromDirectory].every(v => optional(v, bool)) &&
      Array.isArray(row.episodeIds) && row.episodeIds.every(id)))) return false
  if (!Array.isArray(data.events) || !data.events.every(e => string(e.id) && id(e.watchId) && id(e.seriesId) &&
    string(e.title) && string(e.message) && date(e.createdAt) && bool(e.read) && ['episodes', 'season'].includes(e.kind))) return false
  if (!Array.isArray(data.deliveries) || !data.deliveries.every(d =>
    [d.id, d.title, d.body, d.recipient, d.route, d.detail].every(string) && date(d.createdAt) &&
    ['sent','failed','unknown','skipped','pending','sending'].includes(d.status))) return false
  if (new Set(data.watches.map(w => w.item.id)).size !== data.watches.length ||
      new Set(data.events.map(e => e.id)).size !== data.events.length ||
      new Set(data.deliveries.map(d => d.id)).size !== data.deliveries.length) return false
  return Object.entries(data.covers).every(([name, bytes]) => thumb.test(name) && string(bytes) &&
    bytes.length > 0 && bytes.length <= 6 * 1024 * 1024 && bytes.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(bytes))
}

function checkPassword(value: string): void {
  if (!string(value) || !value.trim() || value.length > 1024) throw new UserFacingError('请输入有效的备份密码。')
}

async function coverFolder(dataPath: string, create: boolean): Promise<string> {
  const dir = join(dataPath, 'covers')
  if (create) await mkdir(dir, { recursive: true })
  if (relative(resolve(dir), await realpath(dir)) !== '' || !(await lstat(dir)).isDirectory()) throw new UserFacingError('封面目录无效。')
  return dir
}

async function collectCovers(dataPath: string): Promise<Record<string, string>> {
  const covers: Record<string, string> = {}
  let total = 0
  try {
    const dir = await coverFolder(dataPath, false)
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !thumb.test(entry.name)) continue
      try {
        const path = join(dir, entry.name)
        const info = await lstat(path)
        if (!info.isFile() || !info.size || info.size > 4 * 1024 * 1024) continue
        total += info.size
        if (total > maxBytes / 2) throw new UserFacingError('封面缓存过大，请先清理缓存再导出。')
        covers[entry.name] = (await readFile(path)).toString('base64')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return covers
}

export async function exportBackup(path: string, password: string, view: WatchView, store: Store, tokens: TokenStorage): Promise<void> {
  checkPassword(password)
  const { cipher, ...config } = store.qqConfig()
  let token = ''
  try { if (cipher) token = tokens.decrypt(cipher) }
  catch { throw new UserFacingError('当前 Windows 账户无法读取 QQ Token，请先在推送页重新保存 Token 再导出。') }
  const records = store.backupRecords()
  const data: BackupData = { ...records, view, qq: { ...config, token }, covers: await collectCovers(store.dataPath) }
  const plain = Buffer.from(JSON.stringify(data))
  if (plain.length + magic.length + 44 > maxBytes) throw new UserFacingError('备份数据过大。')
  const salt = randomBytes(16), iv = randomBytes(12)
  const key = await deriveKey(password, salt)
  const enc = createCipheriv('aes-256-gcm', key, iv)
  enc.setAAD(magic)
  const encrypted = Buffer.concat([enc.update(plain), enc.final()])
  key.fill(0)
  plain.fill(0)
  const temp = join(dirname(path), '.ehbackup-' + randomUUID() + '.tmp')
  try {
    await writeFile(temp, Buffer.concat([magic, salt, iv, enc.getAuthTag(), encrypted]), { flag: 'wx', mode: 0o600 })
    await rename(temp, path)
  } finally { await rm(temp, { force: true }) }
}

export async function readBackup(path: string, password: string): Promise<BackupData> {
  checkPassword(password)
  const file = await open(path, 'r')
  let bytes: Buffer
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size <= magic.length + 44 || stat.size > maxBytes) throw new UserFacingError('备份文件大小无效。')
    bytes = Buffer.allocUnsafe(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) throw new UserFacingError('备份文件不完整。')
      offset += bytesRead
    }
  } finally { await file.close() }
  const pos = magic.length
  if (!bytes.subarray(0, pos).equals(magic)) throw new UserFacingError('无法识别备份格式或版本。')
  const key = await deriveKey(password, bytes.subarray(pos, pos + 16))
  let plain: Buffer
  try {
    const dec = createDecipheriv('aes-256-gcm', key, bytes.subarray(pos + 16, pos + 28))
    dec.setAAD(magic)
    dec.setAuthTag(bytes.subarray(pos + 28, pos + 44))
    plain = Buffer.concat([dec.update(bytes.subarray(pos + 44)), dec.final()])
  } catch { throw new UserFacingError('备份密码不正确，或文件已损坏。') }
  finally { key.fill(0) }
  try {
    const data: BackupData = JSON.parse(plain.toString('utf8'))
    if (!valid(data)) throw Error()
    normalizeQq(data.qq)
    return data
  } catch { throw new UserFacingError('备份中的数据格式无效。') }
  finally { plain.fill(0) }
}

export async function restoreBackup(data: BackupData, store: Store, tokens: TokenStorage, assertIdle: () => void): Promise<void> {
  const { token, ...config } = normalizeQq(data.qq)
  let cipher = ''
  try { if (token) cipher = tokens.encrypt(token) }
  catch { throw new UserFacingError('当前系统无法加密保存 QQ Token，导入已取消。') }
  assertIdle()
  const stage = await mkdtemp(join(store.dataPath, '.restore-'))
  const added: string[] = []
  try {
    const covers = await coverFolder(store.dataPath, true)
    for (const [name, encoded] of Object.entries(data.covers)) {
      const staged = join(stage, name)
      await writeFile(staged, Buffer.from(encoded, 'base64'), { flag: 'wx' })
      const target = join(covers, name)
      try {
        await copyFile(staged, target, constants.COPYFILE_EXCL)
        added.push(target)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    assertIdle()
    store.restoreRecords(data, { ...config, cipher })
  } catch (error) {
    for (const file of added) await unlink(file).catch(() => undefined)
    throw error
  } finally { await rm(stage, { recursive: true, force: true }).catch(() => undefined) }
}
