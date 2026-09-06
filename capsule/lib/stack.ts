// The .capsule/ template (manifest) and everything docker: build the image,
// boot an isolated compose stack, restore state, verify health.
//
// Compose runs the repo's own compose file, unmodified, under a capsule-owned
// project name (so volumes never mix with the dev stack's). Ports are the
// repo's ports: shut the dev stack down before running capsule.
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { $ } from "bun";
import { fail } from "./util";

export interface Manifest {
  capsule: number;
  app: string;
  // How the app image is produced. "compose" = `docker compose build <service>`
  // using the service's own build: block. The only mode for now.
  build: "compose";
  run: {
    compose: string;
    service: string;
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

// Find a compose-managed container without knowing its stack's compose files.
export async function containerId(project: string, service: string): Promise<string | null> {
  const ps =
    await $`docker ps -q --filter label=com.docker.compose.project=${project} --filter label=com.docker.compose.service=${service}`
      .quiet()
      .nothrow();
  return ps.stdout.toString().trim().split("\n")[0] || null;
}

// The compose invocation for one app tree under one project name: the repo's
// compose file plus its .env (compose interpolates from the cwd's .env only).
export function stackFlags(appDir: string, m: Manifest, project: string): string[] {
  const env = path.join(appDir, ".env");
  return ["-p", project, "-f", path.join(appDir, m.run.compose), ...(existsSync(env) ? ["--env-file", env] : [])];
}

// The host port the app service publishes, as compose resolves it.
export async function publishedPort(cwd: string, flags: string[], m: Manifest): Promise<number> {
  const r = await $`docker compose ${flags} config --format json`.cwd(cwd).quiet().nothrow();
  if (r.exitCode !== 0) throw new Error(`docker compose config failed\n${r.stderr.toString().slice(-2000)}`);
  const svc = JSON.parse(r.stdout.toString()).services?.[m.run.service];
  if (!svc) throw new Error(`service "${m.run.service}" not in ${m.run.compose}`);
  const port = Number(svc.ports?.[0]?.published);
  if (!port) throw new Error(`service "${m.run.service}" publishes no host port in ${m.run.compose}`);
  return port;
}

export async function buildImage(cwd: string, flags: string[], m: Manifest): Promise<void> {
  if (m.build !== "compose") throw new Error(`unsupported manifest build mode: ${JSON.stringify(m.build)}`);
  console.log(`→ building app image: docker compose build ${m.run.service}`);
  const build = await $`docker compose ${flags} build ${m.run.service}`.cwd(cwd).nothrow();
  if (build.exitCode !== 0) {
    throw new Error(`docker compose build failed (exit ${build.exitCode})\n${build.stderr.toString().slice(-2000)}`);
  }
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
  seedFile: string | null,
): Promise<string> {
  const run = async (what: string, args: string[]) => {
    const r = await $`docker compose ${flags} ${args}`.cwd(cwd).nothrow();
    if (r.exitCode !== 0) {
      const err = r.stderr.toString();
      const hint = /port is already allocated/.test(err)
        ? `\nport ${port} is taken — capsule uses the repo's own ports; stop the dev stack (docker compose stop) and retry`
        : "";
      throw new Error(`${what} failed (exit ${r.exitCode})${hint}\n${err.slice(-2000)}`);
    }
  };
  if (m.state?.service && seedFile && existsSync(seedFile)) {
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
  // --no-build: the image was built explicitly above; never rebuild at up-time.
  await run(`docker compose up for ${project}`, ["up", "-d", "--wait", "--no-build"]);
  const target = `http://localhost:${port}`;
  if (await pollHealth(target, m)) return target;
  const logs = await $`docker compose ${flags} logs --tail 60`.cwd(cwd).quiet().nothrow();
  throw new Error(
    `app not healthy at ${target}${m.run.healthcheck} within ${m.run.ready_timeout ?? 60}s\n--- stack logs ---\n${logs.stdout.toString().slice(-3000)}`,
  );
}

// Build + boot an app tree as compose project `project`. Returns the app URL.
export async function instantiate(appDir: string, m: Manifest, project: string, seedFile: string | null): Promise<string> {
  const flags = stackFlags(appDir, m, project);
  await buildImage(appDir, flags, m);
  const port = await publishedPort(appDir, flags, m);
  return bootStack(appDir, flags, m, project, port, seedFile);
}

// The gate for `capsule init`: static validation only, nothing is built or
// booted. Manifest parses, the compose file exists, the service is in it with
// a build: block and a published port, the healthcheck is a path.
export async function validateTemplate(appDir: string): Promise<{ ok: boolean; log: string }> {
  const m = await loadManifest(appDir).catch((e) => {
    throw new Error(`.capsule/manifest.yaml does not parse: ${e instanceof Error ? e.message : e}`);
  });
  if (!m) return { ok: false, log: ".capsule/manifest.yaml is missing" };
  const problems: string[] = [];
  if (m.build !== "compose") problems.push(`build: must be "compose" (got ${JSON.stringify(m.build)})`);
  if (!m.run?.compose) problems.push("run.compose is missing");
  else if (!existsSync(path.join(appDir, m.run.compose))) problems.push(`run.compose: ${m.run.compose} not found`);
  if (!m.run?.service) problems.push("run.service is missing");
  if (!m.run?.healthcheck?.startsWith("/")) problems.push(`run.healthcheck must be a path like /health (got ${JSON.stringify(m.run?.healthcheck)})`);
  if (m.state?.service && !(m.state.database && m.state.user)) problems.push("state: service set but database/user missing");
  if (problems.length) return { ok: false, log: problems.join("\n  ") };

  const flags = stackFlags(appDir, m, "capsule-validate");
  const r = await $`docker compose ${flags} config --format json`.cwd(appDir).quiet().nothrow();
  if (r.exitCode !== 0) return { ok: false, log: `docker compose config failed\n${r.stderr.toString().slice(-1500)}` };
  const services = JSON.parse(r.stdout.toString()).services ?? {};
  const svc = services[m.run.service];
  if (!svc) return { ok: false, log: `run.service: "${m.run.service}" not in ${m.run.compose} (has: ${Object.keys(services).join(", ")})` };
  if (!svc.build) problems.push(`service "${m.run.service}" has no build: block — capsule builds with docker compose build`);
  const port = Number(svc.ports?.[0]?.published);
  if (!port) problems.push(`service "${m.run.service}" publishes no host port`);
  if (m.state?.service && !services[m.state.service]) problems.push(`state.service: "${m.state.service}" not in ${m.run.compose}`);
  if (problems.length) return { ok: false, log: problems.join("\n  ") };
  return { ok: true, log: `${m.run.compose} → service ${m.run.service} builds and publishes :${port}; healthcheck ${m.run.healthcheck}` };
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
