# Murasaki Chat Agent (plugin)

Murasaki Chat Agent connects any tool-using AI agent to any app from one plain-English request, at the level you ask for: read the app, act in it, or stay connected and respond in real time.

Ask with `/chatagent <what you want>` or in plain words ("I want an agent with constant access to my Slack that can respond"). The skill turns the request into an access spec, picks the most official connection method with the least access, builds it, and verifies it with a real round trip.

Bundled: Slack and WhatsApp channel servers, an event inbox for every other app, a watcher that polls any REST or GraphQL API into the inbox, owner approval for anything sent to other people, permission relay to your control chat, and an always-on supervisor. Slack needs no setup, reusing the login already in your browser or the Slack app; a real bot app is an option. Discord, Telegram and iMessage use Anthropic's official channel plugins.

Setup, usage and design notes are in the repository README and in `skills/chatagent/references/`.

## Install

```
/plugin marketplace add shibakouen/murasaki-chat-agent
/plugin install murasaki-chat-agent@murasaki
```

Then ask in plain words, for example `/chatagent give my agent access to my Slack and let it reply`. Full docs, branding and the agent-agnostic story are in the [repository README](https://github.com/shibakouen/murasaki-chat-agent).
