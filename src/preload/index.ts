import { contextBridge, ipcRenderer } from 'electron'
import type { AppUpdate, HongguoAPI } from '../shared/types'

const api: HongguoAPI = {
  exportBackup: (password, view) => ipcRenderer.invoke('hongguo:export-backup', password, view),
  importBackup: password => ipcRenderer.invoke('hongguo:import-backup', password),
  cacheUsage: () => ipcRenderer.invoke('hongguo:cache-usage'),
  clearCache: () => ipcRenderer.invoke('hongguo:cache-clear'),
  pushPanel: () => ipcRenderer.invoke('hongguo:push-panel'),
  saveQqPush: config => ipcRenderer.invoke('hongguo:save-qq', config),
  checkQqConnection: () => ipcRenderer.invoke('hongguo:check-qq'),
  testQqPush: () => ipcRenderer.invoke('hongguo:test-qq'),
  retryQqPush: id => ipcRenderer.invoke('hongguo:retry-qq', id),
  onPushChanged(listener) {
    const handler = (): void => listener()
    ipcRenderer.on('hongguo:push-changed', handler)
    return () => ipcRenderer.off('hongguo:push-changed', handler)
  },
  appUpdateStatus: () => ipcRenderer.invoke('hongguo:app-update-status'),
  checkAppUpdate: () => ipcRenderer.invoke('hongguo:app-update-check'),
  installAppUpdate: () => ipcRenderer.invoke('hongguo:app-update-install'),
  onAppUpdate(listener) {
    const handler = (_event: Electron.IpcRendererEvent, update: AppUpdate): void => listener(update)
    ipcRenderer.on('hongguo:app-update', handler)
    return () => ipcRenderer.off('hongguo:app-update', handler)
  },
  snapshot: () => ipcRenderer.invoke('hongguo:snapshot'),
  browse: (query) => ipcRenderer.invoke('hongguo:browse', query),
  searchCovers: ids => ipcRenderer.invoke('hongguo:search-covers', ids),
  filters: (genre) => ipcRenderer.invoke('hongguo:filters', genre),
  details: (id) => ipcRenderer.invoke('hongguo:details', id),
  similarSeries: id => ipcRenderer.invoke('hongguo:similar-series', id),
  seasonHeat: id => ipcRenderer.invoke('hongguo:season-heat', id),
  follow: (id) => ipcRenderer.invoke('hongguo:follow', id),
  updateWatch: (id, changes) => ipcRenderer.invoke('hongguo:update-watch', id, changes),
  removeWatch: (id) => ipcRenderer.invoke('hongguo:remove-watch', id),
  checkNow: (id) => ipcRenderer.invoke('hongguo:check-now', id),
  markRead: () => ipcRenderer.invoke('hongguo:mark-read'),
  saveSettings: (settings) => ipcRenderer.invoke('hongguo:save-settings', settings),
  onChanged: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on('hongguo:changed', handler)
    return () => ipcRenderer.removeListener('hongguo:changed', handler)
  },
  windowAction: (action) => ipcRenderer.send('hongguo:window-action', action)
}

contextBridge.exposeInMainWorld('hongguo', api)
