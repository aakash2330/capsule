// capsule repro <issue-url> — fetch the event, write capsules/<id>/, snapshot
// the dev DB + build recipe, boot an isolated stack, fire the trigger.
// Exit 0 = the bug reproduced.
import path from "node:path";
import { $ } from "bun";
import { snapshotRecipe, writeCapsule } from "../lib/record";
import { capsuleDir, currentAppDir, loadRepoSentryConfig, resolveAppDir } from "../lib/repo";
import { extractEvidence, fetchLatestEvent, parseIssueUrl } from "../lib/sentry";
import { dumpState, freePort, instantiate, loadManifest } from "../lib/stack";
import { fail, readEnvFile } from "../lib/util";

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

  // Each bug gets its own isolated stack on its own port.
  const project = `capsule-${issueId}`;
  const port = freePort();
  const target = `http://localhost:${port}`;
  ev.app = manifest.app; // the regression pack replays only this app's capsules
  const dir = await writeCapsule(ev, target, manifest.repro?.auth);
  console.log(`→ wrote ${path.relative(process.cwd(), dir)}/`);

  // Capture the world before booting the reproduction — request × state is
  // the whole bug; the trigger alone replays clean against an empty stack.
  await dumpState(manifest, dir);
  // Snapshot the build recipe so `capsule test` judges candidates without
  // trusting anything outside the capsule record.
  await snapshotRecipe(appDir, manifest, dir);

  if (!ev.request) {
    console.log("⚠ event has no captured request — capsule is evidence-only.");
    console.log("  Enable request capture in the app (sendDefaultPii / body capture) for replayable events.");
    return;
  }

  try {
    await instantiate(appDir, manifest, project, port, path.join(dir, ".env.capsule"));
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
  const port = readEnvFile(path.join(dir, ".env.capsule")).CAPSULE_PORT;
  if (!port) fail(`no stack recorded for capsule ${bugId}`);
  const target = `http://localhost:${port}`;
  console.log("→ replaying the captured request via repro.sh\n");
  const r = await $`bash ${path.join(dir, "repro.sh")}`
    .env({ ...process.env, TARGET_URL: target } as Record<string, string>)
    .nothrow();
  if (r.exitCode !== 0) {
    console.log("\n✓ bug reproduced — repro.sh exits non-zero while the bug is present.");
    console.log("  If the app has your real SENTRY_DSN, the replay just added an event to the same Sentry issue.");
  } else {
    console.log("\n✗ not reproduced — the replayed request did not produce a server error.");
    process.exit(1);
  }
}
