param([string]$Destination, [switch]$NoShortcut)
$ErrorActionPreference = 'Stop'
if (-not $Destination) { $Destination = Join-Path $env:LOCALAPPDATA 'Programs\DMK Chat Vault' }
try {
  if ([IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') -eq [IO.Path]::GetFullPath($destination).TrimEnd('\')) { throw 'This copy is already installed. Open DMK-Chat-Vault.exe.' }
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'DMK-Chat-Vault.exe'))) { throw 'Use the complete Windows release ZIP. The application launcher is missing.' }
  try { $health = (Invoke-WebRequest 'http://127.0.0.1:8765/__dmk_health' -UseBasicParsing -TimeoutSec 2).Content } catch { $health = $null }
  if ($health -and (Test-Path -LiteralPath (Join-Path $destination 'app'))) { throw 'Close Chat Vault using Close app (or close its earlier launcher window) before updating.' }
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'app') -Destination $destination -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'licenses') -Destination $destination -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'media') -Destination $destination -Recurse -Force
  foreach ($name in @('Start.ps1','Start.cmd','DMK-Chat-Vault.exe','README.md','READ-ME-FIRST.txt')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $destination -Force }
  if (-not $NoShortcut) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'DMK Chat Vault.lnk'))
    $shortcut.TargetPath = Join-Path $destination 'DMK-Chat-Vault.exe'; $shortcut.WorkingDirectory = $destination; $shortcut.Description = 'Private WhatsApp export archive'; $shortcut.Save()
  }
  Write-Host "Installed for your Windows account: $destination"
  Write-Host 'Open DMK Chat Vault from Start. Your chat library stays in the folder you choose separately.'
} catch { Write-Error $_.Exception.Message; exit 1 }
