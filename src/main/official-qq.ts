import type { OfficialQqDraft } from '../shared/types'
import { UserFacingError } from './provider'
import type { SavedOfficialConfig } from './store'

export class Unconfirmed extends UserFacingError {}

export function normalizeOfficial(input: unknown): OfficialQqDraft {
  const v = input as OfficialQqDraft
  if (!v || typeof v.enabled !== 'boolean' || !['private', 'group'].includes(v.targetType) ||
      typeof v.appId !== 'string' || typeof v.targetId !== 'string' ||
      (v.secret !== undefined && (typeof v.secret !== 'string' || !/^[\x21-\x7e]{0,2048}$/.test(v.secret)))) {
    throw new UserFacingError('请检查官方机器人的配置。')
  }
  const appId = v.appId.trim(), targetId = v.targetId.trim()
  if ((appId || v.enabled) && !/^\d{1,24}$/.test(appId)) throw new UserFacingError('请填写 QQ 开放平台提供的 AppID。')
  if ((targetId || v.enabled) && !/^[\w-]{1,128}$/.test(targetId)) throw new UserFacingError('请填写此机器人收到的用户或群 OpenID。')
  return { appId, targetId, enabled: v.enabled, targetType: v.targetType, secret: v.secret }
}

export class OfficialQq {
  private cached?: { appId: string; cipher: string; token: string; expires: number }

  constructor(private readonly decrypt: (cipher: string) => string, private readonly request: typeof fetch) {}

  async token(config: SavedOfficialConfig): Promise<string> {
    if (!config.appId || !config.cipher) throw new UserFacingError('请先保存 AppID 和 AppSecret。')
    if (this.cached && this.cached.appId === config.appId && this.cached.cipher === config.cipher &&
        this.cached.expires > Date.now()) return this.cached.token
    let clientSecret: string
    try { clientSecret = this.decrypt(config.cipher) }
    catch { throw new UserFacingError('无法解密 AppSecret，请重新填写。') }
    let response: Response
    try {
      response = await this.request('https://bots.qq.com/app/getAppAccessToken', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: config.appId, clientSecret }),
        redirect: 'error', signal: AbortSignal.timeout(12000) })
    } catch { throw new UserFacingError('无法连接 QQ 开放平台获取凭证。') }
    const data = await response.json().catch(() => null)
    if (!response.ok || typeof data?.access_token !== 'string' || !data.access_token) {
      throw new UserFacingError(`获取 QQ 凭证失败（${data?.code ?? response.status}），请核对 AppID 和 AppSecret。`)
    }
    const ttl = Number(data.expires_in) * 1000
    this.cached = { appId: config.appId, cipher: config.cipher, token: data.access_token,
      expires: Date.now() + ttl - Math.min(ttl / 3, 300000) }
    return data.access_token
  }

  async send(config: SavedOfficialConfig, content: string): Promise<string> {
    const scope = config.targetType === 'private' ? 'users' : 'groups'
    const url = `https://api.sgroup.qq.com/v2/${scope}/${encodeURIComponent(config.targetId)}/messages`
    for (let attempt = 0; ; attempt++) {
      const token = await this.token(config)
      let response: Response
      try {
        response = await this.request(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
          headers: { Authorization: 'QQBot ' + token, 'X-Union-Appid': config.appId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ msg_type: 0, content }) })
      } catch { throw new Unconfirmed('发送连接中断，请到 QQ 核实是否送达。') }
      if (response.status === 401 && attempt === 0) { this.cached = undefined; continue }
      const data = await response.json().catch(() => null)
      if (response.status >= 500) throw new Unconfirmed(`QQ 开放平台返回 HTTP ${response.status}，请核实是否送达。`)
      if (!response.ok || data?.code) {
        throw new UserFacingError(`QQ 平台拒绝发送（${data?.code ?? response.status}），请检查接收 OpenID、主动消息权限和额度。`)
      }
      if (typeof data?.id !== 'string' || !data.id) throw new Unconfirmed('QQ 开放平台未返回消息编号，请核实是否送达。')
      return data.id
    }
  }
}
