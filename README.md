# switchboard

Tell Claude Code which app your agent should use and what it should do there. switchboard figures out how to connect it, sets it up, keeps it running, and proves it works with a real test.

```
/switchboard I want an agent with constant access to my Slack that can respond
/switchboard an agent that answers my Discord DMs
/switchboard let my agent read my WhatsApp and draft replies for me
/switchboard watch my Linear and tell me when an issue assigned to me moves to In Review
/switchboard give my agent access to our admin dashboard, read only
```

## Three levels of access

| Level | What the agent can do | How switchboard connects it |
|---|---|---|
| **Read** | look things up when you ask | the app's official MCP server, its CLI, its API with a read-only token, its local data, or your logged-in browser |
| **Act** | change things when you ask | the same, with write access that still asks you first |
| **Live** | notice events and respond on its own | a channel (Slack, WhatsApp, Discord, Telegram, iMessage) or the event inbox fed by watchers and webhooks, plus an always-on agent |

It picks the most official option that can do the job and asks for the smallest access that covers it.

## What "live" sets up

Each live agent gets its own folder with a persona, standing orders and permissions, and runs Claude Code in a background terminal. It also loads your normal skills and MCP servers, so every tool you already use is available to it.

New messages are pushed straight into the agent's session through a channel. Slack (over Socket Mode, so you need no public URL) and WhatsApp channels come bundled. Discord, Telegram and iMessage use Anthropic's official channel plugins.

Apps that aren't chat apps feed an event inbox instead. A watcher polls any REST or GraphQL API (Linear, GitHub, your own backend) and posts whatever changed. Webhooks can post to the inbox as well.

Only you can give the agent instructions, and only from your private control chat. Messages from anyone else, and every event, reach it as information. When it replies to someone other than you, the reply waits as a draft until you answer `send <code>`, `edit <code> <new text>` or `drop <code>`. If it needs permission to use a tool, the request comes to the same chat and you answer `yes <code>` or `no <code>`.

To keep an agent running, `switchboard always-on` installs a supervisor (launchd on macOS, systemd on Linux, Task Scheduler on Windows) that restarts it after a crash or a reboot.

## Install

```
/plugin marketplace add <owner>/switchboard
/plugin install switchboard@switchboard
```

Then ask for what you want with `/switchboard`, or in plain words.

Requirements: Claude Code 2.1.80 or newer signed in with a claude.ai account or an API key, Node 22.5+, tmux, and Python 3 for always-on agents and watchers. Bun only for the official Discord, Telegram and iMessage plugins.

## The command line

The skill drives a small CLI that you can also use yourself:

```
switchboard setup                                    install the channel runtime
switchboard new ritsuko --channel slack,inbox \
  --persona "Ritsuko, Matteo's assistant" \
  --instructions "Answer questions about my calendar. Draft replies to DMs."
switchboard secret ritsuko SLACK_BOT_TOKEN           store a credential (prompts)
switchboard start ritsuko                            run it in tmux, wait until connected
switchboard status                                   what is running, connected, waiting
switchboard watch ritsuko linear --url ... --items-path ...   poll an API into the inbox
switchboard always-on ritsuko                        survive crashes and reboots
switchboard attach ritsuko                           watch the session live
switchboard remove ritsuko --yes                     stop it and delete its folder
```

## How it works

A channel is an MCP server that Claude Code lets push messages into a running session (Claude Code's channels feature, a research preview). switchboard's channel servers share one core that handles sender checks, pairing, drafts for your approval, permission relay and health heartbeats. Each agent is a normal Claude Code project folder started in tmux with its channels enabled. Watchers and the always-on supervisor run on [daemon-agent](./plugins/switchboard/vendor/daemonctl), which installs real OS services you can list, health check and remove.

More detail: [architecture](./plugins/switchboard/skills/switchboard/references/architecture.md), [how a connection method is chosen](./plugins/switchboard/skills/switchboard/references/method-ladder.md), and per-app guides in [platforms](./plugins/switchboard/skills/switchboard/references/platforms).

## Good to know

- Custom channels load through Claude Code's `--dangerously-load-development-channels` flag, because only Anthropic's own channel plugins are on its allowlist during the preview. switchboard answers that startup warning for you, since you created the agent.
- WhatsApp on a personal number runs through an unofficial WhatsApp Web client, which WhatsApp's terms do not allow for automation, so the account can be restricted. For a business number, use the official WhatsApp Business Cloud API.
- Slack limits history reads for apps outside its Marketplace to one request a minute. Live messages arrive over the socket and are not affected.
- Run one agent per Slack app. Two sessions sharing an app token split the events between them.

## License

MIT
