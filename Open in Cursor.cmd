@echo off
set "COFFEEJACK_CURSOR=%LOCALAPPDATA%\Programs\cursor\Cursor.exe"
if exist "%COFFEEJACK_CURSOR%" (
  start "" "%COFFEEJACK_CURSOR%" "%~dp0CoffeeJack.code-workspace"
) else (
  echo Cursor not found. Open this folder in Cursor manually.
  pause
)
