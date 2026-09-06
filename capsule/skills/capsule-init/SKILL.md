---
name: capsule-init
description: Set up capsule in a repo. Use when the user asks to onboard, init, or configure capsule for a repository. Every config decision is confirmed with the user before anything is written.
---

# capsule-init

You author `.capsule/` for this repo. The CLI never guesses; you propose, the
user confirms, `capsule init` judges. Ask with your question tool if you have
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

| decision | propose from |
|---|---|
| compose file | the repo's compose file; several → list them |
| app service (the one sending events to Sentry) | the service with a `build:` block; several → list them |
| Dockerfile + context | that service's build block, else `Dockerfile` at root |
| container port | service `ports`/`expose`, else `EXPOSE` in the Dockerfile |
| healthcheck path | compose healthcheck URL, else a `/health`-style GET route, else `/`. Never add routes |
| database snapshot | a postgres service (user/db from `POSTGRES_USER`/`POSTGRES_DB`, default `postgres`); "none" if bugs don't need data |

No compose file or Dockerfile? Draft a minimal one under `.capsule/` (app +
its real deps, with healthchecks), confirm it the same way, and point at it.

## 3. Write two files

`.capsule/manifest.yaml`
```yaml
capsule: 1
app: <app>
build: compose     # docker compose build <service>, using the service's own build: block
run:
  compose: <compose file>
  service: <app service>
  port: <container port>
  healthcheck: <path>
  ready_timeout: 60
env: {}
state: {}          # or: {engine: postgres, service, database, user, source_project: <dev compose project name>}
```

`.capsule/overlay.yaml`
```yaml
services:
  <app service>:
    image: ${CAPSULE_IMAGE}        # tag capsule picks per stack
    build:
      context: ${CAPSULE_SRC_ROOT} # the tree capsule is building (repo, or a fix worktree)
    ports: !override
      - "${CAPSULE_PORT}:<container port>"
```
If the service's `build:` names a `dockerfile`, keep it: it resolves relative
to the new context. `capsule` runs `compose build <service>` then
`compose up --no-build`; nothing else in the repo's compose file changes.


## 4. Verify

```bash
capsule init         # confirms SENTRY_AUTH_TOKEN/SENTRY_ORG in the app's .env, then build → boot → 2xx healthcheck
```
On failure: read the log it prints, propose the fix, confirm, apply, re-run `capsule init`.
Only edit inside `.capsule/` unless the user says otherwise.
