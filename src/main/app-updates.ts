import { app } from 'electron'
import electronUpdater from 'electron-updater'
import { join } from 'node:path'
import type { AppUpdate } from '../shared/types'
import { downloadPortable, installPortable, nextPortable } from './portable-update'

class InstalledUpdater extends electronUpdater.NsisUpdater {
  constructor(cache: string) {
    super()
    // Supplying a custom constructor adapter would disable Electron's HTTP executor.
    Object.defineProperty(this.app, 'baseCachePath', { get: () => cache })
  }
}

export function createAppUpdates(dataPath: string, portable: boolean, changed: (state: AppUpdate) => void) {
  const currentVersion = app.getVersion()
  const cache = join(dataPath, 'update-cache')
  const supported = app.isPackaged && process.platform === 'win32'
  const updater = supported && !portable ? new InstalledUpdater(cache) : null
  let downloaded: { info: NonNullable<Awaited<ReturnType<typeof nextPortable>>>; archive: string } | null = null
  let state: AppUpdate = { currentVersion, portable, phase: supported ? 'idle' : 'development' }
  const publish = (details: Omit<AppUpdate, 'currentVersion' | 'portable'>): void => {
    state = { currentVersion, portable, ...details }
    changed(state)
  }
  const failed = (error: unknown): void => {
    console.error('[应用更新]', error)
    if (state.phase !== 'error') publish({ phase: 'error' })
  }
  async function checkPortable(): Promise<void> {
    const info = await nextPortable(currentVersion)
    if (!info) { publish({ phase: 'current' }); return }
    publish({ phase: 'downloading', version: info.version, percent: 0 })
    const archive = await downloadPortable(info, cache, percent => {
      if (state.percent !== percent) publish({ phase: 'downloading', version: info.version, percent })
    })
    downloaded = { info, archive }
    publish({ phase: 'ready', version: info.version })
  }
  function check(): AppUpdate {
    if (!supported || ['checking', 'downloading', 'ready', 'installing'].includes(state.phase)) return state
    publish({ phase: 'checking' })
    if (updater) void updater.checkForUpdates().then(result => result?.downloadPromise).catch(failed)
    else void checkPortable().catch(failed)
    return state
  }
  if (updater) {
    updater.allowDowngrade = false
    updater.allowPrerelease = false
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = true
    updater.disableWebInstaller = true
    updater.on('update-not-available', () => publish({ phase: 'current' }))
    updater.on('update-available', info => publish({ phase: 'downloading', version: info.version, percent: 0 }))
    updater.on('download-progress', progress => {
      const percent = Math.round(progress.percent)
      if (state.phase === 'downloading' && state.percent !== percent) publish({ ...state, percent })
    })
    updater.on('update-downloaded', info => publish({ phase: 'ready', version: info.version }))
    updater.on('error', failed)
  }
  if (supported) {
    const startup = setTimeout(check, 15_000)
    const daily = setInterval(check, 24 * 60 * 60 * 1000)
    app.once('before-quit', () => { clearTimeout(startup); clearInterval(daily) })
  }
  return {
    status: () => state,
    check,
    async install(): Promise<void> {
      if (state.phase !== 'ready') throw new Error('没有可安装的应用更新。')
      if (updater) { updater.quitAndInstall(false, true); return }
      if (!downloaded) throw new Error('请先下载免安装更新。')
      publish({ phase: 'installing', version: downloaded.info.version })
      try { await installPortable(downloaded.info, downloaded.archive, cache) }
      catch (error) { failed(error); throw error }
    }
  }
}
