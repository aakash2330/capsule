# bug-7615248309

**TypeError: null is not an object (evaluating 'user.preferences.theme')**

- Issue: https://aakash-2h.sentry.io/issues/7615248309/?project=4511739550236672&query=is%3Aunresolved&referrer=issue-stream
- Event: 7bce83a5ca37435eb83f32a6dc0d4d45 (2026-07-16T16:18:18.616000Z)
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
