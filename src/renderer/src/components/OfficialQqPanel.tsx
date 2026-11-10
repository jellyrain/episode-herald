import { useState } from 'react'
import { Button, Switch, TextField } from '@radix-ui/themes'
import { Check, Send } from 'lucide-react'
import type { OfficialQqDraft, PushPanel } from '../../../shared/types'
import { unwrap } from '../lib'
import { Choices } from './PageControls'
import styles from './PushPage.module.css'

export function OfficialQqPanel({ config, working, act }: {
  config: PushPanel['official']; working: boolean; act(fn: () => Promise<string>): Promise<void>
}): React.JSX.Element {
  const [patch, setPatch] = useState<Partial<OfficialQqDraft>>({})
  const draft = { ...config, ...patch }
  const dirty = patch.secret !== undefined || (['enabled', 'appId', 'targetId', 'targetType'] as const).some(key => draft[key] !== config[key])
  const edit = (value: Partial<OfficialQqDraft>): void => setPatch(old => ({ ...old, ...value }))
  return <section className={styles.panel}>
    <div className={styles.channelHeader}>
      <div><h2 id="official-enabled">QQ 官方机器人</h2><p>使用 QQ 开放平台的机器人，向指定好友或群发送追更提醒。</p></div>
      <Switch aria-labelledby="official-enabled" disabled={working} checked={draft.enabled} onCheckedChange={enabled => edit({ enabled })} />
    </div>
    <div className={styles.fields}>
      <label className={styles.field}>AppID<TextField.Root value={draft.appId} inputMode="numeric" disabled={working} placeholder="开放平台中的机器人 AppID" onChange={e => edit({ appId: e.target.value })} /></label>
      <div className={styles.field}><label htmlFor="official-secret">AppSecret</label><div className={styles.secret}>
        <TextField.Root id="official-secret" type="password" autoComplete="new-password" disabled={working}
          placeholder={patch.secret === '' ? '保存后清除' : config.hasSecret ? '已保存，输入以替换' : '开放平台中的机器人密钥'} value={patch.secret ?? ''} onChange={e => edit({ secret: e.target.value || undefined })} />
        {config.hasSecret && <Button variant="ghost" disabled={working} onClick={() => edit({ secret: patch.secret === '' ? undefined : '' })}>{patch.secret === '' ? '撤销清除' : '清除'}</Button>}
      </div></div>
      <div className={styles.field}>接收方式<Choices label="官方机器人接收方式" value={draft.targetType} disabled={working}
        options={[{ value: 'private', label: '私聊' }, { value: 'group', label: '群聊' }]} onChange={targetType => edit({ targetType, targetId: '' })} /></div>
      <label className={styles.field}>{draft.targetType === 'group' ? '群 OpenID' : '用户 OpenID'}
        <TextField.Root value={draft.targetId} spellCheck={false} disabled={working} onChange={e => edit({ targetId: e.target.value })} />
        <small>{draft.targetType === 'group' ? '在目标群 @ 机器人，从该机器人的群消息事件复制 group_openid。' : '私聊机器人，从该机器人的私聊消息事件复制 author.user_openid。'}</small></label>
    </div>
    <div className={styles.actions}>
      <Button disabled={working || !dirty} onClick={() => void act(async () => {
        const { appId, targetId, targetType, enabled, secret } = draft
        unwrap(await window.hongguo.saveOfficialQq({ appId, targetId, targetType, enabled, secret }))
        setPatch({})
        return '官方机器人配置已保存。'
      })}><Check size={15} />保存配置</Button>
      <Button variant="surface" disabled={working || dirty || !draft.appId || !config.hasSecret} onClick={() => void act(async () => unwrap(await window.hongguo.checkQqConnection('official')))}>测试连接</Button>
      <Button variant="surface" disabled={working || dirty || !draft.appId || !config.hasSecret || !draft.targetId} onClick={() => void act(async () => {
        unwrap(await window.hongguo.testQqPush('official'))
        return '测试消息已提交，可在最近推送中查看回执。'
      })}><Send size={14} />发送测试消息</Button>
    </div>
  </section>
}
