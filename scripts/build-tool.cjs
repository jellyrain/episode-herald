const { spawnSync } = require('node:child_process')
const { mkdirSync, realpathSync } = require('node:fs')
const { resolve, join } = require('node:path')

// Keep Electron downloads, NSIS tooling and their temporary files in this checkout.
const project = realpathSync.native(resolve(__dirname, '..'))
if (process.platform === 'win32' && /^c:[\\/]/i.test(project)) {
  throw Error('请在 C 盘以外的目录中构建追更小报。')
}
const cache = join(project, '.build-cache')
const temp = join(cache, 'temp')
mkdirSync(temp, { recursive: true })
const env = { ...process.env, electron_config_cache: join(cache, 'electron'),
  ELECTRON_BUILDER_CACHE: join(cache, 'electron-builder'), TMPDIR: temp, TEMP: temp, TMP: temp }
function run(file, args) {
  const child = spawnSync(process.execPath, [require.resolve(file), ...args], {
    cwd: project, env, stdio: 'inherit', windowsHide: true
  })
  if (child.error) throw child.error
  if (child.status !== 0) process.exit(child.status ?? 1)
}
if (process.argv[2] === 'setup') {
  run('electron/install.js', [])
  run('electron-builder/cli.js', ['install-app-deps'])
} else {
  run('electron-builder/cli.js', process.argv.slice(2))
}
