import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Switch, Tabs, TextField } from '@radix-ui/themes'
import { Check, RefreshCw, Send } from 'lucide-react'
import type { DeliveryStatus, PushPanel, QqPushDraft } from '../../../shared/types'
import { dateTime, messageOf, unwrap } from '../lib'
import { Choices, PageHeader } from './PageControls'
import { ErrorBanner } from './Common'
import styles from './PushPage.module.css'

const statuses: Record<DeliveryStatus, string> = { pending: '待发送', sending: '发送中', sent: '已发送',
  failed: '发送失败', unknown: '待核实', skipped: '已跳过' }

export function PushPage({ desktop, busy, setDesktop }: {
  desktop: boolean; busy: boolean; setDesktop(value: boolean): void
}): React.JSX.Element {
  const [panel, setPanel] = useState<PushPanel | null>(null)
  const [patch, setPatch] = useState<Partial<QqPushDraft>>({})
  const [working, setWorking] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState('')
  const revision = useRef(0)
  const load = useCallback(async () => {
    const id = ++revision.current
    try {
      const result = unwrap(await window.hongguo.pushPanel())
      if (revision.current === id) setPanel(result)
    } catch (e) { if (revision.current === id) setError(messageOf(e)) }
  }, [])
  useEffect(() => {
    const unsubscribe = window.hongguo.onPushChanged(() => void load())
    void load()
    return () => { revision.current++; unsubscribe() }
  }, [load])
  const draft = panel ? { ...panel.qq, ...patch } : null
  const dirty = Boolean(panel && (patch.token !== undefined || (['enabled', 'endpoint', 'targetType', 'targetId'] as const)
    .some(key => patch[key] !== undefined && patch[key] !== panel.qq[key])))
  function edit<K extends keyof QqPushDraft>(key: K, value: QqPushDraft[K]): void {
    setPatch(current => ({ ...current, [key]: value }))
    setFeedback('')
    setError('')
  }
  async function act(operation: () => Promise<string>): Promise<void> {
    setWorking(true)
    setFeedback('')
    setError('')
    try { setFeedback(await operation()); await load() }
    catch (e) { setError(messageOf(e)) }
    finally { setWorking(false) }
  }
  return <>
    <PageHeader title="推送" />
    <Tabs.Root defaultValue="qq">
      <Tabs.List aria-label="推送渠道">
        <Tabs.Trigger value="qq">QQ 机器人</Tabs.Trigger>
        <Tabs.Trigger value="desktop">桌面通知</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="qq" className={styles.content}>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {!draft || !panel ? <Button variant="soft" onClick={() => void load()}>重新加载配置</Button> : <>
          <section className={styles.panel}>
            <div className={styles.channelHeader}>
              <div><h2 id="qq-enabled">QQ 机器人推送</h2><p>发现新季或新集时，通过 OneBot 机器人发送消息。</p></div>
              <Switch aria-labelledby="qq-enabled" disabled={working} checked={draft.enabled} onCheckedChange={value => edit('enabled', value)} />
            </div>
            <div className={styles.fields}>
              <label className={styles.field}>HTTP 服务地址
                <TextField.Root value={draft.endpoint} disabled={working} placeholder="http://127.0.0.1:3000" spellCheck={false} onChange={e => edit('endpoint', e.target.value)} />
              </label>
              <div className={styles.field}>
                <label htmlFor="qq-token">Access Token <small>可选</small></label>
                <div className={styles.secret}><TextField.Root id="qq-token" type="password" autoComplete="new-password" aria-describedby="qq-token-help" disabled={working}
                  placeholder={patch.token === '' ? '保存后清除' : panel.qq.hasToken ? '已保存，输入以替换' : '机器人未设置 Token 时留空'}
                  value={patch.token ?? ''} onChange={e => edit('token', e.target.value || undefined)} />
                  {panel.qq.hasToken && <Button variant="ghost" disabled={working} onClick={() => edit('token', patch.token === '' ? undefined : '')}>{patch.token === '' ? '撤销清除' : '清除'}</Button>}
                </div>
                <p id="qq-token-help" className={styles.hint}>在 SnowLuma 当前 QQ 账号的网络配置中，打开对应的 HTTP 服务，复制 Access Token 到这里。</p>
              </div>
              <div className={styles.field}><span>接收方式</span>
                <Choices label="QQ 接收方式" value={draft.targetType} disabled={working}
                  options={[{ value:'private', label:'私聊' },{ value:'group', label:'群聊' }]} onChange={value => edit('targetType', value)} />
              </div>
              <label className={styles.field}>{draft.targetType === 'group' ? '接收群号' : '接收 QQ 号'}
                <TextField.Root inputMode="numeric" value={draft.targetId} disabled={working} placeholder={draft.targetType === 'group' ? '机器人已加入的群号' : '能接收机器人私聊的 QQ 号'} onChange={e => edit('targetId', e.target.value)} />
              </label>
            </div>
            <div className={styles.actions}>
              <Button disabled={!dirty || working} onClick={() => void act(async () => {
                const { enabled, endpoint, targetType, targetId, token } = draft
                unwrap(await window.hongguo.saveQqPush({ enabled, endpoint, targetType, targetId, token }))
                setPatch({})
                return 'QQ 推送配置已保存。'
              })}><Check size={15} />保存配置</Button>
              <Button variant="surface" disabled={dirty || working || !draft.endpoint}
                onClick={() => void act(async () => unwrap(await window.hongguo.checkQqConnection()))}>测试连接</Button>
              <Button variant="surface" disabled={dirty || working || !draft.endpoint || !draft.targetId}
                onClick={() => void act(async () => { unwrap(await window.hongguo.testQqPush()); return '测试消息已提交，可在下方查看结果。' })}>
                <Send size={14} />发送测试消息</Button>
            </div>
            {feedback && <p className={styles.feedback} role="status">{feedback}</p>}
          </section>
          <section className={styles.history}>
            <h2>最近推送</h2>
            {!panel.deliveries.length ? <p>还没有 QQ 推送记录。</p> : panel.deliveries.map(row =>
              <article key={row.id} className={styles.delivery}>
                <span className={styles.status} data-status={row.status}>{statuses[row.status]}</span>
                <div><details className={styles.message}><summary>{row.title}</summary><p>{row.body}</p></details><p>{row.recipient} · {dateTime(row.createdAt)}</p>
                  {row.detail && <p>{row.detail}</p>}</div>
                {row.status === 'failed' && <Button size="1" variant="ghost" disabled={working || dirty}
                  onClick={() => void act(async () => { unwrap(await window.hongguo.retryQqPush(row.id)); return '已提交重试。' })}><RefreshCw size={13} />重试</Button>}
              </article>)}
          </section>
        </>}
      </Tabs.Content>
      <Tabs.Content value="desktop" className={styles.content}>
        <section className={styles.panel}><div className={styles.channelHeader}>
          <div><h2 id="push-desktop">Windows 桌面通知</h2><p>发现新季或新集时在此电脑提醒，受 Windows 勿扰设置影响。</p></div>
          <Switch checked={desktop} disabled={busy} aria-labelledby="push-desktop" onCheckedChange={setDesktop} />
        </div></section>
      </Tabs.Content>
    </Tabs.Root>
  </>
}
