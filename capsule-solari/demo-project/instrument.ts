import * as Sentry from '@sentry/bun';

Sentry.init({
  dsn: process.env.SENTRY_DSN || undefined,
  // Include headers/IP on events — without full request context the capsule
  // agent can't replay the failing request later (PLAN.md pre-work).
  sendDefaultPii: true,
});
