# chatagent

Tell Claude Code which app your agent should use and what it should do there. chatagent figures out how to connect it, sets it up, keeps it running, and proves it works with a real test.

```
/chatagent I want an agent with constant access to my Slack that can respond
/chatagent an agent that answers my Discord DMs
/chatagent let my agent read my WhatsApp and draft replies for me
/chatagent watch my Linear and tell me when an issue assigned to me moves to In Review
/chatagent give my agent access to our admin dashboard, read only
```

## Three levels of access

| Level | What the agent can do | How chatagent connects it |
|---|---|---|
| **Read** | look things up when you ask | the app's official MCP server, its CLI, its API with a read-only token, its local data, or your logged-in browser |
| **Act** | change things when you ask | the same, with write access that still asks you first |
| **Live** | notice events and respond on its own | a channel (Slack, WhatsApp, Discord, Telegram, iMessage) or the event inbox fed by watchers and webhooks, plus an always-on agent |

It picks the most official option that can do the job and asks for the smallest access that covers it.

## What "live" sets up

Each live agent gets its own folder with a persona, standing orders and permissions, and runs Claude Code in a background terminal. It also loads your normal skills and MCP servers, so every tool you already use is available to it.

New messages are pushed straight into the agent's session through a channel. Slack and WhatsApp channels come bundled. Slack needs no setup at all: it reuses the login you already have in your browser or the Slack desktop app, so there is no app to register and no token to paste. WhatsApp reuses a running bridge or a device you pair once by QR. Discord, Telegram and iMessage use Anthropic's official channel plugins, which take one token from the app's own settings.

Apps that aren't chat apps feed an event inbox instead. A watcher polls any REST or GraphQL API (Linear, GitHub, your own backend) and posts whatever changed. Webhooks can post to the inbox as well.

Only you can give the agent instructions, and only from your private control chat. Messages from anyone else, and every event, reach it as information. When it replies to someone other than you, the reply waits as a draft until you answer `send <code>`, `edit <code> <new text>` or `drop <code>`. If it needs permission to use a tool, the request comes to the same chat and you answer `yes <code>` or `no <code>`.

To keep an agent running, `chatagent always-on` installs a supervisor (launchd on macOS, systemd on Linux, Task Scheduler on Windows) that restarts it after a crash or a reboot.

## Install

```
/plugin marketplace add <owner>/chatagent
/plugin install chatagent@chatagent
```

Then ask for what you want with `/chatagent`, or in plain words.

Requirements: Claude Code 2.1.80 or newer signed in with a claude.ai account or an API key, Node 22.5+, tmux, and Python 3 for always-on agents and watchers. Bun only for the official Discord, Telegram and iMessage plugins.

## The command line

The skill drives a small CLI that you can also use yourself:

```
chatagent setup                                    install the channel runtime
chatagent new ritsuko --channel slack,inbox \
  --set slack.workspace=acme \
  --persona "Ritsuko, Matteo's assistant" \
  --instructions "Answer questions about my calendar. Draft replies to DMs."
chatagent start ritsuko                            run it in tmux, wait until connected
#   (Slack uses your existing browser login; no token to store)
chatagent status                                   what is running, connected, waiting
chatagent watch ritsuko linear --url ... --items-path ...   poll an API into the inbox
chatagent always-on ritsuko                        survive crashes and reboots
chatagent attach ritsuko                           watch the session live
chatagent remove ritsuko --yes                     stop it and delete its folder
```

## How it works

A channel is an MCP server that Claude Code lets push messages into a running session (Claude Code's channels feature, a research preview). chatagent's channel servers share one core that handles sender checks, pairing, drafts for your approval, permission relay and health heartbeats. Each agent is a normal Claude Code project folder started in tmux with its channels enabled. Watchers and the always-on supervisor run on [daemon-agent](./plugins/chatagent/vendor/daemonctl), which installs real OS services you can list, health check and remove.

More detail: [architecture](./plugins/chatagent/skills/chatagent/references/architecture.md), [how a connection method is chosen](./plugins/chatagent/skills/chatagent/references/method-ladder.md), and per-app guides in [platforms](./plugins/chatagent/skills/chatagent/references/platforms).

## Good to know

- Custom channels load through Claude Code's `--dangerously-load-development-channels` flag, because only Anthropic's own channel plugins are on its allowlist during the preview. chatagent answers that startup warning for you, since you created the agent.
- WhatsApp on a personal number runs through an unofficial WhatsApp Web client, which WhatsApp's terms do not allow for automation, so the account can be restricted. For a business number, use the official WhatsApp Business Cloud API.
- Slack's default backend reuses the login in your browser, so the agent reads and posts as you. On macOS the first read may show one "allow access" keychain prompt per browser. If you want a separate bot identity instead, use `--set slack.backend=app`.
- WhatsApp on a personal number runs through an unofficial WhatsApp Web client, and a Discord user token breaks Discord's terms. For those, the account can be restricted; use the official route (WhatsApp Business Cloud API, a Discord bot) when that matters.

## License

MIT
