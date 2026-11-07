$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$package = Get-Content -Raw -Encoding utf8 -LiteralPath 'package.json' | ConvertFrom-Json
$source = (Resolve-Path -LiteralPath 'dist/win-unpacked').Path
$manifest = Get-Content -Raw -Encoding utf8 -LiteralPath (Join-Path $source 'program-files.json') | ConvertFrom-Json
if ($manifest.version -cne $package.version -or $manifest.executable -cne 'episode-herald.exe') { throw 'Build version mismatch.' }
$version = $package.version
$root = 'episode-herald'
$name = "episode-herald-$version-win-x64-portable.zip"
$output = Join-Path (Split-Path $source -Parent) $name
$stage = "$output.$([Guid]::NewGuid()).partial"
function Add-TextEntry($zip, [string]$path, [string]$text) {
  $entry = $zip.CreateEntry($path)
  $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
  try { $writer.Write($text) } finally { $writer.Dispose() }
}
try {
  $zip = [IO.Compression.ZipFile]::Open($stage, 'Create')
  try {
    # Collect the final payload: NSIS can add elevate.exe after afterPack.
    $files = @(Get-ChildItem -LiteralPath $source -Force -Recurse -File | ForEach-Object {
      $relative = $_.FullName.Substring($source.Length + 1).Replace('\','/')
      if ($relative -match '^(data|\.local-data|portable\.json)(/|$)' -or $_.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected data in release.' }
      if ($relative -ne 'program-files.json') {
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, "$root/$relative", 'Optimal') | Out-Null
        $relative
      }
    })
    $manifest.files = @($files) + @('portable.json','program-files.json')
    Add-TextEntry $zip "$root/portable.json" '{"edition":"portable"}'
    Add-TextEntry $zip "$root/program-files.json" ($manifest | ConvertTo-Json -Depth 5)
  } finally { $zip.Dispose() }
  Move-Item -LiteralPath $stage -Destination $output -Force
} finally { if ([IO.File]::Exists($stage)) { [IO.File]::Delete($stage) } }
$hash = (Get-FileHash -LiteralPath $output -Algorithm SHA512).Hash.ToLowerInvariant()
$metadata = @{version=$version; file=$name; bytes=(Get-Item -LiteralPath $output).Length; sha512=$hash}
[IO.File]::WriteAllText((Join-Path (Split-Path $source -Parent) 'latest-portable.json'), ($metadata | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Output "Created $name"
