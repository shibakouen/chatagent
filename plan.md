# Plan

## Active

1. Matteo picks the final name, then rename plugin, marketplace, CLI, `~/.chatagent`, `sb-` prefixes.
2. Live test of the Slack channel with a real app in a workspace Matteo chooses (needs him to create the app from `chatagent slack-manifest`).
3. Live test of the Baileys WhatsApp backend (needs a QR pairing on a phone he chooses).
4. Plugin icon (square PNG, 512 to 2048 px) at `plugins/chatagent/.claude-plugin/icon.png`.
5. Push to GitHub once Matteo approves the name, owner and visibility.

## Next ideas

- Approval mode for the official Discord and Telegram plugins (would need forks or a wrapper).
- WhatsApp Business Cloud API backend (webhook into the inbox plus a send tool).
- `chatagent tunnel <agent>` for webhooks, with an explicit confirmation.
- A Linear recipe preset so `watch` needs no long flags.

## Done (2026-11-04)

- Channel core, inbox, Slack, WhatsApp (bridge + Baileys), CLI, watcher, keepalive, skill, references, tests, validation.
