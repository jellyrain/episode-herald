$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$helper = (Resolve-Path -LiteralPath 'resources/updater/portable-install.ps1').Path
$system = [Environment]::GetFolderPath('System')
foreach ($rollback in @($false, $true)) {
  $case = [IO.Directory]::CreateDirectory((Join-Path $PWD ("test-results/portable-" + [Guid]::NewGuid()))).FullName
  $program = Join-Path $case 'current'
  $staged = Join-Path $case 'episode-herald'
  $job = Join-Path $program 'data/update-cache/p-test'
  foreach ($p in $staged,$job) { [IO.Directory]::CreateDirectory($p) | Out-Null }
  $exe = 'episode-herald.exe'
  Copy-Item -LiteralPath (Join-Path $system 'where.exe') -Destination (Join-Path $program $exe)
  if ($rollback) { [IO.File]::WriteAllText((Join-Path $staged $exe), 'not executable') }
  else { Copy-Item -LiteralPath (Join-Path $system 'hostname.exe') -Destination (Join-Path $staged $exe) }
  $index = @{format=1; executable=$exe; files=@($exe,'portable.json','program-files.json')}
  foreach ($p in $program,$staged) {
    $index.version = if ($p -eq $program) {'1.0.1'} else {'1.0.2'}
    [IO.File]::WriteAllText((Join-Path $p 'program-files.json'), ($index | ConvertTo-Json))
    [IO.File]::WriteAllText((Join-Path $p 'portable.json'), '{}')
  }
  $record = Join-Path $program 'data/keep.txt'
  [IO.File]::WriteAllText($record,'keep')
  $archive = Join-Path $job 'update.zip'
  [IO.Compression.ZipFile]::CreateFromDirectory($staged,$archive,'Optimal',$true)
  $result = Join-Path $program 'data/update-cache/portable-result.json'
  $config = Join-Path $job 'install.json'
  $request = @{pid=2147483647; directory=$program; executable=$exe; archive=$archive; root='episode-herald'; version='1.0.2'; sha512=(Get-FileHash -LiteralPath $archive -Algorithm SHA512).Hash.ToLowerInvariant(); ready=(Join-Path $job 'ready'); result=$result}
  [IO.File]::WriteAllText($config, ($request | ConvertTo-Json))
  $ps = Join-Path $system 'WindowsPowerShell/v1.0/powershell.exe'
  $worker = Start-Process -FilePath $ps -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"' + $helper + '"'),'-Config',('"' + $config + '"')) -WindowStyle Hidden -Wait -PassThru
  $report = Get-Content -Raw -Encoding utf8 -LiteralPath $result | ConvertFrom-Json
  if ($report.ok -eq $rollback -or [IO.File]::ReadAllText($record) -cne 'keep') {throw "Unexpected portable result: $($report | ConvertTo-Json)"}
  $expected = if ($rollback) {'where.exe'} else {'hostname.exe'}
  if ((Get-FileHash -LiteralPath (Join-Path $program $exe)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $system $expected)).Hash) {throw 'Wrong program after portable update.'}
}
Write-Output 'Portable upgrade and rollback both preserved the data directory.'
