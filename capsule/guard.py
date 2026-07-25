#!/usr/bin/env python3
"""capsule-guard — PreToolUse policy hook for capsule-protected fix workspaces.

Installed by `capsule protect` into ~/.capsule/bin/. Reads its policy from
<workspace>/.claude/capsule-guard.json (found by walking up from the session
cwd). Covers the gaps the native layers can't express: docker discipline
(the daemon ignores both permission rules and the OS sandbox), workspace
jailing for shell commands, and limiting the capsule CLI to its fix-session
verbs. Inactive (allows everything) when no guard config is present.

Exit 0 = allow. Exit 2 + stderr = deny, message is fed back to the model.
Fails closed: an internal error denies the call.
"""
import json
import os
import re
import sys

TMP_ROOTS = ("/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/")


def deny(msg):
    sys.stderr.write("capsule-guard: " + msg + "\n")
    sys.exit(2)


def load_config(cwd):
    d = os.path.realpath(cwd or "/")
    while True:
        probe = os.path.join(d, ".claude", "capsule-guard.json")
        if os.path.isfile(probe):
            try:
                return json.load(open(probe))
            except Exception:
                deny("guard config is unreadable — refusing to proceed unguarded.")
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def resolve(p, cwd):
    p = os.path.expanduser(p)
    if not os.path.isabs(p):
        p = os.path.join(cwd, p)
    return os.path.realpath(os.path.normpath(p))


def dequote(s):
    # collapse shell quoting/escaping so `docker'.'sock` == `docker.sock`
    return s.replace("'", "").replace('"', "").replace("\\", "")


def segments(cmd):
    # split a compound command into simple-command chunks on every shell
    # separator (;, newline, &&, ||, |, &, and subshell parens) so a check
    # anchored at chunk-start can't be dodged by a second line/statement
    return [s for s in re.split(r"[;\n&|()`]+", cmd) if s.strip()]


def abs_host_mount(text):
    # an absolute or home-rooted bind-mount SOURCE, in CLI (-v /a:/b,
    # --mount source=/a) or compose-YAML (- /a:/b, source: /a) form. Named
    # volumes (vol:/b) and relative binds (./a:/b) start with a letter/'.', so
    # they don't match.
    if re.search(r"source\s*[:=]\s*[\"']?(?:/|~)", text):
        return True
    return bool(
        re.search(r"""(?:^|[\s,\[='"])(?:/|~)[^\s:,'"]*:(?:/|[a-zA-Z]|[.]{1,2}/)""", text, re.M)
    )


def under(p, root):
    root = root.rstrip("/")
    return p == root or p.startswith(root + "/")


class Guard:
    def __init__(self, cfg, cwd):
        self.ws = os.path.realpath(cfg["workspace"])
        self.denied = [os.path.realpath(r) for r in cfg.get("deniedRoots", [])]
        self.offline = cfg.get("offline", False)
        self.capsule_verbs = cfg.get("allowedCapsuleVerbs", ["test", "verify-receipt"])
        self.cwd = cwd or self.ws

    def path_ok(self, p):
        r = resolve(p, self.cwd)
        for root in self.denied:
            if under(r, root):
                return False
        if under(r, self.ws) or r == "/dev/null":
            return True
        if any(under(r, t.rstrip("/")) for t in TMP_ROOTS):
            # other Claude projects' session dirs may hold unrelated state
            ws_slug = "-" + self.ws.strip("/").replace("/", "-")
            if "/claude-" in r and ws_slug not in r:
                return False
            return True
        return False

    SCOPE = (
        "fix sessions are limited to their own workspace, their own docker "
        "compose stack, and `capsule test`. Rework the command to stay inside "
        "the workspace."
    )
    OFFLINE = (
        "this fix session is offline except the error-tracker API (token in "
        ".env). Diagnose from the local repository and verify with "
        "`capsule test`."
    )
    DOCKER = (
        "docker is limited to `docker compose ...` / `docker build ...` for "
        "this workspace's own stack. Enumeration, exec into foreign "
        "containers, host mounts, and the docker socket are disabled."
    )
    CONFIG = "session guard configuration is read-only."

    def check_file_tool(self, tool, ti):
        for field in ("file_path", "path", "notebook_path"):
            v = ti.get(field)
            if v and not self.path_ok(v):
                deny(self.SCOPE)
        if tool == "Glob":
            pat = ti.get("pattern") or ""
            if pat.startswith(("/", "~")):
                base = re.split(r"[*?\[]", pat, 1)[0]
                if base and not self.path_ok(base):
                    deny(self.SCOPE)
        if not ti.get("path") and not ti.get("file_path") and not self.path_ok(self.cwd):
            deny(self.SCOPE)
        if tool in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
            fp = ti.get("file_path") or ti.get("notebook_path") or ""
            if fp and under(resolve(fp, self.cwd), os.path.join(self.ws, ".claude")):
                deny(self.CONFIG)
            # written content may not reference capsule state (blocks e.g.
            # compose files that would have the docker daemon mount it)
            content = " ".join(
                str(ti.get(k, ""))
                for k in ("content", "new_string", "new_source")
            )
            low = dequote(content).lower()
            for root in self.denied:
                if root.lower() in low:
                    deny("files in a fix workspace may not reference capsule state paths.")
            if "docker.sock" in low:
                deny(self.DOCKER)
            # can't author a compose/run file that host-bind-mounts an absolute
            # path — the daemon would mount it outside every sandbox layer
            if abs_host_mount(dequote(content)):
                deny(
                    "files here may not host-bind-mount absolute paths; the "
                    "docker daemon runs outside the guard."
                )

    def compose_file_ok(self, arg):
        # a docker-compose -f argument: must resolve inside the workspace, and
        # its contents must not host-bind-mount anything absolute.
        r = resolve(arg, self.cwd)
        if not self.path_ok(r):
            deny(
                "docker compose -f files must live inside the workspace; a "
                "compose file elsewhere can mount host paths the guard can't see."
            )
        try:
            if abs_host_mount(open(r, errors="ignore").read()):
                deny(
                    "that compose file host-bind-mounts an absolute path — the "
                    "docker daemon runs outside the sandbox, so this is denied."
                )
        except OSError:
            pass

    def check_bash(self, cmd):
        if not self.path_ok(self.cwd):
            deny(self.SCOPE)
        # work on both the raw text and a shell-dequoted view, so quote/escape
        # splitting (docker'.'sock, /Us'e'rs/...) can't hide a literal
        views = (cmd, dequote(cmd))

        for v in views:
            low = v.lower()
            for root in self.denied:
                if root.lower() in low:
                    deny(self.SCOPE)
            # path tokens must stay inside the jail
            for tok in re.findall(r"(?:~|\$HOME|/Users|/home)[^\s\"';|&)(<>]*", v):
                if not self.path_ok(tok.replace("$HOME", os.path.expanduser("~"))):
                    deny(self.SCOPE)

        # obfuscation / indirection: decoders, eval, and aliasing a guarded
        # binary into a variable to dodge the token checks below
        if re.search(r"\beval\b|\bbase64\s+(?:-d|--decode)\b|\bxxd\s+-r\b", cmd):
            deny(self.SCOPE)
        if re.search(r"\b\w+=[\"']?\$?\(?\s*(?:docker|capsule)\b", cmd, re.I):
            deny(self.SCOPE)

        # per-simple-command checks (split on every shell separator, so a
        # second statement / newline can't evade a start-anchored rule)
        for seg in segments(cmd):
            s = seg.strip()
            sd = dequote(s)
            low = sd.lower()

            # cd/pushd escapes
            if re.search(r"\b(?:cd|pushd)\s+\S*\.\.", s):
                deny(self.SCOPE)
            m = re.search(r"\b(?:cd|pushd)\s+[\"']?(/[^\s\"']*)", s)
            if m and not self.path_ok(m.group(1)):
                deny(self.SCOPE)

            # capsule CLI: fix-session verbs only (matches regardless of any
            # leading env/time/newline before the word)
            for m in re.finditer(r"\bcapsule\s+([\w-]+)", s):
                if m.group(1) not in self.capsule_verbs:
                    deny(
                        "fix sessions may run only "
                        + " / ".join("`capsule %s`" % v for v in self.capsule_verbs)
                        + " — other capsule commands are owner-plane."
                    )

            # docker discipline — the sole guard for docker (it is excluded
            # from the OS sandbox), so this is strict
            if re.search(r"\bdocker(?:-compose)?\b", low):
                if re.search(
                    r"docker\.sock|--privileged|--pid[=\s]+host|"
                    r"--userns[=\s]+host|--cap-add|--unix-socket[=\s]*\S*sock",
                    low,
                ):
                    deny(self.DOCKER)
                # subcommand allowlist
                dm = re.search(
                    r"\bdocker\s+((?:--?[\w=./-]+\s+)*)([a-z][\w-]*)", sd, re.I
                )
                sub = dm.group(2).lower() if dm else None
                if re.search(r"\bdocker-compose\b", low):
                    sub = "compose"
                if sub is not None and sub not in (
                    "compose", "build", "buildx", "version",
                ):
                    deny(self.DOCKER)
                # no absolute/home host bind mounts on the CLI
                if abs_host_mount(sd):
                    deny(self.DOCKER)
                if re.search(r"\bcapsule-\d", low):
                    deny(self.DOCKER)
                # inspect every -f/--file compose argument
                for m in re.finditer(r"(?:-f|--file)[=\s]+([^\s\"']+)", sd):
                    self.compose_file_ok(m.group(1))

            # host/process enumeration
            if re.search(
                r"^\s*(?:ps|lsof|netstat|nmap|arp|top|htop|last|who|w|"
                r"mdfind|mdls|locate)\b",
                s,
            ):
                deny(self.SCOPE)

            # system control / nested agents / config
            if re.search(r"\b(?:sudo|osascript|launchctl|crontab)\b", s):
                deny(self.SCOPE)
            if re.search(r"^\s*claude\b|--dangerously-skip-permissions", s):
                deny(self.SCOPE)
            if re.search(r"\.claude\b", sd):
                deny(self.CONFIG)

            # network: offline except the error tracker
            if self.offline:
                if re.search(
                    r"github\.com|githubusercontent|gitlab\.com|bitbucket\.org|"
                    r"google\.|bing\.com|duckduckgo|search\?q=|stackoverflow|"
                    r"www\.npmjs\.com",
                    low,
                ):
                    deny(self.OFFLINE)
                if re.search(r"^\s*gh\s+\w", s):
                    deny(self.OFFLINE)
            if re.search(
                r"\bgit\b.{0,120}\b(?:clone|fetch|pull|ls-remote|submodule|"
                r"remote\s+add|remote\s+set-url)\b|\bgit\s+push\b",
                s,
            ):
                deny(self.OFFLINE if self.offline else self.SCOPE)


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        deny("could not parse tool input; call blocked.")
    cwd = data.get("cwd") or ""
    cfg = load_config(cwd)
    if cfg is None:
        sys.exit(0)  # not a protected workspace
    g = Guard(cfg, cwd)

    tool = data.get("tool_name", "") or ""
    ti = data.get("tool_input") or {}

    if tool in ("WebSearch", "WebFetch"):
        deny(g.OFFLINE if g.offline else g.SCOPE)
    if tool.startswith("mcp__"):
        deny(g.SCOPE)
    if tool == "Bash":
        g.check_bash(ti.get("command", "") or "")
    elif tool in (
        "Read", "Glob", "Grep", "LS", "NotebookRead",
        "Edit", "Write", "MultiEdit", "NotebookEdit",
    ):
        g.check_file_tool(tool, ti)
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        deny("internal guard error; call blocked.")
