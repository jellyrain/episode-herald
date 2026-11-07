import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { resolve, join } from 'node:path'

// The CI runner is a fresh Windows account. Only the loopback debugger is reachable.
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const port = 19371
const directory = resolve(process.argv[2] || 'dist/win-unpacked')
const portable = process.argv[3] === 'portable'
const child = spawn(join(directory, pkg.name + '.exe'), [
  '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'
], { windowsHide: true, stdio: 'ignore' })
let socket
try {
  let page
  for (let i = 0; i < 60 && !page; i++) {
    assert.equal(child.exitCode, null, 'Packaged app exited at startup')
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/list')
      page = (await response.json()).find(tab => tab.type === 'page' && tab.url.startsWith('file:'))
    } catch { /* Chromium may still be starting. */ }
    if (!page) await delay(250)
  }
  assert.ok(page, 'Packaged window did not open')
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((ok, fail) => { socket.onopen = ok; socket.onerror = fail })
  const reply = new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(Error('Timed out checking packaged window')), 8000)
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data)
      if (message.id === 1) { clearTimeout(timer); ok(message) }
    }
  })
  socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      const state = await window.hongguo.appUpdateStatus();
      const snapshot = await window.hongguo.snapshot();
      return { title: document.title, update: state.value, data: snapshot.value?.dataPath };
    })()` } }))
  const result = (await reply).result
  assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description)
  const value = result.result.value
  assert.equal(value.title, pkg.productName)
  assert.equal(value.data.toLowerCase(), join(directory, 'data').toLowerCase())
  for (const path of ['hongguo.sqlite', 'chromium', 'update-cache', 'logs', 'temp', 'crashes']) {
    await access(join(value.data, path))
  }
  assert.equal(value.update.portable, portable)
  assert.equal(value.update.currentVersion, pkg.version)
  assert.notEqual(value.update.phase, 'development')
  console.log('Packaged app, database and Windows updater verified.')
} finally {
  socket?.close()
  child.kill()
  if (child.exitCode === null && child.signalCode === null) await new Promise(ok => child.once('exit', ok))
}
