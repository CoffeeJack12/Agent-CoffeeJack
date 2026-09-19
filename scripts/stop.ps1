$ErrorActionPreference = 'Stop'
$coffeeRoot = Split-Path $PSScriptRoot -Parent
try {
  $coffeeStatus = Invoke-RestMethod 'http://127.0.0.1:3210/api/status' -TimeoutSec 3
  Invoke-RestMethod 'http://127.0.0.1:3210/api/stop' -Method Post -Headers @{'X-CoffeeJack-Token'=$coffeeStatus.token} | Out-Null
  Invoke-RestMethod 'http://127.0.0.1:3210/api/gaming' -Method Post -ContentType 'application/json' -Body '{"enabled":true}' -Headers @{'X-CoffeeJack-Token'=$coffeeStatus.token} | Out-Null
} catch { Write-Output 'App already stopped, or Ollama unavailable.' }
$coffeeExe = Join-Path $coffeeRoot '.runtime\node.exe'
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.ExecutablePath -eq $coffeeExe -and $_.CommandLine -match 'server/index.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId }
Write-Output 'CoffeeJack stopped. Ollama stays idle with models unloaded.'
