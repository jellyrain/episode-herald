import { useEffect, useState, type ReactNode } from 'react'
import { Button, Switch } from '@radix-ui/themes'
import { Save } from 'lucide-react'
import { Choices, PageHeader } from './PageControls'
import { CacheSection } from './CacheSection'
import { BackupSection } from './BackupSection'
import type { AppUpdate, Settings } from '../../../shared/types'
import styles from '../App.module.css'

function SettingRow({ id, label, hint, children }: {
  id: string
  label: string
  hint?: string
  children: ReactNode
}): React.JSX.Element {
  return <div className={styles.settingRow}>
    <div><strong id={id}>{label}</strong>{hint && <p>{hint}</p>}</div>
    {children}
  </div>
}

function SoftwareUpdate(): React.JSX.Element {
  const [status, setStatus] = useState<AppUpdate | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let mounted = true
    const unsubscribe = window.hongguo.onAppUpdate(setStatus)
    void window.hongguo.appUpdateStatus().then(result => {
      if (mounted && result.ok) setStatus(current => current ?? result.value)
    })
    return () => { mounted = false; unsubscribe() }
  }, [])
  if (!status) return <></>
  const descriptions: Record<AppUpdate['phase'], string> = {
    development: '发布版支持自动更新。',
    idle: status.portable ? '新版本会在后台下载，可在这里重启更新。' : '新版本会在后台下载，退出时安装。',
    checking: '正在检查新版本…',
    current: '已是最新版本。',
    downloading: `正在下载 v${status.version} · ${status.percent ?? 0}%`,
    ready: status.portable ? `v${status.version} 已下载，重启即可更新。` : `v${status.version} 已下载，退出时将自动安装。`,
    installing: '正在准备更新，请稍候…',
    error: '检查或下载失败，请稍后重试。'
  }
  async function act(): Promise<void> {
    setError('')
    try {
      const result = status?.phase === 'ready'
        ? await window.hongguo.installAppUpdate()
        : await window.hongguo.checkAppUpdate()
      if (!result.ok) setError(result.error)
    } catch { setError('无法连接更新服务。') }
  }
  return <section>
    <h2>软件更新</h2>
    <SettingRow id="software-update" label={`当前版本 v${status.currentVersion}`} hint={error || descriptions[status.phase]}>
      {status.phase !== 'development' && <Button variant="soft" disabled={['checking', 'downloading', 'installing'].includes(status.phase)} onClick={() => void act()}>
        {status.phase === 'ready' ? '重启并安装' : '检查软件更新'}
      </Button>}
    </SettingRow>
  </section>
}

export function SettingsPage({ visible, settings, dataPath, busy, onSave, onRestored }: { visible: boolean; settings: Settings; dataPath: string; busy: boolean; onSave(settings: Settings): Promise<boolean>; onRestored(): void }): React.JSX.Element {
  // A patch preserves unfinished edits when navigating away and follows external theme changes.
  const [patch, setPatch] = useState<Partial<Settings>>({})
  const draft = { ...settings, ...patch }
  const dirty = Object.entries(patch).some(([key, value]) => settings[key as keyof Settings] !== value)
  const update = <K extends keyof Settings>(key: K, value: Settings[K]): void => setPatch(current => ({ ...current, [key]: value }))

  return <>
    <PageHeader title="软件设置">
      <Button disabled={!dirty || busy} onClick={async () => {
        if (await onSave(draft)) setPatch({})
      }}><Save size={15} />保存设置</Button>
    </PageHeader>
    <div className={styles.settingsSheet}>
      <SoftwareUpdate />
      <section>
        <h2>检查计划</h2>
        <p>在侧栏的「调度任务」中设置自动检查的时间、频率和检查方式。</p>
      </section>
      <section>
        <h2>窗口</h2>
        <div>
          <SettingRow id="tray-label" label="关闭到系统托盘" hint="收起窗口后继续检查，可从托盘菜单退出应用。">
            <Switch checked={draft.closeToTray} onCheckedChange={value => update('closeToTray', value)}
              aria-labelledby="tray-label" disabled={busy} />
          </SettingRow>
        </div>
      </section>
      <section>
        <h2>外观</h2>
        <SettingRow id="theme-label" label="界面主题">
          <Choices label="界面主题" value={draft.theme} disabled={busy}
            options={[{ value: 'dark', label: '墨金' }, { value: 'light', label: '月白' }]}
            onChange={value => update('theme', value)} />
        </SettingRow>
      </section>
      <section>
        <h2>本地数据</h2>
        <div className={styles.dataLocation}>
          <strong>存储位置</strong>
          <code>{dataPath}</code>
        </div>
      </section>
      {visible && <><BackupSection busy={busy} onRestored={() => { setPatch({}); onRestored() }} /><CacheSection /></>}
    </div>
    {dirty && <div className={styles.draftBar} role="status">
      <span>有未保存的设置</span>
      <Button variant="ghost" color="gray" disabled={busy} onClick={() => setPatch({})}>放弃修改</Button>
    </div>}
  </>
}
