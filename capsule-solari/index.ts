#!/usr/bin/env bun
type Command = (args: string[]) => Promise<void>;

const commands: Record<string, Command> = {
  "repro create": async (args) => console.log("repro create", args),
  "repro test": async (args) => console.log("repro test", args),
  "repro run": async (args) => console.log("repro run", args),
};

const [group = "", verb = "", ...args] = Bun.argv.slice(2);
const run = commands[`${group} ${verb}`];
if (!run) {
  console.error(`usage: bun index.ts <command> [args]\n\ncommands:\n${Object.keys(commands).map((c) => `  ${c}`).join("\n")}`);
  process.exit(1);
}
await run(args);
