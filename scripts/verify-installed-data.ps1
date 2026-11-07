$ErrorActionPreference = 'Stop'
$setup = (Get-ChildItem -LiteralPath dist -Filter '*-setup.exe' -File).FullName
$target = [IO.Path]::GetFullPath((Join-Path $PWD 'dist/installed-test/episode-herald'))
if ($target -match '^C:' -or (Test-Path -LiteralPath $target)) { throw 'Expected an unused non-C test directory.' }
function Install-TestBuild {
  $process = Start-Process -FilePath $setup -ArgumentList @('/S',"/D=$target") -PassThru -Wait -WindowStyle Hidden
  if ($process.ExitCode -ne 0 -or !(Test-Path -LiteralPath (Join-Path $target 'episode-herald.exe'))) { throw "Install failed: $($process.ExitCode)" }
}
Install-TestBuild
$cache = Get-ChildItem -LiteralPath (Join-Path $target 'data/update-cache') -Recurse -File -Filter installer.exe
if (!$cache -or $cache.Length -ne (Get-Item -LiteralPath $setup).Length) { throw 'NSIS did not cache its installer beside the app.' }
$sentinel = Join-Path $target 'data/preservation-check.txt'
[IO.File]::WriteAllText($sentinel, 'keep')
Install-TestBuild
if ([IO.File]::ReadAllText($sentinel) -cne 'keep') { throw 'Upgrade lost application data.' }
$uninstaller = (Get-ChildItem -LiteralPath $target -File -Filter 'Uninstall*.exe').FullName
$p = Start-Process -FilePath $uninstaller -ArgumentList @('/S',"_?=$target") -PassThru -Wait -WindowStyle Hidden
if ($p.ExitCode -ne 0 -or (Test-Path -LiteralPath (Join-Path $target 'episode-herald.exe')) -or [IO.File]::ReadAllText($sentinel) -cne 'keep') { throw 'Uninstall did not preserve data.' }
