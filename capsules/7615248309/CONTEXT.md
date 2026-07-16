# Sentry issue 7615248309

**TypeError: null is not an object (evaluating 'user.preferences.theme')**

- Issue: https://aakash-2h.sentry.io/issues/7615248309/?project=4511739550236672&query=is%3Aunresolved&referrer=issue-stream
- Event: 57358c45051b4438a73e399ff995cffd (2026-07-16T19:33:13.809000Z)
- Exception: `TypeError: null is not an object (evaluating 'user.preferences.theme')`

Top in-app frames (innermost first):

1. `/app/server.ts:29` in `<anonymous>`

## Failing request

`POST /signup` with the body in [request-body.json](request-body.json)

## Reproduce

`capsule repro` starts the environment automatically. To run by hand:

```sh
./repro.sh   # exits non-zero while the bug is present
```
