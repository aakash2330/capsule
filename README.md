# capsule.dev

POC: turn a Sentry incident into a locally runnable reproduction (see [PLAN.md](PLAN.md)).

- [demo-app/](demo-app) — the target app: Express (on Bun) + Postgres via docker compose.
  `POST /signup` has a deliberate bug that reports to Sentry.
- [demo-app/.capsule/](demo-app/.capsule) — the environment template (manifest +
  compose overlay + build script). Authored once per repo by `capsule init`
  (Claude Code mines the repo's compose/Dockerfile/CI and writes the template;
  the CLI machine-verifies it: build → boot → 2xx healthcheck, retrying with the
  failure log up to 3×). Per-bug environments are instantiated from it mechanically.
  `capsule init` on a repo that already has a template just re-verifies it.
- [capsule/](capsule) — the CLI. `capsule repro <sentry-issue-url>` pulls the event,
  writes `capsules/bug-<id>/` (evidence.json, repro.sh, CONTEXT.md, .env.capsule),
  builds the app image, boots an **isolated per-bug stack** (own compose project +
  port, separate from your dev stack), and replays the failing request. Fix the code,
  rerun the same command: it rebuilds and re-verifies. `docker compose -p
  capsule-bug-<id> exec app bash` to poke around inside; `... down` to tear down.

## Setup (once)

```sh
(cd demo-app && bun install)          # + put your DSN in demo-app/.env
(cd capsule && bun install && bun link)   # `capsule` is now on your PATH
cp .env.example .env                  # add SENTRY_AUTH_TOKEN
```

The auth token: Sentry → Settings → Auth Tokens → create with scopes
`event:read` + `org:read`. (The DSN only ingests; reading events needs this.)

## The loop

```sh
cd demo-app && docker compose up -d --build   # app on :3002 + postgres

curl -X POST http://localhost:3002/signup \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com"}'            # 500 → issue appears in Sentry

capsule repro <sentry-issue-url>              # reproduce it locally
```

`repro.sh` follows the plan's contract: it exits **non-zero while the bug is
present**, so the fix agent can run it before (must fail) and after (must pass).
