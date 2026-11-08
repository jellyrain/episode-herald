# Adapted for Episode Herald from Wanxiang Workshop (Apache-2.0).
param([Parameter(Mandatory=$true)][string]$Config, [switch]$Launch)
$ErrorActionPreference = 'Stop'
$job = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Launch) {
    $worker = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$PSCommandPath+'"'),'-Config',('"'+$Config+'"')) -WindowStyle Hidden -PassThru
    for ($attempt=0; $attempt -lt 500 -and -not [IO.File]::Exists($job.ready) -and -not $worker.HasExited; $attempt++) { Start-Sleep -Milliseconds 100 }
    if (-not [IO.File]::Exists($job.ready)) { if (-not $worker.HasExited) { $worker.Kill() }; throw 'Update worker did not become ready.' }
    exit 0
}
function LongPath([string]$path) { if ($path.StartsWith('\\')) { return '\\?\UNC\'+$path.Substring(2) }; return '\\?\'+$path }
function SafeRelative([string]$name) {
    if (-not $name -or $name.Contains('\') -or $name.Contains(':') -or $name.StartsWith('/')) { throw 'Invalid archive path.' }
    foreach ($part in $name.Split('/')) {
        if (-not $part -or $part -eq '.' -or $part -eq '..' -or $part -match '[<>"|?*\x00-\x1f]' -or $part -match '[. ]$' -or $part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)') { throw 'Unsafe archive path.' }
    }
    if ($name.Split('/')[0] -ieq 'data') { throw 'An update cannot contain or replace user data.' }
}
function Manifest([string]$folder) {
    $value = [IO.File]::ReadAllText((LongPath (Join-Path $folder 'program-files.json'))) | ConvertFrom-Json
    if ($value.format -ne 1 -or $value.executable -ne $job.executable -or -not $value.files -or $value.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid program manifest.' }
    $names = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in $value.files) { SafeRelative $file; if (-not $names.Add($file)) { throw 'Duplicate program entry.' } }
    if (-not $names.Contains('program-files.json') -or -not $names.Contains($job.executable)) { throw 'Incomplete program manifest.' }
    return $value
}
function MoveEntry([string]$source,[string]$destination) {
    $item = Get-Item -LiteralPath $source -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked program entries are not supported.' }
    if ($item.PSIsContainer) { [IO.Directory]::Move((LongPath $source),(LongPath $destination)) }
    else { [IO.File]::Move((LongPath $source),(LongPath $destination)) }
}
function StartUpdatedApp {
    Start-Process -FilePath (Join-Path $directory $job.executable) -WorkingDirectory $directory -WindowStyle Normal -ErrorAction Stop | Out-Null
}
$oldMoved = New-Object 'Collections.Generic.List[string]'
$newMoved = New-Object 'Collections.Generic.List[string]'
$directory = [IO.Path]::GetFullPath($job.directory)
$work = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($Config))
$backup = Join-Path $work 'previous'
$payload = Join-Path $work 'new'
try {
    if (-not $work.StartsWith(($directory+'\data\update-cache\'),[StringComparison]::OrdinalIgnoreCase) -or $job.root -ne 'episode-herald') { throw 'Invalid update working directory.' }
    SafeRelative $job.executable
    if ($job.executable.Contains('/')) { throw 'Invalid executable name.' }
    foreach ($folder in @($directory,(Join-Path $directory 'data'),(Join-Path $directory 'data\update-cache'),$work)) {
        if ((Get-Item -LiteralPath $folder -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked update directory is not supported.' }
    }
    $old = Manifest $directory
    $algorithm = [Security.Cryptography.SHA512]::Create(); $stream = [IO.File]::OpenRead($job.archive)
    try { $actual = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() } finally { $stream.Dispose(); $algorithm.Dispose() }
    if ($actual -ne $job.sha512) { throw 'Update checksum mismatch.' }
    if ([IO.Directory]::Exists($payload) -or [IO.Directory]::Exists($backup)) { throw 'Update staging already exists; download again.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($job.archive)
    $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    [long]$expanded = 0
    try {
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName.TrimEnd('/')
            if ($name -eq $job.root -and $entry.FullName.EndsWith('/')) { continue }
            if (-not $name.StartsWith(($job.root+'/'),[StringComparison]::Ordinal)) { throw 'ZIP must contain one application folder.' }
            $relative = $name.Substring($job.root.Length+1); SafeRelative $relative
            if (-not $seen.Add($relative) -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Duplicate or linked ZIP entry.' }
            $expanded += $entry.Length; if ($expanded -gt 3GB -or $seen.Count -gt 50000) { throw 'ZIP exceeds update limits.' }
            $destination = Join-Path (Join-Path $payload $job.root) $relative
            if ($entry.FullName.EndsWith('/')) { [IO.Directory]::CreateDirectory((LongPath $destination)) | Out-Null; continue }
            [IO.Directory]::CreateDirectory((LongPath ([IO.Path]::GetDirectoryName($destination)))) | Out-Null
            $inputStream=$entry.Open(); $outputStream=[IO.File]::Open((LongPath $destination),[IO.FileMode]::CreateNew)
            try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
        }
    } finally { $archive.Dispose() }
    $staged=Join-Path $payload $job.root; $next=Manifest $staged
    if ($next.version -ne $job.version -or -not [IO.File]::Exists((Join-Path $staged 'portable.json'))) { throw 'Wrong update version or edition.' }
    foreach ($file in $next.files) { if (-not [IO.File]::Exists((LongPath (Join-Path $staged $file)))) { throw 'Update file missing.' } }
    if ([IO.Directory]::GetFiles((LongPath $staged),'*',[IO.SearchOption]::AllDirectories).Count -ne $next.files.Count) { throw 'Unexpected update files.' }
    $oldRoots=@($old.files | ForEach-Object { $_.Split('/')[0] } | Sort-Object -Unique)
    $newRoots=@($next.files | ForEach-Object { $_.Split('/')[0] } | Sort-Object -Unique)
    foreach ($name in $newRoots) { if ((Test-Path -LiteralPath (Join-Path $directory $name)) -and $name -notin $oldRoots) { throw 'Update would overwrite an unrecognized file.' } }
    [IO.Directory]::CreateDirectory($backup) | Out-Null
    [IO.File]::WriteAllText($job.ready,'ready')
    $parent=Get-Process -Id $job.pid -ErrorAction SilentlyContinue
    if ($parent) {
        try { $parent | Wait-Process -Timeout 300 -ErrorAction Stop }
        catch { if (-not $parent.HasExited) { throw } }
    }
    foreach ($name in $oldRoots) {
        $source=Join-Path $directory $name
        if (-not (Test-Path -LiteralPath $source)) { continue }
        for ($attempt=0; $attempt -lt 120; $attempt++) {
            try { MoveEntry $source (Join-Path $backup $name); $oldMoved.Add($name); break }
            catch { if ($attempt -eq 119) { throw }; Start-Sleep -Milliseconds 250 }
        }
    }
    foreach ($name in $newRoots) { MoveEntry (Join-Path $staged $name) (Join-Path $directory $name); $newMoved.Add($name) }
    StartUpdatedApp
    [IO.File]::WriteAllText($job.result,(@{ok=$true;backup=$backup;version=$job.version} | ConvertTo-Json))
} catch {
    $failure=$_.Exception.Message
    try {
        for ($i=$newMoved.Count-1; $i -ge 0; $i--) { $name=$newMoved[$i]; MoveEntry (Join-Path $directory $name) (Join-Path $staged $name) }
        for ($i=$oldMoved.Count-1; $i -ge 0; $i--) { $name=$oldMoved[$i]; MoveEntry (Join-Path $backup $name) (Join-Path $directory $name) }
        if ($oldMoved.Count) { StartUpdatedApp }
    } catch { $failure += ' Recovery: '+$_.Exception.Message }
    [IO.File]::WriteAllText($job.result,(@{ok=$false;error=$failure;backup=$backup} | ConvertTo-Json)); exit 1
}
