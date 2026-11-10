import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { Store, type WatchRecord } from '../src/main/store'
import { QqPush } from '../src/main/qq-push'
import { Monitor, type MonitorProvider } from '../src/main/monitor'
import type { UpdateEvent, QqPushDraft } from '../src/shared/types'

const config: QqPushDraft = { enabled: true, endpoint: 'http://127.0.0.1:3000', targetType: 'private', targetId: '123456', token: 'offline-test-token' }
const record: WatchRecord = { item: { id: '10001', series: {id:'10001',title:'测试作品',tags:[]}, paused:false,watchSeasons:true,
  addedAt:'2026-01-01T00:00:00Z',baselineReady:true,seasonCount:1,knownEpisodeCount:1 }, seasons:{},seasonBaselineReady:true }
const event = (id: string): UpdateEvent => ({ id, title:'测试作品', watchId:'10001',seriesId:'10001', kind:'episodes',
  message:'新增 1 集，现有 2 集。', createdAt:'2026-01-01T09:00:00Z', read:false })
function fixture(t: TestContext, transport: typeof fetch = fetch) {
  const dir = mkdtempSync(join(__dirname,'qq-push-'))
  const store = new Store(dir)
  const push = new QqPush(store, {
    encrypt: value => Buffer.from(value).toString('base64'),
    decrypt: value => Buffer.from(value, 'base64').toString()
  }, () => {}, transport)
  t.after(() => { push.stop(); store.close(); rmSync(dir,{recursive:true,force:true}) })
  return { dir, store, push }
}
async function settled(push: QqPush): Promise<void> {
  for (let i=0;i<200;i++) {
    if (push.panel().deliveries.every(row => row.status !== 'sending' && row.status !== 'pending')) return
    await delay(10)
  }
  throw Error('Push did not finish')
}

test('OneBot sends new events once after commit, uses the chosen recipient and keeps its token in the main process', async t => {
  const calls: { path: string; auth?: string; body: Record<string, unknown> }[] = []
  const server = createServer(async (req,res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    calls.push({path:req.url!,auth:req.headers.authorization,body:JSON.parse(Buffer.concat(chunks).toString())})
    res.setHeader('Content-Type','application/json')
    const data = req.url?.endsWith('get_login_info') ? {user_id:10001,nickname:'本地测试'} : {message_id:123}
    res.end(JSON.stringify({status:'ok',retcode:0,data}))
  })
  server.listen(0,'127.0.0.1')
  await once(server,'listening')
  t.after(() => { server.close(); server.closeAllConnections() })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const endpoint = 'http://127.0.0.1:'+address.port+'/bot'
  const {store,push} = fixture(t)
  store.commitCheck(record, [event('before-enabled')])
  store.saveSettings({...store.settings(),desktopNotifications:false})
  push.save({...config,endpoint})
  assert.ok(!JSON.stringify(push.panel()).includes(config.token!))
  assert.notEqual(store.qqConfig().cipher,config.token)
  assert.match(await push.checkConnection(),/10001/)
  assert.equal(store.commitCheck(record,[event('new')]).length,1)
  assert.equal(store.commitCheck(record,[event('new')]).length,0)
  await push.dispatch()
  await push.dispatch()
  assert.deepEqual(calls.map(c=>c.path),['/bot/get_login_info','/bot/send_private_msg'])
  assert.equal(calls[1].auth,'Bearer offline-test-token')
  assert.deepEqual(calls[1].body,{user_id:123456,message:[{type:'text',data:{text:'【追更小报 · 新集】\n《测试作品》\n新增 1 集，现有 2 集。'}}]})
  assert.equal(push.panel().deliveries[0].status,'sent')
  push.save({...config,endpoint,targetType:'group',targetId:'88888',token:undefined})
  push.test()
  await settled(push)
  assert.equal(calls.at(-1)?.path,'/bot/send_group_msg')
  assert.equal(calls.at(-1)?.body.group_id,88888)
})

test('destination changes cancel pending messages; uncertain sends are not repeated on restart', async t => {
  let calls = 0
  const {store,push} = fixture(t, async () => { calls++; throw Error('offline') })
  push.save(config)
  store.commitCheck(record,[event('old-target')])
  assert.throws(()=>push.save({...config,endpoint:'http://example.invalid',token:undefined}),/重新填写 Token/)
  push.save({...config,targetId:'654321',token:undefined})
  assert.equal(push.panel().deliveries[0].status,'skipped')
  store.commitCheck(record,[event('timeout'),event('interrupted')])
  store.setDelivery('interrupted','sending')
  push.start()
  await settled(push)
  assert.equal(calls,1)
  assert.equal(push.panel().deliveries.filter(d=>d.status==='unknown').length,2)
  assert.throws(()=>push.retry('timeout'))
  await push.dispatch()
  assert.equal(calls,1)
})

test('a OneBot rejection is visible and can be retried with updated credentials', async t => {
  let calls=0
  const {store,push} = fixture(t, async () => {
    calls++
    return calls===1 ? new Response(null,{status:401}) : Response.json({retcode:0,status:'ok',data:{message_id:77}})
  })
  push.save(config)
  store.commitCheck(record,[event('retry')])
  await push.dispatch()
  assert.equal(push.panel().deliveries[0].status,'failed')
  assert.match(push.panel().deliveries[0].detail,/Token/)
  push.save({...config,token:'changed'})
  push.retry('retry')
  await settled(push)
  assert.equal(push.panel().deliveries[0].status,'sent')
  assert.equal(calls,2)
})

test('normal monitoring pushes a newly listed season and its first episodes even when desktop notifications are off', async t => {
  const received: string[] = []
  const {dir,store,push} = fixture(t, async (_url, init) => {
    received.push(JSON.parse(String(init?.body)).message[0].data.text)
    return Response.json({status:'ok',retcode:0,data:{message_id:received.length}})
  })
  const first = {id:'10001',title:'第一季',index:1,episodeCount:1}
  const next = {id:'10002',title:'第二季',index:2,episodeCount:0}
  let announced = false
  const provider: MonitorProvider = {
    async seasonDirectory() { return { seasons: announced ? [first, next] : [first] } },
    async inspect(id, related = true) {
      const season = id === first.id ? first : next
      return {series:{...season,tags:[]},seasons:related && announced ? [first,next] : [season],seasonListAvailable:related}
    },
    async episodeIds(id) { return id === first.id ? ['20001'] : next.episodeCount ? ['20002'] : [] },
    async details() { return {series:{...first,tags:[]},seasons:[first]} },
    async browse() {return {items:[],hasMore:false}}, async filters() {return []}
  }
  store.saveSettings({...store.settings(),desktopNotifications:false})
  push.save(config)
  let desktopCalls = 0
  const monitor = new Monitor(dir,()=>{},()=>{desktopCalls++},provider,store,()=>{void push.dispatch()})
  await monitor.follow(first.id)
  assert.equal(received.length,0)
  announced = true
  await monitor.checkNow()
  await settled(push)
  next.episodeCount = 1
  await monitor.checkNow()
  await settled(push)
  await monitor.checkNow()
  assert.equal(desktopCalls,0)
  assert.equal(received.length,2)
  assert.match(received[0],/新季[\s\S]*预约/)
  assert.match(received[1],/新集[\s\S]*新增 1 集/)
})

test('official QQ and OneBot independently deliver the same desktop notification with scoped secrets and routes', async t => {
  const bodies: string[] = [], officialPaths: string[] = []
  let tokens = 0
  const { store, push, dir } = fixture(t, async (url, init) => {
    const payload = JSON.parse(String(init?.body))
    if (String(url).startsWith('https://bots.qq.com/')) {
      assert.deepEqual(payload, { appId: '123456', clientSecret: 'sample-secret' })
      tokens++
      return Response.json({ access_token: 'sample-token', expires_in: '3600' })
    }
    if (String(url).startsWith('https://api.sgroup.qq.com/')) {
      assert.equal(new Headers(init?.headers).get('Authorization'), 'QQBot sample-token')
      assert.equal(payload.msg_id, undefined)
      assert.equal(payload.msg_type, 0)
      bodies.push(payload.content)
      officialPaths.push(new URL(String(url)).pathname)
      return Response.json({ id: 'official-message-id' })
    }
    bodies.push(payload.message[0].data.text)
    return Response.json({ status: 'ok', retcode: 0, data: { message_id: 12 } })
  })
  const official = { enabled: true, appId: '123456', secret: 'sample-secret', targetType: 'private', targetId: 'user-openid' } as const
  push.saveOfficial(official)
  push.save(config)
  assert.ok(!JSON.stringify(push.panel()).includes(official.secret))
  const row = { id: '12345', title: '新番', episodeCount: 1, tags: [] }
  const provider: MonitorProvider = {
    async inspect() { return { series: row, seasons: [row], seasonListAvailable: true } },
    async seasonDirectory() { return { seasons: [row] } },
    async episodeIds() { return row.episodeCount === 1 ? ['12346'] : ['12346', '12347'] },
    async details() { return { series: row, seasons: [row] } },
    async browse() { return { items: [], hasMore: false } }, async filters() { return [] }
  }
  const desktop: string[] = []
  const monitor = new Monitor(dir, () => {}, (title, body) => desktop.push(title + '\n' + body), provider, store)
  await monitor.follow(row.id)
  row.episodeCount++
  await monitor.checkNow()
  await push.dispatch()
  assert.equal(desktop.length, 1)
  assert.deepEqual(bodies, [desktop[0], desktop[0]])
  push.saveOfficial({ ...official, secret: undefined, targetType: 'group', targetId: 'group-openid' })
  push.test('official')
  await settled(push)
  assert.deepEqual(officialPaths, ['/v2/users/user-openid/messages', '/v2/groups/group-openid/messages'])
  assert.equal(tokens, 1)
  assert.equal(push.panel().deliveries.filter(d => d.status === 'sent').length, 3)
})

test('changing official recipient preserves pending OneBot deliveries and surfaces platform refusals', async t => {
  const { store, push } = fixture(t, async url => String(url).includes('getAppAccessToken')
    ? Response.json({ access_token: 'token', expires_in: 3600 })
    : Response.json({ code: 40034024 }, { status: 403 }))
  push.save(config)
  const official = { enabled: true, appId: '123', secret: 'secret', targetType: 'group', targetId: 'group1' } as const
  push.saveOfficial(official)
  store.commitCheck(record, [event('both')])
  push.saveOfficial({ ...official, targetId: 'group2' })
  assert.deepEqual(store.deliveries().map(row => row.status), ['skipped','pending'])
  assert.throws(() => push.saveOfficial({ ...official, appId: '456', secret: undefined }), /AppSecret/)
  push.test('official')
  await settled(push)
  assert.equal(store.deliveries()[0].status, 'failed')
  assert.match(store.deliveries()[0].detail, /40034024/)
})
