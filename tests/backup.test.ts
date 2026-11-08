import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { exportBackup, readBackup, restoreBackup } from '../src/main/backup'
import { QqPush, type TokenStorage } from '../src/main/qq-push'
import { Store, type WatchRecord } from '../src/main/store'

const now = '2026-11-07T00:00:00.000Z'
const title = '备份样本'
const record: WatchRecord = {
  item: { id: '12345', addedAt: now, series: { id: '12345', title, tags: ['剧情'] }, paused: true,
    baselineReady: true, watchSeasons: true, seasonCount: 1, knownEpisodeCount: 1 },
  seasons: { '12345': { id: '12345', title, index: 1, episodeIds: ['98765'], baselineReady: true } },
  seasonBaselineReady: true
}
const thumb = 'c'.repeat(64) + '.thumb'
function keys(prefix: string): TokenStorage {
  return { encrypt: value => prefix + value, decrypt: value => {
    if (!value.startsWith(prefix)) throw Error('different account')
    return value.slice(prefix.length)
  } }
}
function setup(t: TestContext): { source: Store; target: Store; file: string } {
  const dir = mkdtempSync(join(__dirname, 'backup-test-'))
  const source = new Store(join(dir, 'one')), target = new Store(join(dir, 'two'))
  t.after(() => { source.close(); target.close(); rmSync(dir, { recursive: true, force: true }) })
  source.saveSettings({theme:'light', autoCheck:false, checkTime:'18:20', desktopNotifications:false, closeToTray:false})
  source.saveCheckState({ lastCheckAt:now, lastCheckSummary:'完成' })
  source.saveQq({enabled:true,endpoint:'http://127.0.0.1:3000',targetId:'123456',targetType:'group',cipher:'old-secretTOKEN'})
  source.commitCheck(record,[{id:'update-1', watchId:'12345', seriesId:'12345', title, createdAt:now, message:'新增 1 集。',kind:'episodes',read:true}])
  mkdirSync(join(source.dataPath,'covers'))
  writeFileSync(join(source.dataPath,'covers',thumb),Buffer.from([0xff,0xd8,0xff,0xf1]))
  writeFileSync(join(source.dataPath,'anonymous.json'),'private-device-file')
  return {source,target,file:join(dir,'backup.ehbackup')}
}

test('encrypted backup restores complete watch state, settings, cached art and a working QQ token on another account', async t => {
  const {source,target,file} = setup(t)
  const route = source.qqConfig()
  for (const [id, status] of [['a','sending'],['b','sent'],['c','failed']] as const) {
    source.enqueueQq(id,title,id,route,now)
    source.setDelivery(id,status,'receipt')
  }
  await exportBackup(file,'sample password','grid',source,keys('old-'))
  const bytes = readFileSync(file)
  for (const secret of ['secretTOKEN',title,'private-device-file','127.0.0.1']) assert.equal(bytes.includes(Buffer.from(secret)),false)
  const data = await readBackup(file,'sample password')
  assert.equal(data.view,'grid')
  await restoreBackup(data,target,keys('new-'),()=>{})
  assert.deepEqual(target.watches(),source.watches())
  assert.deepEqual(target.events(),source.events())
  assert.deepEqual(target.checkState(),source.checkState())
  assert.deepEqual(target.settings(),source.settings())
  assert.deepEqual(target.qqConfig(),{...source.qqConfig(),cipher:'new-secretTOKEN'})
  assert.deepEqual(readFileSync(join(target.dataPath,'covers',thumb)),readFileSync(join(source.dataPath,'covers',thumb)))
  assert.equal(target.nextDelivery(),undefined)
  assert.deepEqual(target.deliveries().map(row=>row.status),['failed','sent','unknown','skipped'])
  const requests: string[] = []
  const push = new QqPush(target,keys('new-'),()=>{},async (url, init) => {
    requests.push(String(url)); assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer secretTOKEN')
    return Response.json({retcode:0, data:{user_id:123456,nickname:'样本'}})
  })
  await push.dispatch()
  assert.equal(requests.length,0)
  assert.match(await push.checkConnection(), /样本/)
  await restoreBackup(data,target,keys('new-'),()=>{})
  assert.equal(target.events().length,1)
  assert.equal(target.deliveries().length,4)
})

test('bad password or damaged backup is rejected; an unreadable QQ token cannot replace a good backup', async t => {
  const {source,file} = setup(t)
  await exportBackup(file,'right','list',source,keys('old-'))
  const saved = readFileSync(file)
  await assert.rejects(readBackup(file,'wrong'), /密码/)
  await assert.rejects(exportBackup(file,'right','grid',source,keys('wrong-')), /QQ Token/)
  assert.deepEqual(readFileSync(file),saved)
  saved[saved.length-1] ^= 1
  writeFileSync(file,saved)
  await assert.rejects(readBackup(file,'right'), /损坏/)
})

test('a busy monitor at commit time rolls back added covers and a failed database transaction retains local data', async t => {
  const {source,target,file} = setup(t)
  target.saveSettings({...target.settings(),checkTime:'13:55'})
  await exportBackup(file,'pw','list',source,keys('old-'))
  const data = await readBackup(file,'pw')
  let checks = 0
  await assert.rejects(restoreBackup(data,target,keys('new-'),()=>{ if (++checks === 2) throw Error('busy') }),/busy/)
  assert.equal(existsSync(join(target.dataPath,'covers',thumb)), false)
  data.events.push(data.events[0])
  await assert.rejects(restoreBackup(data,target,keys('new-'),()=>{}),/UNIQUE/)
  assert.equal(existsSync(join(target.dataPath,'covers',thumb)),false)
  assert.equal(target.settings().checkTime,'13:55')
  assert.equal(target.watches().length,0)
  assert.equal(target.events().length,0)
})
