# Choosing how to connect an app

Work down the ladder and stop at the first rung that delivers the requested level
with the least access. Check what is already installed before adding anything:
`claude mcp list`, `which <cli>`, the person's existing scripts and bridges.

**Prefer the no-setup path.** Most people do not want to register an app or create
an API key. When the app keeps a login the person already has (a browser session,
the app's own desktop client, a local database), reuse that first. The agent then
acts as the person, with no token to paste. Slack does this by default (it reads the
browser's `d` cookie and gets a session token); WhatsApp reuses a running bridge or
a QR-paired device; iMessage reads the local database. Reach for a registered app or
an API key only when there is no such login, when the person wants a separate bot
identity, or when the official route is the only one allowed.

## Rung 0: reuse a login the person already has

No setup, no token. If the person is already signed into the app, borrow that
session: the browser cookie (Slack), the desktop app's own stored session
(Slack, Discord), a running local bridge (WhatsApp), or a local database
(iMessage). The agent acts as the person. This is the first thing to try for any
app that has a session on the machine, because it asks nothing of the person. The
cost is that it rides an unofficial surface for some apps (see each platform note),
and the agent's messages come from the person's own account, so approval stays on.

## Rung 1: official MCP server

Best for read and act. Maintained by the vendor, OAuth instead of pasted tokens,
scoped to what the person can already see.

- Look for it in the vendor's docs ("MCP server", "Claude", "AI integrations") and in
  `claude mcp` registries. Many are remote HTTP servers:
  `claude mcp add --transport http <name> <url>`.
- Confirm with one real call before calling it done.

## Rung 2: official CLI

Good for read and act when the vendor ships a CLI that is already logged in
(`gh`, `stripe`, `wrangler`, `vercel`, `supabase`, `gcloud`, `aws`). Add only the
read-only subcommands to the allow list; writes keep asking.

## Rung 3: the app's API with a token

When there is no MCP server or CLI. The person creates the token in the app's
settings with the narrowest scope that fits (read-only for `read`). Store it where
the consumer reads it:
- an agent's `secrets.env` via `chatagent secret`
- a watcher's secrets via `daemonctl secret set`
Never in a repo, a CLAUDE.md, or a URL.

For act, either a small MCP server over the API or, for a few calls, the agent
using curl with the token from the environment. Prefer an existing open-source MCP
server for that API after reading its code; it is code that will hold the token.

## Rung 4: local data

Some apps already keep everything on disk: iMessage `~/Library/Messages/chat.db`,
a WhatsApp bridge's SQLite store, a sync tool's export folder, a mail client's
Maildir. Read-only access through SQLite or files, no network, no account risk.
Needs the OS permission that guards it (Full Disk Access for chat.db on macOS).

## Rung 5: the person's logged-in browser

For web apps with no API worth using. A browser automation MCP (Playwright MCP, or
an extension-based one that drives the person's own Chrome) can read pages and
click through UIs. Slowest and most brittle rung, and automation of some consumer
apps breaks their terms. Use it for read and act on demand; for live, pair it with
a watcher that runs a short scripted read on a schedule and posts what changed.

## Adding "live"

Read and act happen when someone asks. Live means the agent notices on its own.

| Source can… | Use |
|---|---|
| hold a socket or long poll (Slack Socket Mode, Discord gateway, Telegram getUpdates, WhatsApp Web) | a channel server: bundled `slack` / `whatsapp`, or the official `discord` / `telegram` / `imessage` plugins |
| call a webhook | the `inbox` channel; expose `127.0.0.1:<inbox_port>/event` through a tunnel (`cloudflared tunnel --url http://127.0.0.1:<port>`), and put the inbox token in the webhook's header. Say out loud that this exposes a local port. |
| only be asked | a watcher: `chatagent watch` polls the API on a cursor or version field and posts changes to the inbox |

Pick the interval from how fresh it must feel and from the API's rate limit:
60 to 120 s for work tools, 5 to 15 min for anything rate limited or expensive.

## Picking the voice for chat apps

- **Bot** (default): a separate identity. Safe; people see it is an assistant.
- **The person**: replies appear as them (Slack user token, WhatsApp on their number).
  Keep approval mode on, add a signature if they want people to know, and confirm
  the choice with them before building.
