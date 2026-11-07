import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { AppCache } from '../src/main/cache'

async function fixture(t: TestContext): Promise<{
  data: string; root: string; folder: string; cache: AppCache
  put(file: string, content?: string): Promise<string>
  job(name: string, version: string): Promise<string>
  setBusy(value: boolean): void
}> {
  const folder = await mkdtemp(join(__dirname, 'cache-test-'))
  assert.equal(dirname(folder), __dirname)
  t.after(() => rm(folder, { recursive: true, force: true }))
  const data = join(folder, 'data')
  const root = join(data, 'update-cache')
  let web = 19
  let busy = false
  const cache = new AppCache(data, '1.10.0', () => busy, {
    getCacheSize: async () => web,
    clearCache: async () => { web = 0 }
  })
  async function put(file: string, content = 'obsolete'): Promise<string> {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
    return file
  }
  async function job(name: string, version: string): Promise<string> {
    const dir = join(root, 'p-' + name)
    await put(join(dir, 'install.json'), JSON.stringify({ root: 'episode-herald', executable: 'episode-herald.exe', version }))
    await put(join(dir, 'ready'), 'ready')
    await mkdir(join(dir, 'new', 'episode-herald'), { recursive: true })
    return put(join(dir, 'previous', 'resources', 'app.asar'))
  }
  return { data, root, folder, cache, put, job, setBusy: (value: boolean): void => { busy = value } }
}

test('reclaims legacy completed backups, consumed archives and thumbnails with accurate byte totals', async t => {
  const { root, data, cache, put, job } = await fixture(t)
  const olderBackup = await job('abc123', '1.9.0')
  const latestBackup = await job('next01', '1.10.0')
  const pending = join(root, 'episode-herald-updater', 'pending')
  await put(join(root, 'portable-result.json'), JSON.stringify({ ok: true, version: '1.10.0', backup: join(root,'p-next01','previous') }))
  const obsolete = [olderBackup, latestBackup, await put(join(root, 'episode-herald-1.9.0-win-x64-portable.zip')),
    await put(join(pending, 'episode-herald-1.10.0-setup.exe')), await put(join(root, 'episode-herald-updater', 'installer.exe'))]
  const cover = await put(join(data, 'covers', 'a'.repeat(64) + '.thumb'))
  const keep = [await put(join(root, 'episode-herald-1.11.0-win-x64-portable.zip')),
    await put(join(pending, 'episode-herald-1.11.0-setup.exe')), await put(join(pending, 'update-info.json')),
    await put(join(data, 'hongguo.sqlite')), await put(join(data, 'anonymous.json')), await put(join(data, 'temp', 'in-use')),
    await put(join(root, 'user.zip')), await put(join(data, 'covers', 'working.tmp'))]
  const before = await cache.usage()
  assert.deepEqual(before, { updates: 8 * obsolete.length, covers: 8, web: 19, updatesBusy: false, skipped: 0 })
  assert.ok(obsolete.every(file => existsSync(file)))
  const first = cache.clear()
  assert.equal(cache.clear(), first)
  const after = await first
  assert.equal(after.freed, before.updates + before.web + before.covers)
  assert.equal(after.skipped, 0)
  assert.deepEqual(after.usage, { updates: 0, covers: 0, web: 0, skipped: 0, updatesBusy: false })
  assert.ok([cover, ...obsolete].every(file => !existsSync(file)))
  assert.ok(keep.every(file => existsSync(file)))
  assert.equal((await cache.clear()).freed, 0)
})

test('keeps active updater files, incomplete swaps, failed recovery and unrecognized workdirs', async t => {
  const { root, cache, put, job, setBusy } = await fixture(t)
  const failed = await job('failed', '1.9.0')
  await put(join(root,'portable-result.json'), JSON.stringify({ ok:false, backup:join(root,'p-failed','previous') }))
  const incomplete = await job('middle', '1.8.0')
  await put(join(root,'p-middle','new','episode-herald','remaining'))
  const current = await job('active','1.10.0')
  const unknown = await put(join(root,'p-random','previous','keep'))
  const nsis = await put(join(root,'episode-herald-updater','installer.exe'))
  const partial = await put(join(root,'12345678-1234-1234-1234-123456789abc.partial'))
  const oldZip = await put(join(root,'episode-herald-1.9.0-win-x64-portable.zip'))
  setBusy(true)
  assert.equal((await cache.usage()).updates,8)
  assert.equal((await cache.clear()).freed,8 + 19)
  assert.ok(!existsSync(oldZip) && existsSync(nsis) && existsSync(partial))
  setBusy(false)
  assert.equal((await cache.clear()).freed,16)
  assert.ok([failed, incomplete, current, unknown].every(file => existsSync(file)))
})

test('ignores directory links instead of following them into unrelated data', async t => {
  const { root, data, folder, cache, put } = await fixture(t)
  const external = join(folder, 'external')
  const cover = await put(join(external, 'a'.repeat(64) + '.thumb'))
  const setup = await put(join(external, 'installer.exe'))
  await mkdir(root, { recursive: true })
  await symlink(external, join(data,'covers'), 'junction')
  await symlink(external, join(root,'episode-herald-updater'), 'junction')
  assert.equal((await cache.clear()).freed,19)
  assert.ok(existsSync(cover) && existsSync(setup))
})
