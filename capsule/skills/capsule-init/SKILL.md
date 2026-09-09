---
name: capsule-init
description: Set up capsule in a repo. Use when the user asks to onboard, init, or configure capsule for a repository. Every config decision is confirmed with the user before anything is written.
---

# capsule-init

You author `.capsule/` for this repo. The CLI never guesses; you propose, the
user confirms, `capsule init` validates. Ask with your question tool if you have
one, otherwise in chat. Write nothing until every decision below is confirmed.

## 0. Start clean

If `.capsule/` already exists, ask: "`.capsule/` already exists — replace it and
start from scratch?" Yes → delete `.capsule/`. No → stop.

## 1. Gather facts

```bash
docker compose config --format json     # services, build, ports, healthchecks, env
```

Also read the Dockerfile(s) and grep GET routes. Never invent services the
app doesn't use.

## 2. Confirm each decision, one at a time

Show the proposed value, where it came from, and alternatives. Enter/yes keeps it.

| decision                                       | propose from                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| compose file                                   | the repo's compose file; several → list them                                                                        |
| app service (the one sending events to Sentry) | the service with a `build:` block; several → list them                                                              |
| healthcheck path                               | compose healthcheck URL, else a `/health`-style GET route, else `/`. Never add routes                               |
| database snapshot                              | a postgres service (user/db from `POSTGRES_USER`/`POSTGRES_DB`, default `postgres`); "none" if bugs don't need data |

No compose file or Dockerfile? Draft a minimal one under `.capsule/` (app +
its real deps, with healthchecks), confirm it the same way, and point at it.

## 3. Write one file

`.capsule/manifest.yaml`

```yaml
capsule: 1
app: <app>
build: compose # docker compose build <service>, using the service's own build: block
run:
  compose: <compose file>
  service: <app service>
  healthcheck: <path>
  ready_timeout: 60
state: {} # or: {engine: postgres, service, database, user, source_project: <dev compose project name>}
```

Compose runs the repo's compose file unmodified, under project `capsule-<id>`,
on the repo's own ports. Tell the user: stop the dev stack before `capsule init`,
`capsule repro`, or `capsule test`.

## 4. Hand off — never run `capsule init` yourself

It prompts for a Sentry auth token. The user runs it in their own terminal so
the secret goes to a local script, not into the chat. Never ask for the token.

Tell the user: "`.capsule/manifest.yaml` is written. Run `capsule init` in the
repo. It confirms SENTRY_AUTH_TOKEN / SENTRY_ORG in .env (token read hidden,
stays on your machine) and validates the manifest. Nothing is built or run."

If they report a validation error: propose the fix, confirm, apply, ask them
to re-run. Only edit inside `.capsule/` unless the user says otherwise.
