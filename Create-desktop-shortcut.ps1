$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'DMK Chat Vault.lnk'))
$launcher = Join-Path $PSScriptRoot 'DMK-Chat-Vault.exe'
$shortcut.TargetPath = if (Test-Path -LiteralPath $launcher) { $launcher } else { Join-Path $PSScriptRoot 'Start.cmd' }
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.Description = 'Your permanent local WhatsApp archive'
$shortcut.Save()
Write-Host 'DMK Chat Vault shortcut created on your desktop.'
