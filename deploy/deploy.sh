#!/usr/bin/env bash
# Copy Celeste into a web server's document root. There is no build step.
#
#   deploy/deploy.sh /var/www/celeste
#
# Stamps the build time into src/debug.js so debug logs say which version
# produced them.
set -euo pipefail
DEST="${1:?usage: deploy/deploy.sh <document-root>}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$DEST"
rsync -a --delete --chmod=D755,F644 \
  "$SRC/index.html" "$SRC/style.css" "$SRC/src" "$SRC/vendor" "$DEST/"
sed -i.bak "s/__BUILD__/$(date -u +%Y%m%dT%H%M%SZ)/" "$DEST/src/debug.js" && rm -f "$DEST/src/debug.js.bak"
echo "deployed to $DEST"
