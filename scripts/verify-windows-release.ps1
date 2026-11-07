$ErrorActionPreference = 'Stop'
$package = Get-Content -Raw -Encoding utf8 -LiteralPath 'package.json' | ConvertFrom-Json
$name = "$($package.name)-$($package.version)-setup.exe"
$feed = Get-Content -Raw -Encoding utf8 -LiteralPath 'dist/latest.yml'
$config = Get-Content -Raw -Encoding utf8 -LiteralPath 'dist/win-unpacked/resources/app-update.yml'
if (!$config.Contains('https://github.com/jellyrain/episode-herald/releases/latest/download/')) {
  throw 'The packaged app does not point to the stable release feed.'
}
foreach ($file in @("dist/$name", "dist/$name.blockmap", "dist/win-unpacked/$($package.name).exe")) {
  if ((Get-Item -LiteralPath $file).Length -le 0) { throw "Empty release file: $file" }
}
$stream = [IO.File]::OpenRead((Resolve-Path -LiteralPath "dist/$name").Path)
try { $sha = [Convert]::ToBase64String([Security.Cryptography.SHA512]::HashData($stream)) }
finally { $stream.Dispose() }
foreach ($line in @("version: $($package.version)", "path: $name", "sha512: $sha", "- url: $name", "size: $((Get-Item -LiteralPath "dist/$name").Length)")) {
  if (($feed -split '\r?\n' | ForEach-Object { $_.Trim() }) -cnotcontains $line) { throw "Invalid update manifest entry: $line" }
}
Write-Output "Verified installer, blockmap and stable update feed for $name"
