# demo-app

The target app: minimal Express (on Bun) + Postgres, run via docker compose.
`POST /signup` has a deliberate application-level bug that reports to Sentry.
This app generates the incidents that capsule reproduces. Not part of the product.

## Run

```sh
# DSN goes in .env (compose passes it into the container)
docker compose up -d --build
```

## Trigger the bug

```sh
curl http://localhost:3002/health                        # 200, sanity check

curl -X POST http://localhost:3002/signup \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com"}'                       # 500 → Sentry event
```

Signup inserts the user, then reads `user.preferences.theme` — but
`preferences` is NULL for fresh signups, so every signup crashes with a
`TypeError` *after* the row is written. The error middleware in
[server.ts](server.ts) captures the exception with the raw request attached,
so the event in Sentry carries everything needed to replay it.

Replaying is deterministic: the insert is `on conflict do nothing`, so
repeated replays of the same email keep hitting the same TypeError.
