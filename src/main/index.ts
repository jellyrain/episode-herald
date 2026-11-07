import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  powerMonitor,
  protocol,
  safeStorage,
  Tray,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import icon from '../../resources/icon.png?asset&asarUnpack'
import windowsIcon from '../../build/icon.ico?asset&asarUnpack'
import { productName } from '../../package.json'
import type { BrowseQuery, Result, Settings } from '../shared/types'
import { Monitor } from './monitor'
import { QqPush } from './qq-push'
import { Store } from './store'
import { createAppUpdates } from './app-updates'
import { configureDataPaths, importInstalledData } from './data-paths'
import { CoverCache } from './covers'
import { Provider, toUserMessage } from './provider'

const bundlePath = dirname(fileURLToPath(import.meta.url))
protocol.registerSchemesAsPrivileged([{ scheme: 'hongguo-cover', privileges: { standard: true, secure: true } }])
const rendererFile = join(bundlePath, '../renderer/index.html')
const developmentUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined
const portable = app.isPackaged && existsSync(join(dirname(process.execPath), 'portable.json'))
const paths = (() => {
  try { return configureDataPaths() }
  catch (error) {
    dialog.showErrorBox('无法使用程序数据目录', error instanceof Error ? error.message : '请检查程序目录的写入权限。')
    process.exit(1)
  }
})()
const shellIcon = process.platform === 'win32' ? windowsIcon : icon
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let monitor: Monitor | null = null
let quitting = false
const notifications = new Set<Notification>()

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.show()
  mainWindow?.focus()
}

function emitChanged(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('hongguo:changed')
  tray?.setToolTip(monitor?.snapshot().checking ? `${productName} · 正在检查更新` : productName)
}

function notify(title: string, body: string): void {
  if (!Notification.isSupported() || !monitor?.snapshot().settings.desktopNotifications) return
  const notification = new Notification({ title, body, icon })
  notifications.add(notification)
  notification.on('click', showWindow)
  notification.on('close', () => notifications.delete(notification))
  notification.on('failed', () => notifications.delete(notification))
  notification.show()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: productName,
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: monitor?.snapshot().settings.theme === 'light' ? '#f4f1ea' : '#111619',
    icon: shellIcon,
    webPreferences: {
      preload: join(bundlePath, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false
    }
  })
  const window = mainWindow
  window.once('ready-to-show', () => window.show())
  window.on('close', (event) => {
    if (!quitting && tray && monitor?.snapshot().settings.closeToTray) {
      event.preventDefault()
      window.hide()
    }
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault())
  window.webContents.on('will-redirect', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  )
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.on('before-input-event', (event, input) => {
    if (!app.isPackaged && input.type === 'keyDown' && input.key === 'F12') {
      event.preventDefault()
      window.webContents.toggleDevTools()
    }
  })
  const load = developmentUrl ? window.loadURL(developmentUrl) : window.loadFile(rendererFile)
  void load.catch(() => {
    dialog.showErrorBox('页面未能打开', '请重新启动应用；开发环境下请确认界面服务仍在运行。')
    app.quit()
  })
}

function isTrusted(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  if (event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) {
    return false
  }
  try {
    const source = new URL(event.senderFrame.url)
    const expected = new URL(developmentUrl ?? pathToFileURL(rendererFile).href)
    return source.protocol === expected.protocol &&
      source.host === expected.host &&
      source.pathname === expected.pathname
  } catch {
    return false
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求参数不正确。')
  return value as Record<string, unknown>
}

function text(value: unknown, maximum = 160): string {
  if (typeof value !== 'string' || value.length > maximum) throw new Error('请求参数不正确。')
  return value
}

function seriesId(value: unknown): string {
  const id = text(value, 30)
  if (!/^\d{1,30}$/.test(id)) throw new Error('作品编号不正确。')
  return id
}

function genre(value: unknown): string {
  const result = text(value, 30)
  if (!['short_play', 'comic_series', 'ai_series'].includes(result)) throw new Error('作品类型不正确。')
  return result
}

function browseQuery(value: unknown): BrowseQuery {
  const input = record(value)
  if (!['discover', 'search', 'rank', 'filter'].includes(input.mode as string)) {
    throw new Error('浏览方式不正确。')
  }
  const query: BrowseQuery = { mode: input.mode as BrowseQuery['mode'] }
  if (input.query !== undefined) query.query = text(input.query, 200)
  if (input.cursor !== undefined) query.cursor = text(input.cursor, 65_536)
  if (input.genre !== undefined) query.genre = genre(input.genre)
  if (input.content !== undefined) query.content = text(input.content, 100)
  if (input.board !== undefined) query.board = text(input.board, 100)
  if (input.selections !== undefined) {
    const selections = record(input.selections)
    if (Object.keys(selections).length > 20) throw new Error('筛选条件过多。')
    query.selections = Object.fromEntries(
      Object.entries(selections).map(([key, values]) => {
        if (!/^[a-zA-Z0-9_]{1,80}$/.test(key) || !Array.isArray(values) || values.length > 30) {
          throw new Error('筛选条件不正确。')
        }
        return [key, values.map((value) => text(value, 150))]
      })
    )
  }
  return query
}

function settings(value: unknown): Settings {
  const input = record(value)
  if (
    !['dark', 'light'].includes(input.theme as string) ||
    typeof input.checkTime !== 'string' ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.checkTime) ||
    typeof input.autoCheck !== 'boolean' ||
    typeof input.desktopNotifications !== 'boolean' ||
    typeof input.closeToTray !== 'boolean'
  ) {
    throw new Error('设置内容不正确，请检查后重试。')
  }
  return {
    theme: input.theme as Settings['theme'],
    checkTime: input.checkTime,
    autoCheck: input.autoCheck,
    desktopNotifications: input.desktopNotifications,
    closeToTray: input.closeToTray
  }
}

function registerIpc(service: Monitor, updates: ReturnType<typeof createAppUpdates>, push: QqPush, provider: Provider): void {
  function handle<T>(name: string, action: (...args: unknown[]) => T | Promise<T>): void {
    ipcMain.handle('hongguo:' + name, async (event, ...args): Promise<Result<T>> => {
      if (!isTrusted(event)) return { ok: false, error: '当前页面无权执行此操作。' }
      try {
        return { ok: true, value: await action(...args) }
      } catch (error) {
        return { ok: false, error: toUserMessage(error) }
      }
    })
  }
  handle('snapshot', () => service.snapshot())
  handle('push-panel', () => push.panel())
  handle('save-qq', value => push.save(value))
  handle('check-qq', () => push.checkConnection())
  handle('test-qq', () => push.test())
  handle('retry-qq', id => push.retry(text(id)))
  handle('app-update-status', updates.status)
  handle('app-update-check', updates.check)
  handle('app-update-install', updates.install)
  handle('browse', (query) => service.browse(browseQuery(query)))
  handle('filters', (value) => service.filters(genre(value)))
  handle('details', (id) => service.details(seriesId(id)))
  handle('similar-series', id => provider.similarSeries(seriesId(id)))
  handle('season-heat', id => provider.seasonHeat(seriesId(id)))
  handle('follow', (id) => service.follow(seriesId(id)))
  handle('update-watch', (id, value) => {
    const input = record(value)
    const changes: { paused?: boolean; watchSeasons?: boolean } = {}
    if (input.paused !== undefined) {
      if (typeof input.paused !== 'boolean') throw new Error('追更设置不正确。')
      changes.paused = input.paused
    }
    if (input.watchSeasons !== undefined) {
      if (typeof input.watchSeasons !== 'boolean') throw new Error('追更设置不正确。')
      changes.watchSeasons = input.watchSeasons
    }
    return service.updateWatch(seriesId(id), changes)
  })
  handle('remove-watch', (id) => service.removeWatch(seriesId(id)))
  handle('check-now', (id) => service.checkNow(id === undefined ? undefined : seriesId(id)))
  handle('mark-read', () => service.markRead())
  handle('save-settings', (value) => service.saveSettings(settings(value)))
  ipcMain.on('hongguo:window-action', (event, action: unknown) => {
    if (!isTrusted(event) || !mainWindow) return
    if (action === 'minimize') mainWindow.minimize()
    if (action === 'maximize') {
      if (mainWindow.isMaximized()) mainWindow.unmaximize()
      else mainWindow.maximize()
    }
    if (action === 'close') mainWindow.close()
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (app.isReady() && monitor) showWindow()
  })
  app.on('activate', () => {
    if (monitor) showWindow()
  })
  app.on('before-quit', () => {
    quitting = true
    monitor?.stop()
    for (const notification of notifications) notification.close()
    notifications.clear()
    tray?.destroy()
    tray = null
  })
  app.on('window-all-closed', () => app.quit())

  void app.whenReady().then(() => {
    app.setAppUserModelId('com.episodeherald.desktop')
    Menu.setApplicationMenu(null)
    const dataPath = paths.data
    if (app.isPackaged && !portable) importInstalledData(paths.oldAppData, dataPath)
    const covers = new CoverCache(dataPath)
    protocol.handle('hongguo-cover', request => covers.respond(request))
    const store = new Store(dataPath)
    const push = new QqPush(store, {
      encrypt: token => safeStorage.encryptString(token).toString('base64'),
      decrypt: cipher => safeStorage.decryptString(Buffer.from(cipher, 'base64'))
    }, () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('hongguo:push-changed')
    })
    app.once('before-quit', () => push.stop())
    const provider = new Provider(dataPath)
    monitor = new Monitor(dataPath, emitChanged, notify, provider, store, () => { void push.dispatch() })
    const updates = createAppUpdates(dataPath, portable, state => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('hongguo:app-update', state)
    })
    registerIpc(monitor, updates, push, provider)
    tray = new Tray(shellIcon)
    tray.setToolTip(productName)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `打开${productName}`, click: showWindow },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() }
      ])
    )
    tray.on('double-click', showWindow)
    createWindow()
    push.start()
    monitor.start()
    powerMonitor.on('resume', () => monitor?.resume())
  }).catch(() => {
    dialog.showErrorBox(`${productName}未能启动`, '无法初始化本地数据。请确认数据目录可写后重新启动；已有追更数据不会被自动清除。')
    app.quit()
  })
}
