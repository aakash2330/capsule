// Sentry API access and the evidence we keep from an event.
import { fail } from "./util";

const apiBase = () => process.env.SENTRY_API_BASE ?? "https://sentry.io";
const authHeaders = () => ({ Authorization: `Bearer ${process.env.SENTRY_AUTH_TOKEN}` });

export interface Frame {
  filename?: string;
  function?: string;
  line?: number;
}

export interface Evidence {
  issueId: string;
  issueUrl: string;
  app?: string; // owning app (manifest.app) — scopes the regression pack
  eventId?: string;
  title?: string;
  dateCreated?: string;
  fetchedAt: string;
  exception: { type: string; value: string; topFrames: Frame[] };
  request: {
    method: string;
    url: string;
    path: string;
    contentType: string;
    userAgent?: string | null;
    body: string | null;
  } | null;
}

export function parseIssueUrl(raw: string): { org: string; issueId: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    fail(`not a URL: ${raw}`);
  }
  const idMatch = u.pathname.match(/issues\/(\d+)/);
  if (!idMatch) fail(`no issue id in URL path: ${u.pathname}`);
  const orgFromPath = u.pathname.match(/organizations\/([^/]+)\//)?.[1];
  const sub = u.hostname.endsWith(".sentry.io") ? u.hostname.slice(0, -".sentry.io".length) : "";
  const orgFromHost = sub && !["www", "us", "de", "sentry"].includes(sub) ? sub : "";
  const org = process.env.SENTRY_ORG || orgFromPath || orgFromHost;
  if (!org) fail("could not determine the org slug — set SENTRY_ORG=<slug>");
  return { org, issueId: idMatch[1] };
}

export async function fetchLatestEvent(org: string, issueId: string): Promise<any> {
  if (!process.env.SENTRY_AUTH_TOKEN) fail("SENTRY_AUTH_TOKEN is not set — run capsule init");
  const url = `${apiBase()}/api/0/organizations/${org}/issues/${issueId}/events/latest/`;
  let res: globalThis.Response;
  try {
    res = await fetch(url, { headers: authHeaders() });
  } catch (e) {
    fail(`cannot reach Sentry API at ${apiBase()}: ${e}`);
  }
  if (!res.ok) fail(`Sentry API returned ${res.status} for ${url}\n${await res.text()}`);
  return res.json();
}

// GET the org list to prove the token works; returns org slugs.
export async function validateSentryToken(): Promise<{ ok: boolean; orgs: string[] }> {
  if (!process.env.SENTRY_AUTH_TOKEN) return { ok: false, orgs: [] };
  try {
    const res = await fetch(`${apiBase()}/api/0/organizations/`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, orgs: [] };
    const arr: any[] = await res.json();
    return { ok: true, orgs: arr.map((o) => o.slug).filter(Boolean) };
  } catch {
    return { ok: false, orgs: [] };
  }
}

// The REST API wraps things in `entries` and uses camelCase (lineNo/inApp);
// raw event JSON uses top-level keys and snake_case. Accept both.
export function extractEvidence(event: any, issueUrl: string, issueId: string): Evidence {
  const entries: any[] = event.entries ?? [];

  const excValues =
    entries.find((e) => e.type === "exception")?.data?.values ?? event.exception?.values ?? [];
  const exc = excValues.at(-1) ?? {};
  const frames: any[] = exc.stacktrace?.frames ?? [];
  const inApp = frames.filter((f) => f.inApp ?? f.in_app);
  const topFrames: Frame[] = (inApp.length ? inApp : frames)
    .slice(-3)
    .reverse()
    .map((f) => ({ filename: f.filename, function: f.function, line: f.lineNo ?? f.lineno }));

  const reqData = entries.find((e) => e.type === "request")?.data ?? event.request ?? {};
  const headerPairs: [string, unknown][] = Array.isArray(reqData.headers)
    ? reqData.headers
    : Object.entries(reqData.headers ?? {});
  const headers = Object.fromEntries(headerPairs.map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  const body =
    reqData.data == null ? null : typeof reqData.data === "string" ? reqData.data : JSON.stringify(reqData.data);

  let request: Evidence["request"] = null;
  if (reqData.method && reqData.url) {
    let reqPath = "/";
    try {
      const u = new URL(reqData.url);
      reqPath = u.pathname + u.search;
    } catch {}
    request = {
      method: String(reqData.method).toUpperCase(),
      url: reqData.url,
      path: reqPath,
      contentType: headers["content-type"] ?? "application/json",
      // Replay with the caller's own User-Agent — apps behind bot detection
      // (e.g. isbot) silently no-op a default curl UA and the bug never fires.
      userAgent: headers["user-agent"] ?? null,
      body,
    };
  }

  return {
    issueId,
    issueUrl,
    eventId: event.eventID ?? event.event_id,
    title: event.title,
    dateCreated: event.dateCreated ?? event.datetime,
    fetchedAt: new Date().toISOString(),
    exception: { type: exc.type ?? "UnknownError", value: exc.value ?? "", topFrames },
    request,
  };
}
