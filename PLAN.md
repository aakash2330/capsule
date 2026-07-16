# Capsule — v0 plan (personal POC)

> A Sentry incident on my app becomes a verified, locally runnable reproduction capsule that my fixing agent can work against.

Date: 2026-07-14. Status: pre-code. Scope: **built for myself, on my own app** — the goal is to find out if it works for me. Not a product; customer/GTM/security concerns are deliberately parked (three lines at the bottom).

## Why

Separation of concerns between two agents:

- **Capsule agent** — its only job: turn a Sentry incident into a reproducible environment, and *prove* it reproduces.
- **Fix agent** (existing minion) — starts with clean context and a ready-made failing repro instead of flailing through docker/deps/seeding.

Benefits: the fixer's context stays clean; the capsule outlives both agents (rerun after the fix, keep as regression evidence); every auto-fix gets an honest label — **verified fix** vs **the fixer guessed**. Research grounding: a failing repro test roughly doubles fix precision (SWT-bench); Google's APR pipeline runs bug-reproduction as its own phase (arXiv 2502.01821).

## The contract (this is the whole point)

Splitting reproduce/fix only works if the boundary is an objective check — otherwise the capsule agent hands over an environment that *looks* right and the guessing has just moved one step left.

**A capsule counts only if `repro.sh` exits non-zero with an error whose fingerprint matches the Sentry event, 3/3 runs.**

- Fingerprint = exception type + top in-app stack frames (Sentry-grouping style). Never match error-message strings.
- Confidence tiers the capsule agent must self-assign:
  - `exact` — fingerprint matched 3/3
  - `partial` — an error reproduced, but fingerprint differs or intermittent (<3/3)
  - `context-only` — could not reproduce; capsule contains gathered evidence only
- No match → label `context-only`. Never declare success on vibes.

## Capsule anatomy

Four parts with distinct semantics — world, poke, expectation, plus the env they live in:

```
bug-<id>/
  manifest.json    # oracle + provenance: event ID, issue URL, git SHA, capture lag,
                   # expected fingerprint, confidence, verification record
  compose.yaml     # environment: app image @ SHA + Postgres + DSN sink; egress blocked
  setup.sh         # state: turn a blank environment into the required world (idempotent RESET)
  repro.sh         # trigger: fire the input that hits the bug (assumes freshly-setup env)
  CONTEXT.md       # failure narrative for the next agent (event summary, breadcrumbs, hypotheses)
  seed.dump        # (flavor A) full DB snapshot restored by setup.sh
```

Rules:

- **`setup.sh` is a reset, not a setup.** Verification runs 3× and the fix loop reruns constantly; every run starts from identical state → drop/recreate + hydrate, idempotent.
- **The script is the interface; how it makes state is an implementation detail.**
  - Flavor A (v0 default): restore `seed.dump` — exact, dumb, preserves the weird data that caused the bug. Own app → whole `pg_dump`, no slicing, no anonymization.
  - Flavor B (promotion): agent distills the dump into minimal generative INSERTs/factories, then **re-verifies 3/3**. If the fingerprint still matches, the capsule graduates to a permanent synthetic regression fixture (committable, no real data). The verifier is what makes distillation safe.
- **Code and state stay separable.** The fix loop is: same state + same trigger + same expectation, *different code*. App image per SHA (cached, shared across bugs on one release); state per bug.
- **Runtime-agnostic, local by default.** `setup.sh`/`repro.sh` assume nothing but a Docker daemon and the manifest — no host paths, no localhost-isms, no personal env vars. v0 runs on my laptop via compose; the same artifact can later run in CI unchanged.
- **Egress blocked by default** inside the compose network, with the DSN sink and any mocks as the only reachable endpoints — a replay must not send a real email or hit a real API key. Secrets are injected at runtime via a generated `.env.capsule` (synthetic values; I control the webhook signing secret inside the capsule, so re-signing replayed payloads just works).

## Architecture

```
Sentry issue URL
      │
      ▼
┌─────────────────┐      bug-<id>/ dir     ┌─────────────────┐
│  capsule agent   │ ────────────────────▶ │    fix agent     │
│ (build + verify) │                       │ (existing minion)│
└─────────────────┘                       └─────────────────┘
```

### Capsule agent (Claude Agent SDK agent with a small toolbelt)

1. **Evidence**: pull event JSON from Sentry API — stack trace, release, request data, breadcrumbs, timestamp, tags.
2. **Code**: resolve release → git SHA (GitHub tag fallback), checkout into a fresh worktree.
3. **Environment**: instantiate a **hand-written compose template authored once for my app**. The agent fills the template; it does not synthesize infra per-bug.
4. **State**: `setup.sh` restoring latest dump (flavor A).
5. **Clock**: pin to event timestamp via Node `--require` Date shim when the bug smells time-dependent (expiry/cron/trial bugs).
6. **Failing input**: replay the captured request if the event has one; otherwise iterate — read code + event, write a repro script or failing test, run, compare fingerprints, adjust. Budget-capped (~15 attempts).
7. **Emit** the capsule directory, self-assign confidence, record the verification run in `manifest.json`.

### Verifier (non-negotiable, ~1 day of work)

Point the capsule app's `SENTRY_DSN` at a tiny local ingest sink → the replayed error arrives in Sentry's own structured format → fingerprint-match against the original event. This is what elevates the system above "agent makes a docker folder".

### Fix agent handoff

The fixer minion is prompted with the capsule dir and three rules:

1. `repro.sh` must fail (fingerprint-matched) before you start.
2. `repro.sh` must pass when you're done.
3. The test suite must stay green.

## Pre-work — do on my app NOW (only helps incidents that happen after)

- [ ] Sentry Node SDK: enable request body capture (`maxRequestBodySize: 'always'` / `sendDefaultPii`) — bodies are **not** captured by default; without this, POST bugs arrive unreplayable.
- [ ] `sentry-cli releases set-commits` in deploy → exact SHA on every event.
- [ ] Nightly `pg_dump` retained ≥7 days → shrinks state-drift between incident and capture.

## Build order (~1–2 weeks)

| Step | Deliverable | Notes |
|---|---|---|
| 1 | `capsule evidence <sentry-url>` → normalized `evidence.json` + what's-missing report | Sentry API + release→SHA. Useful standalone. |
| 2 | Compose template + worktree checkout + `setup.sh` → app boots at SHA with seeded DB | Template authored by hand once. |
| 3 | DSN sink + fingerprint matcher | The verifier. Build **before** the agent loop. |
| 4 | Capsule agent loop (SDK) with attempt budget + confidence tiers | Steps 1–3 become its tools. |
| 5 | Fixer handoff prompt + A/B harness | Same bug: fixer with capsule vs without. |

## Does it work for me? (define before running)

On the next ~10 **real** Sentry incidents from my app (no cherry-picking — the denominator is every incident, decided in advance):

- ≥5 reach `exact`.
- Median event → running capsule < 15 min.
- Fixer-with-capsule beats fixer-without on the same bugs (verified fixes, fewer flailing turns).
- Log a failure-cause taxonomy for every non-exact result: state drift / missing request data / env assembly / other. If misses cluster somewhere, that's the next thing to build (or the reason to stop).

Also honest: if my app's bugs turn out to be mostly stateless null-derefs, the capsule adds ceremony over "fixer, write a failing test first" — the taxonomy will show that too.

## Cut list (deliberately not in v0)

Tenant slicing, anonymization, multi-stack support, SaaS/control plane/hosted anything, auto-trigger webhooks, MCP server, GitHub-issue triggers (prose-only repro is guessing — if ever added, an issue must *resolve* to a Sentry event, never be the sole evidence), dashboards, pricing, other people's apps.

## Parked (company stuff — do not re-raise unprompted)

Extensive research on the commercial version exists from the 2026-07-14 sessions: retroactive-capture limits on default Sentry configs, webhook wedge (Stripe/GitHub retroactively fetchable ≤30d), tenant-scoped subsetting over causal slicing, customer-side data plane, name collisions ("Capsule" is crowded; "Groundhog" was cleanest). Revisit only if the POC works for me first.
