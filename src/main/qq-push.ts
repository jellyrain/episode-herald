import { randomUUID } from 'node:crypto'
import type { PushPanel, QqPushConfig } from '../shared/types'
import { UserFacingError } from './provider'
import { qqRoute, type SavedQqConfig, type Store } from './store'

export interface TokenStorage {
  encrypt(token: string): string
  decrypt(cipher: string): string
}

export function normalizeQq(input: unknown): QqPushConfig & { token?: string } {
  const value = input as Record<string, unknown> | null
  if (!value || typeof value.enabled !== 'boolean' || typeof value.endpoint !== 'string' ||
      !['private', 'group'].includes(String(value.targetType)) || typeof value.targetId !== 'string' ||
      (value.token !== undefined && (typeof value.token !== 'string' || !/^[\x21-\x7e]{0,2048}$/.test(value.token)))) {
    throw new UserFacingError('请检查 QQ 推送配置，Token 不能包含空格或换行。')
  }
  let endpoint = value.endpoint.trim()
  if (endpoint || value.enabled) {
    try {
      const url = new URL(endpoint)
      if (endpoint.length > 2048 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error()
      endpoint = url.href.replace(/\/+$/, '')
    } catch { throw new UserFacingError('请填写 OneBot HTTP 服务地址，例如 http://127.0.0.1:3000。') }
  }
  const targetId = value.targetId.trim()
  if ((targetId || value.enabled) && (!/^[1-9]\d{0,15}$/.test(targetId) || !Number.isSafeInteger(Number(targetId)))) {
    throw new UserFacingError('请填写有效的 QQ 号或群号。')
  }
  return { enabled: value.enabled, endpoint, targetType: value.targetType as QqPushConfig['targetType'], targetId, token: value.token as string | undefined }
}

class Unconfirmed extends UserFacingError {}

export class QqPush {
  private running = false
  private stopped = false

  constructor(private readonly store: Store, private readonly tokens: TokenStorage,
    private readonly changed: () => void, private readonly request: typeof fetch = fetch) {}

  get sending(): boolean { return this.running }

  start(): void {
    this.store.recoverDeliveries()
    void this.dispatch()
  }

  stop(): void { this.stopped = true }

  panel(): PushPanel {
    const { cipher, ...config } = this.store.qqConfig()
    return { qq: { ...config, hasToken: Boolean(cipher) }, deliveries: this.store.deliveries() }
  }

  save(input: unknown): PushPanel {
    const value = normalizeQq(input)
    const { endpoint, targetId } = value
    const old = this.store.qqConfig()
    if (old.cipher && endpoint !== old.endpoint && value.token === undefined) {
      throw new UserFacingError('更换服务地址时，请重新填写 Token 或清除已保存的 Token。')
    }
    let cipher = old.cipher
    if (typeof value.token === 'string') {
      try { cipher = value.token ? this.tokens.encrypt(value.token) : '' }
      catch { throw new UserFacingError('无法加密保存 Token，请检查当前系统账户。') }
    }
    this.store.saveQq({ enabled: value.enabled, endpoint, targetType: value.targetType as QqPushConfig['targetType'], targetId, cipher })
    this.changed()
    return this.panel()
  }

  private async call(config: SavedQqConfig, action: string, params: object): Promise<Record<string, unknown>> {
    if (!config.endpoint) throw new UserFacingError('请先填写并保存机器人 HTTP 地址。')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (config.cipher) {
      try { headers.Authorization = 'Bearer ' + this.tokens.decrypt(config.cipher) }
      catch { throw new UserFacingError('当前系统账户无法读取已保存的 Token，请重新填写。') }
    }
    let response: Response
    try {
      response = await this.request(config.endpoint + '/' + action, {
        method: 'POST', headers, body: JSON.stringify(params), redirect: 'error', signal: AbortSignal.timeout(12_000)
      })
    } catch { throw new Unconfirmed('连接中断或超时，请检查机器人地址与网络。') }
    if (response.status === 401 || response.status === 403) throw new UserFacingError('机器人拒绝访问，请检查 HTTP Token。')
    if (!response.ok) throw new Unconfirmed(`机器人返回 HTTP ${response.status}。`)
    const result = await response.json().catch(() => null)
    if (!result || typeof result.retcode !== 'number') throw new Unconfirmed('没有收到有效的 OneBot 回执。')
    if (result.status === 'async' || result.retcode === 1) throw new Unconfirmed('机器人已受理，但尚未确认结果。')
    if (result.retcode !== 0 || result.status === 'failed') throw new UserFacingError(`机器人拒绝了请求（${result.retcode}），请检查机器人权限和接收对象。`)
    return result.data ?? {}
  }

  async checkConnection(): Promise<string> {
    const data = await this.call(this.store.qqConfig(), 'get_login_info', {})
    if (!/^\d+$/.test(String(data.user_id))) throw new UserFacingError('未获取到机器人 QQ 号，请检查登录状态。')
    return `已连接：${String(data.nickname || 'QQ 机器人')}（${data.user_id}）`
  }

  test(): PushPanel {
    const config = this.store.qqConfig()
    if (!config.endpoint || !config.targetId) throw new UserFacingError('请先保存机器人地址和接收对象。')
    this.store.enqueueQq('test:' + randomUUID(), '测试消息', '【追更小报】这是一条 QQ 推送测试消息。', config, new Date().toISOString())
    void this.dispatch()
    return this.panel()
  }

  retry(id: string): PushPanel {
    const config = this.store.qqConfig()
    if ((!config.enabled && !id.startsWith('test:')) || !this.store.retryDelivery(id, config)) {
      throw new UserFacingError('无法重试，请确认通道已开启、接收配置与原记录一致。')
    }
    void this.dispatch()
    return this.panel()
  }

  async dispatch(): Promise<void> {
    if (this.running || this.stopped) return
    this.running = true
    try {
      while (!this.stopped) {
        const next = this.store.nextDelivery()
        if (!next) break
        const config = this.store.qqConfig()
        if (next.route !== qqRoute(config) || (!config.enabled && !next.id.startsWith('test:'))) {
          this.store.setDelivery(next.id, 'skipped', '推送配置已更改')
        } else {
          this.store.setDelivery(next.id, 'sending')
          this.changed()
          try {
            const group = config.targetType === 'group'
            const data = await this.call(config, group ? 'send_group_msg' : 'send_private_msg', {
              [group ? 'group_id' : 'user_id']: Number(config.targetId),
              message: [{ type: 'text', data: { text: next.body } }]
            })
            if (!['number','string'].includes(typeof data.message_id)) throw new Unconfirmed('机器人没有返回消息编号。')
            this.store.setDelivery(next.id, 'sent', `消息编号 ${data.message_id}`)
          } catch (error) {
            this.store.setDelivery(next.id, error instanceof Unconfirmed ? 'unknown' : 'failed',
              error instanceof UserFacingError ? error.message : '推送未完成。')
          }
        }
        this.changed()
      }
    } finally { this.running = false }
  }
}
