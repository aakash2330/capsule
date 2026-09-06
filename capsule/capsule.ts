#!/usr/bin/env bun
// capsule — turn a Sentry issue into a locally runnable reproduction.
// Every command acts on the current directory. Config is the app's own .env
// (SENTRY_AUTH_TOKEN, SENTRY_ORG); shell env vars override.
import { cmdSession, cmdSessionKill } from "./cmd/session";
import { cmdInit } from "./cmd/init";
import { cmdRepro } from "./cmd/repro";
import { cmdTest, cmdVerify } from "./cmd/test";

function usage(): never {
  console.log(`capsule — reproduce a Sentry issue locally (run inside the app repo)

  capsule init                       onboarding: confirms the Sentry vars in the app's
                                     .env (adds missing ones), then verifies the .capsule/
                                     template (build → boot → healthcheck). Author .capsule/
                                     with the capsule-init skill first. Re-run any time.
  capsule repro <sentry-issue-url>   fetch evidence, snapshot the dev DB, boot an isolated
                                     stack, replay the trigger; exit 0 = bug reproduced
  capsule test <issue-id>            judge the current directory against the capsule:
                                     build → reset world → replay → verdict + receipt
  capsule test                       regression pack across all capsules
  capsule session                    a shell in a blind Docker Sandboxes microVM on a copy
                                     of the app (no .capsule/ inside); run \`claude\` there.
                                     Reconnects if the sandbox already exists.
  capsule session kill               remove the VM; the copy and your diff stay on disk`);
  process.exit(1);
}

const [cmd, arg] = Bun.argv.slice(2);
switch (cmd) {
  case "init":
    await cmdInit();
    break;
  case "repro":
    if (!arg) usage();
    await cmdRepro(arg);
    break;
  case "test":
    await (arg ? cmdVerify(arg) : cmdTest());
    break;
  case "session":
    await (arg === "kill" ? cmdSessionKill() : cmdSession());
    break;
  default:
    usage();
}
process.exit(process.exitCode ?? 0);
