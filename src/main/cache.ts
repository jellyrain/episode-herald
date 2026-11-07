import { lstat, readFile, readdir, realpath, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type { CacheCleanup, CacheUsage } from '../shared/types'

type Category = 'updates' | 'covers'
type BrowserCache = { getCacheSize(): Promise<number>; clearCache(): Promise<void> }
const stable = /^\d+\.\d+\.\d+$/

function compareVersion(version: string, installed: string): number {
  if (!stable.test(version) || !stable.test(installed)) return NaN
  const current = installed.split('.').map(BigInt)
  for (const [index, part] of version.split('.').map(BigInt).entries()) {
    if (part !== current[index]) return part < current[index] ? -1 : 1
  }
  return 0
}

// Recheck the canonical path before traversing a directory or removing a file.
// A link anywhere under the data directory must never redirect cleanup elsewhere.
async function plainEntry(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  const info = await lstat(path)
  if (info.isSymbolicLink() || relative(resolve(path), await realpath(path)) !== '') return undefined
  return info
}

async function metadata(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const info = await plainEntry(path)
    if (!info?.isFile() || info.size > 65536) return undefined
    const value = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
    return value && typeof value === 'object' ? value : undefined
  } catch { return undefined }
}

async function finishedBackup(work: string, version: string, report?: Record<string, unknown>): Promise<boolean> {
  const job = await metadata(join(work, 'install.json'))
  if (job?.root !== 'episode-herald' || job.executable !== 'episode-herald.exe' || typeof job.version !== 'string') return false
  const order = compareVersion(job.version, version)
  if (!(order <= 0)) return false
  // Older clients only wrote the last result. Never take a deletion path from that file.
  if (typeof report?.backup === 'string' && basename(dirname(report.backup)) === basename(work) && basename(report.backup) === 'previous') {
    return report.ok === true && report.version === job.version
  }
  // A completed older swap leaves the extracted application directory empty.
  // An unfinished swap or a rollback leaves program files in it.
  const staged = join(work, 'new', 'episode-herald')
  return order < 0 && !!(await plainEntry(join(work, 'ready')))?.isFile() &&
    !!(await plainEntry(staged))?.isDirectory() && (await readdir(staged)).length === 0
}

export class AppCache {
  clearing?: Promise<CacheCleanup>

  constructor(private readonly data: string, private readonly version: string,
    private readonly updatesBusy: () => boolean, private readonly browser: BrowserCache) {}

  async usage(): Promise<CacheUsage> {
    if (this.clearing) return (await this.clearing).usage
    return this.process(false)
  }

  clear(): Promise<CacheCleanup> {
    this.clearing ??= this.cleanup().finally(() => { this.clearing = undefined })
    return this.clearing
  }

  private async cleanup(): Promise<CacheCleanup> {
    const cleared = await this.process(true)
    const usage = await this.process(false)
    return { freed: cleared.updates + cleared.covers + cleared.web, skipped: cleared.skipped, usage }
  }

  private async process(remove: boolean): Promise<CacheUsage> {
    const totals: CacheUsage = { covers: 0, updates: 0, web: 0, skipped: 0, updatesBusy: this.updatesBusy() }
    async function attempt(operation: () => Promise<void>): Promise<void> {
      try { await operation() }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') totals.skipped++ }
    }
    async function entries(path: string): Promise<string[]> {
      return (await plainEntry(path))?.isDirectory() ? readdir(path) : []
    }
    async function visit(path: string, category: Category, tree = false): Promise<void> {
      const info = await plainEntry(path)
      if (info?.isFile()) {
        if (remove) await unlink(path)
        totals[category] += Number(info.size)
      } else if (tree && info?.isDirectory()) {
        for (const name of await readdir(path)) await attempt(() => visit(join(path, name), category, true))
        if (remove) await rmdir(path)
      }
    }
    const covers = join(this.data, 'covers')
    await attempt(async () => {
      for (const name of await entries(covers)) {
        if (/^[a-f\d]{64}\.thumb$/i.test(name)) await attempt(() => visit(join(covers, name), 'covers'))
      }
    })
    const root = join(this.data, 'update-cache')
    await attempt(async () => {
      const report = await metadata(join(root, 'portable-result.json'))
      for (const name of await entries(root)) {
        const path = join(root, name)
        const zip = /^episode-herald-(\d+\.\d+\.\d+)-win-x64-portable\.zip$/.exec(name)
        const abandonedDownload = !totals.updatesBusy && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\.partial$/i.test(name)
        if ((zip && compareVersion(zip[1], this.version) <= 0) || abandonedDownload) {
          await attempt(() => visit(path, 'updates'))
        } else if (/^p-[a-z\d]{6}$/i.test(name)) {
          await attempt(async () => {
            if (await finishedBackup(path, this.version, report)) await visit(join(path, 'previous'), 'updates', true)
          })
        }
      }
      const nsis = join(root, 'episode-herald-updater')
      if (!totals.updatesBusy) {
        for (const name of ['installer.exe', 'current.blockmap']) await attempt(() => visit(join(nsis, name), 'updates'))
      }
      const pending = join(nsis, 'pending')
      for (const name of await entries(pending)) {
        const exe = /^episode-herald-(\d+\.\d+\.\d+)-setup\.exe$/.exec(name)
        const temporary = !totals.updatesBusy && /^(?:[0-2]-)?temp-episode-herald-\d+\.\d+\.\d+-setup\.exe$/.test(name)
        if ((exe && compareVersion(exe[1], this.version) <= 0) || temporary) await attempt(() => visit(join(pending, name), 'updates'))
      }
    })
    await attempt(async () => {
      const before = await this.browser.getCacheSize()
      if (remove) await this.browser.clearCache()
      totals.web = Math.max(0, before - (remove ? await this.browser.getCacheSize() : 0))
    })
    return totals
  }
}
