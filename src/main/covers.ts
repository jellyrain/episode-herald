import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { net } from 'electron'
import { coverAddress } from '../shared/covers'
import { decodeCover } from './decode-cover'

const maxImageBytes = 4 * 1024 * 1024
const maxCacheBytes = 48 * 1024 * 1024
class CoverFailure extends Error {}

function imageType(bytes: Buffer): string | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif'
  if (bytes.toString('ascii', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(bytes.toString('ascii', 8, 12))) return 'image/avif'
  return undefined
}

function cacheKey(source: URL): string {
  // Signatures change between checks. The CDN asset path and transform identify the cover.
  const identity = new URL(source)
  for (const key of ['x-expires', 'x-signature']) identity.searchParams.delete(key)
  return createHash('sha256').update(identity.href).digest('hex')
}

async function downloadCover(source: URL): Promise<Buffer> {
  const response = await net.fetch(source.href, {
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(12_000)
  })
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxImageBytes) {
    await response.body?.cancel()
    throw new CoverFailure(!response.ok ? `封面服务器返回 HTTP ${response.status}` : '封面为空或超过大小限制')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxImageBytes) {
      await reader.cancel()
      throw new CoverFailure('封面超过大小限制')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks, total)
}

export class CoverCache {
  private readonly directory: string
  private readonly errorLog: string
  private logging = false
  private readonly pending = new Map<string, Promise<Buffer>>()
  private readonly waiting: (() => void)[] = []
  private active = 0
  private writes = 0

  constructor(dataPath: string) {
    this.directory = join(dataPath, 'covers')
    this.errorLog = join(dataPath, 'logs', 'cover-error.log')
  }

  async respond(request: Request): Promise<Response> {
    const route = new URL(request.url)
    const source = coverAddress(route.searchParams.get('src') ?? '')
    if (request.method !== 'GET' || route.hostname !== 'poster' || route.pathname !== '/' || !source) {
      return new Response(null, { status: 400 })
    }
    const key = cacheKey(source)
    try {
      let job = this.pending.get(key)
      if (!job) {
        job = this.load(key, source).finally(() => this.pending.delete(key))
        this.pending.set(key, job)
      }
      const bytes = await job
      return new Response(new Uint8Array(bytes), {
        headers: { 'Content-Type': imageType(bytes)!, 'X-Content-Type-Options': 'nosniff' }
      })
    } catch (error) {
      const reason = error instanceof CoverFailure ? error.message
        : String(error).match(/(?:net::)?ERR_[A-Z_]+|TimeoutError/)?.[0] ?? '封面网络请求未完成'
      await this.recordFailure(source, reason)
      return new Response(null, { status: 502 })
    }
  }

  private async recordFailure(source: URL, reason: string): Promise<void> {
    if (this.logging) return
    this.logging = true
    try {
      await writeFile(this.errorLog, `${new Date().toISOString()} ${source.hostname} ${reason}\n`)
    } catch { /* Diagnostics are optional on read-only media. */ }
    finally { this.logging = false }
  }

  private async load(key: string, source: URL): Promise<Buffer> {
    const file = join(this.directory, key + '.thumb')
    try {
      const cached = await readFile(file)
      if (imageType(cached)) return cached
    } catch { /* An unreadable cache entry can be fetched again. */ }
    if (this.active >= 3) await new Promise<void>(resolve => this.waiting.push(resolve))
    else this.active++
    const temp = join(this.directory, randomUUID() + '.tmp')
    try {
      let bytes = await downloadCover(source)
      if (!imageType(bytes)) {
        if (bytes.toString('ascii', 4, 8) !== 'ftyp') throw new CoverFailure('图片服务返回了无法识别的格式')
        try { bytes = await decodeCover(bytes) }
        catch { throw new CoverFailure('已收到图片，但内置解码器未能转换封面') }
      }
      try {
        await mkdir(this.directory, { recursive: true })
        await writeFile(temp, bytes)
        await rename(temp, file)
        if (this.writes++ % 24 === 0) void this.prune().catch(() => undefined)
      } catch { await this.recordFailure(source, '图片已显示，但写入本地封面缓存失败') }
      return bytes
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.active--
      await unlink(temp).catch(() => undefined)
    }
  }

  private async prune(): Promise<void> {
    const entries = (await readdir(this.directory)).filter(name => /^[a-f0-9]{64}\.thumb$/.test(name))
    const files = await Promise.all(entries.map(async name => {
      const path = join(this.directory, name)
      const { size, mtimeMs } = await stat(path)
      return { path, size, mtimeMs }
    }))
    let size = files.reduce((sum, file) => sum + file.size, 0)
    for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (size <= maxCacheBytes) break
      await unlink(file.path)
      size -= file.size
    }
  }
}
