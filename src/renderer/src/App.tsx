import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, IconButton, Spinner, Theme, Tooltip } from '@radix-ui/themes'
import { Bell, CheckCheck, Compass, Library, Minus, Moon, RefreshCw, Send, Settings as SettingsIcon, Square, Sun, X } from 'lucide-react'
import { productName } from '../../../package.json'
import newsboy from './assets/newsboy.png'
import type { Result, Snapshot } from '../../shared/types'
import { dateTime, messageOf, unwrap } from './lib'
import { EmptyState, ErrorBanner } from './components/Common'
import { WatchList } from './components/WatchList'
import { PageHeader } from './components/PageControls'
import { Discover } from './components/Discover'
import { SettingsPage } from './components/SettingsPage'
import { PushPage } from './components/PushPage'
import { SeriesDialog } from './components/SeriesDialog'
import styles from './App.module.css'

type Page = 'watches' | 'discover' | 'updates' | 'push' | 'settings'
const pages = [
  { id: 'watches', label: '我的追更', icon: Library },
  { id: 'discover', label: '发现作品', icon: Compass },
  { id: 'updates', label: '更新记录', icon: Bell },
  { id: 'push', label: '推送', icon: Send }
] as const

export default function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [page, setPage] = useState<Page>('watches')
  const [discoveryOpened, setDiscoveryOpened] = useState(false)
  const [pushOpened, setPushOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const mainRef = useRef<HTMLElement>(null)
  useEffect(() => { mainRef.current?.scrollTo(0, 0) }, [page])
  const navigate = (next: Page): void => {
    if (next === 'discover') setDiscoveryOpened(true)
    if (next === 'push') setPushOpened(true)
    setPage(next)
  }
  const openSeries = (id: string): void => { setError(''); setSelected(id) }
  const refresh = useCallback(async () => {
    try {
      if (!window.hongguo) throw new Error('桌面连接未建立，请通过应用启动。')
      setSnapshot(unwrap(await window.hongguo.snapshot()))
      setError('')
    } catch (e) { setError(messageOf(e)) }
  }, [])

  useEffect(() => {
    void refresh()
    return window.hongguo?.onChanged(() => { void refresh() })
  }, [refresh])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 5000)
    return () => clearTimeout(timer)
  }, [notice])

  const mutate = async (operation: () => Promise<Result<Snapshot>>, success?: string): Promise<boolean> => {
    setBusy(true)
    setError('')
    try {
      setSnapshot(unwrap(await operation()))
      if (success) setNotice(success)
      return true
    } catch (e) { setError(messageOf(e)); return false }
    finally { setBusy(false) }
  }
  const follow = async (id: string): Promise<boolean> => mutate(() => window.hongguo.follow(id), '已加入追更，首次检查用于记录当前进度。')
  const unread = snapshot?.events.filter(event => !event.read).length ?? 0
  const checking = busy || Boolean(snapshot?.checking)
  const appearance = snapshot?.settings.theme ?? 'dark'

  return <Theme appearance={appearance} accentColor="gold" grayColor="sage" radius="medium" scaling="100%" className={styles.theme}>
    <div className={styles.app} data-appearance={appearance}>
      <header className={styles.titlebar}>
        <span className={styles.titlebarBrand}><img src={newsboy} alt="" draggable={false} />{productName}</span>
        <div className={styles.windowControls}>
          <button aria-label="最小化" onClick={() => window.hongguo?.windowAction('minimize')}><Minus size={15} /></button>
          <button aria-label="最大化或还原" onClick={() => window.hongguo?.windowAction('maximize')}><Square size={12} /></button>
          <button aria-label={snapshot?.settings.closeToTray ? '关闭到托盘' : '退出应用'} className={styles.closeWindow} onClick={() => window.hongguo?.windowAction('close')}><X size={16} /></button>
        </div>
      </header>
      <div className={styles.shell}>
        <aside className={styles.sidebar}>
          <nav className={styles.navigation} aria-label="主导航">
            {pages.map(({ id, label, icon: Icon }) => (
              <Tooltip key={id} content={label} side="right">
                <button className={styles.navItem} aria-label={label} aria-current={page === id ? 'page' : undefined}
                  onClick={() => navigate(id)}>
                  <Icon size={18} /><span>{label}</span>
                  {id === 'updates' && unread > 0 && <b>{unread}</b>}
                </button>
              </Tooltip>
            ))}
          </nav>
          <div className={styles.sidebarBottom}>
            <Tooltip content="检查所有追更中的作品" side="right">
              <button className={styles.navItem} aria-label="检查更新"
                disabled={checking || !snapshot?.watches.some(watch => !watch.paused)}
                onClick={() => void mutate(() => window.hongguo.checkNow())}>
                <RefreshCw size={17} className={snapshot?.checking ? styles.spin : undefined} />
                <span>{snapshot?.checking ? '正在检查…' : '检查更新'}</span>
              </button>
            </Tooltip>
            <div className={styles.preferences}>
              <Tooltip content="软件设置" side="right">
                <button className={styles.navItem} aria-label="软件设置" aria-current={page === 'settings' ? 'page' : undefined}
                  onClick={() => navigate('settings')}>
                  <SettingsIcon size={18} /><span>软件设置</span>
                </button>
              </Tooltip>
              <Tooltip content={appearance === 'dark' ? '切换浅色' : '切换深色'}>
                <IconButton variant="ghost" color="gray" aria-label="切换主题" disabled={!snapshot || busy}
                  onClick={() => snapshot && void mutate(() => window.hongguo.saveSettings({
                    ...snapshot.settings, theme: appearance === 'dark' ? 'light' : 'dark'
                  }))}>
                  {appearance === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
                </IconButton>
              </Tooltip>
            </div>
          </div>
        </aside>
        <div className={styles.mainShell}>
          <main ref={mainRef} className={styles.main}>
            {error && <ErrorBanner>{error}</ErrorBanner>}
            {!snapshot ? <EmptyState title={error ? '暂时无法读取追更空间' : '正在打开追更空间'} action={error ? <Button variant="soft" onClick={() => void refresh()}>重新加载</Button> : <Spinner />}>你的作品和检查记录保存在本机。</EmptyState> : <>
              {page === 'watches' && <WatchList snapshot={snapshot} busy={checking} onDiscover={() => navigate('discover')} onOpen={openSeries} onCheck={id => void mutate(() => window.hongguo.checkNow(id))} onToggle={(id, paused) => void mutate(() => window.hongguo.updateWatch(id, { paused }))} onRemove={id => void mutate(() => window.hongguo.removeWatch(id), '已取消追更。')} />}
              {discoveryOpened && <div hidden={page !== 'discover'}><Discover watches={snapshot.watches} busy={checking} onOpen={openSeries} onFollow={follow} /></div>}
              {page === 'updates' && <>
                <PageHeader title="更新记录" detail={snapshot.events.length + ' 条记录 · ' + unread + ' 条未读'}>
                  <Button variant="surface" disabled={busy || unread === 0}
                    onClick={() => void mutate(() => window.hongguo.markRead(), '已标记全部已读。')}>
                    <CheckCheck size={16} />全部已读
                  </Button>
                </PageHeader>
                {snapshot.events.length === 0 ? (
                  <EmptyState title="暂无更新记录" icon={<Bell size={24} />}
                    action={<Button variant="soft" onClick={() => navigate('watches')}>查看我的追更</Button>}>
                    加入追更后发现的新季和新集会保存在这里。
                  </EmptyState>
                ) : (
                  <div className={styles.eventList}>
                    {snapshot.events.map(event => (
                      <article key={event.id} className={styles.event} data-unread={!event.read}>
                        <span className={styles.eventKind}>{event.kind === 'season' ? '新季' : '新集'}</span>
                        <div className={styles.eventBody}>
                          <button onClick={() => openSeries(event.seriesId)}>{event.title}</button>
                          <p>{event.message}</p>
                        </div>
                        {!event.read && <span className={styles.unreadDot} aria-label="未读" />}
                        <time dateTime={event.createdAt}>{dateTime(event.createdAt)}</time>
                      </article>
                    ))}
                  </div>
                )}
              </>}
              {pushOpened && <div hidden={page !== 'push'}><PushPage desktop={snapshot.settings.desktopNotifications} busy={busy}
                setDesktop={value => void mutate(() => window.hongguo.saveSettings({ ...snapshot.settings, desktopNotifications: value }), '桌面通知设置已保存。')} /></div>}
              <div hidden={page !== 'settings'}><SettingsPage settings={snapshot.settings} dataPath={snapshot.dataPath} busy={busy} onSave={settings => mutate(() => window.hongguo.saveSettings(settings), '设置已保存。')} /></div>
            </>}

          </main>
        </div>
      </div>
      {snapshot && <footer className={styles.statusbar}>
        <span><i data-active={snapshot.settings.autoCheck} />
          {snapshot.checking ? '正在检查更新…' : snapshot.settings.autoCheck
            ? snapshot.nextCheckAt ? '下次检查 ' + dateTime(snapshot.nextCheckAt) : '每天 ' + snapshot.settings.checkTime + ' 自动检查'
            : '自动检查已暂停'}
        </span>
        <span>{snapshot.lastCheckAt && '上次检查 ' + dateTime(snapshot.lastCheckAt)} {snapshot.lastCheckSummary}</span>
      </footer>}
      {notice && <div className={styles.toast} role="status"><CheckCheck size={17} />{notice}<button aria-label="关闭提示" onClick={() => setNotice('')}><X size={14} /></button></div>}
      {selected && <SeriesDialog id={selected} watch={snapshot?.watches.find(item => item.id === selected)} busy={checking} mutationError={error} onClose={() => setSelected(null)} onFollow={follow} onWatchSeasons={(id, watchSeasons) => void mutate(() => window.hongguo.updateWatch(id, { watchSeasons }))} />}
    </div>
  </Theme>
}
