---
description: Connect an agent to any app from one sentence (read, act, or live and responding)
argument-hint: "<what you want, e.g. an agent with constant access to my Slack that can respond>"
---

Use the `switchboard` skill for this request: $ARGUMENTS

If the request is empty, run `node ${CLAUDE_PLUGIN_ROOT}/bin/switchboard.mjs status` and say what agents exist, then ask what app the person wants connected and what the agent should do with it.
