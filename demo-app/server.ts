// Sentry must be initialized before the rest of the app.
import "./instrument";

import * as Sentry from "@sentry/bun";
import { sql } from "bun";
import express from "express";
import type { NextFunction, Request, Response } from "express";

// Schema + seed live in db/init.sql (applied by the postgres image on first boot).

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
