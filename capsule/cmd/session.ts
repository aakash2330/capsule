// capsule session       — a shell inside a Docker Sandboxes microVM on a copy of
//                         the app with no .capsule/; run `claude` in there yourself.
// capsule session kill  — remove the VM. The copy (and your diff) stays on disk.
// Blinding is a property of WHERE the fixer runs, not a filter on what it may
// touch: the microVM mounts ONLY the fix workspace, so capsule (this repo,
// ~/.capsule, running stacks, the host docker daemon) does not exist inside it.
// The judge (`capsule test`) runs on the host, against the same folder.
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { $ } from "bun";
import { CAPSULE_HOME, CONFIG_DIR, loadRepoSentryConfig } from "../lib/repo";
import { fail } from "../lib/util";

const sandboxName = (appDir: string) => "capsule-" + path.basename(appDir).replace(/[^A-Za-z0-9._-]/g, "-");
const workspaceFor = (appDir: string) => path.join(CONFIG_DIR, "fix", path.basename(appDir));
// Minimal progress log so a slow `sbx` step is visibly in progress, not hung.
const step = (msg: string) => console.error(`→ ${msg}`);

// `sbx` present, daemon up, signed in — or a precise next step.
async function requireSbx(): Promise<void> {
  if (!Bun.which("sbx")) {
    fail("Docker Sandboxes (`sbx`) is not installed. Install and sign in:\n    brew install docker/tap/sbx  &&  sbx login");
  }
  step("checking sbx daemon");
  if ((await $`sbx daemon status`.quiet().nothrow()).exitCode !== 0) {
    step("starting sbx daemon");
    await $`sbx daemon start -d`.quiet().nothrow();
  }
  step("checking sbx login");
  if ((await $`sbx ls`.quiet().nothrow()).exitCode !== 0) fail("not signed in to Docker Sandboxes — run: sbx login");
}

// Copy the app into a blind workspace WITHOUT .capsule/ or secrets, and make
// it a git repo so the judge's receipt has a HEAD. sbx mounts a folder as-is
// with no ignore list, so the copy is what excludes .capsule/ from view.
async function prepareBlindWorkspace(appDir: string, ws: string): Promise<void> {
  if (!existsSync(ws)) {
    step(`copying app to blind workspace ${ws}`);
    await mkdir(path.dirname(ws), { recursive: true });
    await $`rsync -a --exclude .capsule --exclude .env --exclude node_modules --exclude .git ${appDir}/ ${ws}/`;
    step("committing workspace baseline");
    await $`git -C ${ws} init -q`.nothrow();
    await $`git -C ${ws} add -A`.nothrow();
    await $`git -C ${ws} -c user.name=prod -c user.email=prod@example.com commit -q -m prod`.nothrow();
  }
  // capsule's own artifacts must never be in the blind copy: the receipt the
  // judge drops in the worktree, and a .capsule/ that `capsule init`/the skill
  // wrote if someone ran them in here. Both are capsule's, never the user's diff.
  await $`rm -rf ${path.join(ws, ".capsule-receipt.json")} ${path.join(ws, ".capsule")}`.nothrow();
}

// Network policy + the Sentry token as a proxy-managed secret (the VM only
// ever sees a placeholder), then create the sandbox on the workspace if absent.
async function ensureSandbox(appDir: string, ws: string): Promise<string> {
  const name = sandboxName(appDir);
  step("applying network policy (sentry.io)");
  await $`sbx policy init balanced`.quiet().nothrow(); // no-op once initialized
  await $`sbx policy allow network ${"sentry.io,*.sentry.io"}`.quiet().nothrow();
  const haveSecret = (await $`sbx secret ls`.quiet().nothrow()).stdout.toString().toLowerCase().includes("sentry");
  const hasToken = (f: string) => existsSync(f) && /^SENTRY_AUTH_TOKEN=./m.test(readFileSync(f, "utf8"));
  const appEnv = path.join(appDir, ".env");
  const tokenFile = hasToken(appEnv) ? appEnv : path.join(CAPSULE_HOME, ".env");
  if (!haveSecret && hasToken(tokenFile)) {
    step(`registering SENTRY_AUTH_TOKEN from ${tokenFile} as a proxy secret`);
    await $`sbx secret set-custom --host sentry.io --host ${"*.sentry.io"} --env SENTRY_AUTH_TOKEN --command ${`sed -n 's/^SENTRY_AUTH_TOKEN=//p' '${tokenFile}' | tr -d '"' | head -1`}`
      .quiet()
      .nothrow();
  }
  const exists = (await $`sbx ls -q`.quiet().nothrow()).stdout.toString().split("\n").map((s) => s.trim()).includes(name);
  if (!exists) {
    step(`creating sandbox ${name} (first run pulls the microVM image; can take a few minutes)`);
    const c = await $`sbx create --name ${name} claude ${ws}`.nothrow();
    if (c.exitCode !== 0) fail(`could not create the sandbox:\n${c.stderr.toString().slice(-500)}`);
  } else {
    step(`reusing sandbox ${name}`);
  }
  return name;
}

function appDirOrFail(): string {
  const appDir = path.resolve(process.env.CAPSULE_APP_DIR ?? process.cwd());
  if (!existsSync(path.join(appDir, "package.json")) && !existsSync(path.join(appDir, "Dockerfile"))) {
    fail(`${appDir} does not look like an app repo — cd into it first`);
  }
  return appDir;
}

export async function cmdSession(): Promise<void> {
  const appDir = appDirOrFail();
  loadRepoSentryConfig(appDir); // a repo token becomes the proxy secret
  await requireSbx();
  const ws = workspaceFor(appDir);
  await prepareBlindWorkspace(appDir, ws);
  const name = await ensureSandbox(appDir, ws);
  console.log(`✓ blind sandbox ready
  app:        ${appDir}
  workspace:  ${ws}   (copy of the app, no .capsule/)
  sandbox:    ${name}
  judge from the host, in another terminal:
      cd ${ws} && capsule test <issue-id>
  dropping you into a shell inside the sandbox — run \`claude\` when ready.
`);
  // a shell, not the agent launcher: you decide when to start claude
  const proc = Bun.spawn(["sbx", "exec", "-it", "-w", ws, name, "bash", "-l"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await proc.exited;
}

// Remove the VM only. The workspace copy — and any diff in it — is never touched.
export async function cmdSessionKill(): Promise<void> {
  const appDir = appDirOrFail();
  const name = sandboxName(appDir);
  const ws = workspaceFor(appDir);
  const stat = (await $`git -C ${ws} diff --stat`.quiet().nothrow()).stdout.toString().trim();
  if (stat) console.log(`diff kept at ${ws}:\n${stat}`);
  const r = await $`sbx rm -f ${name}`.quiet().nothrow();
  console.log(r.exitCode === 0 ? `✓ sandbox ${name} removed` : `no sandbox ${name} to remove`);
}
