import { existsSync, readFileSync } from "node:fs";
import readline from "node:readline";

export function fail(msg: string): never {
  console.error(`capsule: ${msg}`);
  process.exit(1);
}

// KEY=value lines; surrounding quotes and a leading `export ` are dropped.
export function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export const interactive = () => Boolean(process.stdin.isTTY);

export function promptLine(q: string, def?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(def ? `${q} [${def}]: ` : `${q}: `, (ans) => {
      rl.close();
      resolve(ans.trim() || def || "");
    });
  });
}

// no-echo read for secrets (token paste)
export function promptSecret(q: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(q + ": ");
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    let buf = "";
    const done = () => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      resolve(buf.trim());
    };
    const onData = (d: Buffer) => {
      for (const code of d) {
        if (code === 3) {
          process.stdout.write("\n");
          process.exit(1);
        }
        if (code === 4 || code === 10 || code === 13) return done();
        if (code === 127 || code === 8) buf = buf.slice(0, -1);
        else if (code >= 32) buf += String.fromCharCode(code);
      }
    };
    stdin.on("data", onData);
  });
}
