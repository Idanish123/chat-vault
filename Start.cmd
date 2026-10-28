@echo off
cd /d "%~dp0"
if exist "%~dp0DMK-Chat-Vault.exe" (
  start "DMK Chat Vault" "%~dp0DMK-Chat-Vault.exe"
) else (
  start "DMK Chat Vault" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start.ps1"
)
