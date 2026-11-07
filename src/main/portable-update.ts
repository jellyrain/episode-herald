import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app } from 'electron'

const feed = 'https://github.com/jellyrain/episode-herald/releases/latest/download/'
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
interface Package { version: string; file: string; bytes: number; sha512: string }

async function response(name: string, timeout: number): Promise<Response> {
  // Use a version tag for the ZIP so that publishing another Latest during a download is safe.
  const result = await fetch(name, { signal: AbortSignal.timeout(timeout) })
  if (!result.ok || !result.body || !result.url.startsWith('https://')) throw new Error('更新服务暂时不可用。')
  return result
}

export async function nextPortable(current: string): Promise<Package | null> {
  const result = await response(feed + 'latest-portable.json', 30_000)
  const reader = result.body!.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > 16_384) throw new Error('更新清单过大。')
      chunks.push(Buffer.from(value))
    }
  } finally { await reader.cancel() }
  const info: Package = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!info || typeof info.version !== 'string' || !stable.test(info.version) ||
      info.file !== `episode-herald-${info.version}-win-x64-portable.zip` ||
      !Number.isSafeInteger(info.bytes) || info.bytes < 1 || info.bytes > 2 ** 31 ||
      typeof info.sha512 !== 'string' || !/^[a-f0-9]{128}$/.test(info.sha512)) throw new Error('免安装版更新清单无效。')
  const installed = current.split('.').map(BigInt)
  const next = info.version.split('.').map(BigInt)
  const part = next.findIndex((value, i) => value !== installed[i])
  return part >= 0 && next[part] > installed[part] ? info : null
}

async function digest(file: string): Promise<string> {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function downloadPortable(info: Package, cache: string, progress: (percent: number) => void): Promise<string> {
  const archive = join(cache, info.file)
  const previous = await stat(archive).catch(() => null)
  if (previous?.size === info.bytes && await digest(archive) === info.sha512) return archive
  const url = `https://github.com/jellyrain/episode-herald/releases/download/v${info.version}/${info.file}`
  const result = await response(url, 30 * 60_000)
  const temporary = join(cache, randomUUID() + '.partial')
  const hash = createHash('sha512')
  let bytes = 0
  try {
    const file = await open(temporary, 'wx')
    const reader = result.body!.getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.length
        if (bytes > info.bytes) throw new Error('下载长度异常。')
        hash.update(value)
        await file.writeFile(value)
        progress(Math.floor(100 * bytes / info.bytes))
      }
      if (bytes !== info.bytes || hash.digest('hex') !== info.sha512) throw new Error('更新校验失败。')
      await file.sync()
    } finally { await file.close(); await reader.cancel() }
    await rename(temporary, archive)
    return archive
  } finally { await rm(temporary, { force: true }) }
}

export async function installPortable(info: Package, archive: string, cache: string): Promise<void> {
  const work = await mkdtemp(join(cache, 'p-'))
  const helper = join(work, 'install.ps1')
  const config = join(work, 'install.json')
  const ready = join(work, 'ready')
  const result = join(cache, 'portable-result.json')
  await copyFile(join(process.resourcesPath, 'app.asar.unpacked/resources/updater/portable-install.ps1'), helper)
  await writeFile(config, JSON.stringify({ pid: process.pid, directory: dirname(process.execPath),
    executable: basename(process.execPath), archive, root: 'episode-herald', version: info.version, sha512: info.sha512, ready, result }))
  const worker = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Config', config, '-Launch'],
    { windowsHide: true, stdio: 'ignore' })
  let failure: Error | undefined
  worker.on('error', error => { failure = error })
  for (let i = 0; i < 600; i++) {
    if (await readFile(ready, 'utf8').catch(() => '') === 'ready') {
      worker.unref()
      app.quit()
      return
    }
    if (failure || worker.exitCode !== null) break
    await delay(100)
  }
  worker.kill()
  throw failure ?? new Error('未能准备免安装更新，请重新检查。')
}
