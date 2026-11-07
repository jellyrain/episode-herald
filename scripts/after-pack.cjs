const fs = require('node:fs')
const path = require('node:path')

module.exports = function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const root = context.appOutDir
  const files = []
  const folders = []
  function walk(relative) {
    for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, item.name)
      if (/^(data|\.local-data)(\/|$)/i.test(name) || item.isSymbolicLink()) throw Error('Unexpected build input: ' + name)
      if (item.isDirectory()) { walk(name); folders.push(name) }
      else if (item.isFile()) files.push(name)
    }
  }
  walk('')
  const executable = 'episode-herald.exe'
  if (!files.includes(executable)) throw Error('Missing packaged executable')
  const manifest = 'program-files.json'
  files.push(manifest)
  fs.writeFileSync(path.join(root, manifest), JSON.stringify({ format: 1, executable, version: context.packager.appInfo.version, files }))
  // NSIS normally removes the entire install folder. Remove only shipped files.
  const escape = name => name.replaceAll('$', '$$$$').replaceAll('/', '\\')
  const commands = ['!macro customRemoveFiles', '  SetOutPath $TEMP']
  for (const file of new Set([...files, 'resources/elevate.exe', 'uninstallerIcon.ico'])) commands.push('  Delete "$INSTDIR\\' + escape(file) + '"')
  commands.push('  Delete "$INSTDIR\\${UNINSTALL_FILENAME}"')
  for (const folder of folders) commands.push('  RMDir "$INSTDIR\\' + escape(folder) + '"')
  commands.push('  RMDir "$INSTDIR"', '!macroend')
  fs.writeFileSync(path.join(context.packager.info.buildResourcesDir, 'remove-program-files.nsh'), commands.join('\n') + '\n')
}
