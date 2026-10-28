param([int]$Port = 8765, [switch]$NoBrowser, [switch]$Quiet, [string]$LogDirectory)
$ErrorActionPreference = 'Stop'
$appRoot = Join-Path $PSScriptRoot 'app'
try { $release = Get-Content -LiteralPath (Join-Path $appRoot 'version.json') -Raw | ConvertFrom-Json }
catch { if ($NoBrowser) { throw }; Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.MessageBox]::Show('The release metadata is missing or damaged. Extract the complete release ZIP again.', 'Chat Vault', 'OK', 'Error') | Out-Null; exit 1 }
$sha = [Security.Cryptography.SHA256]::Create()
$rootHash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($appRoot).ToLowerInvariant())))).Replace('-', '').ToLowerInvariant()
$sha.Dispose()
if (-not $LogDirectory) { $LogDirectory = Join-Path $env:LOCALAPPDATA 'DMK Chat Vault\Logs' }
New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
$logPath = Join-Path $LogDirectory 'launcher.jsonl'
$address = "http://127.0.0.1:$Port"
$identity = 'DMKChatVault/' + $release.version + '/' + $release.build
$tokenBytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($tokenBytes); $rng.Dispose()
$controlToken = [Convert]::ToBase64String($tokenBytes)
$stopRequested = $false
$windows = @{}; $hadWindow = $false; $emptySince = [DateTime]::UtcNow
function Write-ActivityLog([string]$Action, [string]$Detail = '') {
  try {
    if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 1MB) { Move-Item -LiteralPath $logPath -Destination ($logPath + '.1') -Force }
    @{ at = [DateTime]::UtcNow.ToString('o'); action = $Action; detail = $Detail } | ConvertTo-Json -Compress | Add-Content -LiteralPath $logPath -Encoding UTF8
  } catch { if (-not $Quiet) { Write-Warning 'Launcher logging is unavailable. Check folder permissions.' } }
}
function Open-ChatVault {
  $candidates = @((Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'), (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'), (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'), (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'))
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { Start-Process -FilePath $candidate -ArgumentList "--app=$address/?desktop=1", '--no-first-run'; Write-ActivityLog 'browser.open' ([IO.Path]::GetFileName($candidate)); return }
  }
  throw 'Microsoft Edge or Google Chrome is required. Install one and open Chat Vault again.'
}
try {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
  try { $listener.Start(20) }
  catch {
    try { $health = (Invoke-WebRequest -Uri "$address/__dmk_health" -UseBasicParsing -TimeoutSec 3).Content | ConvertFrom-Json } catch { $health = $null }
    if ($health -and $health.identity -eq $identity -and $health.root -eq $rootHash) { if (-not $NoBrowser) { Open-ChatVault }; exit 0 }
    throw 'Another copy or an older version is running on the selected port. Close it using Close app (or close its old launcher window), then open this version again. Your saved library is separate from the application.'
  }
  $Port = $listener.LocalEndpoint.Port; $address = "http://127.0.0.1:$Port"
  Write-ActivityLog 'launcher.start' $identity
  if (-not $NoBrowser) { Open-ChatVault }
  if (-not $Quiet) { Write-Host "Chat Vault $($release.version) is ready at $address" }
  $allowed = @('index.html','styles.css','core.js','app.js','vault.js','library.js','archives.js','vendor-rar.js','processor.js','processor-worker.js','offline.html','version.json','dmk-chat-vault-source.zip')
  $mime = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.css'='text/css; charset=utf-8'; '.json'='application/json'; '.zip'='application/zip' }
  while (-not $stopRequested) {
    foreach ($windowId in @($windows.Keys)) { if (([DateTime]::UtcNow - $windows[$windowId]).TotalSeconds -gt 180) { $windows.Remove($windowId) } }
    if ($windows.Count) { $emptySince = [DateTime]::UtcNow }
    elseif (($hadWindow -and ([DateTime]::UtcNow - $emptySince).TotalSeconds -gt 5) -or (-not $hadWindow -and ([DateTime]::UtcNow - $emptySince).TotalSeconds -gt 180)) { Write-ActivityLog 'launcher.stop' 'no-active-windows'; break }
    if (-not $listener.Pending()) { Start-Sleep -Milliseconds 100; continue }
    $client = $listener.AcceptTcpClient()
    try {
      $client.ReceiveTimeout = 4000; $client.SendTimeout = 4000
      $stream = $client.GetStream(); $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 4096, $true)
      $request = $reader.ReadLine(); if (-not $request -or $request.Length -gt 4096) { continue }
      $requestHeaders = @{}; $count = 0
      while ($true) {
        $line = $reader.ReadLine(); if ($null -eq $line -or $line -eq '') { break }
        $count += $line.Length; if ($count -gt 16384) { throw 'Request header limit exceeded.' }
        $colon = $line.IndexOf(':'); if ($colon -lt 1) { throw 'Invalid request header.' }
        $name = $line.Substring(0, $colon).ToLowerInvariant(); if ($requestHeaders.ContainsKey($name)) { throw 'Duplicate request header.' }; $requestHeaders[$name] = $line.Substring($colon + 1).Trim()
      }
      $parts = $request.Split(' '); if ($parts.Length -ne 3) { continue }
      $method = $parts[0]; $route = [Uri]::UnescapeDataString(($parts[1] -split '\?')[0]).TrimStart('/'); if (-not $route) { $route = 'index.html' }
      $status = '200 OK'; $type = 'text/plain; charset=utf-8'; $text = ''; $body = $null; $extra = ''
      if ($requestHeaders['host'] -ne "127.0.0.1:$Port") { $status = '403 Forbidden'; $text = 'Invalid local host.' }
      elseif ($requestHeaders['origin'] -and $requestHeaders['origin'] -ne $address) { $status = '403 Forbidden'; $text = 'Cross-origin requests are not allowed.' }
      elseif ($route -eq '__dmk_shutdown' -and $method -eq 'POST') {
        if ($requestHeaders['x-dmk-token'] -ne $controlToken) { $status = '403 Forbidden'; $text = 'Invalid local control token.' }
        else { $text = 'Closed'; $stopRequested = $true; Write-ActivityLog 'launcher.stop' 'requested' }
      }
      elseif ($route -in @('__dmk_heartbeat','__dmk_leave') -and $method -eq 'POST') {
        $windowId = $requestHeaders['x-dmk-window']
        if ($requestHeaders['x-dmk-token'] -ne $controlToken -or $windowId -notmatch '^[a-f0-9-]{36}$') { $status='403 Forbidden'; $text='Invalid local window token.' }
        elseif ($route -eq '__dmk_leave') { $windows.Remove($windowId); $text='Window closed' }
        elseif ($windows.Count -ge 16 -and -not $windows.ContainsKey($windowId)) { $status='429 Too Many Requests'; $text='Too many app windows.' }
        else { $windows[$windowId]=[DateTime]::UtcNow; $hadWindow=$true; $text='Active' }
      }
      elseif ($method -notin @('GET','HEAD')) { $status = '405 Method Not Allowed'; $text = 'Only local control POST and static GET/HEAD are supported.' }
      elseif ($route -eq '__dmk_health') { $type = 'application/json'; $text = @{ identity=$identity; version=$release.version; build=$release.build; root=$rootHash } | ConvertTo-Json -Compress }
      elseif ($route -eq 'bootstrap.js') { $type = 'text/javascript; charset=utf-8'; $text = 'window.DMKDesktop=' + (@{ version=$release.version; build=$release.build; token=$controlToken } | ConvertTo-Json -Compress) + ';' }
      elseif ($route -eq 'dmk-chat-vault-pc.zip') {
        $packagePath = Join-Path $PSScriptRoot 'DMK-Chat-Vault-PC-portable.zip'
        if (Test-Path -LiteralPath $packagePath) { $body = [IO.File]::ReadAllBytes($packagePath); $type='application/zip'; $extra = "Content-Disposition: attachment; filename=DMK-Chat-Vault-PC-portable.zip`r`n" }
        else { $text = 'This is the installed PC edition. To share it, use the original portable ZIP or build a release from the source bundle.'; $status='404 Not Found' }
      }
      elseif ($route -notin $allowed) { $status = '404 Not Found'; $text = 'Not found' }
      else { $body = [IO.File]::ReadAllBytes((Join-Path $appRoot $route)); $ext = [IO.Path]::GetExtension($route); if ($mime.ContainsKey($ext)) { $type = $mime[$ext] } }
      if ($null -eq $body) { $body = [Text.Encoding]::UTF8.GetBytes($text) }
      $policy = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
      if ($route -eq 'offline.html') { $extra = "Content-Disposition: attachment; filename=DMK-Chat-Vault-Offline.html`r`n" }
      $headers = "HTTP/1.1 $status`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nX-Content-Type-Options: nosniff`r`nReferrer-Policy: no-referrer`r`nX-Frame-Options: DENY`r`nContent-Security-Policy: $policy`r`n${extra}Connection: close`r`n`r`n"
      $headerBytes = [Text.Encoding]::ASCII.GetBytes($headers); $stream.Write($headerBytes, 0, $headerBytes.Length); if ($method -ne 'HEAD') { $stream.Write($body, 0, $body.Length) }; $stream.Flush()
      $logRoute = if ($route -in $allowed -or $route -in @('bootstrap.js','__dmk_health','__dmk_shutdown')) { $route } else { 'unknown-route' }
      Write-ActivityLog 'http.request' ($method + ' ' + ($status -split ' ')[0] + ' ' + $logRoute)
    } catch { Write-ActivityLog 'http.error' $_.Exception.GetType().Name }
    finally { $client.Close() }
  }
} catch {
  Write-ActivityLog 'launcher.error' $_.Exception.GetType().Name
  if ($NoBrowser) { Write-Error $_.Exception.Message }
  else { Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Chat Vault could not start', 'OK', 'Error') | Out-Null }
  exit 1
} finally { if ($listener) { $listener.Stop() } }
