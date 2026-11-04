# WhatsApp

Bundled channel: `--channel whatsapp`. The owner's control chat is "Message yourself"
on their own number. Messages the agent writes there start with 🤖 so it never reads
its own output back.

## Pick the route

| Situation | Route |
|---|---|
| A business number, customers write in | **WhatsApp Business Cloud API** (official). Free-form replies only inside 24 hours of the customer's last message; outside it, approved templates only. Needs a Meta business account and a webhook (inbox channel through a tunnel). Not bundled yet; build it as a webhook into the inbox plus a small send tool. |
| A personal number, and `lharries/whatsapp-mcp` (whatsmeow bridge) is already running | `--set whatsapp.backend=bridge`. Reads the bridge's SQLite store read-only, sends through its local REST API at `127.0.0.1:8080/api`. No second linked device. |
| A personal number, no bridge | `--set whatsapp.backend=baileys`, then `chatagent setup --with whatsapp` and `chatagent whatsapp-login <agent>` (QR code under Settings → Linked devices). |

Both personal-number routes are unofficial WhatsApp Web clients. WhatsApp's terms
bar automated and bulk use of consumer accounts, and accounts can be restricted. Say
this once, plainly, before building on a personal number.

## Options

- `--set whatsapp.listen='["dms"]'` (default) or `'["dms","groups"]'`.
- Default policy `owner`: only "Message yourself" reaches the agent. To let it read and
  draft replies to other people: `chatagent access <agent> whatsapp policy all`
  (or `allowlist` plus `allow <jid>`). Replies to them stay drafts until approved.
- Bridge path: `--set whatsapp.bridge_dir=/path/to/whatsapp-bridge` if not in `~/whatsapp-mcp/whatsapp-bridge`.

## Traps

- Newer chats are keyed by `@lid` ids, not phone numbers; the bridge backend maps
  them to names through the bridge's `whatsmeow_lid_map` and contacts tables.
- After a restart the bridge backend replays up to 50 missed messages, then jumps
  ahead, so a long outage never floods the agent.
- The bridge must be running for sends; reads work from the store regardless.
- Node 22.5+ is required (built-in `node:sqlite`).
