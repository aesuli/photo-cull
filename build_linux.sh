#!/usr/bin/env bash
# Build single-file Linux executable for Photo Cull.
# Output: dist/PhotoCull
# Entry point: photo_cull_portable.py

set -e

if ! command -v python3 &> /dev/null; then
  echo "python3 was not found on PATH."
  exit 1
fi

python3 -m pip install --upgrade pip
python3 -m pip install pyinstaller cherrypy pillow

python3 -m PyInstaller \
  --noconfirm \
  --clean \
  --onefile \
  --windowed \
  --name PhotoCull \
  --add-data "static:static" \
  photo_cull_portable.py

echo ""
echo "Build complete: dist/PhotoCull"
echo "Run the executable with no arguments to open the folder picker launcher."
