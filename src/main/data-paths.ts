import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'

function localDirectory(path: string): string {
  const resolved = resolve(path)
  let ancestor = resolved
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor)
  if (process.platform === 'win32' && [resolved, realpathSync.native(ancestor)].some(p => /^c:[\\/]/i.test(p))) {
    throw new Error('请将追更小报放在 C 盘以外的可写目录，再启动程序。')
  }
  mkdirSync(resolved, { recursive: true })
  return resolved
}

export function configureDataPaths(): { data: string; oldAppData: string } {
  const oldAppData = app.getPath('appData')
  const data = localDirectory(app.isPackaged ? join(dirname(process.execPath), 'data')
    : process.env.HONGGUO_DATA_DIR || join(app.getAppPath(), '.local-data'))
  app.setPath('appData', data)
  app.setPath('userData', data)
  app.setPath('sessionData', localDirectory(join(data, 'chromium')))
  app.setAppLogsPath(localDirectory(join(data, 'logs')))
  app.setPath('crashDumps', localDirectory(join(data, 'crashes')))
  const temp = localDirectory(join(data, 'temp'))
  app.setPath('temp', temp)
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = temp
  localDirectory(join(data, 'update-cache'))
  return { data, oldAppData }
}

// Read v1.0.0 files without opening the old database for writing. Replay its WAL
// on a local copy. The database is published last so a failed import can retry.
export function importInstalledData(parent: string, target: string): void {
  const name = 'hongguo.sqlite'
  if (existsSync(join(target, name))) return
  const source = ['episode-herald', 'hongguo-list', '红果追更'].map(n => join(parent, n))
    .find(path => existsSync(join(path, name)))
  if (!source) return
  const stage = mkdtempSync(join(target, '.import-'))
  const files = [name, name + '-wal']
  const fingerprint = (): string => files.map(file => {
    const info = statSync(join(source, file), { throwIfNoEntry: false, bigint: true })
    return info ? `${info.size}:${info.mtimeNs}:${info.ino}` : '-'
  }).join('/')
  try {
    const before = fingerprint()
    for (const file of files) {
      if (existsSync(join(source, file))) cpSync(join(source, file), join(stage, file))
    }
    if (before !== fingerprint()) throw new Error('旧版正在写入数据，请退出旧版后重试。')
    const db = new DatabaseSync(join(stage, name))
    try {
      if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('旧数据库校验失败。')
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally { db.close() }
    for (const file of ['anonymous.json', 'covers']) {
      if (existsSync(join(source, file))) cpSync(join(source, file), join(target, file), { recursive: true, force: false })
    }
    renameSync(join(stage, name), join(target, name))
  } finally { rmSync(stage, { recursive: true, force: true }) }
}
