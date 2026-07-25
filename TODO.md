# go through yc application - nothing technical asked in there

# figure out what is one bug that can only be recreated with this

the failure is a fact on your laptop before any AI has an opinion
no self-grading

Without capsule: paste link → watch the agent narrate environment archaeology in your terminal → receive a diff plus prose ("this should resolve the issue ✅") → you now review the reasoning, decide whether to trust it, and your real verification system is deploying and waiting to see if Sentry fires again — your users are the test bench. That's how "Fixed in v3.0.2" happened.

Reproduction is the only step an AI can't hallucinate — so capsule makes it the contract

Everything else in the loop is an opinion; the capsule is an exit code.

# (#3750)

It's invisible without state. A fresh install renders the report fine — $0, no crash. The exception exists only when real revenue rows are in the DB (#3750: pageviews fine, $0 fine, first tracked purchase → 500). So replaying the captured request against a clean environment returns 200. The bug is not in the request and not in the code alone — it's in request × state. That's the exact thing capsule ships and nothing else does.

The Sentry trace is minified garbage. The real production stack trace is at u (.next/server/chunks/[root-of-the-server]\__6c460d17._.js:59:56) — single-letter functions in a bundled Next.js chunk. No filename, no function, no line that maps to source. An agent given only the Sentry link starts from "an error type and a URL."

The crash hid a second bug the event can't contain. The maintainer's diagnosis in #3692: the query also wasn't case-insensitive on currency — lowercase 'usd' rows silently return empty revenue. The fix commit repairs both. A crash-less wrong-answer bug generates no Sentry event at all; it lives purely in the data. Only whoever holds the real rows ever sees it.

The critical distinction: the fix agent's environment is built from its beliefs; the capsule's environment is a dump of what happened

# here's what needed to be done 
1. start with setting up the repo, only uptil the point the bug was valid, I don't want the fixing agent to be able to see that the fix has already been done, the fix and all discussions surrounding it should be hidden to the fixing agent, for now, I'll be using claude code
2. a capsule will be set up and it'll reproduce the issue
3. my local agent tries to fix the issue, it has no context about what went into reproducing the issue
4. creates a fix, run tests, confirms that the issue has been fixed locally.
5. apply the same fix to capsule, run the test, but the issue is still there. 
6. verdict, the same fix worked fine for local setup but didn't for capsule.

# add atleast 3 interations
