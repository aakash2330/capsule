#!/usr/bin/env bash
# demo-reset.sh — pre-demo gate for the capsule fix-loop demo (see DEMO.md).
# Usage:
#   bash demo-reset.sh            full gate: state checks + baseline-red + known-good-green (~6 min)
#   bash demo-reset.sh --quick    state checks only (~15 s)
# Exits 0 with "ALL CLEAR" or 1 at the first failed check. Safe to re-run.
set -u
cd "$(dirname "$0")"
QUICK="${1:-}"
WS="$HOME/code/umami-fix"
CID=7625584533
PASS_BASE=7ef30a8   # deploy base: 1e778ab + "report caught /api/send failures to Sentry"
FAILED=0

say()  { printf '  %s %s\n' "$1" "$2"; }
gate() { # gate <name> <ok:0|1> <detail>
  if [ "$2" = 0 ]; then say "✓" "$1 — $3"; else say "✗" "$1 — $3"; FAILED=1; fi
}

echo "capsule demo gate — $(date '+%Y-%m-%d %H:%M')"

# 1. docker
docker version --format '{{.Server.Version}}' >/dev/null 2>&1
gate "docker" $? "daemon reachable"

# 2. fixer workspace pristine
HEAD=$(git -C "$WS" rev-parse --short HEAD 2>/dev/null)
[ "$HEAD" = "$PASS_BASE" ]; gate "workspace HEAD" $? "$WS @ ${HEAD:-?} (want $PASS_BASE)"
DIRTY=$(git -C "$WS" status --porcelain 2>/dev/null | grep -v '^?? .claude' | grep -cv '^$')
[ "${DIRTY:-1}" = 0 ]; gate "workspace clean" $? "$DIRTY tracked file(s) modified (want 0)"
[ ! -f "$WS/.capsule-receipt.json" ]; gate "no stale receipt" $? "$WS/.capsule-receipt.json"

# 3. capsule assets
for f in seed.dump repro.sh evidence.json .capsule-recipe/manifest.yaml request-body.json; do
  [ -f "capsules/$CID/$f" ] || [ -e "capsules/$CID/$f" ]
  gate "asset $f" $? "capsules/$CID/$f"
done

# 3b. second-act capsule (ttclid) assets
for f in seed.dump repro.sh evidence.json request-body.json; do
  [ -e "capsules/7633195238/$f" ]
  gate "act2 $f" $? "capsules/7633195238/$f"
done
grep -q 'tier 2' capsules/7633195238/repro.sh
gate "act2 oracle" $? "two-tier oracle installed (not the generated stub)"


# 5. claude CLI
command -v claude >/dev/null 2>&1; gate "claude CLI" $? "$(claude --version 2>/dev/null || echo missing)"

# 6. known-good patch on file
[ -s ".demo-state/known-good-fix.patch" ]; gate "known-good patch" $? ".demo-state/known-good-fix.patch"

if [ "$FAILED" = 1 ]; then echo "NOT CLEAR — fix the ✗ items above."; exit 1; fi
if [ "$QUICK" = "--quick" ]; then echo "ALL CLEAR (quick — baseline/green not re-proven)"; exit 0; fi

# 7. baseline must be RED on the pristine tree
echo "→ proving baseline red (build + world reset + replay, ~2-4 min)…"
if (cd "$WS" && bun "$OLDPWD/capsule/capsule.ts" test "$CID") >/tmp/demo-gate-red.log 2>&1; then
  say "✗" "baseline is GREEN on the pristine tree — the capsule no longer reproduces the bug. DO NOT DEMO. (/tmp/demo-gate-red.log)"
  exit 1
fi
grep -q 'tier 1' /tmp/demo-gate-red.log
gate "baseline red" $? "FAIL tier-1 on pristine tree"

# 8. known-good fix must be GREEN
echo "→ proving known-good green (~2-4 min)…"
git -C "$WS" apply "$PWD/.demo-state/known-good-fix.patch" || { say "✗" "patch apply" "known-good patch no longer applies"; exit 1; }
if (cd "$WS" && bun "$OLDPWD/capsule/capsule.ts" test "$CID") >/tmp/demo-gate-green.log 2>&1; then
  say "✓" "known-good green — PASS with the reference fix"
else
  say "✗" "known-good fix FAILED the capsule — judge or world drifted. DO NOT DEMO. (/tmp/demo-gate-green.log)"
  git -C "$WS" checkout -- .
  exit 1
fi
git -C "$WS" checkout -- .
rm -f "$WS/.capsule-receipt.json"
say "✓" "workspace re-reset" "pristine again"

echo "ALL CLEAR — red-before / green-after proven on this machine today."
