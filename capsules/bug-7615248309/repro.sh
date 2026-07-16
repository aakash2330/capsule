#!/usr/bin/env bash
# Sentry issue 7615248309 — TypeError: null is not an object (evaluating 'user.preferences.theme')
# Contract: exits non-zero while the bug is present.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="${TARGET_URL:-http://localhost:55766}"
OUT="$(mktemp)"
STATUS=$(curl -s -o "$OUT" -w '%{http_code}' -X POST "$TARGET/signup" -H 'content-type: application/json' --data-binary @"$DIR/request-body.json")
echo "POST /signup -> HTTP $STATUS"
cat "$OUT"; echo
rm -f "$OUT"
if [ "$STATUS" -ge 500 ]; then
  echo "BUG REPRODUCED - replayed request produced a server error."
  exit 1
fi
echo "not reproduced - no server error."
exit 0
