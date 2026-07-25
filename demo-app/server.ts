// Sentry must be initialized before the rest of the app.
import "./instrument";

import * as Sentry from "@sentry/bun";
import { sql } from "bun";
import express from "express";
import type { NextFunction, Request, Response } from "express";

await sql`
  create table if not exists users (
    id serial primary key,
    email text unique not null,
    preferences jsonb
  )
`;

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.post("/signup", async (req: Request, res: Response) => {
  const { email } = req.body;
  await sql`insert into users (email) values (${email}) on conflict (email) do nothing`;
  const [user] = await sql`select * from users where email = ${email}`;
  // The deliberate bug: `preferences` is NULL for fresh signups.
  res.json({ id: user.id, email: user.email, theme: user.preferences.theme });
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
