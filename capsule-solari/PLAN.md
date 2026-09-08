# Capsule on Solari

Everything below was checked live when this was written; links at the bottom.

**Pitch:** every Sentry issue gets a live machine with the bug already happening in it. Shell in, patch it, replay the request.

**README line:** Capsule gives you a reproducible environment for every Sentry issue.

**Draw-the-line sentence:** Capsule doesn't ask you to write the failing test. The production request is the failing test.

## Why this exists (the channel)

- Harry Chow (Head of Growth Ops, Pinetree Research) posted a hiring challenge: fork `solari-sdk/solari-cookbook`, build a real use case on Solari, publish it, post on X or LinkedIn tagging @harrychow_ and @getsolari. SWE intern, "$300K annualized", remote, no relocation. International eligibility was asked in the LinkedIn comments and not answered. Ask this in the first message.
- Free credits code, public on LinkedIn: `STARTER1MO-MKY4BNDK` at console.getsolari.com.
- Technical reviewer: James Sng, GitHub `jssng-pinetree`. He reads code and writes long reviews. He created `applications/` for bigger programs; its table says "none yet" and about 35 PRs are open. Nobody has an application merged.
- Treat this as one channel, not the target. Pinetree is a young Palo Alto lab with no funding on record (Tracxn); legal entity Claim Copilot, Inc.

## What Solari is

Cloud browsers, headless microVM sandboxes, and Linux desktops behind one `slr_live_` key. The primitive nobody else sells: a snapshot captures disk, memory and running processes of a live machine, and `create({ fromSnapshot })` forks copies of it in about a second. That snapshot is our "reproducible environment".

Pricing (Starter, $20/month with $20 credits): browser $0.10/hr; sandbox $0.035 per vCPU-hour plus $0.011 per GB-hour, so a 2 vCPU / 2 GB sandbox is about $0.09/hr; snapshots free to 10 GB, then $0.05/GB-month once snapshot billing starts. A reproduction is a few minutes of sandbox, about a cent.

## The product

Lives at `applications/capsule/` in our fork of the cookbook. One folder. A stranger clones it, sets one key, gets output. The full repo at `~/code/capsule.dev` stays as the bigger version the README links to.

### Commands

```
capsule sync                       pull unresolved Sentry issues above a level, build one frozen
                                   machine per new issue, print reproduced / did not fire / no request
capsule shell <issue>              fork the snapshot, drop into a terminal on the failing machine (PTY)
capsule replay <issue> [--patch]   fork, apply the patch if given, fire the original request from a
                                   separate Solari browser, check the row exists, print pass or fail
capsule gc                         list every sandbox tagged with this run id and kill it
```

Two ways in, one file in the middle, everything after it identical:

```
capsule sync --from ./fixtures/                                  # exported Sentry event JSON, Solari key only
capsule sync https://sentry.io/organizations/<org>/issues/<id>/  # needs SENTRY_AUTH_TOKEN
```

`evidence` is the raw Sentry event JSON, exactly what the "JSON" link on any Sentry event page downloads. No custom format. The URL path fetches the same JSON through the API.

### What `sync` does per issue

1. Create a sandbox from the base template, tagged with `metadata: { capsuleRun: <run id>, issue: <id> }`, `lifecycle: { onTimeout: "kill" }`.
2. Install Postgres and Bun natively (apt plus a shell command). No Docker inside the sandbox.
3. Upload the demo-app as a tarball, untar, run the manifest's seed, start the app, wait for `/health`.
4. Replay the request from the event: method, URL, headers, body. Confirm the failure fires (status and, where present, the same error fingerprint).
5. Write a marker file with a random token, record its SHA-256.
6. Snapshot while running. Print the table row.

Output:

```
issue    title                          reproduced   snapshot
12345    POST /signup 500               yes          snap_8f2a
12346    TypeError in checkout worker   no request   skipped
12347    GET /orders/:id 500            no           snap_91c0 (booted, did not fire)
```

### What `replay` does

1. Fork the snapshot once per patch, in parallel.
2. In each fork: compare the marker hash to the base, apply the patch, restart the app, expose the port with `previewUrl`.
3. Launch a separate Solari browser session (a different machine, no access to the sandbox). Open the preview URL, submit the request like a user.
4. Two checks: the request no longer fails, and the row exists, read through a small read-only endpoint.
5. Regression pack: every past fixture must still pass.
6. Kill the forks and the browser. Print:

```
patch                 replay   row exists   regressions   verdict
01-real-fix           pass     yes          0             FIXED
02-silence-error      pass     no           0             FALSE FIX
03-breaks-login       pass     yes          1             REGRESSION
forks restored: 3/3 (sha256 match)   wall clock: 41s   cost: $0.02
```

Patch two is the argument: an error that goes away is not work that got done. Same point as the one example the reviewer merged (form-delivery-check: "verify the lead arrived, not just the 200").

### Layout

```
applications/capsule/
  README.md                 what it proves, how to run, honest limits
  .env.example              SOLARI_API_KEY, SENTRY_AUTH_TOKEN (URL form only)
  package.json              tsx, @solarisdk/sdk, @solarisdk/browser
  capsule.ts                sync | shell | replay | gc
  lib/solari.ts             create / snapshot / fork / kill, all tagged with the run id
  lib/sentry.ts             fetch event JSON by URL; parse the request out of an event
  lib/manifest.ts           read demo-app/.capsule/manifest.yaml
  lib/judge.ts              the browser that checks a fork
  demo-app/                 Express on Bun + Postgres, copied in, with .capsule/ inside
  fixtures/
    signup-500.json         exported Sentry event, real
    orders-500.json
    checkout-null.json      the one that won't fire with the seed
  patches/
    01-real-fix.diff
    02-silence-error.diff
    03-breaks-login.diff
```

Under a thousand lines. No UI, no docs folder, no framework.

### Manifest change

`demo-app/.capsule/manifest.yaml` today says `build: compose`. The Solari runner needs plain commands instead. Add a second runner block the sandbox uses:

```yaml
sandbox:
  install: ["apt-get install -y postgresql", "curl -fsSL https://bun.sh/install | bash"]
  seed:    ["service postgresql start", "psql -f db/seed.sql"]
  start:   "bun run server.ts"
  port:    3002
  health:  /health
```

Say in the README that the manifest is hand-written per repo. That sentence keeps the "your own repo" claim honest.

## Out of scope, on purpose

UI, multi-repo, the DSN sink, a long-running watcher (sync is one-shot, cron it), hosted anything, more than three patches, more than three fixtures, an AI that writes fixes. Everything else goes to `capsule.dev/IDEAS.md`.

## Build order

1. **Hour one.** Free key. Prove apt works in the base template and Postgres starts as a plain process. If apt is missing, build a custom template once with their Image builder (`aptInstall`) and start from that. Custom images are marked Beta.
2. **Record the fixtures.** Add the two extra bugs to demo-app. Run demo-app locally with a DSN, trigger each bug, export each event's JSON, commit to `fixtures/`.
3. **`sync` end to end on fixture files.** Create, install, upload, seed, start, replay, marker, snapshot. Metadata tagging and `gc`.
4. **`replay`.** Fork per patch, marker check, patch, preview URL, browser judge, row check, table. Write the three patches.
5. **`shell`** (PTY into a fork). Sentry URL path with fail-fast. Regression pack.
6. **README, `.env.example`, fresh-clone run** on a wiped directory with a fresh key. Checklist below.
7. **Ship.** PR to the cookbook under `applications/capsule/`. Post on X and LinkedIn with the two tables. DM James Sng with the PR link. Email Harry Chow.
8. **Freeze.** Show HN uses the same artifact.

## The reviewer's checklist

From his review comments on cookbook PRs #9, #16, #20 and the gotchas section of the cookbook README. Go through every line before opening the PR.

1. Runs end to end on a fresh key from a fresh clone. Do it on a wiped directory before submitting.
2. Fails immediately with a clear message if `SOLARI_API_KEY` is missing, or if a Sentry URL is given without `SENTRY_AUTH_TOKEN`. Never partway through a run. The message says the file path works without the token.
3. No binary fixtures. Events are JSON. No PNGs, no gzipped replays, no recordings committed.
4. No duplicated files. He checks hashes. One copy of demo-app.
5. Fixtures you own. Pointing the demo at someone else's repo is a stated no.
6. Dependencies from the registry. No vendored SDK, no lockfile for packages not used, no committed build output.
7. No generated scaffolding. No CLAUDE.md, no AGENTS.md, no untouched starter files.
8. Bash-first run blocks in the README.
9. Every sandbox tagged with metadata at create, and cleanup that uses `listAll({ metadata })` on that tag. He said nothing in the repo teaches this and he wants it.
10. Prove the fork restored, not just booted: hash a file in the base, compare in each fork, print the count.
11. `.env.example` lists every variable the code reads and nothing else.
12. Nothing outside `applications/capsule/` changes except one row in the applications table.

His one-line test for everything: is Solari doing the work or decorating it? Here the snapshot is the reproduction, the fork is the isolation, the browser is the independent judge. Remove any one and the tool stops working.

## SDK gotchas that bite this exact design

- Sandbox commands are not shell-interpreted. `run("ls -la")` looks for a binary named `ls -la`. Put argv in `args` or run `sh -c` explicitly.
- `kill()` ends a sandbox. `close()` only drops the connection and the machine keeps running until idle timeout. Forks use `lifecycle: { onTimeout: "kill" }`.
- `timeoutMs` is a rolling idle window, not a deadline. Every action resets it.
- `previewUrl` returns a URL that already carries `?pt_token=`. Build paths with the URL class or every request 404s.
- Snapshot only while the machine is running, or it returns 409 NotRunning.
- The browser runs on Solari's infrastructure and cannot reach a laptop, which is why the app must run in the sandbox.
- Browser side: `browser.close()` is enough on SDK 0.1.3; `contexts()[0]` is undefined unless a proxy was requested, use `newContext()`.
- Browser sessions die around ten minutes in practice (Simon Doba's `outlive` package exists for this). The judge opens one browser per fork and closes it in under a minute.
- Custom images and persistent volumes are marked Beta in the changelog.

## Honest limits, written in the README before he asks

- Only request-shaped failures replay. A Sentry event for an HTTP handler carries method, URL, headers and usually the body. Background jobs and frontend errors are skipped with a reason.
- Sentry scrubs bodies sometimes. Missing body prints "no request", never a fake reproduction.
- The app needs a build recipe. The manifest is hand-written per repo; the demo ships one.
- The read-only check endpoint lives in the same fork the patch modified, so a hostile patch could edit it. A stricter split puts the database in a third sandbox.
- The judge browser is a real separate session, not a fetch call.
- No fixer is included. Bring your own patches.

## How this differs from the queue

| | PatchProof (#48) | Capsule |
|---|---|---|
| Input | A probe script you wrote, plus expected strings | The request that failed in production |
| Runs in the VM | One script in an empty folder | The app with its database, seeded to the failing state |
| Environment | Two throwaway VMs, no snapshot | One frozen machine, forked per fix, kept as a regression guard |
| Judge | The probe, inside the same VM as the candidate code | A separate browser outside the VM, plus a side-effect check |

Shared with PatchProof and with #16: the rule that the broken side must fail before the fixed side may pass. That is fine; it is the right rule.

Nobody in the queue starts from an error tracker. Worldline (#20) used snapshot-fork for a candidate tournament, not for bugs. ghostspec (#9), GoblinQA (#41), self-healing-e2e (#50) and Project Polished (#6) are frontend test generation or repair. FlakeProof (#26) and One-in-Twenty (#36) are backend but start from a test suite or a planted bug.

## Launch

1. PR title: "Add applications/capsule: a reproducible environment for every Sentry issue". Body: the two tables, the honest limits, one paragraph on what Solari does in it.
2. Post on X and LinkedIn the same hour. Tag @harrychow_ and @getsolari on X, Harry Chow and Solari on LinkedIn. One closing line: looking for remote AI product engineering work, IST with EU or US-East evening overlap.
3. DM James Sng on GitHub or LinkedIn with the PR link and one sentence: what it does, and that it is the first entry for `applications/`.
4. Email harry.chow@pinetree-research.com with the post link. One question only: is the role open to someone based in India working remotely.
5. Join the Discord (discord.gg/2g8qQbTEbk) and post the PR link once. Do not ask for review there.

## Open questions

- Does apt work in the base template? Hour one.
- Is the intern role open outside the US? Ask Harry in the first email.
- Does the PTY endpoint work through `@solarisdk/sdk` for `shell`, or only through `@solarisdk/sandbox`? Check the SDK table at docs.getsolari.com/languages when implementing.

## Links

- Solari: https://www.getsolari.com/ ; docs https://docs.getsolari.com/ ; snapshots https://docs.getsolari.com/snapshots ; sandboxes https://docs.getsolari.com/sandboxes ; languages https://docs.getsolari.com/languages ; pricing https://docs.getsolari.com/pricing ; changelog https://changelog.getsolari.com/ ; terms https://www.getsolari.com/terms
- Cookbook: https://github.com/solari-sdk/solari-cookbook ; applications folder rules in `applications/README.md`
- Reviewer comments to reread: PR #9 https://github.com/solari-sdk/solari-cookbook/pull/9 ; PR #16 https://github.com/solari-sdk/solari-cookbook/pull/16 ; PR #20 https://github.com/solari-sdk/solari-cookbook/pull/20
- Merged example to copy the shape of: `examples/form-delivery-check-ts` (index.ts, README.md, .env.example, package.json)
- Challenge post: https://x.com/harrychow_/status/2094437473912844480 ; LinkedIn version with the remote and credits P.S.: https://www.linkedin.com/posts/harry-chow1_were-hiring-a-swe-intern-for-pinetree-research-activity-7500203701882527746-mZal
- Humans: James Sng https://github.com/jssng-pinetree , https://www.linkedin.com/in/james-sng-36b6a1256/ ; Harry Chow https://x.com/harrychow_ , harry.chow@pinetree-research.com
- Pinetree: https://pinetree-research.com/ ; careers https://pinetree-research.com/careers ; Tracxn https://tracxn.com/d/companies/pinetree-research/__b06FNuHdgO73hM2IfxVtG-MFX0kF8cyZRpzvSQDiu6s
- PatchProof for comparison: https://github.com/solari-sdk/solari-cookbook/pull/48
