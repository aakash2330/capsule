// capsule repro <issue-url> — fetch the event, write capsules/<id>/, snapshot
// the dev DB + build recipe, boot an isolated stack, fire the trigger.
// Exit 0 = the bug reproduced.
import path from "node:path";
import { $ } from "bun";
import { snapshotRecipe, writeCapsule } from "../lib/record";
import { capsuleDir, currentAppDir, loadRepoSentryConfig, resolveAppDir } from "../lib/repo";
import { extractEvidence, fetchLatestEvent, parseIssueUrl } from "../lib/sentry";
import { dumpState, instantiate, loadManifest, publishedPort, stackFlags } from "../lib/stack";
import { fail } from "../lib/util";

export async function cmdRepro(issueUrl: string): Promise<void> {
  if (!resolveAppDir()) fail("not inside an onboarded repo — cd into your app repo and run `capsule init`");
  const appDir = currentAppDir();
  loadRepoSentryConfig(appDir);
  const manifest = await loadManifest(appDir);
  if (!manifest) fail("no .capsule/manifest.yaml — run capsule init first");

  const { org, issueId } = parseIssueUrl(issueUrl);
  console.log(`→ fetching latest event for issue ${issueId} (org: ${org})`);
  const ev = extractEvidence(await fetchLatestEvent(org, issueId), issueUrl, issueId);
  const top = ev.exception.topFrames[0];
  console.log(`→ ${ev.exception.type}: ${ev.exception.value}${top ? ` — at ${top.filename}:${top.line}` : ""}`);

  // Each bug gets its own compose project (own volumes); ports are the repo's
  // own, so the dev stack must be down.
  const project = `capsule-${issueId}`;
  const port = await publishedPort(appDir, stackFlags(appDir, manifest, project), manifest);
  const target = `http://localhost:${port}`;
  ev.app = manifest.app; // the regression pack replays only this app's capsules
  const dir = await writeCapsule(ev, target, manifest.repro?.auth);
  console.log(`→ wrote ${path.relative(process.cwd(), dir)}/`);

  // Capture the world before booting the reproduction — request × state is
  // the whole bug; the trigger alone replays clean against an empty stack.
  await dumpState(manifest, dir);
  // Snapshot the build recipe so `capsule test` judges candidates without
  // trusting anything outside the capsule record.
  await snapshotRecipe(appDir, dir);

  if (!ev.request) {
    console.log("⚠ event has no captured request — capsule is evidence-only.");
    console.log("  Enable request capture in the app (sendDefaultPii / body capture) for replayable events.");
    return;
  }

  try {
    await instantiate(appDir, manifest, project, path.join(dir, "seed.dump"));
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  console.log(`
capsule stack (isolated from your dev stack):
  app URL:   ${target}
  shell in:  docker compose -p ${project} exec app bash
  logs:      docker compose -p ${project} logs -f app
  tear down: docker compose -p ${project} down
  after fixing locally:  capsule test ${issueId}
`);
  await replay(issueId);
}

// Fire a capsule's captured trigger against its running stack.
async function replay(bugId: string): Promise<void> {
  const dir = capsuleDir(bugId);
  console.log("→ replaying the captured request via repro.sh\n");
  // repro.sh carries its own TARGET_URL default (the app URL recorded at repro-time).
  const r = await $`bash ${path.join(dir, "repro.sh")}`.nothrow();
  if (r.exitCode !== 0) {
    console.log("\n✓ bug reproduced — repro.sh exits non-zero while the bug is present.");
    console.log("  If the app has your real SENTRY_DSN, the replay just added an event to the same Sentry issue.");
  } else {
    console.log("\n✗ not reproduced — the replayed request did not produce a server error.");
    process.exit(1);
  }
}
