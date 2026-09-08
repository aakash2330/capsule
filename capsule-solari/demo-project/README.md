# demo-project

The app under test: Express (on Bun) + Postgres, run as plain processes. No Docker.
It carries deliberate, state-dependent bugs that report to Sentry; the events
they produce are the fixtures Capsule replays.

- [server.ts](server.ts): routes and the error middleware that attaches the raw
  request to every Sentry event, so events are replayable.
- [db/init.sql](db/init.sql): schema plus the seed rows the bugs depend on.
- [.capsule/manifest.yaml](.capsule/manifest.yaml): how a Solari sandbox
  installs, seeds, and starts this app. Hand-written per repo.

## Run locally

```bash
bun install
```

```bash
psql -U postgres -f db/init.sql
```

```bash
POSTGRES_URL=postgres://postgres:postgres@localhost:5432/postgres bun server.ts
```

## Endpoints

```bash
curl http://localhost:3002/health
```

```bash
curl http://localhost:3002/users
```

## Bug 1: revenue report crosses 32-bit

```bash
curl 'http://localhost:3002/reports/revenue?currency=EUR'
```

```bash
curl 'http://localhost:3002/reports/revenue?currency=USD'
```

EUR has no orders and returns 200. USD has $30M of orders, so `sum(amount_cents)`
passes 2^31, Bun hands it back as a BigInt, and the fee arithmetic throws a
`TypeError`. A small database never triggers it. The seed also stores older orders
as `usd`, which the query silently misses: a fix that only casts the sum reports
the wrong total.

## Bug 2: signup reads a NULL preference

```bash
curl -X POST http://localhost:3002/signup -H 'content-type: application/json' -d '{"email":"grace@example.com"}'
```

The seed holds a legacy user whose `preferences` is NULL. Signup then reads
`user.preferences.theme` and crashes with a `TypeError`. A fresh email returns 200,
and the same request against an empty database returns 200: the bug is request
times state.

## Bug 3: rename collides with an existing email

```bash
curl -X PATCH http://localhost:3002/users/2 -H 'content-type: application/json' -d '{"email":"grace@example.com"}'
```

The update is unguarded, so renaming to an address another row owns raises a
Postgres unique violation (23505). Different error class from bug 1.

## Reset the database

```bash
psql -U postgres -c 'drop table if exists users, orders' && psql -U postgres -f db/init.sql
```
