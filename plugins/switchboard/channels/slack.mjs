#!/usr/bin/env node
// Slack channel over Socket Mode: no public URL, no tunnel.
//
// Secrets (switchboard secret <agent> KEY):
//   SLACK_APP_TOKEN   xapp-...  app-level token with connections:write (opens the socket)
//   SLACK_BOT_TOKEN   xoxb-...  the bot
//   SLACK_USER_TOKEN  xoxp-...  optional; lets the agent read your own DMs and post as you
//
// agent.json config:
//   post_as   "bot" | "user"   who replies to other people appear to come from (default bot)
//   listen    ["dm", "mention", "my_dms", "channels"]
//             dm        DMs to the bot (always on; it is how the owner talks to the agent)
//             mention   @mentions of the bot in channels it was invited to
//             my_dms    DMs and group DMs sent to YOU (needs SLACK_USER_TOKEN)
//             channels  every message in the channel ids listed in watch_channels
//   watch_channels  ["C0123..."]
//
// History reads use conversations.history, which Slack limits to 1 request a
// minute and 15 messages for distributed non-Marketplace apps created after
// 2025-05-29. Realtime messages come over the socket and are not limited.

import { createWriteStream } from 'node:fs'
import { join, basename } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { SocketModeClient } from '@slack/socket-mode'
import { WebClient, LogLevel } from '@slack/web-api'
import { runChannel } from './lib/core.mjs'

const quietLogger = {
  debug() {}, info() {}, warn() {}, error(...a) { process.stderr.write(`slack: ${a.join(' ')}\n`) },
  setLevel() {}, getLevel() { return LogLevel.ERROR }, setName() {},
}

runChannel(async agent => {
  const cfg = agent.config
  const listen = new Set(cfg.listen || ['dm', 'mention'])
  listen.add('dm')
  const watch = new Set(cfg.watch_channels || [])
  const appToken = agent.secret('SLACK_APP_TOKEN')
  const botToken = agent.secret('SLACK_BOT_TOKEN')
  const userToken = agent.secret('SLACK_USER_TOKEN', cfg.post_as === 'user' || listen.has('my_dms'))

  const bot = new WebClient(botToken, { logger: quietLogger })
  const user = userToken ? new WebClient(userToken, { logger: quietLogger }) : null
  const socket = new SocketModeClient({ appToken, logger: quietLogger })

  let botUserId = null
  let ownerUserId = null
  const names = new Map()
  const chans = new Map()
  const seen = new Set()
  const files = new Map() // message key -> slack file objects, for download_attachment

  const remember = key => {
    if (seen.has(key)) return true
    seen.add(key)
    if (seen.size > 4000) seen.delete(seen.values().next().value)
    return false
  }

  const userName = async id => {
    if (!id) return 'unknown'
    if (names.has(id)) return names.get(id)
    try {
      const r = await bot.users.info({ user: id })
      const n = r.user?.profile?.display_name || r.user?.real_name || r.user?.name || id
      names.set(id, n)
      return n
    } catch { return id }
  }

  const chanLabel = async id => {
    if (chans.has(id)) return chans.get(id)
    let label = id
    try {
      const r = await (user || bot).conversations.info({ channel: id })
      const c = r.channel
      if (c?.is_im) label = `DM with ${await userName(c.user)}`
      else if (c?.is_mpim) label = 'group DM'
      else if (c?.name) label = `#${c.name}`
    } catch {}
    chans.set(id, label)
    return label
  }

  const clientFor = chatId => {
    // The owner's control chat is the DM with the bot, so the bot answers there.
    const a = agent._ownerChat
    if (cfg.post_as === 'user' && user && chatId !== a) return user
    return bot
  }

  return {
    label: 'Slack',
    supportsPairing: !userToken, // with a user token the owner is known, so no pairing step
    historyNote: 'Slack allows about 1 history request a minute for apps outside the Marketplace, so ask for what you need once.',
    extraInstructions: [
      'Slack formatting: *bold*, _italic_, `code`, <url|text>. Mention someone with <@USER_ID>.',
      cfg.post_as === 'user' ? 'Replies to other people are posted as the owner\'s own Slack account, so write the way they would.' : '',
    ].filter(Boolean).join('\n'),

    async start(onInbound, { setConnected, ensureOwner }) {
      const ba = await bot.auth.test()
      botUserId = ba.user_id
      if (user) {
        const ua = await user.auth.test()
        ownerUserId = ua.user_id
        const im = await bot.conversations.open({ users: ownerUserId })
        agent._ownerChat = im.channel.id
        ensureOwner({ user_id: ownerUserId, chat_id: im.channel.id, label: await userName(ownerUserId) })
      }

      const handle = async (event, body) => {
        if (!event || event.bot_id || event.user === botUserId) return
        if (event.subtype && !['file_share', 'thread_broadcast'].includes(event.subtype)) return
        const key = `${event.channel}:${event.ts}`
        if (remember(key)) return

        const viaUser = body?.authorizations?.some(x => x.user_id === ownerUserId && !x.is_bot) && ownerUserId
        const isDm = event.channel_type === 'im' || event.channel_type === 'mpim'
        const isBotDm = isDm && !viaUser
        // Your own messages elsewhere are not instructions and not news.
        if (event.user === ownerUserId && event.channel !== agent._ownerChat) return

        let wanted = false
        if (event.type === 'app_mention') wanted = listen.has('mention')
        else if (isBotDm) wanted = true
        else if (viaUser && isDm) wanted = listen.has('my_dms')
        else if (watch.has(event.channel)) wanted = listen.has('channels')
        if (!wanted) return

        const att = (event.files || []).map(f => `${f.name} (${f.mimetype}, ${Math.round((f.size || 0) / 1024)}KB)`)
        if (event.files?.length) {
          files.set(key, event.files)
          if (files.size > 500) files.delete(files.keys().next().value)
        }
        await onInbound({
          chat_id: event.channel,
          message_id: event.ts,
          user_id: event.user,
          user: await userName(event.user),
          text: event.text || '',
          ts: new Date(Number(event.ts) * 1000).toISOString(),
          thread_ts: event.thread_ts,
          where: await chanLabel(event.channel),
          is_dm: isBotDm,
          attachments: att.length ? att.join('; ') : undefined,
        })
      }

      socket.on('message', async ({ ack, event, body }) => { await ack(); await handle(event, body) })
      socket.on('app_mention', async ({ ack, event, body }) => { await ack(); await handle(event, body) })
      socket.on('connected', () => setConnected(true))
      socket.on('disconnected', () => setConnected(false))
      await socket.start()
      setConnected(true)
    },

    async send(chatId, text, opts = {}) {
      const client = clientFor(chatId)
      if (opts.files?.length) {
        await client.filesUploadV2({
          channel_id: chatId,
          thread_ts: opts.thread_ts,
          initial_comment: text,
          file_uploads: opts.files.map(f => ({ file: f, filename: basename(f) })),
        })
        return {}
      }
      const r = await client.chat.postMessage({ channel: chatId, text, thread_ts: opts.thread_ts, unfurl_links: false })
      return { message_id: r.ts }
    },

    describe: chanLabel,

    async download(chatId, messageId) {
      const list = files.get(`${chatId}:${messageId}`) || []
      const out = []
      for (const f of list) {
        const url = f.url_private_download || f.url_private
        if (!url) continue
        const res = await fetch(url, { headers: { Authorization: `Bearer ${userToken || botToken}` } })
        if (!res.ok) throw new Error(`download ${f.name}: HTTP ${res.status}`)
        const dest = join(agent.stateDir, 'inbox', `${messageId}-${basename(f.name || f.id)}`)
        await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
        out.push(dest)
      }
      return out
    },

    async history(chatId, limit) {
      const r = await (user || bot).conversations.history({ channel: chatId, limit: Math.min(limit, 15) })
      const rows = []
      for (const m of (r.messages || []).reverse()) {
        rows.push({ ts: new Date(Number(m.ts) * 1000).toISOString(), user: await userName(m.user), text: m.text || '' })
      }
      return rows
    },

    async stop() {
      await socket.disconnect().catch(() => {})
    },
  }
})
