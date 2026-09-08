// Sentry must be initialized before the rest of the app.
import "./instrument";

import * as Sentry from "@sentry/bun";
import { SQL } from "bun";
import express from "express";
import type { NextFunction, Request, Response } from "express";

// Schema + seed live in db/init.sql (applied by the postgres image on first boot).

// int8 comes back as BigInt once it leaves 32-bit range (sums do, rows don't).
const sql = new SQL(process.env.POSTGRES_URL!, { bigint: true });

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// Small read query — handy for checking what state a stack actually holds.
app.get("/users", async (_req: Request, res: Response) => {
  const rows = await sql`select id, email, preferences from users order by id`;
  res.json({ count: rows.length, users: rows });
});

app.post("/signup", async (req: Request, res: Response) => {
  const { email } = req.body;
  // New users get default preferences, so a fresh signup works fine.
  await sql`
    insert into users (email, preferences)
    values (${email}, '{"theme": "light"}')
    on conflict (email) do nothing
  `;
  const [user] = await sql`select * from users where email = ${email}`;
  // The deliberate bug: legacy rows (seeded before preferences had a default)
  // still carry NULL, so signing up with one of those emails crashes here.
  // It only reproduces against a database that holds such a row.
  res.json({ id: user.id, email: user.email, theme: user.preferences.theme });
});

// Revenue report. The deliberate bug: sum(integer) is int8, so once the total
// passes 2^31 it arrives as a BigInt and the fee arithmetic throws. Small
// databases never see it. The seed also holds 'usd' rows this query misses.
app.get("/reports/revenue", async (req: Request, res: Response) => {
  const currency = String(req.query.currency ?? "USD");
  const [{ total }] = await sql`select sum(amount_cents) total from orders where currency = ${currency}`;
  const fee = Math.round((total ?? 0) * 0.029);
  res.json({ currency, total_cents: total + fee });
});

// Rename a user. The deliberate bug: the update is unguarded, so renaming to an
// email that another row already owns raises a unique-violation (23505) from
// Postgres. Only reproduces when the database holds the target email.
app.patch("/users/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { email } = req.body;
  const [user] = await sql`
    update users set email = ${email} where id = ${id}
    returning id, email
  `;
  if (!user) return res.status(404).json({ error: "no such user" });
  res.json(user);
});

// The report-and-500 boundary: Express 5 forwards async rejections here.
// Captures the error with the raw request attached so the event is replayable.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  Sentry.withScope((scope) => {
    scope.setSDKProcessingMetadata({
      normalizedRequest: {
        method: req.method,
        url: `http://${req.headers.host ?? "localhost"}${req.originalUrl}`,
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [
            k,
            Array.isArray(v) ? v.join(", ") : (v ?? ""),
          ]),
        ),
        data: JSON.stringify(req.body),
      },
    });
    Sentry.captureException(err);
  });
  res.status(500).json({ error: "internal server error" });
});

const port = Number(process.env.PORT ?? 3002);
app.listen(port, () => {
  console.log(`demo-app listening on :${port}`);
});
