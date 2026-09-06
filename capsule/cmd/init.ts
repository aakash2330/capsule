// capsule init — run inside the app repo. Docker check → confirm the Sentry
// vars in the app's own .env (adding any that are missing) → verify the
// .capsule/ template. Re-runnable; every run redoes every step.
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { $ } from "bun";
import { validateSentryToken } from "../lib/sentry";
import { verifyTemplate } from "../lib/stack";
import { fail, interactive, promptLine, promptSecret, readEnvFile } from "../lib/util";

const SENTRY_VARS = ["SENTRY_AUTH_TOKEN", "SENTRY_ORG"];

export async function cmdInit(): Promise<void> {
  const tty = interactive();
  console.log("\ncapsule onboarding\n──────────────────");
  if ((await $`docker version --format {{.Server.Version}}`.quiet().nothrow()).exitCode !== 0) {
    fail("docker is not running — start Docker Desktop / dockerd");
  }
  const appDir = process.cwd();
  console.log(`→ app repo: ${appDir}`);

  // Sentry vars live in the app's .env — same file, same names the app uses.
  const envFile = path.join(appDir, ".env");
  const orig = readEnvFile(envFile);
  const env = { ...orig };
  const found = SENTRY_VARS.filter((k) => env[k]);
  if (found.length) {
    const show = (k: string) => (k.includes("TOKEN") ? `${env[k].slice(0, 4)}…${env[k].slice(-4)}` : env[k]);
    console.log(`→ found in .env: ${found.map((k) => `${k}=${show(k)}`).join(", ")}`);
    const use = tty ? await promptLine("  use these? (Y/n)", "Y") : "Y";
    if (!/^y/i.test(use)) for (const k of found) delete env[k];
  }
  if (!env.SENTRY_AUTH_TOKEN) {
    if (!tty) fail(`SENTRY_AUTH_TOKEN missing from ${envFile} (Sentry → Settings → Auth Tokens, scopes org:read + event:read)`);
    console.log("  Sentry → Settings → Auth Tokens → Create (scopes: org:read, event:read)");
    env.SENTRY_AUTH_TOKEN = await promptSecret("  paste Sentry auth token (hidden)");
    if (!env.SENTRY_AUTH_TOKEN) fail("no token entered");
  }
  process.env.SENTRY_AUTH_TOKEN = env.SENTRY_AUTH_TOKEN;
  process.stdout.write("→ validating token… ");
  const who = await validateSentryToken();
  if (!who.ok) {
    console.log("✗");
    fail("token rejected by Sentry (check scopes org:read + event:read, or SENTRY_API_BASE)");
  }
  console.log(`✓ org(s): ${who.orgs.join(", ") || "—"}`);
  if (!env.SENTRY_ORG) {
    env.SENTRY_ORG =
      who.orgs.length === 1 || !tty
        ? who.orgs[0]
        : await promptLine(`  default Sentry org (${who.orgs.join(", ")})`, who.orgs[0]);
  }
  process.env.SENTRY_ORG = env.SENTRY_ORG;
  const missing = SENTRY_VARS.filter((k) => orig[k] !== env[k]);
  if (missing.length) {
    const add = tty ? await promptLine(`  add ${missing.join(", ")} to .env? (Y/n)`, "Y") : "Y";
    if (/^y/i.test(add)) {
      const cur = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
      const sep = cur && !cur.endsWith("\n") ? "\n" : "";
      await writeFile(envFile, cur + sep + missing.map((k) => `${k}=${env[k]}`).join("\n") + "\n");
      console.log(`→ wrote ${missing.join(", ")} to .env`);
    }
    // ponytail: substring match — ".env.example" alone would satisfy it; tighten if it bites.
    const gi = path.join(appDir, ".gitignore");
    if (!/\.env/.test(existsSync(gi) ? readFileSync(gi, "utf8") : "")) {
      console.log("  ⚠ .env is not in .gitignore — add it, it now holds a secret");
    }
  }

  // The template is authored by the capsule-init skill (or by hand); the CLI
  // only judges it: build → boot → 2xx healthcheck.
  if (!existsSync(path.join(appDir, ".capsule", "manifest.yaml"))) {
    console.log(
      "\n○ no .capsule/manifest.yaml — author it with the capsule-init skill from your agent, then re-run `capsule init`",
    );
    return;
  }
  console.log("→ checking .capsule/ template (build + boot + healthcheck)");
  const v = await verifyTemplate(appDir);
  console.log(v.ok ? `  ✓ ${v.log}` : `  ✗ ${v.log.slice(-1500)}`);
  console.log(
    v.ok
      ? "\n✓ onboarding complete.\n\nnext:\n  capsule repro <sentry-issue-url>     reproduce a bug in an isolated stack"
      : "\n○ onboarding incomplete — fix .capsule/ (or what it points at) and re-run `capsule init`",
  );
}
