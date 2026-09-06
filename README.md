# capsule.dev

POC: turn a Sentry incident into a locally runnable reproduction (see [PLAN.md](PLAN.md)).

- [demo-app/](demo-app) — the target app: Express (on Bun) + Postgres via docker compose.
  `POST /signup` has a deliberate bug that reports to Sentry.
- [demo-app/.capsule/](demo-app/.capsule) — the environment template (one
  manifest). Authored once per repo by the
  [capsule-init skill](capsule/skills/capsule-init) from whatever agent you use: it
  proposes each value from the repo's compose config / Dockerfile / routes and
  you confirm or change every one before anything is written. The CLI never
  authors it and never calls an AI; `capsule init` validates it against the
  compose file (nothing is built or run) and is re-run after any fix. Per-bug environments are instantiated from it mechanically.
- [capsule/](capsule) — the CLI. `capsule.ts` is the entry (usage + dispatch);
  one file per command under `cmd/` (init, repro, test, claude); shared pieces
  under `lib/` (repo paths + .env, Sentry API + evidence, manifest + docker
  stack, the capsule record on disk). `capsule repro <sentry-issue-url>` pulls
  the event, writes `capsules/<id>/` (evidence.json, repro.sh, seed.dump,
  .capsule-recipe/), boots the repo's compose file as project `capsule-<id>`
  (own volumes, same ports — stop your dev stack first), and replays the
  failing request. `docker compose -p capsule-<id> exec app bash` to poke
  around inside; `... down` to tear down.

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

## The fix loop

```sh
capsule repro <issue-url>     # evidence + isolated stack booted + trigger replayed: bug confirmed present
# ...fix the code in your editor...
capsule test <issue-id>       # rebuild from your tree, reset the world, replay → PASS/FAIL + signed receipt
capsule test                  # regression pack: every past bug must stay fixed
docker compose -p capsule-<id> down       # when you're done
```

`capsule test` exits non-zero if any bug reproduces, so it doubles as a CI gate.
The capsules/ directory is the regression suite — each reproduced incident
permanently guards the codebase. (v0 checks at the HTTP level; fingerprint
matching arrives with the DSN sink.)

`repro.sh` follows the plan's contract: it exits **non-zero while the bug is
present**, so the fix agent can run it before (must fail) and after (must pass).
