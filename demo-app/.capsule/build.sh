#!/usr/bin/env bash
# Build the app image for the capsule. Prints the tag on stdout.
# With a git repo this would take a SHA and check out a worktree; this repo
# isn't one yet, so it builds the current tree and tags :local.
set -euo pipefail
dir="$(cd "$(dirname "$0")/.." && pwd)"
sha="$(git -C "$dir" rev-parse --short HEAD 2>/dev/null || echo local)"
tag="capsule/demo-app:${1:-$sha}"
docker build -t "$tag" "$dir" >&2
echo "$tag"
