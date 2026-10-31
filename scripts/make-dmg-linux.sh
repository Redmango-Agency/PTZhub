#!/usr/bin/env bash
# Crea le immagini disco per Mac anche da Linux (senza hdiutil): immagine ISO 9660 con
# estensioni Rock Ridge (permessi e collegamenti), che macOS apre come un normale .dmg.
# Prima: npx electron-builder --mac dir --arm64 --x64
# Uso: scripts/make-dmg-linux.sh   (richiede genisoimage)
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
for ARCH in arm64 x64; do
  SRC=dist/mac-arm64; [ "$ARCH" = x64 ] && SRC=dist/mac
  STAGE=$(mktemp -d)
  cp -a "$SRC/PTZ Hub.app" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"
  cp build/mac-extra/Leggimi.txt "$STAGE/Leggimi.txt"
  genisoimage -quiet -V "PTZ Hub" -D -R -no-pad -o "dist/PTZ-Hub-$VERSION-mac-$ARCH.dmg" "$STAGE"
  rm -rf "$STAGE"
  echo "dist/PTZ-Hub-$VERSION-mac-$ARCH.dmg"
done
