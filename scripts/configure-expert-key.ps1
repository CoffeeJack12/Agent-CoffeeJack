$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root ".env"

$provider = (Read-Host "Provider [gemini/groq] (default: gemini)").Trim().ToLowerInvariant()
if (-not $provider) { $provider = "gemini" }
if ($provider -notin @("gemini", "groq")) {
  throw "Provider must be gemini or groq."
}

$name = if ($provider -eq "groq") { "GROQ_API_KEY" } else { "GEMINI_API_KEY" }
$secure = Read-Host "Paste the $provider API key (input is hidden)" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
if ([string]::IsNullOrWhiteSpace($key)) { throw "No key entered." }

$lines = if (Test-Path $envPath) { [System.IO.File]::ReadAllLines($envPath) } else { @() }
$pattern = "^" + [regex]::Escape($name) + "="
$found = $false
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match $pattern) { $lines[$i] = "$name=$key"; $found = $true }
}
if (-not $found) { $lines += "$name=$key" }
[System.IO.File]::WriteAllLines($envPath, $lines, [System.Text.UTF8Encoding]::new($false))
Write-Host "Saved $name locally in .env. Restart CoffeeJack to activate it."
