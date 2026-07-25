#!/usr/bin/env bun
// capsule — turn a Sentry issue into a locally runnable reproduction.
// Commands: init (onboarding wizard + per-repo config), doctor (health check),
// create (evidence + isolated env), run (fire the trigger), repro (create +
// run), apply (local tree → stack), test (judge a worktree + signed receipt),
// protect (guard a fix repo). See usage().
//
// Config model: ~/.capsule holds machine-level install state (guard engine,
// `capsule` shim, receipt secret) only. Each app repo carries its OWN Sentry
// token (.capsule/credentials, git-ignored) + org (.capsule/config.json,
// committable), so one machine drives many projects each with its own key.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
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
    // per-repo Sentry secrets come from each repo's .capsule/, never the CLI's
    // own .env — otherwise one repo's token would shadow every other repo's.
    if (["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_API_BASE"].includes(m[1]))
      continue;
    let value = m[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    process.env[m[1]] ??= value;
  }
}

// Bun auto-loads the cwd's .env into process.env before this file runs. Those
// values must not masquerade as a deliberate export and shadow the *target*
// repo's own Sentry key. Scrub cwd/.env's SENTRY_* back out — a real shell
// export (value differs, or there's no cwd .env) survives; the per-repo loader
// then owns them. Keeps one repo's key from bleeding into another's commands.
try {
  const cwdEnv = Bun.file(path.join(process.cwd(), ".env"));
  if (await cwdEnv.exists()) {
    for (const line of (await cwdEnv.text()).split("\n")) {
      const m = line.match(
        /^\s*(?:export\s+)?(SENTRY_AUTH_TOKEN|SENTRY_ORG|SENTRY_API_BASE)\s*=\s*(.*?)\s*$/,
      );
      if (!m) continue;
      let v = m[2];
      if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
      if (process.env[m[1]] === v) delete process.env[m[1]];
    }
  }
} catch {}

// ~/.capsule holds machine-level install state only (the guard engine, the
// `capsule` shim, the receipt-signing secret) — NEVER per-project Sentry
// secrets. Each app repo carries its own Sentry token/org (see below), so one
// machine can drive many projects, each with its own credentials.
const CONFIG_DIR = path.join(process.env.HOME ?? "", ".capsule");

// Walk up from `start` to the nearest onboarded repo — one carrying a real
// .capsule template (manifest.yaml) or config (config.json). Requiring one of
// those, and skipping the machine-level ~/.capsule dir, avoids mistaking the
// global install dir for a project. Lets `capsule <cmd>` work from anywhere
// inside a project.
function findRepo(start: string): string | null {
  let d = path.resolve(start);
  for (;;) {
    if (
      d !== CONFIG_DIR &&
      (existsSync(path.join(d, ".capsule", "manifest.yaml")) ||
        existsSync(path.join(d, ".capsule", "config.json")))
    ) {
      return d;
    }
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

const apiBase = () => process.env.SENTRY_API_BASE ?? "https://sentry.io";
const TARGET_URL = process.env.TARGET_URL ?? "http://localhost:3002";
// The app repo capsule operates on, resolved lazily on every call so that
// CAPSULE_APP_DIR set mid-run (e.g. by the init→repro handoff) takes effect.
// resolveAppDir() returns null when we're not in an onboarded repo; callers
// that need a real repo use that to fail with a helpful message.
function resolveAppDir(): string | null {
  if (process.env.CAPSULE_APP_DIR) return path.resolve(process.env.CAPSULE_APP_DIR);
  return findRepo(process.cwd());
}
function currentAppDir(): string {
  return (
    resolveAppDir() ?? path.resolve(import.meta.dir, "..", "demo-app")
  );
}

const repoCapsuleDir = (appDir: string) => path.join(appDir, ".capsule");
const repoConfigPath = (appDir: string) =>
  path.join(repoCapsuleDir(appDir), "config.json");
const repoCredsPath = (appDir: string) =>
  path.join(repoCapsuleDir(appDir), "credentials");

// Load a repo's own Sentry config into the environment. A real shell export
// still wins (??=); a value auto-loaded from the cwd's .env does NOT, because
// it was scrubbed at startup (see the cwd-.env scrub below). Within a repo:
//   .capsule/config.json (org/apiBase) + .capsule/credentials (token)
//   >  the repo's own .env  (fallback)
async function loadRepoSentryConfig(appDir: string): Promise<void> {
  const setEnvFrom = (text: string) => {
    for (const line of text.split("\n")) {
      const m = line.match(
        /^\s*(?:export\s+)?(SENTRY_AUTH_TOKEN|SENTRY_ORG|SENTRY_API_BASE)\s*=\s*(.*?)\s*$/,
      );
      if (!m) continue;
      let v = m[2];
      if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
      process.env[m[1]] ??= v;
    }
  };
  try {
    const cf = Bun.file(repoConfigPath(appDir));
    if (await cf.exists()) {
      const c = JSON.parse(await cf.text());
      if (c.sentryOrg) process.env.SENTRY_ORG ??= c.sentryOrg;
      if (c.sentryApiBase) process.env.SENTRY_API_BASE ??= c.sentryApiBase;
    }
  } catch {}
  try {
    const creds = Bun.file(repoCredsPath(appDir));
    if (await creds.exists()) setEnvFrom(await creds.text());
  } catch {}
  try {
    const dotenv = Bun.file(path.join(appDir, ".env"));
    if (await dotenv.exists()) setEnvFrom(await dotenv.text());
  } catch {}
}

// Capsule state lives with the product, never with the code under test — a
// fix workspace must be able to run `capsule test` without capsules/ (or any
// judge internals) being reachable inside it.
const CAPSULE_HOME = path.resolve(
  process.env.CAPSULE_HOME ?? path.resolve(import.meta.dir, ".."),
);

function capsRoot(): string {
  return path.join(CAPSULE_HOME, "capsules");
}

interface Frame {
  filename?: string;
  function?: string;
  line?: number;
}

interface Evidence {
  issueId: string;
  issueUrl: string;
  app?: string; // owning app (manifest.app) — scopes the regression pack
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

Start here:
  capsule init [dir]                 one-time onboarding wizard: checks prereqs,
                                     stores your Sentry token + config, installs the
                                     \`capsule\` command, authors the .capsule/ template.
                                     Then you can run everything below with no env vars.
                                     Flags: --sentry-token <t> --org <slug> --app-dir <d>
                                            --yes (non-interactive) --force --skip-template
  capsule doctor                     re-check prerequisites, config, and token any time

Everyday:
  capsule repro <sentry-issue-url>   create + run in one shot (the common case)
  capsule create <sentry-issue-url>  fetch evidence + build & boot the isolated stack
  capsule run <issue-id>             fire the captured trigger; exit 0 = bug reproduced
  capsule apply <issue-id>           swap your local tree into the bug's running stack
  capsule test <issue-id> [--dir D]  judge a worktree against the capsule: build →
                                     reset world → replay → verdict + signed receipt.
                                     THE fix-session verb.
  capsule test                       regression pack across all capsules
  capsule verify-receipt <file>      check a receipt's signature (CI / PR review)
  capsule protect [workspace]        guard a fix repo (permission denies + OS sandbox +
                                     capsule-guard hook) so an agent can only \`capsule test\`

Config lives in ~/.capsule (written by init). Env vars still override:
  SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_API_BASE, CAPSULE_APP_DIR, TARGET_URL`);
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
  const url = `${apiBase()}/api/0/organizations/${org}/issues/${issueId}/events/latest/`;
  let res: globalThis.Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    fail(`cannot reach Sentry API at ${apiBase()}: ${e}`);
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

function renderReproSh(
  ev: Evidence,
  target: string,
  auth?: ReproAuth | null,
): string {
  const req = ev.request!;
  const bodyArgs =
    req.body == null
      ? ""
      : `-H 'content-type: ${req.contentType}' --data-binary @"$DIR/request-body.json"`;
  const authPrelude = auth
    ? `
# The captured Authorization header arrived scrubbed ([Filtered]) — mint a
# fresh token against the capsule's own restored state instead.
TOKEN=$(curl -s -X POST "$TARGET${auth.login_path}" -H 'content-type: application/json' --data '${auth.body}' | sed -E 's/.*"${auth.token_field}":"([^"]+)".*/\\1/')
`
    : "";
  const authHeader = auth ? `-H "authorization: Bearer $TOKEN" ` : "";
  return `#!/usr/bin/env bash
# Sentry issue ${ev.issueId} — ${ev.exception.type}: ${ev.exception.value}
# Contract: exits non-zero while the bug is present.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="\${TARGET_URL:-${target}}"
${authPrelude}OUT="$(mktemp)"
STATUS=$(curl -s -o "$OUT" -w '%{http_code}' -X ${req.method} ${authHeader}"$TARGET${req.path}" ${bodyArgs})
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

async function writeCapsule(
  ev: Evidence,
  target: string,
  auth?: ReproAuth | null,
): Promise<string> {
  const dir = path.join(capsRoot(), ev.issueId);
  // Guard against two different bugs sharing an id (e.g. same issue number in
  // two Sentry orgs) silently clobbering each other's snapshot.
  const existing = path.join(dir, "evidence.json");
  if (existsSync(existing)) {
    try {
      const prev = JSON.parse(readFileSync(existing, "utf8"));
      if (prev.issueUrl && prev.issueUrl !== ev.issueUrl) {
        fail(
          `capsule ${ev.issueId} already exists for a different issue (${prev.issueUrl}). ` +
            `Issue-id collision across orgs — use a separate CAPSULE_HOME per org.`,
        );
      }
    } catch {}
  }
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
    await Bun.write(repro, renderReproSh(ev, target, auth));
    await chmod(repro, 0o755);
  }
  return dir;
}

// Find a compose-managed container without knowing its stack's compose files.
async function containerId(
  project: string,
  service: string,
): Promise<string | null> {
  const ps =
    await $`docker ps -q --filter label=com.docker.compose.project=${project} --filter label=com.docker.compose.service=${service}`
      .quiet()
      .nothrow();
  return ps.stdout.toString().trim().split("\n")[0] || null;
}

// World capture (flavor A): pg_dump the live stack's DB into the capsule.
// Failure is non-fatal — the capsule degrades to stateless replay.
async function dumpState(m: Manifest, dir: string): Promise<boolean> {
  const s = m.state;
  if (!s?.service || !s.source_project) return false;
  const cid = await containerId(s.source_project, s.service);
  if (!cid) {
    console.log(
      `⚠ no running ${s.service} container in compose project ${s.source_project} — capsule gets no state snapshot`,
    );
    return false;
  }
  const dump = await $`docker exec ${cid} pg_dump -U ${s.user} -Fc ${s.database}`
    .quiet()
    .nothrow();
  if (dump.exitCode !== 0) {
    console.log(
      `⚠ pg_dump failed (exit ${dump.exitCode}) — continuing without state\n${dump.stderr.toString().slice(-400)}`,
    );
    return false;
  }
  await Bun.write(path.join(dir, "seed.dump"), dump.stdout);
  console.log(
    `→ captured state snapshot from ${s.source_project}/${s.service} (${dump.stdout.length} bytes)`,
  );
  return true;
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
  // World: which service holds state, and which live compose project to
  // snapshot it from at create-time (PLAN.md flavor A — exact dump, no slicing).
  state?: {
    engine?: string;
    service?: string;
    database?: string;
    user?: string;
    source_project?: string;
  };
  // Sentry scrubs Authorization headers, so replays against authed endpoints
  // mint a fresh token from the capsule's own restored state.
  repro?: {
    auth?: { login_path: string; body: string; token_field: string };
  };
}

type ReproAuth = NonNullable<NonNullable<Manifest["repro"]>["auth"]>;

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

  // World restore: if the capsule carries a state snapshot, boot the DB
  // alone, restore into it, and only then bring up the app — its boot-time
  // migration check then sees the snapshot's schema, not an empty database.
  const seedFile = path.join(path.dirname(envFile), "seed.dump");
  if (m.state?.service && existsSync(seedFile)) {
    console.log(
      `→ restoring state snapshot into ${m.state.service} (${statSync(seedFile).size} bytes)`,
    );
    const upDb = await $`docker compose ${flags} up -d --wait ${m.state.service}`
      .cwd(appDir)
      .nothrow();
    if (upDb.exitCode !== 0) {
      throw new Error(
        `docker compose up ${m.state.service} failed (exit ${upDb.exitCode})\n${upDb.stderr.toString().slice(-2000)}`,
      );
    }
    const cid = await containerId(project, m.state.service);
    if (!cid) throw new Error(`no ${m.state.service} container in ${project}`);
    const restore =
      await $`docker exec -i ${cid} pg_restore -U ${m.state.user} -d ${m.state.database} --clean --if-exists --no-owner < ${seedFile}`.nothrow();
    if (restore.exitCode !== 0) {
      throw new Error(
        `pg_restore failed (exit ${restore.exitCode})\n${restore.stderr.toString().slice(-2000)}`,
      );
    }
    console.log(`→ state restored into ${project}`);
  }

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
      currentAppDir(),
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
    `→ target app not responding at ${TARGET_URL} — starting docker compose in ${currentAppDir()}`,
  );
  const result = await $`docker compose up -d --build --wait`
    .cwd(currentAppDir())
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

// Author (via Claude Code) + machine-verify a .capsule/ template. Returns
// true on success; throws on hard errors. One step of `capsule init`.
async function ensureTemplate(appDir: string, force: boolean): Promise<boolean> {
  if (!existsSync(appDir)) fail(`no such directory: ${appDir}`);
  const hasTemplate = existsSync(
    path.join(appDir, ".capsule", "manifest.yaml"),
  );

  if (hasTemplate && !force) {
    console.log("→ .capsule/ template exists — verifying (build + boot)");
    const v = await verifyTemplate(appDir);
    if (v.ok) {
      console.log(`  ✓ template verified — ${v.log}`);
      return true;
    }
    console.log(
      `  ✗ existing template failed verification:\n${v.log.slice(0, 800)}\n  re-authoring…`,
    );
  }

  if ((await $`which claude`.quiet().nothrow()).exitCode !== 0) {
    console.log(
      "  ⚠ skipping template authoring — `claude` CLI not found.\n" +
        "    Install Claude Code, then re-run `capsule init`, or author .capsule/ by hand.",
    );
    return false;
  }

  let failureLog = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(
      `→ authoring .capsule/ with Claude Code (attempt ${attempt}/3 — a few minutes)`,
    );
    const run =
      await $`claude -p ${initPrompt(failureLog)} --permission-mode acceptEdits`
        .cwd(appDir)
        .nothrow();
    if (run.exitCode !== 0) fail(`claude exited with ${run.exitCode}`);
    await $`chmod +x ${path.join(appDir, ".capsule", "build.sh")}`
      .quiet()
      .nothrow();

    console.log("→ machine-verifying the template (build + boot + healthcheck)");
    const v = await verifyTemplate(appDir);
    if (v.ok) {
      console.log(`  ✓ template authored and verified — ${v.log}`);
      return true;
    }
    failureLog = v.log;
    console.log(`  ✗ verification failed (attempt ${attempt}):\n${v.log.slice(0, 1000)}\n`);
  }
  fail("template did not pass verification after 3 attempts — inspect .capsule/ and finish by hand");
}

// ─── onboarding: per-repo config, prompts, prerequisites ────────────────────
async function loadRepoConfig(appDir: string): Promise<Record<string, any>> {
  const f = Bun.file(repoConfigPath(appDir));
  if (!(await f.exists())) return {};
  try {
    return JSON.parse(await f.text());
  } catch {
    return {};
  }
}

// Non-secret per-repo config — safe to commit and share with the team.
async function saveRepoConfig(
  appDir: string,
  patch: Record<string, any>,
): Promise<void> {
  await mkdir(repoCapsuleDir(appDir), { recursive: true });
  const merged = { ...(await loadRepoConfig(appDir)), ...patch };
  await Bun.write(repoConfigPath(appDir), JSON.stringify(merged, null, 2) + "\n");
}

// The Sentry token is per-repo and secret: it lives in .capsule/credentials,
// which we keep out of git via .capsule/.gitignore.
async function saveRepoSentryToken(
  appDir: string,
  token: string,
): Promise<void> {
  const cdir = repoCapsuleDir(appDir);
  await mkdir(cdir, { recursive: true });

  // Ensure .gitignore covers the credential BEFORE the token touches disk, so
  // there's no window where a git add could commit it (and no plaintext file
  // left uncovered if the ignore write fails).
  const gi = path.join(cdir, ".gitignore");
  const want = ["credentials", ".env", ".env.*", ".env.verify"];
  let lines: string[] = [];
  if (existsSync(gi)) lines = readFileSync(gi, "utf8").split("\n");
  const have = new Set(lines.map((l) => l.trim()));
  const add = want.filter((w) => !have.has(w));
  if (add.length) {
    await Bun.write(
      gi,
      (lines.join("\n").replace(/\n*$/, "") + "\n" + add.join("\n") + "\n").replace(
        /^\n+/,
        "",
      ),
    );
  }

  // Create the secret restrictively in one step (never world-readable, even
  // for an instant), belt-and-suspenders chmod after.
  await writeFile(repoCredsPath(appDir), `SENTRY_AUTH_TOKEN=${token}\n`, {
    mode: 0o600,
  });
  await chmod(repoCredsPath(appDir), 0o600);
  process.env.SENTRY_AUTH_TOKEN = token;
}

function interactive(yes?: boolean): boolean {
  return Boolean(process.stdin.isTTY) && !yes;
}

function promptLine(q: string, def?: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(def ? `${q} [${def}]: ` : `${q}: `, (ans) => {
      rl.close();
      resolve(ans.trim() || def || "");
    });
  });
}

// no-echo read for secrets (token paste)
function promptSecret(q: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(q + ": ");
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    let buf = "";
    const done = () => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      resolve(buf.trim());
    };
    const onData = (d: Buffer) => {
      for (const code of d) {
        if (code === 3) {
          process.stdout.write("\n");
          process.exit(1);
        }
        if (code === 4 || code === 10 || code === 13) return done();
        if (code === 127 || code === 8) buf = buf.slice(0, -1);
        else if (code >= 32) buf += String.fromCharCode(code);
      }
    };
    stdin.on("data", onData);
  });
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
}

async function preflight(): Promise<Check[]> {
  const which = async (bin: string) =>
    (await $`which ${bin}`.quiet().nothrow()).exitCode === 0;
  const dockerUp =
    (await $`docker version --format {{.Server.Version}}`.quiet().nothrow())
      .exitCode === 0;
  return [
    {
      name: "docker",
      ok: dockerUp,
      required: true,
      detail: dockerUp
        ? "daemon reachable"
        : "not running — start Docker Desktop / dockerd",
    },
    {
      name: "bun",
      ok: true,
      required: true,
      detail: `runtime ${Bun.version}`,
    },
    {
      name: "git",
      ok: await which("git"),
      required: false,
      detail: "used to tag capsule images",
    },
    {
      name: "python3",
      ok: existsSync("/usr/bin/python3") || (await which("python3")),
      required: false,
      detail: "runs the capsule-guard hook (capsule protect)",
    },
    {
      name: "claude",
      ok: await which("claude"),
      required: false,
      detail: "authors the .capsule/ template on first onboard",
    },
  ];
}

// GET the org list to prove the token works; returns org slugs.
async function validateSentryToken(): Promise<{ ok: boolean; orgs: string[] }> {
  const token = process.env.SENTRY_AUTH_TOKEN;
  if (!token) return { ok: false, orgs: [] };
  try {
    const res = await fetch(`${apiBase()}/api/0/organizations/`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, orgs: [] };
    const arr: any[] = await res.json();
    return { ok: true, orgs: arr.map((o) => o.slug).filter(Boolean) };
  } catch {
    return { ok: false, orgs: [] };
  }
}

// Install the `capsule` shim on PATH and the guard engine, both outside every
// fix workspace. Shared by `capsule init` and `capsule protect`.
async function installShimAndGuard(): Promise<{
  shim: string;
  guard: string;
  onPath: boolean;
}> {
  const home = process.env.HOME ?? "";
  if (!home) fail("HOME is not set");
  const binDir = path.join(home, ".capsule", "bin");
  await mkdir(binDir, { recursive: true });
  const guard = path.join(binDir, "capsule-guard.py");
  await $`cp ${path.join(import.meta.dir, "guard.py")} ${guard}`;
  const shim = path.join(home, ".local", "bin", "capsule");
  await mkdir(path.dirname(shim), { recursive: true });
  await Bun.write(
    shim,
    `#!/bin/bash\nexec ${process.execPath} ${path.join(import.meta.dir, "capsule.ts")} "$@"\n`,
  );
  await chmod(shim, 0o755);
  const onPath = (process.env.PATH ?? "")
    .split(":")
    .includes(path.dirname(shim));
  return { shim, guard, onPath };
}

function looksLikeApp(dir: string): boolean {
  return [
    "package.json",
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yaml",
    "pyproject.toml",
    "go.mod",
    "pom.xml",
    "Gemfile",
  ].some((f) => existsSync(path.join(dir, f)));
}

interface InitOpts {
  appDir?: string;
  token?: string;
  org?: string;
  yes?: boolean;
  force?: boolean;
  reproUrl?: string;
  skipTemplate?: boolean;
}

// The onboarding wizard: everything a user needs to go from a cloned repo to
// running `capsule repro`. Asks only for what can't be detected (the Sentry
// token), persists the rest, and is safely re-runnable.
async function cmdInit(opts: InitOpts): Promise<void> {
  const tty = interactive(opts.yes);
  console.log("\ncapsule onboarding\n──────────────────");

  // 1. prerequisites
  const checks = await preflight();
  for (const c of checks) {
    const mark = c.ok ? "✓" : c.required ? "✗" : "○";
    console.log(`  ${mark} ${c.name.padEnd(8)} ${c.detail}`);
  }
  const missingReq = checks.filter((c) => c.required && !c.ok);
  if (missingReq.length) {
    fail(
      `missing required tools: ${missingReq
        .map((c) => c.name)
        .join(", ")}. Fix the above and re-run \`capsule init\`.`,
    );
  }

  // 2. app repo to onboard
  let appDir = opts.appDir
    ? path.resolve(opts.appDir)
    : looksLikeApp(process.cwd())
      ? process.cwd()
      : tty
        ? path.resolve(
            await promptLine("path to the app repo to onboard", process.cwd()),
          )
        : process.cwd();
  if (!existsSync(appDir)) fail(`no such directory: ${appDir}`);
  if (!looksLikeApp(appDir)) {
    if (tty) {
      const go = await promptLine(
        `${appDir} doesn't look like an app repo (no package.json/Dockerfile/compose). Continue anyway? (y/N)`,
        "N",
      );
      if (!/^y/i.test(go)) fail("aborted — point capsule init at your app repo");
    } else {
      console.log(`  ⚠ ${appDir} has no obvious app manifest — continuing`);
    }
  }
  console.log(`\n→ app repo: ${appDir}`);

  // Pick up any credentials this repo already has (re-runnable onboarding).
  await loadRepoSentryConfig(appDir);

  // 3. Sentry token — per repo, so every project uses its own key.
  // Accept --sentry-token @file (avoids the token in shell history / ps).
  let provided = opts.token;
  if (provided?.startsWith("@")) {
    const p = path.resolve(provided.slice(1));
    if (!existsSync(p)) fail(`--sentry-token file not found: ${p}`);
    provided = readFileSync(p, "utf8").trim();
  } else if (provided) {
    console.log(
      "  ⚠ an inline --sentry-token is visible in shell history and `ps`; prefer --sentry-token @file or the interactive prompt.",
    );
  }
  if (provided) await saveRepoSentryToken(appDir, provided);
  if (!process.env.SENTRY_AUTH_TOKEN) {
    if (!tty) {
      fail(
        "no Sentry auth token for this repo. Pass --sentry-token <t>, set " +
          "SENTRY_AUTH_TOKEN, or run interactively. Create one at Sentry → " +
          "Settings → Auth Tokens (scopes: org:read, event:read).",
      );
    }
    console.log(
      "\nThis repo needs its own Sentry auth token (each project uses its own).\n" +
        "  Sentry → Settings → Auth Tokens → Create (scopes: org:read, event:read)",
    );
    const t = await promptSecret("paste Sentry auth token (hidden)");
    if (!t) fail("no token entered");
    await saveRepoSentryToken(appDir, t);
  }
  process.stdout.write("→ validating token… ");
  const who = await validateSentryToken();
  if (!who.ok) {
    console.log("✗");
    fail(
      "token rejected by Sentry (check scopes org:read + event:read, or SENTRY_API_BASE). " +
        `Stored at ${repoCredsPath(appDir)} — edit or delete and re-run.`,
    );
  }
  console.log(`✓ ${who.orgs.length} org(s): ${who.orgs.join(", ") || "—"}`);

  // Capture the token into this repo even if it arrived via the environment,
  // so later runs need no env var. (Skips if the repo already stores its own.)
  if (!existsSync(repoCredsPath(appDir)) && process.env.SENTRY_AUTH_TOKEN) {
    await saveRepoSentryToken(appDir, process.env.SENTRY_AUTH_TOKEN);
  }

  // 4. default org for this repo (so issue URLs need not carry it)
  let org = opts.org ?? process.env.SENTRY_ORG;
  if (!org) {
    if (who.orgs.length === 1) org = who.orgs[0];
    else if (tty && who.orgs.length > 1)
      org =
        (await promptLine(
          `default Sentry org for this repo (${who.orgs.join(", ")})`,
          who.orgs[0],
        )) || undefined;
  }

  // 5. persist non-secret config into the repo (committable)
  await saveRepoConfig(appDir, {
    ...(org ? { sentryOrg: org } : {}),
    ...(process.env.SENTRY_API_BASE &&
    process.env.SENTRY_API_BASE !== "https://sentry.io"
      ? { sentryApiBase: process.env.SENTRY_API_BASE }
      : {}),
  });
  console.log(
    `→ saved ${path.relative(appDir, repoConfigPath(appDir))} (config) + ${path.relative(appDir, repoCredsPath(appDir))} (token, git-ignored)`,
  );

  // 6. install the `capsule` command + guard engine (machine-level, once)
  const { shim, onPath } = await installShimAndGuard();
  console.log(`→ installed \`capsule\` at ${shim}`);
  if (!onPath) {
    console.log(
      `  ⚠ ${path.dirname(shim)} is not on your PATH. Add it:\n` +
        `      echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc`,
    );
  }

  // 7. environment template (author + verify)
  let templateOk = existsSync(path.join(appDir, ".capsule", "manifest.yaml"));
  if (!opts.skipTemplate) {
    templateOk = await ensureTemplate(appDir, Boolean(opts.force));
  }

  // 8. done — and optionally repro straight away
  console.log("\n✓ onboarding complete.");
  if (opts.reproUrl) {
    console.log(`\n→ reproducing ${opts.reproUrl}\n`);
    process.env.CAPSULE_APP_DIR = appDir;
    const created = await cmdCreate(opts.reproUrl);
    if (created.hasRequest) await cmdRun(created.bugId, created.target);
    return;
  }
  console.log(
    "\nnext:\n" +
      "  capsule repro <sentry-issue-url>     reproduce a bug in an isolated stack\n" +
      (templateOk
        ? ""
        : "  (install `claude`, then re-run `capsule init` to author the .capsule/ template)\n") +
      "  capsule protect <fix-workspace>      guard a repo where an agent will fix bugs\n" +
      "  capsule doctor                       re-check your setup any time",
  );
}

// Read-only health check: prerequisites + this repo's config + capsule inventory.
async function cmdDoctor(appDirArg?: string): Promise<void> {
  console.log("\ncapsule doctor\n──────────────");
  const checks = await preflight();
  for (const c of checks) {
    const mark = c.ok ? "✓" : c.required ? "✗" : "○";
    console.log(`  ${mark} ${c.name.padEnd(8)} ${c.detail}`);
  }
  const appDir = appDirArg
    ? path.resolve(appDirArg)
    : (findRepo(process.cwd()) ?? process.cwd());
  const onboarded = existsSync(repoCapsuleDir(appDir));
  await loadRepoSentryConfig(appDir);
  const cfg = await loadRepoConfig(appDir);
  const tokenSet = Boolean(process.env.SENTRY_AUTH_TOKEN);
  console.log(`\nrepo: ${appDir}`);
  console.log(
    `  onboarded   ${existsSync(repoCapsuleDir(appDir)) ? "yes (.capsule/ present)" : "no — run capsule init here"}`,
  );
  console.log(`  sentry org  ${cfg.sentryOrg ?? "(auto from issue URL)"}`);
  console.log(
    `  token       ${tokenSet ? "present (this repo)" : "MISSING — run capsule init here"}`,
  );
  const home = process.env.HOME ?? "";
  const shim = path.join(home, ".local", "bin", "capsule");
  const onPath = (process.env.PATH ?? "").split(":").includes(path.dirname(shim));
  console.log(
    `  capsule cmd ${existsSync(shim) ? (onPath ? "on PATH" : "installed, NOT on PATH") : "not installed — run capsule init"}`,
  );
  if (tokenSet) {
    process.stdout.write("  token check ");
    const who = await validateSentryToken();
    console.log(who.ok ? `valid (${who.orgs.join(", ")})` : "REJECTED by Sentry");
  }
  const root = capsRoot();
  const caps = existsSync(root)
    ? readdirSync(root).filter((d) => !d.startsWith("."))
    : [];
  console.log(`\ncapsules: ${caps.length ? caps.join(", ") : "none yet"}`);
  const ready =
    checks.every((c) => !c.required || c.ok) && onboarded && tokenSet;
  console.log(
    `\n${ready ? "✓ ready — capsule repro <sentry-issue-url>" : "○ run capsule init in this repo to finish setup"}`,
  );
}

// Apply the local working tree to a bug's running stack: rebuild the image
// with a distinct tag, swap only the app service, leave state untouched.
async function cmdApply(bugId: string): Promise<void> {
  const dir = path.join(capsRoot(), bugId);
  const envFile = path.join(dir, ".env.capsule");
  if (!existsSync(envFile)) {
    fail(`no capsule stack config at ${envFile} — run capsule repro first`);
  }
  const m = await loadManifest(currentAppDir());
  if (!m) fail(`no .capsule/ template in ${currentAppDir()}`);
  const port = Number(readEnvFile(envFile).CAPSULE_PORT);
  if (!port) fail(`${envFile} has no CAPSULE_PORT`);
  const project = `capsule-${bugId}`;

  const ps =
    await $`docker compose ${composeFlags(currentAppDir(), m, project, envFile)} ps -q`
      .cwd(currentAppDir())
      .quiet()
      .nothrow();
  if (!ps.stdout.toString().trim()) {
    fail(`stack ${project} is not running — run capsule repro first`);
  }

  // Distinct tag per apply, so the test verdict pins to an exact image.
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  let image: string;
  try {
    image = await buildImage(currentAppDir(), `fix-${stamp}`);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  await Bun.write(envFile, `CAPSULE_IMAGE=${image}\nCAPSULE_PORT=${port}\n`);

  const service = m.run.service ?? "app";
  console.log(
    `→ swapping ${service} in ${project} to ${image} (state untouched)`,
  );
  const up =
    await $`docker compose ${composeFlags(currentAppDir(), m, project, envFile)} up -d --no-deps ${service}`
      .cwd(currentAppDir())
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

// ─── fixer-plane verb: capsule test <id> ────────────────────────────────────
// The one command a fix workspace may run. Builds a candidate image from the
// caller's worktree using the CAPSULE's snapshot of the build recipe, resets
// the judge's world from seed.dump, replays the trigger, and returns the
// verdict as an exit code plus a delta signal — never raw state. Every
// verdict is written as an HMAC-signed receipt.

async function loadRecipeManifest(recipeDir: string): Promise<Manifest> {
  const file = Bun.file(path.join(recipeDir, "manifest.yaml"));
  if (!(await file.exists()))
    throw new Error(`capsule recipe has no manifest.yaml in ${recipeDir}`);
  return Bun.YAML.parse(await file.text()) as Manifest;
}

// Snapshot the app's .capsule/ template plus its compose file into the
// capsule record at create-time, so the judge never executes fix-workspace
// authored compose/overlay files.
async function snapshotRecipe(
  appDir: string,
  m: Manifest,
  dir: string,
): Promise<void> {
  const rd = path.join(dir, ".capsule-recipe");
  await mkdir(rd, { recursive: true });
  const cp = await $`cp -R ${path.join(appDir, ".capsule")}/. ${rd}/`.nothrow();
  if (cp.exitCode !== 0) throw new Error("failed to snapshot .capsule/ recipe");
  const compose =
    await $`cp ${path.join(appDir, m.run.compose)} ${path.join(rd, "compose.snapshot.yaml")}`.nothrow();
  if (compose.exitCode !== 0)
    throw new Error(`failed to snapshot ${m.run.compose}`);
  console.log(`→ snapshotted build recipe into ${path.relative(CAPSULE_HOME, rd)}/`);
}

function recipeComposeFlags(
  recipeDir: string,
  project: string,
  envFile: string,
): string[] {
  return [
    "-p",
    project,
    "-f",
    path.join(recipeDir, "compose.snapshot.yaml"),
    "-f",
    path.join(recipeDir, "overlay.yaml"),
    "--env-file",
    envFile,
  ];
}

async function hmacKey(): Promise<string> {
  // A shared team/CI secret makes receipts verifiable across machines; the
  // per-machine file is the local-only fallback.
  if (process.env.CAPSULE_SECRET) return process.env.CAPSULE_SECRET;
  const keyFile = path.join(
    process.env.HOME ?? "~",
    ".capsule",
    "secret",
  );
  if (!existsSync(keyFile)) {
    await mkdir(path.dirname(keyFile), { recursive: true });
    await Bun.write(keyFile, crypto.randomUUID() + crypto.randomUUID());
    await chmod(keyFile, 0o600);
  }
  return (await Bun.file(keyFile).text()).trim();
}

async function signReceipt(receipt: Record<string, unknown>): Promise<string> {
  const { createHmac } = await import("node:crypto");
  return createHmac("sha256", await hmacKey())
    .update(JSON.stringify(receipt))
    .digest("hex");
}

async function cmdVerifyReceipt(file: string): Promise<void> {
  if (!existsSync(file)) fail(`no such receipt: ${file}`);
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const { sig, ...body } = parsed;
  const expect = await signReceipt(body);
  if (sig !== expect) {
    console.log("✗ TAMPERED — signature does not match receipt contents");
    process.exit(1);
  }
  console.log(
    `✓ authentic capsule receipt\n  capsule: ${body.capsule}\n  verdict: ${body.verdict}${body.tier ? ` (${body.tier})` : ""}\n  worktree: ${body.worktree} @ ${body.git?.head}${body.git?.dirty ? " (dirty)" : ""}\n  image: ${body.image}\n  at: ${body.at}`,
  );
}

async function cmdVerify(bugId: string, worktreeArg?: string): Promise<void> {
  const dir = path.join(capsRoot(), bugId);
  const recipeDir = path.join(dir, ".capsule-recipe");
  const reproSh = path.join(dir, "repro.sh");
  const seedFile = path.join(dir, "seed.dump");
  if (!existsSync(recipeDir))
    fail(`capsule ${bugId} has no build recipe — re-run capsule create`);
  if (!existsSync(reproSh)) fail(`capsule ${bugId} has no repro.sh`);

  const worktree = path.resolve(worktreeArg ?? process.cwd());
  let m: Manifest;
  try {
    m = await loadRecipeManifest(recipeDir);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  if (!existsSync(path.join(worktree, "package.json")))
    fail(
      `${worktree} does not look like the app's source tree (no package.json) — run capsule test from the repo you are fixing, or pass --dir`,
    );

  // Guard against judging the wrong app: if the worktree is itself onboarded,
  // its app name must match the capsule's. Building this capsule's recipe
  // against a different app's source would produce a meaningless verdict.
  const wtManifest = await loadManifest(worktree);
  if (wtManifest?.app && m.app && wtManifest.app !== m.app) {
    fail(
      `capsule ${bugId} is for app "${m.app}", but ${worktree} is app "${wtManifest.app}". ` +
        `Run capsule test from the "${m.app}" repo.`,
    );
  }

  // identity of the tree under test, for the receipt
  const head =
    (await $`git -C ${worktree} rev-parse --short HEAD`.quiet().nothrow())
      .stdout.toString().trim() || "nogit";
  const dirtyDiff = (
    await $`git -C ${worktree} diff HEAD`.quiet().nothrow()
  ).stdout.toString();
  const dirty = dirtyDiff.trim().length > 0;
  const { createHash } = await import("node:crypto");
  const diffHash = createHash("sha256").update(dirtyDiff).digest("hex").slice(0, 12);

  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  console.log(
    `→ building candidate image from ${worktree} (${head}${dirty ? `+${diffHash}` : ""})`,
  );
  let image: string;
  try {
    const script = path.join(recipeDir, "build.sh");
    const build = await $`bash ${script} candidate-${stamp}`
      .cwd(worktree)
      .env({ ...process.env, CAPSULE_SRC_ROOT: worktree } as Record<
        string,
        string
      >)
      .nothrow();
    if (build.exitCode !== 0)
      throw new Error(
        `recipe build.sh failed (exit ${build.exitCode})\n${build.stderr.toString().slice(-2000)}`,
      );
    image = build.stdout.toString().trim().split("\n").at(-1)!;
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }

  const project = `capsule-${bugId}`;
  const envFile = path.join(dir, ".env.capsule");
  const port = Number(readEnvFile(envFile).CAPSULE_PORT) || freePort();
  await Bun.write(envFile, `CAPSULE_IMAGE=${image}\nCAPSULE_PORT=${port}\n`);
  const flags = recipeComposeFlags(recipeDir, project, envFile);
  const service = m.run.service ?? "app";

  // Deterministic judging: tear the whole stack down (containers + volume)
  // and rebuild the world from the snapshot before every verdict, so neither
  // an earlier candidate nor a stale container can move the goalposts.
  console.log(`→ resetting capsule world from seed.dump (project ${project})`);
  await $`docker compose ${flags} down -v --remove-orphans`
    .cwd(CAPSULE_HOME)
    .quiet()
    .nothrow();
  if (m.state?.service && existsSync(seedFile)) {
    const upDb = await $`docker compose ${flags} up -d --wait ${m.state.service}`
      .cwd(CAPSULE_HOME)
      .nothrow();
    if (upDb.exitCode !== 0)
      fail(`could not start capsule db (exit ${upDb.exitCode})`);
    const cid = await containerId(project, m.state.service);
    if (!cid) fail(`no ${m.state.service} container in ${project}`);
    const restore =
      await $`docker exec -i ${cid} pg_restore -U ${m.state.user} -d ${m.state.database} --clean --if-exists --no-owner < ${seedFile}`.nothrow();
    if (restore.exitCode !== 0)
      fail(
        `world restore failed (exit ${restore.exitCode})\n${restore.stderr.toString().slice(-1500)}`,
      );
  }
  const up = await $`docker compose ${flags} up -d --wait`
    .cwd(CAPSULE_HOME)
    .nothrow();
  if (up.exitCode !== 0)
    fail(
      `candidate stack failed to start (exit ${up.exitCode})\n${up.stderr.toString().slice(-2000)}`,
    );
  const target = `http://localhost:${port}`;
  if (!(await pollHealth(target, m)))
    fail(`candidate app not healthy at ${target}${m.run.healthcheck}`);

  console.log(`→ candidate healthy — replaying the captured trigger\n`);
  // Pin the target to the candidate's own stack — an inherited TARGET_URL
  // would divert the replay off-box and repro.sh would skip the tier-2 check,
  // forging a PASS. The verdict must be about THIS stack.
  const r = await $`bash ${reproSh}`
    .env({ ...process.env, TARGET_URL: target } as Record<string, string>)
    .quiet()
    .nothrow();
  const out = r.stdout.toString();
  process.stdout.write(out);
  const pass = r.exitCode === 0;
  const tier = /\[tier 1/.test(out)
    ? "tier 1: fingerprint"
    : /\[tier 2/.test(out)
      ? "tier 2: expectation"
      : null;

  // signed receipt — the artifact a PR can carry
  let issueUrl = "";
  try {
    issueUrl = JSON.parse(
      readFileSync(path.join(dir, "evidence.json"), "utf8"),
    ).issueUrl;
  } catch {}
  const receiptBody = {
    v: 1,
    capsule: bugId,
    issueUrl,
    verdict: pass ? "PASS" : "FAIL",
    tier: pass ? null : tier,
    worktree,
    git: { head, dirty, diffHash: dirty ? diffHash : null },
    image,
    output: out.trim().split("\n").slice(-8),
    at: new Date().toISOString(),
  };
  const receipt = { ...receiptBody, sig: await signReceipt(receiptBody) };
  const receiptsDir = path.join(dir, "receipts");
  await mkdir(receiptsDir, { recursive: true });
  const receiptFile = path.join(
    receiptsDir,
    `${stamp}-${pass ? "pass" : "fail"}.json`,
  );
  await Bun.write(receiptFile, JSON.stringify(receipt, null, 2) + "\n");
  await Bun.write(
    path.join(worktree, ".capsule-receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );

  const deltaLine = out
    .split("\n")
    .find((l) => l.startsWith("expectation:"));
  console.log(`
────────────────────────────────────────────────────────
CAPSULE VERDICT: ${pass ? "PASS — trigger replayed clean and the report agrees with the world" : `FAIL (${tier ?? "error"})`}${
    !pass && tier === "tier 2: expectation"
      ? "\n  the crash is gone but the app still disagrees with its own data:"
      : ""
  }${!pass && deltaLine ? `\n  ${deltaLine}` : ""}
  receipt: ${path.relative(process.cwd(), receiptFile)} (signed; copy at .capsule-receipt.json)
────────────────────────────────────────────────────────`);
  process.exit(r.exitCode);
}

// ─── capsule protect: install fix-workspace guardrails ──────────────────────
// Three enforcement layers so a fix session can never reach capsule state:
// native permission deny rules (file tools), the OS Bash sandbox (denyRead at
// the syscall level), and the capsule-guard PreToolUse hook (docker discipline
// + workspace jail — the gaps the native layers can't express).
async function cmdProtect(workspaceArg?: string): Promise<void> {
  const ws = path.resolve(workspaceArg ?? process.cwd());
  if (!existsSync(ws)) fail(`no such directory: ${ws}`);
  const home = process.env.HOME ?? "";
  if (!home) fail("HOME is not set");
  const deniedRoots = [
    CAPSULE_HOME,
    path.join(home, ".capsule"),
    ...(existsSync(currentAppDir()) ? [currentAppDir()] : []),
  ].filter((r) => r !== ws && !ws.startsWith(r + "/"));

  // guard engine + `capsule` shim, outside every fix workspace
  const { guard: guardDst } = await installShimAndGuard();

  const claudeDir = path.join(ws, ".claude");
  await mkdir(claudeDir, { recursive: true });
  await Bun.write(
    path.join(claudeDir, "capsule-guard.json"),
    JSON.stringify(
      {
        v: 1,
        workspace: ws,
        deniedRoots,
        offline: true,
        allowedCapsuleVerbs: ["test", "verify-receipt"],
      },
      null,
      2,
    ) + "\n",
  );

  const settingsFile = path.join(claudeDir, "settings.json");
  let settings: any = {};
  if (existsSync(settingsFile)) {
    try {
      settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    } catch {
      fail(`${settingsFile} is not valid JSON — fix or remove it first`);
    }
  }
  settings.permissions ??= {};
  const deny: string[] = settings.permissions.deny ?? [];
  for (const rule of [
    "WebSearch",
    "WebFetch",
    "Bash(gh:*)",
    ...deniedRoots.flatMap((r) => [`Read(/${r}/**)`, `Edit(/${r}/**)`]),
  ]) {
    if (!deny.includes(rule)) deny.push(rule);
  }
  settings.permissions.deny = deny;
  // Guardrails must WIN over any pre-existing sandbox block, and the security
  // sub-objects (filesystem/network) merge rather than clobber — so a re-run
  // with changed deniedRoots updates them and can't be silently disabled.
  const ex = settings.sandbox ?? {};
  settings.sandbox = {
    ...ex,
    enabled: true,
    excludedCommands: [
      ...new Set([
        ...(ex.excludedCommands ?? []),
        "docker *",
        "docker-compose *",
        "capsule *",
      ]),
    ],
    filesystem: { ...(ex.filesystem ?? {}), denyRead: deniedRoots },
    network: {
      ...(ex.network ?? {}),
      allowedDomains: [
        "sentry.io",
        "*.sentry.io",
        "registry.npmjs.org",
        "binaries.prisma.sh",
      ],
    },
  };
  settings.hooks ??= {};
  const pre: any[] = settings.hooks.PreToolUse ?? [];
  if (!JSON.stringify(pre).includes("capsule-guard.py")) {
    pre.push({
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: `/usr/bin/python3 ${guardDst}`,
          timeout: 15,
        },
      ],
    });
  }
  settings.hooks.PreToolUse = pre;
  await Bun.write(settingsFile, JSON.stringify(settings, null, 2) + "\n");

  console.log(`✓ capsule protect — guardrails installed for fix workspace ${ws}
  layer 1  permission deny rules: Read/Edit blocked on capsule state dirs
  layer 2  OS sandbox (Seatbelt/bubblewrap): denyRead on the same roots for
           every Bash command; docker + capsule excluded → governed by layer 3
  layer 3  capsule-guard hook on every tool call: workspace jail, docker
           limited to compose/build (no enumeration, sockets, host mounts),
           offline except the Sentry API, capsule CLI limited to
           \`capsule test\` / \`capsule verify-receipt\`
  fix sessions verify only via:  capsule test <issue-id>`);
}

// Replay every capsule's trigger against a running stack. The capsules
// directory is the regression suite: exit 0 = every past bug stays absent.
async function cmdTest(bugId?: string): Promise<void> {
  const root = capsRoot();
  const m = await loadManifest(currentAppDir());
  const healthPath = m?.run.healthcheck ?? "/health";

  // Scope the regression pack to THIS app: replaying another app's captured
  // request against this stack is meaningless. A capsule with no recorded app
  // (legacy) is included for back-compat.
  const readApp = (d: string): string | undefined => {
    try {
      return JSON.parse(
        readFileSync(path.join(root, d, "evidence.json"), "utf8"),
      ).app;
    } catch {
      return undefined;
    }
  };
  const all = existsSync(root)
    ? readdirSync(root).filter(
        (d) => !d.startsWith(".") && existsSync(path.join(root, d, "repro.sh")),
      )
    : [];
  const dirs = all
    .filter((d) => !m?.app || !readApp(d) || readApp(d) === m.app)
    .sort();
  const skipped = all.length - dirs.length;
  if (dirs.length === 0) {
    fail(
      "no capsules for this app with a repro.sh — run capsule repro first" +
        (skipped ? ` (${skipped} belong to other apps)` : ""),
    );
  }
  if (skipped) console.log(`→ ${skipped} capsule(s) for other apps skipped`);

  // Target: explicit TARGET_URL, else the given bug's stack, else the first
  // capsule stack that answers its healthcheck.
  let target = process.env.TARGET_URL ?? "";
  if (!target) {
    for (const d of bugId ? [bugId] : dirs) {
      const env = readEnvFile(path.join(root, d, ".env.capsule"));
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

  console.log(
    `→ replaying ${dirs.length} capsule trigger(s) against ${target}\n`,
  );
  let failed = 0;
  for (const d of dirs) {
    let title = d;
    let reqLabel = "";
    let issueUrl = "";
    try {
      const evj = JSON.parse(
        readFileSync(path.join(root, d, "evidence.json"), "utf8"),
      );
      title = evj.title ?? `${evj.exception?.type}: ${evj.exception?.value}`;
      issueUrl = evj.issueUrl ?? "";
      if (evj.request) {
        const body = evj.request.body
          ? ` ${evj.request.body.slice(0, 40)}`
          : "";
        reqLabel = ` (${evj.request.method} ${evj.request.path}${body})`;
      }
    } catch {}
    const r = await $`bash ${path.join(root, d, "repro.sh")}`
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

const flagVal = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : undefined;
};

if (args[0] === "init") {
  const positional = args.slice(1).find((a) => !a.startsWith("--"));
  const reproUrl =
    positional && /^https?:\/\//.test(positional) ? positional : undefined;
  await cmdInit({
    appDir: reproUrl ? flagVal("--app-dir") : (positional ?? flagVal("--app-dir")),
    token: flagVal("--sentry-token"),
    org: flagVal("--org"),
    yes: args.includes("--yes") || args.includes("-y"),
    force: args.includes("--force"),
    reproUrl,
    skipTemplate: args.includes("--skip-template"),
  });
  process.exit(0);
}

if (args[0] === "doctor") {
  const positional = args.slice(1).find((a) => !a.startsWith("--"));
  await cmdDoctor(positional ?? flagVal("--app-dir"));
  process.exit(0);
}

if (args[0] === "apply") {
  if (!args[1]) usage();
  await cmdApply(args[1]);
  process.exit(0);
}

if (args[0] === "test") {
  const id = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
  if (id) {
    const dirIdx = args.indexOf("--dir");
    await cmdVerify(id, dirIdx > -1 ? args[dirIdx + 1] : undefined);
  } else {
    await cmdTest(); // regression pack across all capsules
  }
  process.exit(0);
}

if (args[0] === "verify-receipt") {
  if (!args[1]) usage();
  await cmdVerifyReceipt(args[1]);
  process.exit(0);
}

if (args[0] === "protect") {
  await cmdProtect(args.slice(1).find((a) => !a.startsWith("--")));
  process.exit(0);
}

// Create the reproduction environment: evidence → capsule dir → isolated
// stack, booted and healthy. Does NOT fire the trigger.
async function cmdCreate(issueUrl: string): Promise<{
  bugId: string;
  target: string;
  hasRequest: boolean;
}> {
  // Must be inside an onboarded repo (or have CAPSULE_APP_DIR / TARGET_URL set),
  // else we'd silently fall back to the bundled demo-app.
  if (!resolveAppDir() && !process.env.TARGET_URL) {
    fail(
      "not inside an onboarded repo — cd into your app repo and run `capsule init`, or set CAPSULE_APP_DIR.",
    );
  }
  // Pull this repo's own Sentry token/org (each project has its own).
  await loadRepoSentryConfig(currentAppDir());
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
  const manifest = process.env.TARGET_URL ? null : await loadManifest(currentAppDir());
  const project = manifest ? `capsule-${issueId}` : null;
  const port = manifest ? freePort() : 0;
  const target = manifest ? `http://localhost:${port}` : TARGET_URL;

  // Stamp the owning app so the regression pack (capsule test) only ever
  // replays this app's own capsules, and cross-app id collisions are caught.
  ev.app = manifest?.app ?? path.basename(currentAppDir());

  const dir = await writeCapsule(ev, target, manifest?.repro?.auth);
  console.log(`→ wrote ${path.relative(process.cwd(), dir)}/`);

  // Capture the world before booting the reproduction — request × state is
  // the whole bug; the trigger alone replays clean against an empty stack.
  if (manifest?.state) await dumpState(manifest, dir);
  // Snapshot the build recipe so `capsule test` can judge candidates without
  // trusting (or exposing) anything outside the capsule record.
  if (manifest) await snapshotRecipe(currentAppDir(), manifest, dir);

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
  const dir = path.join(capsRoot(), bugId);
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
