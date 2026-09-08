import { SolariClient } from "@solarisdk/sdk";

const apiKey = process.env.SOLARI_API_KEY;
if (!apiKey) throw new Error("SOLARI_API_KEY is not set (see .env)");

export const solari = new SolariClient({ apiKey });
const APP = "demo-project";
const GUEST_DIR = "/app";

type Manifest = { sandbox: { install: string[]; seed: string[]; start: string; port: number; health: string }; env: Record<string, string> };
export const manifest: Manifest = Bun.YAML.parse(await Bun.file(`${APP}/.capsule/manifest.yaml`).text()) as Manifest;

/** Run a list of shell lines in the guest; throws on the first non-zero exit. */
export async function sh(sb: Awaited<ReturnType<typeof solari.sandboxes.create>>, lines: string[], cwd = GUEST_DIR) {
  await sb.connect();
  const script = ["set -e", ...lines].join("\n");
  const out = await sb.commands.run("sh", { args: ["-c", script], cwd, env: { HOME: "/root" }, timeoutMs: 600_000 });
  if (out.exitCode !== 0) throw new Error(`guest command failed (${out.exitCode}):\n${script}\n${out.stderr}`);
  return out;
}

/** Cache key: the manifest install step + the dependency lockfile. Changes → new base. */
async function baseKey() {
  const lock = await Bun.file(`${APP}/bun.lock`).text();
  const pkg = await Bun.file(`${APP}/package.json`).text();
  const h = new Bun.CryptoHasher("sha256").update(manifest.sandbox.install.join("\n") + lock + pkg).digest("hex");
  return `capsule-base-${h.slice(0, 12)}`;
}

/**
 * Base snapshot: apt packages, Bun, node_modules from the lockfile, Postgres
 * running with an empty cluster. No source, no env, no rows. Built once per key.
 */
export async function ensureBase(): Promise<string> {
  const name = await baseKey();
  const { snapshots } = await solari.sandboxes.listSnapshots({ template: "base" });
  const hit = snapshots.find((s) => s.name === name);
  if (hit) return hit.id;

  console.log(`building base snapshot ${name}`);
  const sb = await solari.sandboxes.create({ template: "base", metadata: { capsuleBase: name }, lifecycle: { onTimeout: "kill" } });
  try {
    await sh(sb, [`mkdir -p ${GUEST_DIR}`], "/");
    await sh(sb, manifest.sandbox.install);
    await sb.files.upload(`${GUEST_DIR}/package.json`, await Bun.file(`${APP}/package.json`).text());
    await sb.files.upload(`${GUEST_DIR}/bun.lock`, await Bun.file(`${APP}/bun.lock`).text());
    await sh(sb, ["/root/.bun/bin/bun install --frozen-lockfile", "service postgresql start"]);
    return await sb.snapshot(name);
  } finally {
    await sb.kill();
  }
}

/** Fork the base snapshot. Killed on idle timeout so nothing leaks. */
export async function createSandbox(metadata: Record<string, string> = {}) {
  return solari.sandboxes.create({ fromSnapshot: await ensureBase(), metadata, lifecycle: { onTimeout: "kill" } });
}

if (import.meta.main) {
  const sb = await createSandbox({ capsuleRun: crypto.randomUUID() });
  const out = await sh(sb, ["/root/.bun/bin/bun --version", "ls node_modules | wc -l", "service postgresql status"]);
  console.log(sb.sandboxId, out.stdout.trim());
  await sb.kill();
}
