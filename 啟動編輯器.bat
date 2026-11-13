@echo off
rem Starts the spatial wallpaper editor: runs the local helper (serve.py) and opens the browser.
rem If the helper is already running, only the browser is opened.
rem Keep this file ASCII-only: cmd.exe misreads multi-byte text in batch files.
setlocal
cd /d "%~dp0"
set "URL=http://127.0.0.1:8765/"

curl.exe -s -o nul --max-time 2 "%URL%api/status" 2>nul
if not errorlevel 1 (
  echo The editor is already running. Opening the browser.
  start "" "%URL%"
  exit /b 0
)

set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  echo Python was not found. Install Python 3 from https://www.python.org/downloads/
  echo and tick "Add python.exe to PATH" in the installer.
  pause
  exit /b 1
)

title Spatial Wallpaper Editor
echo Close this window to stop the editor.
echo.
%PY% serve.py --port 8765 --open
if errorlevel 1 (
  echo.
  echo The editor did not start. See the message above.
  pause
)
