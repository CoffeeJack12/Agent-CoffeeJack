param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$coffeeRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $coffeeRoot
$coffeeNode = Join-Path $coffeeRoot '.runtime\node.exe'
if (-not (Test-Path -LiteralPath $coffeeNode)) { $coffeeNode = (Get-Command node -ErrorAction Stop).Source }
$env:PATH = (Split-Path $coffeeNode -Parent) + ';' + (Join-Path $coffeeRoot 'node_modules\.bin') + ';' + $env:PATH
$coffeeGit = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd'
if (Test-Path -LiteralPath $coffeeGit) { $env:PATH = $coffeeGit + ';' + $env:PATH }
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $coffeeRoot '.runtime\browsers'
$env:OLLAMA_MODELS = Join-Path $coffeeRoot '.runtime\models'
$env:OLLAMA_HOST = '127.0.0.1:11434'
$env:OLLAMA_NO_CLOUD = '1'
$env:OLLAMA_MAX_LOADED_MODELS = '1'
$env:OLLAMA_NUM_PARALLEL = '1'
$env:COFFEEJACK_PORT = '3210'
New-Item -ItemType Directory -Force (Join-Path $coffeeRoot '.local\logs') | Out-Null
try { Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2 | Out-Null }
catch {
  $coffeeOllama = Join-Path $coffeeRoot '.runtime\ollama\ollama.exe'
  if (-not (Test-Path -LiteralPath $coffeeOllama)) { $coffeeOllama = (Get-Command ollama -ErrorAction Stop).Source }
  Start-Process -FilePath $coffeeOllama -ArgumentList 'serve' -WindowStyle Hidden -WorkingDirectory $coffeeRoot -RedirectStandardOutput (Join-Path $coffeeRoot '.local\logs\ollama-out.log') -RedirectStandardError (Join-Path $coffeeRoot '.local\logs\ollama-error.log')
}
$coffeeRunning = $false
try { $coffeeStatus = Invoke-RestMethod 'http://127.0.0.1:3210/api/status' -TimeoutSec 3; $coffeeRunning = [bool]$coffeeStatus.token } catch {}
if (-not $coffeeRunning) {
  $coffeeProcess = Start-Process -FilePath $coffeeNode -ArgumentList 'server/index.mjs' -WorkingDirectory $coffeeRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $coffeeRoot '.local\logs\app-out.log') -RedirectStandardError (Join-Path $coffeeRoot '.local\logs\app-error.log')
  try { $coffeeProcess.PriorityClass = 'BelowNormal' } catch {}
  $coffeeReady = $false
  for ($coffeeAttempt=0; $coffeeAttempt -lt 20; $coffeeAttempt++) {
    Start-Sleep -Milliseconds 500
    try { Invoke-RestMethod 'http://127.0.0.1:3210/api/status' -TimeoutSec 3 | Out-Null; $coffeeReady = $true; break } catch {}
  }
  if (-not $coffeeReady) { throw 'CoffeeJack did not start. Check .local\logs\app-error.log.' }
}
if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:3210' }
Write-Output 'CoffeeJack is ready at http://127.0.0.1:3210'
