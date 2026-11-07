import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { importInstalledData } from '../src/main/data-paths'

test('import includes committed WAL records and keeps a previously imported local database', t => {
  const root = mkdtempSync(join(__dirname, 'import-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const profile = join(root, 'hongguo-list')
  const local = join(root, 'data')
  mkdirSync(profile)
  mkdirSync(local)
  const source = new DatabaseSync(join(profile, 'hongguo.sqlite'))
  try {
    source.exec("PRAGMA journal_mode=WAL; CREATE TABLE watches(title); INSERT INTO watches VALUES ('first')")
    assert.ok(existsSync(join(profile, 'hongguo.sqlite-wal')))
    importInstalledData(root, local)
    source.exec("INSERT INTO watches VALUES ('later')")
    importInstalledData(root, local)
    const copy = new DatabaseSync(join(local, 'hongguo.sqlite'), { readOnly: true })
    try { assert.deepEqual(copy.prepare('SELECT title FROM watches').all().map(row => row.title), ['first']) }
    finally { copy.close() }
  } finally { source.close() }
})
