$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$helper = (Resolve-Path -LiteralPath 'resources/updater/portable-install.ps1').Path
$system = [Environment]::GetFolderPath('System')
$probe = [IO.Directory]::CreateDirectory((Join-Path $PWD ("test-results/portable-window-" + [guid]::NewGuid()))).FullName
$source = Join-Path $probe 'WindowProbe.cs'
$probeExe = Join-Path $probe 'WindowProbe.exe'
[IO.File]::WriteAllText($source, @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

class WindowProbe {
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [STAThread] static void Main() {
    using (var form = new Form()) {
      form.Text = "Episode Herald - update test";
      // The first ShowWindow uses the show state supplied by the updater.
      ShowWindow(form.Handle, 1);
      File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data", "window.txt"),
        IsWindowVisible(form.Handle) ? "visible" : "hidden");
    }
  }
}
'@)
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $compiler /nologo /target:winexe /reference:System.Windows.Forms.dll "/out:$probeExe" $source
if ($LASTEXITCODE -ne 0) { throw 'Failed to build window probe.' }
foreach ($rollback in @($false, $true)) {
  $case = [IO.Directory]::CreateDirectory((Join-Path $PWD ("test-results/portable-" + [Guid]::NewGuid()))).FullName
  $program = Join-Path $case 'current'
  $staged = Join-Path $case 'episode-herald'
  $job = Join-Path $program 'data/update-cache/p-test'
  foreach ($p in $staged,$job) { [IO.Directory]::CreateDirectory($p) | Out-Null }
  $exe = 'episode-herald.exe'
  Copy-Item -LiteralPath $probeExe -Destination (Join-Path $program $exe)
  if ($rollback) { [IO.File]::WriteAllText((Join-Path $staged $exe), 'not executable') }
  else { Copy-Item -LiteralPath $probeExe -Destination (Join-Path $staged $exe) }
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
  $expectedVersion = if ($rollback) {'1.0.1'} else {'1.0.2'}
  $manifest = Get-Content -Raw -LiteralPath (Join-Path $program 'program-files.json') | ConvertFrom-Json
  if ($manifest.version -ne $expectedVersion -or (Get-FileHash -LiteralPath (Join-Path $program $exe)).Hash -ne (Get-FileHash -LiteralPath $probeExe).Hash) { throw 'Wrong program after portable update.' }
  $window = Join-Path $program 'data/window.txt'
  for ($i=0; $i -lt 100 -and !(Test-Path -LiteralPath $window); $i++) { Start-Sleep -Milliseconds 100 }
  if (!(Test-Path -LiteralPath $window) -or [IO.File]::ReadAllText($window) -cne 'visible') { throw 'The relaunched application did not show its window.' }
}
Write-Output 'Portable upgrade and rollback both showed the application window and preserved the data directory.'
