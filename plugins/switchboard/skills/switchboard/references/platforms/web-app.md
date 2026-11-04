# Any web app

Work the ladder in `../method-ladder.md`. Questions to answer from the app's own docs,
in this order, before writing anything:

1. Does it publish an MCP server? (search the docs and the vendor's GitHub for "MCP")
2. Does it ship a CLI?
3. Does it have a REST or GraphQL API, and how are tokens created and scoped?
4. Does it send webhooks? For which events?
5. Does it keep data locally (desktop app with a SQLite store or export folder)?

## When the only way in is the web UI

Use a browser automation MCP against the person's logged-in browser for read and act.

- Prefer one that attaches to the person's existing Chrome profile (their sessions,
  no new logins) over a fresh headless browser that must log in.
- Keep it on read unless the request is to act; every click that changes something
  should be a step the person asked for.
- Never type credentials into a login form on the person's behalf; if a session has
  expired, stop and tell them.

For live, a watcher can run a short scripted read on a schedule (open the page,
extract the rows, compare with last time) and post changes to the inbox. Keep the
interval long (5 to 15 minutes) and the script narrow; browser automation of some
consumer sites breaks their terms, and say so when it does.

## Verify

One real read that returns the person's real data, shown to them. For live, one
event delivered to the agent and acted on.
