// Where things live: the app repo under test, and capsule's own state.
import { existsSync } from "node:fs";
import path from "node:path";
import { readEnvFile } from "./util";

export const CONFIG_DIR = path.join(process.env.HOME ?? "", ".capsule");

// Capsule state lives with the product, never with the code under test — a
// fix workspace must be able to run `capsule test` without capsules/ (or any
// judge internals) being reachable inside it.
export const CAPSULE_HOME = path.resolve(
  process.env.CAPSULE_HOME ?? path.resolve(import.meta.dir, "..", ".."),
);
export const capsRoot = () => path.join(CAPSULE_HOME, "capsules");
export const capsuleDir = (bugId: string) => path.join(capsRoot(), bugId);

// Walk up from `start` to the nearest onboarded repo (one with
// .capsule/manifest.yaml), skipping ~/.capsule. Lets `capsule <cmd>` work from
// anywhere inside a project.
export function findRepo(start: string): string | null {
  let d = path.resolve(start);
  for (;;) {
    if (d !== CONFIG_DIR && existsSync(path.join(d, ".capsule", "manifest.yaml"))) return d;
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

// null when not inside an onboarded repo. CAPSULE_APP_DIR overrides for scripts.
export function resolveAppDir(): string | null {
  if (process.env.CAPSULE_APP_DIR) return path.resolve(process.env.CAPSULE_APP_DIR);
  return findRepo(process.cwd());
}
export const currentAppDir = () => resolveAppDir() ?? process.cwd();

// The repo's Sentry vars come from its own .env — the same file the app
// reads. A real shell export still wins.
export function loadRepoSentryConfig(appDir: string): void {
  const env = readEnvFile(path.join(appDir, ".env"));
  for (const k of ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_API_BASE"]) {
    if (env[k]) process.env[k] ??= env[k];
  }
}
