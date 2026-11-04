# Discovery

## Why this exists

Matteo wants an open-source Claude Code plugin where anyone types one sentence ("an agent with constant access to my Slack that can respond", "an agent that answers my Discord", "let my agent read my WhatsApp", "look at my Linear", "any web app") and the plugin works out how to connect, sets it up in the most robust way, and keeps it running.

Before this, every connected agent on his Mac was a one-off: `~/decks/lamponi-investor-seed/slack_dave.py` covered one Slack DM and stopped when its session went idle; Slack, WhatsApp and Discord syncs were read-only mirrors into the vault (vault `Research/Slack Agents/`, 2026-11-04).

## Scope (2026-11-04)

Any app, three levels: read, act, live (react and respond). Messaging apps get two-way channels; everything else gets the event inbox plus watchers or webhooks; read/act use the app's MCP server, CLI, API, local data or the logged-in browser.

## Success

- One request produces a running, verified connection without the person writing code.
- Only the owner can instruct the agent; replies to other people wait for approval by default.
- Survives crashes and reboots; removable in one command.
- Publishable on GitHub as a Claude Code marketplace.
