#!/usr/bin/env bun
// capsule — turn a Sentry issue into a locally runnable reproduction.
// Commands: create (evidence + isolated env), run (fire the trigger),
// repro (create + run), init (author/verify the .capsule/ template),
// apply (local tree → running stack), test (regression pack). See usage().

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { $ } from "bun";

// Bun only auto-loads .env from the cwd — also read the repo-root .env next
// to the CLI so `capsule` works from anywhere. Existing env always wins.
const rootEnvFile = Bun.file(path.resolve(import.meta.dir, "..", ".env"));
if (await rootEnvFile.exists()) {
  for (const line of (await rootEnvFile.text()).split("\n")) {
    const m = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/,
    );
    if (!m) continue;
    let value = m[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    process.env[m[1]] ??= value;
  }
}

const API_BASE = process.env.SENTRY_API_BASE ?? "https://sentry.io";
const TARGET_URL = process.env.TARGET_URL ?? "http://localhost:3002";
const APP_DIR =
  process.env.CAPSULE_APP_DIR ??
  path.resolve(import.meta.dir, "..", "demo-app");

interface Frame {
  filename?: string;
  function?: string;
  line?: number;
}

interface Evidence {
  issueId: string;
  issueUrl: string;
  eventId?: string;
  title?: string;
  dateCreated?: string;
  fetchedAt: string;
  exception: { type: string; value: string; topFrames: Frame[] };
  request: {
    method: string;
    url: string;
    path: string;
    contentType: string;
    body: string | null;
  } | null;
}

function fail(msg: string): never {
  console.error(`capsule: ${msg}`);
  process.exit(1);
}

function usage(): never {
  console.log(`capsule — reproduce a Sentry issue locally

Usage:
  capsule create <sentry-issue-url>  fetch evidence + build & boot the isolated
                                     reproduction environment (no replay)
  capsule run <issue-id>             fire the captured trigger against the bug's
                                     stack; exit 0 = bug reproduced
  capsule repro <sentry-issue-url>   create + run in one shot
  capsule init [dir] [--force]       author (via Claude Code) + machine-verify a
                                     .capsule/ environment template for a repo;
                                     with an existing template, verifies it
  capsule apply <issue-id>           rebuild the app image from your local tree and
                                     swap it into the bug's running stack (state kept)
  capsule test [issue-id]            replay every capsule's trigger against a running
                                     stack (the regression pack); non-zero exit on failures

Env:
  SENTRY_AUTH_TOKEN  required — Sentry → Settings → Auth Tokens (scopes: event:read, org:read)
  SENTRY_ORG         org slug, if not inferable from the issue URL
  TARGET_URL         replay against this URL instead of an isolated per-bug stack
  CAPSULE_APP_DIR    app repo dir with a .capsule/ template (default: ../demo-app next to the CLI)

With a .capsule/ template in the app dir, each bug gets its own isolated
docker compose stack (own project + port) that you can shell into.`);
  process.exit(1);
}

function parseIssueUrl(raw: string): { org: string; issueId: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    fail(`not a URL: ${raw}`);
  }
  const idMatch = u.pathname.match(/issues\/(\d+)/);
  if (!idMatch) fail(`no issue id in URL path: ${u.pathname}`);
  const orgFromPath = u.pathname.match(/organizations\/([^/]+)\//)?.[1];
  const sub = u.hostname.endsWith(".sentry.io")
    ? u.hostname.slice(0, -".sentry.io".length)
    : "";
  const orgFromHost =
    sub && !["www", "us", "de", "sentry"].includes(sub) ? sub : "";
  const org = process.env.SENTRY_ORG || orgFromPath || orgFromHost;
  if (!org) fail("could not determine the org slug — set SENTRY_ORG=<slug>");
  return { org, issueId: idMatch[1] };
}

async function fetchLatestEvent(org: string, issueId: string): Promise<any> {
  const token = process.env.SENTRY_AUTH_TOKEN;
  if (!token) {
    fail(`SENTRY_AUTH_TOKEN is not set.
Create one at Sentry → Settings → Auth Tokens (scopes: event:read, org:read),
then export it or put it in a .env in the directory you run capsule from.`);
  }
  const url = `${API_BASE}/api/0/organizations/${org}/issues/${issueId}/events/latest/`;
  let res: globalThis.Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    fail(`cannot reach Sentry API at ${API_BASE}: ${e}`);
  }
  if (!res.ok)
    fail(`Sentry API returned ${res.status} for ${url}\n${await res.text()}`);
  return res.json();
}

// The REST API wraps things in `entries` and uses camelCase (lineNo/inApp);
// raw event JSON uses top-level keys and snake_case. Accept both.
function extractEvidence(
  event: any,
  issueUrl: string,
  issueId: string,
): Evidence {
  const entries: any[] = event.entries ?? [];

  const excValues =
    entries.find((e) => e.type === "exception")?.data?.values ??
    event.exception?.values ??
    [];
  const exc = excValues.at(-1) ?? {};
  const frames: any[] = exc.stacktrace?.frames ?? [];
  const inApp = frames.filter((f) => f.inApp ?? f.in_app);
  const topFrames: Frame[] = (inApp.length ? inApp : frames)
    .slice(-3)
    .reverse()
    .map((f) => ({
      filename: f.filename,
      function: f.function,
      line: f.lineNo ?? f.lineno,
    }));

  const reqData =
    entries.find((e) => e.type === "request")?.data ?? event.request ?? {};
  const headerPairs: [string, unknown][] = Array.isArray(reqData.headers)
    ? reqData.headers
    : Object.entries(reqData.headers ?? {});
  const headers = Object.fromEntries(
    headerPairs.map(([k, v]) => [String(k).toLowerCase(), String(v)]),
  );
  const body =
    reqData.data == null
      ? null
      : typeof reqData.data === "string"
        ? reqData.data
        : JSON.stringify(reqData.data);

  let request: Evidence["request"] = null;
  if (reqData.method && reqData.url) {
    let reqPath = "/";
    try {
      const u = new URL(reqData.url);
      reqPath = u.pathname + u.search;
    } catch {}
    request = {
      method: String(reqData.method).toUpperCase(),
      url: reqData.url,
      path: reqPath,
      contentType: headers["content-type"] ?? "application/json",
      body,
    };
  }

  return {
    issueId,
    issueUrl,
    eventId: event.eventID ?? event.event_id,
    title: event.title,
    dateCreated: event.dateCreated ?? event.datetime,
    fetchedAt: new Date().toISOString(),
    exception: {
      type: exc.type ?? "UnknownError",
      value: exc.value ?? "",
      topFrames,
    },
    request,
  };
}

function renderReproSh(ev: Evidence, target: string): string {
  const req = ev.request!;
  const bodyArgs =
    req.body == null
      ? ""
      : `-H 'content-type: ${req.contentType}' --data-binary @"$DIR/request-body.json"`;
  return `#!/usr/bin/env bash
# Sentry issue ${ev.issueId} — ${ev.exception.type}: ${ev.exception.value}
# Contract: exits non-zero while the bug is present.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="\${TARGET_URL:-${target}}"
OUT="$(mktemp)"
STATUS=$(curl -s -o "$OUT" -w '%{http_code}' -X ${req.method} "$TARGET${req.path}" ${bodyArgs})
echo "${req.method} ${req.path} -> HTTP $STATUS"
cat "$OUT"; echo
rm -f "$OUT"
if [ "$STATUS" -ge 500 ]; then
  echo "BUG REPRODUCED - replayed request produced a server error."
  exit 1
fi
echo "not reproduced - no server error."
exit 0
`;
}

function renderContext(ev: Evidence): string {
  const frames = ev.exception.topFrames
    .map(
      (f, i) =>
        `${i + 1}. \`${f.filename ?? "?"}:${f.line ?? "?"}\` in \`${f.function ?? "?"}\``,
    )
    .join("\n");
  const requestSection = ev.request
    ? `\`${ev.request.method} ${ev.request.path}\`${ev.request.body != null ? " with the body in [request-body.json](request-body.json)" : ""}`
    : "_no request captured on the event — context-only capsule_";
  return `# Sentry issue ${ev.issueId}

**${ev.title ?? `${ev.exception.type}: ${ev.exception.value}`}**

- Issue: ${ev.issueUrl}
- Event: ${ev.eventId ?? "?"} (${ev.dateCreated ?? "?"})
- Exception: \`${ev.exception.type}: ${ev.exception.value}\`

Top in-app frames (innermost first):

${frames || "_none_"}

## Failing request

${requestSection}

## Reproduce

\`capsule repro\` starts the environment automatically. To run by hand:

\`\`\`sh
./repro.sh   # exits non-zero while the bug is present
\`\`\`
`;
}

async function writeCapsule(ev: Evidence, target: string): Promise<string> {
  const dir = path.resolve("capsules", ev.issueId);
  await mkdir(dir, { recursive: true });
  await Bun.write(
    path.join(dir, "evidence.json"),
    JSON.stringify(ev, null, 2) + "\n",
  );
  await Bun.write(path.join(dir, "CONTEXT.md"), renderContext(ev));
  if (ev.request) {
    if (ev.request.body != null) {
      await Bun.write(
        path.join(dir, "request-body.json"),
        ev.request.body + "\n",
      );
    }
    const repro = path.join(dir, "repro.sh");
    await Bun.write(repro, renderReproSh(ev, target));
    await chmod(repro, 0o755);
  }
  return dir;
}

interface Manifest {
  capsule: number;
  app: string;
  run: {
    compose: string;
    service?: string;
    port: number;
    healthcheck: string;
    ready_timeout?: number;
  };
}

async function loadManifest(appDir: string): Promise<Manifest | null> {
  const file = Bun.file(path.join(appDir, ".capsule", "manifest.yaml"));
  if (!(await file.exists())) return null;
  return Bun.YAML.parse(await file.text()) as Manifest;
}

function freePort(): number {
  const srv = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = srv.port;
  srv.stop(true);
  if (!port) fail("could not allocate a free host port");
  return port;
}

async function buildImage(appDir: string, tag?: string): Promise<string> {
  console.log("→ building app image via .capsule/build.sh");
  const script = path.join(appDir, ".capsule", "build.sh");
  const build = tag
    ? await $`bash ${script} ${tag}`.cwd(appDir).nothrow()
    : await $`bash ${script}`.cwd(appDir).nothrow();
  if (build.exitCode !== 0) {
    throw new Error(
      `build.sh failed (exit ${build.exitCode})\n${build.stderr.toString().slice(-2000)}`,
    );
  }
  return build.stdout.toString().trim().split("\n").at(-1)!;
}

function composeFlags(
  appDir: string,
  m: Manifest,
  project: string,
  envFile: string,
): string[] {
  const flags = [
    "-p",
    project,
    "-f",
    path.join(appDir, m.run.compose),
    "-f",
    path.join(appDir, ".capsule", "overlay.yaml"),
  ];
  const appEnv = path.join(appDir, ".env");
  if (existsSync(appEnv)) flags.push("--env-file", appEnv);
  flags.push("--env-file", envFile);
  return flags;
}

async function pollHealth(target: string, m: Manifest): Promise<boolean> {
  const deadline = Date.now() + (m.run.ready_timeout ?? 60) * 1000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${target}${m.run.healthcheck}`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) return true;
    } catch {}
    await Bun.sleep(1000);
  }
  return false;
}

function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// Instantiate the .capsule/ template as an isolated stack: own compose
// project, pinned image, own host port. Throws with logs on failure.
async function instantiate(
  appDir: string,
  m: Manifest,
  project: string,
  port: number,
  envFile: string,
): Promise<string> {
  const image = await buildImage(appDir);
  await Bun.write(envFile, `CAPSULE_IMAGE=${image}\nCAPSULE_PORT=${port}\n`);
  const flags = composeFlags(appDir, m, project, envFile);

  console.log(`→ starting isolated stack ${project} (host port ${port})`);
  const up = await $`docker compose ${flags} up -d --wait`
    .cwd(appDir)
    .nothrow();
  if (up.exitCode !== 0) {
    throw new Error(
      `docker compose up failed for ${project} (exit ${up.exitCode})\n${up.stderr.toString().slice(-3000)}`,
    );
  }

  const target = `http://localhost:${port}`;
  if (await pollHealth(target, m)) return target;
  const logs = await $`docker compose ${flags} logs --tail 60`
    .cwd(appDir)
    .quiet()
    .nothrow();
  throw new Error(
    `app not healthy at ${target}${m.run.healthcheck} within ${m.run.ready_timeout ?? 60}s\n--- stack logs ---\n${logs.stdout.toString().slice(-3000)}`,
  );
}

async function upCapsuleStack(
  m: Manifest,
  project: string,
  port: number,
  dir: string,
): Promise<void> {
  try {
    const target = await instantiate(
      APP_DIR,
      m,
      project,
      port,
      path.join(dir, ".env.capsule"),
    );
    console.log(`→ capsule app healthy at ${target}`);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

async function appUp(): Promise<boolean> {
  try {
    const res = await fetch(`${TARGET_URL}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureAppUp(): Promise<void> {
  if (await appUp()) {
    console.log(`→ target app already up at ${TARGET_URL}`);
    return;
  }
  console.log(
    `→ target app not responding at ${TARGET_URL} — starting docker compose in ${APP_DIR}`,
  );
  const result = await $`docker compose up -d --build --wait`
    .cwd(APP_DIR)
    .nothrow();
  if (result.exitCode !== 0)
    fail(`docker compose up failed (exit ${result.exitCode})`);
  for (let i = 0; i < 30; i++) {
    if (await appUp()) {
      console.log(`→ target app is up at ${TARGET_URL}`);
      return;
    }
    await Bun.sleep(1000);
  }
  fail(`app did not respond at ${TARGET_URL}/health within 30s of compose up`);
}

// The objective gate for `capsule init`: the template counts only if the CLI
// can build the image, boot the stack, and get a 2xx healthcheck. Always
// tears the verification stack down.
async function verifyTemplate(
  appDir: string,
): Promise<{ ok: boolean; log: string }> {
  const m = await loadManifest(appDir);
  if (!m) return { ok: false, log: ".capsule/manifest.yaml is missing" };
  const project = "capsule-verify";
  const port = freePort();
  const envFile = path.join(appDir, ".capsule", ".env.verify");
  try {
    const target = await instantiate(appDir, m, project, port, envFile);
    return { ok: true, log: `app healthy at ${target}${m.run.healthcheck}` };
  } catch (e) {
    return { ok: false, log: e instanceof Error ? e.message : String(e) };
  } finally {
    await $`docker compose ${composeFlags(appDir, m, project, envFile)} down -v --remove-orphans`
      .cwd(appDir)
      .quiet()
      .nothrow();
    await $`rm -f ${envFile}`.quiet().nothrow();
  }
}

function initPrompt(failureLog: string): string {
  return `Onboard this repository into "capsule", a tool that reproduces production bugs in isolated docker compose environments. Author an environment template in .capsule/ — create files ONLY inside .capsule/; never modify anything outside it.

Mine recipes that already exist, in priority order: docker compose files > Dockerfile > .devcontainer > CI workflows > README. Reference the repo's own files instead of duplicating their contents. Do not invent services the app doesn't use.

Create exactly these files:

1) .capsule/manifest.yaml
   capsule: 1
   app: <short app name>
   build:
     image: capsule/<app>
     dockerfile: <path to the Dockerfile used, relative to repo root>
   run:
     compose: <repo's compose file path, or .capsule/compose.yaml if you had to create one>
     service: <name of the app service in that compose file>
     port: <container port the app listens on>
     healthcheck: <existing HTTP GET path that returns 2xx when the app is up>
     ready_timeout: 60
   env: {}
   state: {}

2) .capsule/overlay.yaml — a compose override applied on top of run.compose:
   services:
     <app service>:
       image: \${CAPSULE_IMAGE}
       build: !reset null
       ports: !override
         - "\${CAPSULE_PORT}:<container port>"

3) .capsule/build.sh — executable bash that builds the app image and prints the tag as the LAST line of stdout (send docker build output to stderr). Tag capsule/<app>:<git short sha>, falling back to :local outside a git repo.

If the repo has no compose file, write a minimal .capsule/compose.yaml (the app service plus its real dependencies such as postgres/redis, with healthchecks) and point run.compose at it. If there is no Dockerfile, write .capsule/Dockerfile and reference it from build.sh. Pick the cheapest existing GET route for the healthcheck; do not add routes to the app.

After you finish, the capsule CLI machine-verifies the template: it runs build.sh, brings the stack up with the overlay, and polls the healthcheck for a 2xx within ready_timeout. Make that pass.${
    failureLog
      ? `\n\nA previous attempt failed verification with this log — diagnose and fix the template:\n${failureLog.slice(-3000)}`
      : ""
  }`;
}

async function cmdInit(appDir: string, force: boolean): Promise<void> {
  if (!existsSync(appDir)) fail(`no such directory: ${appDir}`);
  const hasTemplate = existsSync(path.join(appDir, ".capsule", "manifest.yaml"));

  if (hasTemplate && !force) {
    console.log(
      "→ .capsule/ already exists — running verification only (--force re-authors)",
    );
    const v = await verifyTemplate(appDir);
    if (v.ok) {
      console.log(`✓ template verified — ${v.log}`);
      return;
    }
    fail(
      `template failed verification:\n${v.log}\n\nFix .capsule/ by hand or re-author with: capsule init --force`,
    );
  }

  if ((await $`which claude`.quiet().nothrow()).exitCode !== 0) {
    fail(
      "`claude` CLI not found — capsule init uses Claude Code to author the template",
    );
  }

  let failureLog = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(
      `→ authoring .capsule/ with Claude Code (attempt ${attempt}/3 — this can take a few minutes)`,
    );
    const run = await $`claude -p ${initPrompt(failureLog)} --permission-mode acceptEdits`
      .cwd(appDir)
      .nothrow();
    if (run.exitCode !== 0) fail(`claude exited with ${run.exitCode}`);
    await $`chmod +x ${path.join(appDir, ".capsule", "build.sh")}`
      .quiet()
      .nothrow();

    console.log("→ machine-verifying the template (build + boot + healthcheck)");
    const v = await verifyTemplate(appDir);
    if (v.ok) {
      console.log(
        `✓ capsule init complete — template authored and verified (${v.log})`,
      );
      return;
    }
    failureLog = v.log;
    console.log(`✗ verification failed (attempt ${attempt}):\n${v.log.slice(0, 1200)}\n`);
  }
  fail(
    "template did not pass verification after 3 attempts — inspect .capsule/ and finish by hand",
  );
}

// Apply the local working tree to a bug's running stack: rebuild the image
// with a distinct tag, swap only the app service, leave state untouched.
async function cmdApply(bugId: string): Promise<void> {
  const dir = path.resolve("capsules", bugId);
  const envFile = path.join(dir, ".env.capsule");
  if (!existsSync(envFile)) {
    fail(`no capsule stack config at ${envFile} — run capsule repro first`);
  }
  const m = await loadManifest(APP_DIR);
  if (!m) fail(`no .capsule/ template in ${APP_DIR}`);
  const port = Number(readEnvFile(envFile).CAPSULE_PORT);
  if (!port) fail(`${envFile} has no CAPSULE_PORT`);
  const project = `capsule-${bugId}`;

  const ps = await $`docker compose ${composeFlags(APP_DIR, m, project, envFile)} ps -q`
    .cwd(APP_DIR)
    .quiet()
    .nothrow();
  if (!ps.stdout.toString().trim()) {
    fail(`stack ${project} is not running — run capsule repro first`);
  }

  // Distinct tag per apply, so the test verdict pins to an exact image.
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  let image: string;
  try {
    image = await buildImage(APP_DIR, `fix-${stamp}`);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  await Bun.write(envFile, `CAPSULE_IMAGE=${image}\nCAPSULE_PORT=${port}\n`);

  const service = m.run.service ?? "app";
  console.log(`→ swapping ${service} in ${project} to ${image} (state untouched)`);
  const up = await $`docker compose ${composeFlags(APP_DIR, m, project, envFile)} up -d --no-deps ${service}`
    .cwd(APP_DIR)
    .nothrow();
  if (up.exitCode !== 0) fail(`docker compose up failed (exit ${up.exitCode})`);

  const target = `http://localhost:${port}`;
  if (!(await pollHealth(target, m))) {
    fail(
      `app not healthy at ${target}${m.run.healthcheck} after apply — check: docker compose -p ${project} logs app`,
    );
  }
  console.log(`✓ applied — ${target} now runs ${image} (state preserved)`);
  console.log(`  next: capsule test ${bugId}`);
}

// Replay every capsule's trigger against a running stack. The capsules
// directory is the regression suite: exit 0 = every past bug stays absent.
async function cmdTest(bugId?: string): Promise<void> {
  const capsRoot = path.resolve("capsules");
  const dirs = existsSync(capsRoot)
    ? readdirSync(capsRoot)
        .filter(
          (d) =>
            !d.startsWith(".") &&
            existsSync(path.join(capsRoot, d, "repro.sh")),
        )
        .sort()
    : [];
  if (dirs.length === 0) {
    fail("no capsules with a repro.sh under ./capsules — run capsule repro first");
  }

  const m = await loadManifest(APP_DIR);
  const healthPath = m?.run.healthcheck ?? "/health";

  // Target: explicit TARGET_URL, else the given bug's stack, else the first
  // capsule stack that answers its healthcheck.
  let target = process.env.TARGET_URL ?? "";
  if (!target) {
    for (const d of bugId ? [bugId] : dirs) {
      const env = readEnvFile(path.join(capsRoot, d, ".env.capsule"));
      if (!env.CAPSULE_PORT) continue;
      const candidate = `http://localhost:${env.CAPSULE_PORT}`;
      try {
        const res = await fetch(`${candidate}${healthPath}`, {
          signal: AbortSignal.timeout(1500),
        });
        if (res.ok) {
          target = candidate;
          break;
        }
      } catch {}
    }
  }
  if (!target) {
    fail(
      `no running capsule stack found${bugId ? ` for ${bugId}` : ""} — run capsule repro (or apply) first, or set TARGET_URL`,
    );
  }

  console.log(`→ replaying ${dirs.length} capsule trigger(s) against ${target}\n`);
  let failed = 0;
  for (const d of dirs) {
    let title = d;
    let reqLabel = "";
    let issueUrl = "";
    try {
      const evj = JSON.parse(
        readFileSync(path.join(capsRoot, d, "evidence.json"), "utf8"),
      );
      title = evj.title ?? `${evj.exception?.type}: ${evj.exception?.value}`;
      issueUrl = evj.issueUrl ?? "";
      if (evj.request) {
        const body = evj.request.body ? ` ${evj.request.body.slice(0, 40)}` : "";
        reqLabel = ` (${evj.request.method} ${evj.request.path}${body})`;
      }
    } catch {}
    const r = await $`bash ${path.join(capsRoot, d, "repro.sh")}`
      .env({ ...process.env, TARGET_URL: target } as Record<string, string>)
      .quiet()
      .nothrow();
    const pass = r.exitCode === 0;
    if (!pass) failed++;
    console.log(`${pass ? "✓" : "✗"} ${d} — ${title}${reqLabel}`);
    if (!pass) {
      const tail = r.stdout
        .toString()
        .trim()
        .split("\n")
        .slice(-2)
        .join("\n      ");
      console.log(`      ${tail}`);
      if (issueUrl) console.log(`      ${issueUrl}`);
    }
  }
  console.log(
    `\n${dirs.length - failed} passed, ${failed} failed — HTTP-level check only (fingerprint match arrives with the DSN sink)`,
  );
  if (failed > 0) process.exit(1);
}

const args = Bun.argv.slice(2);

if (args[0] === "init") {
  const dirArg = args.slice(1).find((a) => !a.startsWith("--"));
  await cmdInit(path.resolve(dirArg ?? "."), args.includes("--force"));
  process.exit(0);
}

if (args[0] === "apply") {
  if (!args[1]) usage();
  await cmdApply(args[1]);
  process.exit(0);
}

if (args[0] === "test") {
  await cmdTest(args[1]);
  process.exit(0);
}

// Create the reproduction environment: evidence → capsule dir → isolated
// stack, booted and healthy. Does NOT fire the trigger.
async function cmdCreate(issueUrl: string): Promise<{
  bugId: string;
  target: string;
  hasRequest: boolean;
}> {
  const { org, issueId } = parseIssueUrl(issueUrl);
  console.log(`→ fetching latest event for issue ${issueId} (org: ${org})`);
  const event = await fetchLatestEvent(org, issueId);
  const ev = extractEvidence(event, issueUrl, issueId);
  const top = ev.exception.topFrames[0];
  console.log(
    `→ ${ev.exception.type}: ${ev.exception.value}${top ? ` — at ${top.filename}:${top.line}` : ""}`,
  );

  // With a .capsule/ template, each bug gets its own isolated stack on its own
  // port. Setting TARGET_URL explicitly skips that and replays against it.
  const manifest = process.env.TARGET_URL ? null : await loadManifest(APP_DIR);
  const project = manifest ? `capsule-${issueId}` : null;
  const port = manifest ? freePort() : 0;
  const target = manifest ? `http://localhost:${port}` : TARGET_URL;

  const dir = await writeCapsule(ev, target);
  console.log(`→ wrote ${path.relative(process.cwd(), dir)}/`);

  if (!ev.request) {
    console.log(
      "⚠ event has no captured request — capsule is context-only (evidence + narrative).",
    );
    console.log(
      "  Enable request capture in the app (sendDefaultPii / body capture) for replayable events.",
    );
    return { bugId: issueId, target, hasRequest: false };
  }

  if (manifest && project) {
    await upCapsuleStack(manifest, project, port, dir);
  } else {
    await ensureAppUp();
  }

  if (project) {
    console.log(`
capsule stack (isolated from your dev stack):
  app URL:   ${target}
  shell in:  docker compose -p ${project} exec app bash
  logs:      docker compose -p ${project} logs -f app
  tear down: docker compose -p ${project} down
  run the repro:         capsule run ${issueId}
  after fixing locally:  capsule apply ${issueId} && capsule test ${issueId}`);
  }
  return { bugId: issueId, target, hasRequest: true };
}

// Fire a capsule's captured trigger against its stack. Exit 0 = reproduced.
async function cmdRun(bugId: string, targetOverride?: string): Promise<void> {
  const dir = path.resolve("capsules", bugId);
  const reproSh = path.join(dir, "repro.sh");
  if (!existsSync(reproSh)) {
    fail(
      `no repro.sh in ${dir} — run capsule create <issue-url> first (or the capsule is context-only)`,
    );
  }

  let target = targetOverride ?? process.env.TARGET_URL ?? "";
  if (!target) {
    const env = readEnvFile(path.join(dir, ".env.capsule"));
    if (env.CAPSULE_PORT) target = `http://localhost:${env.CAPSULE_PORT}`;
  }
  if (!target) {
    fail(
      `no stack recorded for capsule ${bugId} — run capsule create first, or set TARGET_URL`,
    );
  }

  try {
    await fetch(target, { signal: AbortSignal.timeout(1500) });
  } catch {
    fail(
      `nothing responding at ${target} — restart the stack with: docker compose -p capsule-${bugId} up -d  (or re-run capsule create)`,
    );
  }

  console.log("→ replaying the captured request via repro.sh\n");
  const repro = await $`bash ${reproSh}`
    .env({ ...process.env, TARGET_URL: target } as Record<string, string>)
    .nothrow();

  if (repro.exitCode !== 0) {
    console.log(
      "\n✓ bug reproduced — repro.sh exits non-zero while the bug is present.",
    );
    console.log(
      "  If the app has your real SENTRY_DSN, the replay just added a new event to the same Sentry issue.",
    );
  } else {
    console.log(
      "\n✗ not reproduced — the replayed request did not produce a server error.",
    );
    process.exit(1);
  }
}

if (args[0] === "create") {
  if (!args[1]) usage();
  await cmdCreate(args[1]);
  process.exit(0);
}

if (args[0] === "run") {
  if (!args[1]) usage();
  await cmdRun(args[1]);
  process.exit(0);
}

if (args[0] !== "repro" || !args[1]) usage();
const created = await cmdCreate(args[1]);
if (created.hasRequest) await cmdRun(created.bugId, created.target);
