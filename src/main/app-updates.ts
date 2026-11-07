import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { AppUpdate } from '../shared/types'

export function createAppUpdates(changed: (state: AppUpdate) => void) {
  const currentVersion = app.getVersion()
  const updater = app.isPackaged && process.platform === 'win32' ? new electronUpdater.NsisUpdater() : null
  let state: AppUpdate = { currentVersion, phase: updater ? 'idle' : 'development' }
  const publish = (details: Omit<AppUpdate, 'currentVersion'>): void => {
    state = { currentVersion, ...details }
    changed(state)
  }
  const failed = (error: unknown): void => {
    console.error('[应用更新]', error)
    if (state.phase !== 'error') publish({ phase: 'error' })
  }
  function check(): AppUpdate {
    if (!updater || ['checking', 'downloading', 'ready'].includes(state.phase)) return state
    publish({ phase: 'checking' })
    void updater.checkForUpdates().then(result => result?.downloadPromise).catch(failed)
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
    const startup = setTimeout(check, 15_000)
    const daily = setInterval(check, 24 * 60 * 60 * 1000)
    app.once('before-quit', () => { clearTimeout(startup); clearInterval(daily) })
  }
  return {
    status: () => state,
    check,
    install(): void {
      if (!updater || state.phase !== 'ready') throw new Error('没有可安装的应用更新。')
      updater.quitAndInstall(false, true)
    }
  }
}
