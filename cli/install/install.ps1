# Installs the hivenod agent CLI on Windows: irm https://hivenod.com/install.ps1 | iex
# Downloads hivenod-windows-x64.exe from the release manifest, checks its SHA-256 checksum
# (manifest and the .sha256 file must both match) and puts it in $env:HIVENOD_INSTALL_DIR
# (default %LOCALAPPDATA%\hivenod), added to the user PATH. Nothing is installed if a check fails.
$ErrorActionPreference = 'Stop'
$site = if ($env:HIVENOD_WEB_URL) { $env:HIVENOD_WEB_URL.TrimEnd('/') } else { 'https://hivenod.com' }
$dir = if ($env:HIVENOD_INSTALL_DIR) { $env:HIVENOD_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'hivenod' }
if (-not [Environment]::Is64BitOperatingSystem) { throw 'hivenod needs 64-bit Windows' }
$target = 'windows-x64'
$m = Invoke-RestMethod "$site/cli/bin/latest.json?t=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
$f = $m.files.$target
if (-not $f -or $f.sha256 -notmatch '^[0-9a-f]{64}$') { throw "the release has no binary for $target" }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("hivenod-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Downloading hivenod $($m.version) for $target..."
  $exe = Join-Path $tmp 'hivenod.exe'
  Invoke-WebRequest "$site$($f.path)" -OutFile $exe -UseBasicParsing
  $side = (Invoke-WebRequest "$site$($f.path).sha256" -UseBasicParsing).Content
  if ($side -is [byte[]]) { $side = [Text.Encoding]::ASCII.GetString($side) }
  $got = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $f.sha256 -or $got -ne ($side -split '\s+')[0].ToLower()) { throw "checksum mismatch (got $got): nothing was installed" }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Move-Item -Force $exe (Join-Path $dir 'hivenod.exe')
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $dir) {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$dir", 'User')
  Write-Host "Added $dir to your user PATH (open a new terminal to use it)."
}
& (Join-Path $dir 'hivenod.exe') --version
Write-Host "Next: hivenod pair, then install the hivenod plugin in Claude Code ($site/agents)."
