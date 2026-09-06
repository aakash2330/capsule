// capsule test <id>   — judge the current directory against one capsule:
//   build a candidate image from the current tree's own compose file, reset
//   the world from seed.dump, replay the trigger, write a receipt. Exit code =
//   verdict. The one command a fix workspace may run.
// capsule test        — regression pack: replay every capsule's trigger
//   against a running stack; exit 0 = every past bug stays absent.
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { $ } from "bun";
import { hasRecipe, readEvidence, recipeDir } from "../lib/record";
import { capsRoot, capsuleDir, currentAppDir } from "../lib/repo";
import { bootStack, buildImage, loadManifest, publishedPort, readManifest, stackFlags } from "../lib/stack";
import { fail } from "../lib/util";

export async function cmdVerify(bugId: string): Promise<void> {
  const dir = capsuleDir(bugId);
  const rd = recipeDir(dir);
  const reproSh = path.join(dir, "repro.sh");
  if (!hasRecipe(dir)) fail(`capsule ${bugId} has no build recipe — re-run capsule repro`);
  if (!existsSync(reproSh)) fail(`capsule ${bugId} has no repro.sh`);
  const m = (await readManifest(path.join(rd, "manifest.yaml")))!;

  const worktree = process.cwd();
  if (!existsSync(path.join(worktree, "package.json"))) {
    fail(`${worktree} does not look like the app's source tree (no package.json) — run capsule test from inside the repo you are fixing`);
  }
  // Guard against judging the wrong app.
  const wt = await loadManifest(worktree);
  if (wt?.app && wt.app !== m.app) {
    fail(`capsule ${bugId} is for app "${m.app}", but ${worktree} is app "${wt.app}"`);
  }

  // identity of the tree under test, for the receipt
  const head = (await $`git -C ${worktree} rev-parse --short HEAD`.quiet().nothrow()).stdout.toString().trim() || "nogit";
  const diff = (await $`git -C ${worktree} diff HEAD`.quiet().nothrow()).stdout.toString();
  const dirty = diff.trim().length > 0;
  const diffHash = createHash("sha256").update(diff).digest("hex").slice(0, 12);
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  console.log(`→ candidate: ${worktree} (${head}${dirty ? `+${diffHash}` : ""})`);

  try {
    const project = `capsule-${bugId}`;
    const image = `${project}-${m.run.service}`; // compose's default image name
    const flags = stackFlags(worktree, m, project);
    await buildImage(worktree, flags, m);
    const port = await publishedPort(worktree, flags, m);

    // Deterministic judging: tear the whole stack down (containers + volume)
    // and rebuild the world from the snapshot before every verdict.
    console.log(`→ resetting capsule world from seed.dump (project ${project})`);
    await $`docker compose ${flags} down -v --remove-orphans`.cwd(worktree).quiet().nothrow();
    const target = await bootStack(worktree, flags, m, project, port, path.join(dir, "seed.dump"));

    console.log("→ candidate healthy — replaying the captured trigger\n");
    // Pin TARGET_URL to this stack, and hard-bound the replay: a candidate that
    // hangs on the trigger (crash turned into a stall) must be a judge error.
    const rp = Bun.spawn(["bash", reproSh], {
      env: { ...process.env, TARGET_URL: target } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      rp.kill("SIGKILL");
    }, 180_000);
    const out = await new Response(rp.stdout).text();
    const exitCode = await rp.exited;
    clearTimeout(killer);
    if (timedOut) throw new Error("replay timed out after 180s — the candidate accepted the connection but never answered the trigger request");
    process.stdout.write(out);
    const pass = exitCode === 0;
    // A PASS is only a PASS if the oracle actually ran its expectation tier.
    if (pass && /skipping expectation tier/.test(out)) {
      throw new Error("judge inconclusive: repro.sh skipped its expectation tier — refusing to certify a PASS");
    }
    const tier = /\[tier 1/.test(out) ? "tier 1: fingerprint" : /\[tier 2/.test(out) ? "tier 2: expectation" : null;
    const deltaLine = out.split("\n").find((l) => l.startsWith("expectation:"));

    const receipt = {
      v: 1,
      capsule: bugId,
      issueUrl: readEvidence(bugId)?.issueUrl ?? "",
      verdict: pass ? "PASS" : "FAIL",
      tier: pass ? null : tier,
      worktree,
      git: { head, dirty, diffHash: dirty ? diffHash : null },
      image,
      output: out.trim().split("\n").slice(-8),
      at: new Date().toISOString(),
    };
    const receiptsDir = path.join(dir, "receipts");
    await mkdir(receiptsDir, { recursive: true });
    const receiptFile = path.join(receiptsDir, `${stamp}-${pass ? "pass" : "fail"}.json`);
    const json = JSON.stringify(receipt, null, 2) + "\n";
    await Bun.write(receiptFile, json);
    await Bun.write(path.join(worktree, ".capsule-receipt.json"), json);

    console.log(`
────────────────────────────────────────────────────────
CAPSULE VERDICT: ${pass ? "PASS — trigger replayed clean and the report agrees with the world" : `FAIL (${tier ?? "error"})`}${
      !pass && tier === "tier 2: expectation" ? "\n  the crash is gone but the app still disagrees with its own data:" : ""
    }${!pass && deltaLine ? `\n  ${deltaLine}` : ""}
  receipt: ${path.relative(process.cwd(), receiptFile)} (copy at .capsule-receipt.json)
────────────────────────────────────────────────────────`);
    process.exit(exitCode);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

export async function cmdTest(): Promise<void> {
  const root = capsRoot();
  const appDir = currentAppDir();
  const m = await loadManifest(appDir);
  if (!m) fail(`no .capsule/manifest.yaml in ${appDir} — run capsule test from inside the app repo`);

  // Scope the pack to THIS app: replaying another app's captured request
  // against this stack is meaningless.
  const all = existsSync(root)
    ? readdirSync(root).filter((d) => !d.startsWith(".") && existsSync(path.join(root, d, "repro.sh")))
    : [];
  const dirs = all.filter((d) => !m?.app || (readEvidence(d)?.app ?? m.app) === m.app).sort();
  const skipped = all.length - dirs.length;
  if (dirs.length === 0) fail("no capsules for this app — run capsule repro first");
  if (skipped) console.log(`→ ${skipped} capsule(s) for other apps skipped`);

  // Target: whatever is answering on the app's own port (a capsule stack or the dev stack).
  const port = await publishedPort(appDir, stackFlags(appDir, m, "capsule"), m);
  const target = `http://localhost:${port}`;
  const up = await fetch(`${target}${m.run.healthcheck}`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
  if (!up) fail(`nothing healthy at ${target}${m.run.healthcheck} — start a stack first (capsule repro, or docker compose up)`);

  console.log(`→ replaying ${dirs.length} capsule trigger(s) against ${target}\n`);
  let failed = 0;
  for (const d of dirs) {
    const ev = readEvidence(d);
    const title = ev?.title ?? (ev ? `${ev.exception.type}: ${ev.exception.value}` : d);
    const req = ev?.request ? ` (${ev.request.method} ${ev.request.path}${ev.request.body ? ` ${ev.request.body.slice(0, 40)}` : ""})` : "";
    const r = await $`bash ${path.join(root, d, "repro.sh")}`
      .env({ ...process.env, TARGET_URL: target } as Record<string, string>)
      .quiet()
      .nothrow();
    const pass = r.exitCode === 0;
    if (!pass) failed++;
    console.log(`${pass ? "✓" : "✗"} ${d} — ${title}${req}`);
    if (!pass) {
      console.log(`      ${r.stdout.toString().trim().split("\n").slice(-2).join("\n      ")}`);
      if (ev?.issueUrl) console.log(`      ${ev.issueUrl}`);
    }
  }
  console.log(`\n${dirs.length - failed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
