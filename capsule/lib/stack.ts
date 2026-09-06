// The .capsule/ template (manifest) and everything docker: build the image,
// boot an isolated compose stack, restore state, verify health.
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { $ } from "bun";
import { fail } from "./util";

export interface Manifest {
  capsule: number;
  app: string;
  // How the app image is produced. "compose" = `docker compose build <service>`
  // using the service's own build: block (context redirected to CAPSULE_SRC_ROOT
  // by the overlay). The only mode for now.
  build: "compose";
  run: {
    compose: string;
    service: string;
    port: number;
    healthcheck: string;
    ready_timeout?: number;
  };
  // World: which service holds state, and which live compose project to
  // snapshot it from at repro-time (exact pg_dump, no slicing).
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
export type ReproAuth = NonNullable<NonNullable<Manifest["repro"]>["auth"]>;

export async function readManifest(file: string): Promise<Manifest | null> {
  const f = Bun.file(file);
  if (!(await f.exists())) return null;
  return Bun.YAML.parse(await f.text()) as Manifest;
}
export const loadManifest = (appDir: string) =>
  readManifest(path.join(appDir, ".capsule", "manifest.yaml"));

export function freePort(): number {
  const srv = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = srv.port;
  srv.stop(true);
  if (!port) fail("could not allocate a free host port");
  return port;
}

// Find a compose-managed container without knowing its stack's compose files.
export async function containerId(project: string, service: string): Promise<string | null> {
  const ps =
    await $`docker ps -q --filter label=com.docker.compose.project=${project} --filter label=com.docker.compose.service=${service}`
      .quiet()
      .nothrow();
  return ps.stdout.toString().trim().split("\n")[0] || null;
}

// Build the app image with `docker compose build <service>`. The overlay
// points the service's build context at CAPSULE_SRC_ROOT and its image at
// CAPSULE_IMAGE, both read from the env file already in `flags`.
export async function buildImage(cwd: string, flags: string[], m: Manifest): Promise<void> {
  if (m.build !== "compose") throw new Error(`unsupported manifest build mode: ${JSON.stringify(m.build)}`);
  console.log(`→ building app image: docker compose build ${m.run.service}`);
  const build = await $`docker compose ${flags} build ${m.run.service}`.cwd(cwd).nothrow();
  if (build.exitCode !== 0) {
    throw new Error(`docker compose build failed (exit ${build.exitCode})\n${build.stderr.toString().slice(-2000)}`);
  }
}

// The per-stack env file: pins the image tag, host port and source tree the
// overlay interpolates. Everything compose needs to build and boot this stack.
export const writeStackEnv = (envFile: string, image: string, port: number, srcRoot: string) =>
  Bun.write(envFile, `CAPSULE_IMAGE=${image}\nCAPSULE_PORT=${port}\nCAPSULE_SRC_ROOT=${srcRoot}\n`);

export function composeFlags(project: string, files: string[], envFiles: string[]): string[] {
  return [
    "-p",
    project,
    ...files.flatMap((f) => ["-f", f]),
    ...envFiles.filter(existsSync).flatMap((f) => ["--env-file", f]),
  ];
}

export async function pollHealth(target: string, m: Manifest): Promise<boolean> {
  const deadline = Date.now() + (m.run.ready_timeout ?? 60) * 1000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${target}${m.run.healthcheck}`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {}
    await Bun.sleep(1000);
  }
  return false;
}

// Bring a stack up and wait for the healthcheck. If a seed.dump exists, boot
// the DB alone, restore into it, and only then bring up the app — its
// boot-time migration check then sees the snapshot's schema, not an empty
// database. Throws with logs on failure. Returns the app URL.
export async function bootStack(
  cwd: string,
  flags: string[],
  m: Manifest,
  project: string,
  port: number,
  seedFile: string,
): Promise<string> {
  const run = async (what: string, args: string[]) => {
    const r = await $`docker compose ${flags} ${args}`.cwd(cwd).nothrow();
    if (r.exitCode !== 0) {
      throw new Error(`${what} failed (exit ${r.exitCode})\n${r.stderr.toString().slice(-2000)}`);
    }
  };
  if (m.state?.service && existsSync(seedFile)) {
    console.log(`→ restoring state snapshot into ${m.state.service} (${statSync(seedFile).size} bytes)`);
    await run(`docker compose up ${m.state.service}`, ["up", "-d", "--wait", "--no-build", m.state.service]);
    const cid = await containerId(project, m.state.service);
    if (!cid) throw new Error(`no ${m.state.service} container in ${project}`);
    const restore =
      await $`docker exec -i ${cid} pg_restore -U ${m.state.user} -d ${m.state.database} --clean --if-exists --no-owner < ${seedFile}`.nothrow();
    if (restore.exitCode !== 0) {
      throw new Error(`pg_restore failed (exit ${restore.exitCode})\n${restore.stderr.toString().slice(-2000)}`);
    }
  }
  console.log(`→ starting stack ${project} (host port ${port})`);
  // --no-build: the image was built (and tagged) explicitly; never rebuild at up-time.
  await run(`docker compose up for ${project}`, ["up", "-d", "--wait", "--no-build"]);
  const target = `http://localhost:${port}`;
  if (await pollHealth(target, m)) return target;
  const logs = await $`docker compose ${flags} logs --tail 60`.cwd(cwd).quiet().nothrow();
  throw new Error(
    `app not healthy at ${target}${m.run.healthcheck} within ${m.run.ready_timeout ?? 60}s\n--- stack logs ---\n${logs.stdout.toString().slice(-3000)}`,
  );
}

// Instantiate the app's .capsule/ template as an isolated stack: pin a tag +
// host port + source tree in envFile, build the image, boot with the overlay.
export async function instantiate(
  appDir: string,
  m: Manifest,
  project: string,
  port: number,
  envFile: string,
): Promise<string> {
  const sha = (await $`git -C ${appDir} rev-parse --short HEAD`.quiet().nothrow()).stdout.toString().trim() || "local";
  await writeStackEnv(envFile, `capsule/${m.app}:${sha}`, port, appDir);
  const flags = templateFlags(appDir, m, project, envFile);
  await buildImage(appDir, flags, m);
  return bootStack(appDir, flags, m, project, port, path.join(path.dirname(envFile), "seed.dump"));
}
const templateFlags = (appDir: string, m: Manifest, project: string, envFile: string) =>
  composeFlags(
    project,
    [path.join(appDir, m.run.compose), path.join(appDir, ".capsule", "overlay.yaml")],
    [path.join(appDir, ".env"), envFile],
  );

// The objective gate for `capsule init`: the template counts only if we can
// build the image, boot the stack, and get a 2xx healthcheck. Always tears
// the verification stack down.
export async function verifyTemplate(appDir: string): Promise<{ ok: boolean; log: string }> {
  const m = await loadManifest(appDir);
  if (!m) return { ok: false, log: ".capsule/manifest.yaml is missing" };
  const project = "capsule-verify";
  const envFile = path.join(appDir, ".capsule", ".env.verify");
  try {
    const target = await instantiate(appDir, m, project, freePort(), envFile);
    return { ok: true, log: `app healthy at ${target}${m.run.healthcheck}` };
  } catch (e) {
    return { ok: false, log: e instanceof Error ? e.message : String(e) };
  } finally {
    await $`docker compose ${templateFlags(appDir, m, project, envFile)} down -v --remove-orphans`
      .cwd(appDir)
      .quiet()
      .nothrow();
    await $`rm -f ${envFile}`.quiet().nothrow();
  }
}

// World capture: pg_dump the live dev stack's DB into the capsule. Failure is
// non-fatal — the capsule degrades to stateless replay.
export async function dumpState(m: Manifest, dir: string): Promise<void> {
  const s = m.state;
  if (!s?.service || !s.source_project) return;
  const cid = await containerId(s.source_project, s.service);
  if (!cid) {
    console.log(`⚠ no running ${s.service} container in compose project ${s.source_project} — no state snapshot`);
    return;
  }
  const dump = await $`docker exec ${cid} pg_dump -U ${s.user} -Fc ${s.database}`.quiet().nothrow();
  if (dump.exitCode !== 0) {
    console.log(`⚠ pg_dump failed (exit ${dump.exitCode}) — continuing without state\n${dump.stderr.toString().slice(-400)}`);
    return;
  }
  await Bun.write(path.join(dir, "seed.dump"), dump.stdout);
  console.log(`→ captured state snapshot from ${s.source_project}/${s.service} (${dump.stdout.length} bytes)`);
}
