@echo off
setlocal

REM Build single-file Windows executable for Photo Cull.
REM Output: dist\PhotoCull.exe
REM Entry point: photo_cull_portable.py

where py >nul 2>nul
if errorlevel 1 (
  echo Python launcher ^(py^) was not found on PATH.
  exit /b 1
)

py -m pip install --upgrade pip >nul
if errorlevel 1 (
  echo Failed to upgrade pip.
  exit /b 1
)

py -m pip install pyinstaller cherrypy pillow
if errorlevel 1 (
  echo Failed to install build/runtime dependencies.
  exit /b 1
)

py -m PyInstaller ^
  --noconfirm ^
  --clean ^
  --onefile ^
  --windowed ^
  --name PhotoCull ^
  --add-data "static;static" ^
  photo_cull_portable.py

if errorlevel 1 (
  echo Build failed.
  exit /b 1
)

echo.
echo Build complete: dist\PhotoCull.exe
echo Run the EXE with no arguments to open the folder picker launcher.
