$ErrorActionPreference = "SilentlyContinue"
$repo = "C:\Users\Abdul\CoffeeJack"
$url = "http://127.0.0.1:3210"
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

$listening = Get-NetTCPConnection -LocalPort 3210 -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c cd /d `"$repo`" && npm start" -WindowStyle Hidden
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    $listening = Get-NetTCPConnection -LocalPort 3210 -State Listen -ErrorAction SilentlyContinue
    if ($listening) { break }
  }
}

if (Test-Path $edge) {
  Start-Process -FilePath $edge -ArgumentList "--app=$url","--start-maximized"
} else {
  Start-Process $url
}