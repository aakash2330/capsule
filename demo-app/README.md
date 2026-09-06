# demo-app

The target app: minimal Express (on Bun) + Postgres, run via docker compose.
`POST /signup` has a deliberate, **state-dependent** bug that reports to Sentry.
This app generates the incidents that capsule reproduces. Not part of the product.

Services: `postgres` (schema + seed rows from [db/init.sql](db/init.sql), applied
on first boot of the `pgdata` volume) and `app`.

## Run

```sh
# DSN goes in .env (compose passes it into the container)
docker compose up -d --build
```

## Endpoints

```sh
curl http://localhost:3002/health     # 200, sanity check
curl http://localhost:3002/users      # what the database currently holds
```

## Trigger the bug

```sh
curl -X POST http://localhost:3002/signup \
  -H 'content-type: application/json' \
  -d '{"email":"fresh@example.com"}'                     # 200 — new users work

curl -X POST http://localhost:3002/signup \
  -H 'content-type: application/json' \
  -d '{"email":"grace@example.com"}'                     # 500 → Sentry event
```

New signups are inserted with default `preferences`, so they succeed. The seed
contains a legacy user (`grace@example.com`) whose `preferences` is NULL, and
signup then reads `user.preferences.theme`, so that email crashes with a
`TypeError`. The same request against an empty database returns 200: the bug is
request × state, which is exactly what capsule's `seed.dump` snapshot captures
(see the `state` block in [.capsule/manifest.yaml](.capsule/manifest.yaml)).

The error middleware in [server.ts](server.ts) captures the exception with the
raw request attached, so the event in Sentry carries everything needed to replay it.

## Trigger the second bug (rename collision)

```sh
curl -X PATCH http://localhost:3002/users/2 \
  -H 'content-type: application/json' \
  -d '{"email":"ada2@example.com"}'                      # 200 — free email, rename works

curl -X PATCH http://localhost:3002/users/2 \
  -H 'content-type: application/json' \
  -d '{"email":"grace@example.com"}'                     # 500 → Sentry event
```

`PATCH /users/:id` updates the email without checking for collisions, so renaming
to an address another row already owns raises a Postgres unique-violation
(`23505`). Against a database without `grace@example.com` the same request
returns 200. Same request × state shape as `/signup`, but a different error class
(database constraint, not a `TypeError`), so it exercises a separate capsule.

## Reset the database

```sh
docker compose down -v && docker compose up -d --build   # re-runs db/init.sql
```
