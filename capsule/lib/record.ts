// The capsule record on disk: capsules/<id>/ with evidence.json, repro.sh,
// request-body.json, seed.dump, .env.capsule and the .capsule-recipe snapshot.
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { $ } from "bun";
import { CAPSULE_HOME, capsuleDir } from "./repo";
import type { Evidence } from "./sentry";
import type { Manifest, ReproAuth } from "./stack";
import { fail } from "./util";

export function readEvidence(bugId: string): Evidence | null {
  try {
    return JSON.parse(readFileSync(path.join(capsuleDir(bugId), "evidence.json"), "utf8"));
  } catch {
    return null;
  }
}

function renderReproSh(ev: Evidence, target: string, auth?: ReproAuth | null): string {
  const req = ev.request!;
  const uaArg = req.userAgent ? `-A '${req.userAgent.replace(/'/g, `'\\''`)}' ` : "";
  const bodyArgs =
    req.body == null ? "" : `-H 'content-type: ${req.contentType}' --data-binary @"$DIR/request-body.json"`;
  const authPrelude = auth
    ? `
# The captured Authorization header arrived scrubbed ([Filtered]) — mint a
# fresh token against the capsule's own restored state instead.
TOKEN=$(curl -s --max-time 30 --connect-timeout 5 -X POST "$TARGET${auth.login_path}" -H 'content-type: application/json' --data '${auth.body}' | sed -E 's/.*"${auth.token_field}":"([^"]+)".*/\\1/')
`
    : "";
  const authHeader = auth ? `-H "authorization: Bearer $TOKEN" ` : "";
  // Exception values often carry newlines (Prisma multi-line messages) —
  // collapse them or the lines after the first execute as shell commands.
  const title = `${ev.exception.type}: ${ev.exception.value}`.replace(/\s+/g, " ").slice(0, 160);
  return `#!/usr/bin/env bash
# Sentry issue ${ev.issueId} — ${title}
# Contract: exits non-zero while the bug is present.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="\${TARGET_URL:-${target}}"
${authPrelude}OUT="$(mktemp)"
STATUS=$(curl -s --max-time 30 --connect-timeout 5 -o "$OUT" -w '%{http_code}' -X ${req.method} ${uaArg}${authHeader}"$TARGET${req.path}" ${bodyArgs})
echo "${req.method} ${req.path} -> HTTP $STATUS"
cat "$OUT"; echo
rm -f "$OUT"
# A missing or broken response is never a PASS: 000 = no HTTP response at all
# (crash mid-request, hang past --max-time, connection refused); 4xx = the
# trigger no longer even reaches the buggy path (deleted route, failed auth).
if [ "$STATUS" = "000" ]; then
  echo "BUG REPRODUCED [tier 1: fingerprint] - app gave no HTTP response to the replayed request."
  exit 1
fi
if [ "$STATUS" -ge 500 ]; then
  echo "BUG REPRODUCED [tier 1: fingerprint] - replayed request produced a server error."
  exit 1
fi
if [ "$STATUS" -ge 400 ]; then
  echo "INCONCLUSIVE - HTTP $STATUS: the trigger no longer reaches its code path (rejected or missing). Not accepting as a fix."
  exit 1
fi
echo "not reproduced - no server error."
exit 0
`;
}

export async function writeCapsule(ev: Evidence, target: string, auth?: ReproAuth | null): Promise<string> {
  const dir = capsuleDir(ev.issueId);
  // Guard against two different bugs sharing an id (e.g. same issue number in
  // two Sentry orgs) silently clobbering each other's snapshot.
  const prev = readEvidence(ev.issueId);
  if (prev?.issueUrl && prev.issueUrl !== ev.issueUrl) {
    fail(
      `capsule ${ev.issueId} already exists for a different issue (${prev.issueUrl}). ` +
        `Issue-id collision across orgs — use a separate CAPSULE_HOME per org.`,
    );
  }
  await mkdir(dir, { recursive: true });
  await Bun.write(path.join(dir, "evidence.json"), JSON.stringify(ev, null, 2) + "\n");
  if (ev.request) {
    if (ev.request.body != null) {
      await Bun.write(path.join(dir, "request-body.json"), ev.request.body + "\n");
    }
    const repro = path.join(dir, "repro.sh");
    await Bun.write(repro, renderReproSh(ev, target, auth));
    await chmod(repro, 0o755);
  }
  return dir;
}

// Snapshot the app's .capsule/ template plus its compose file into the
// capsule record at repro-time, so the judge never executes fix-workspace
// authored compose/overlay files.
export async function snapshotRecipe(appDir: string, m: Manifest, dir: string): Promise<void> {
  const rd = recipeDir(dir);
  await mkdir(rd, { recursive: true });
  const cp = await $`cp -R ${path.join(appDir, ".capsule")}/. ${rd}/`.nothrow();
  if (cp.exitCode !== 0) throw new Error("failed to snapshot .capsule/ recipe");
  const compose =
    await $`cp ${path.join(appDir, m.run.compose)} ${path.join(rd, "compose.snapshot.yaml")}`.nothrow();
  if (compose.exitCode !== 0) throw new Error(`failed to snapshot ${m.run.compose}`);
  console.log(`→ snapshotted build recipe into ${path.relative(CAPSULE_HOME, rd)}/`);
}
export const recipeDir = (dir: string) => path.join(dir, ".capsule-recipe");
export const hasRecipe = (dir: string) => existsSync(recipeDir(dir));
