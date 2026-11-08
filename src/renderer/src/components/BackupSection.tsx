import { useState } from 'react'
import { Button, Dialog, Spinner, TextField } from '@radix-ui/themes'
import { Download, Upload } from 'lucide-react'
import { messageOf, unwrap } from '../lib'
import { ErrorBanner } from './Common'
import styles from '../App.module.css'

export function BackupSection({ busy, onRestored }: { busy: boolean; onRestored(): void }): React.JSX.Element {
  const [mode, setMode] = useState<'import' | 'export' | null>(null)
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const exporting = mode === 'export'
  function open(next: typeof mode): void {
    setPassword(''); setConfirmation(''); setError(''); setMode(next)
  }
  async function submit(): Promise<void> {
    if (working || !mode || !password.trim()) return
    if (exporting && password !== confirmation) { setError('两次输入的密码不一致。'); return }
    setWorking(true)
    setError('')
    try {
      if (exporting) {
        const file = unwrap(await window.hongguo.exportBackup(password, localStorage.getItem('watch-view') === 'grid' ? 'grid' : 'list'))
        if (!file) return
        setNotice('备份已保存到 ' + file)
      } else {
        const restored = unwrap(await window.hongguo.importBackup(password))
        if (!restored) return
        localStorage.setItem('watch-view', restored.view)
        onRestored()
        setNotice(`已导入 ${restored.watches} 部作品、${restored.events} 条更新记录及设置。`)
      }
      open(null)
    } catch (e) { setError(messageOf(e)) }
    finally { setWorking(false) }
  }
  return <section>
    <h2>数据备份</h2>
    <div className={styles.cachePanel}>
      <p>备份追更进度、更新记录、已缓存封面，以及软件和推送设置（含 QQ Token）。</p>
      <div className={styles.backupButtons}>
        <Button size="2" variant="surface" disabled={working} onClick={() => open('export')}><Download size={14} />导出备份</Button>
        <Button size="2" variant="surface" disabled={busy || working} onClick={() => open('import')}><Upload size={14} />导入备份</Button>
      </div>
      {notice && <p role="status" className={styles.backupNotice}>{notice}</p>}
    </div>
    <Dialog.Root open={mode !== null} onOpenChange={value => { if (!value && !working) open(null) }}>
      <Dialog.Content maxWidth="430px">
        <Dialog.Title>{exporting ? '导出备份' : '导入备份'}</Dialog.Title>
        <Dialog.Description size="2" color="gray">
          {exporting ? '设置备份密码。换机恢复时需输入同一密码。' : '输入导出时设置的密码，选择备份文件后可确认替换。'}
        </Dialog.Description>
        <form onSubmit={event => { event.preventDefault(); void submit() }}>
          <label className={styles.backupPassword}>备份密码<TextField.Root type="password" autoComplete={exporting ? 'new-password' : 'off'}
            value={password} maxLength={1024} disabled={working} onChange={event => setPassword(event.target.value)} /></label>
          {exporting && <label className={styles.backupPassword}>确认密码<TextField.Root type="password" autoComplete="new-password"
            value={confirmation} maxLength={1024} disabled={working} onChange={event => setConfirmation(event.target.value)} /></label>}
          {error && <ErrorBanner>{error}</ErrorBanner>}
          <div className={styles.dialogActions}><Button type="button" variant="soft" color="gray" disabled={working} onClick={() => open(null)}>取消</Button>
            <Button type="submit" disabled={working || !password.trim() || (exporting && !confirmation)}>{working && <Spinner size="1" />}{exporting ? '选择保存位置' : '选择备份文件'}</Button></div>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  </section>
}
