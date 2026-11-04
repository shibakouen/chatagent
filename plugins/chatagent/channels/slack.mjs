#!/usr/bin/env node
// Slack channel, two backends:
//
//   session  (default, keyless) use the Slack login already in the person's
//            browser or Slack desktop app. No Slack app, no bot, no API key.
//            Replies come from the person's own account. The owner is that
//            account; "Message yourself" / a self-DM is the control chat.
//   app      a real Slack app over Socket Mode (xapp + xoxb, optional xoxp).
//            A bot identity, pairing by code. Use when the person wants a
//            separate bot rather than acting as themselves, or an admin
//            requires an installed app.
//
// agent.json config (channels.slack):
//   backend        "session" | "app"           (default session)
//   workspace      domain, name or team id      (session: which of your workspaces)
//   sources        ["chrome","slack-app",...]   (session: which browsers to read)
//   post_as        "user" | "bot"               (app only; session always posts as you)
//   listen         ["dm","mention","my_dms","channels"]
//   watch_channels ["C0123"]
//
// Secrets override the browser read when set:
//   SLACK_D_COOKIE, SLACK_XOXC_TOKEN, SLACK_WORKSPACE_DOMAIN   (session)
//   SLACK_APP_TOKEN, SLACK_BOT_TOKEN, SLACK_USER_TOKEN          (app)

import { createWriteStream } from 'node:fs'
import { join, basename } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { runChannel } from './lib/core.mjs'

const quietLogger = {
  debug() {}, info() {}, warn() {}, error(...a) { process.stderr.write(`slack: ${a.join(' ')}\n`) },
  setLevel() {}, getLevel() { return 'error' }, setName() {}, setName2() {},
}

// ---------------------------------------------------------------- session backend

async function sessionBackend(agent, cfg, listen, watch) {
  const { readDCookie, listWorkspaces, pickWorkspace, sessionClient, UA } = await import('./lib/slack-session.mjs')
  const WebSocket = (await import('ws')).default

  let cookie = agent.secret('SLACK_D_COOKIE', false)
  let source = 'SLACK_D_COOKIE'
  if (!cookie) {
    const sources = cfg.sources
    const r = readDCookie(sources)
    cookie = r.cookie
    source = r.source
  }
  let team
  const forcedToken = agent.secret('SLACK_XOXC_TOKEN', false)
  if (forcedToken) {
    const domain = agent.secret('SLACK_WORKSPACE_DOMAIN')
    const list = await listWorkspaces(cookie).catch(() => [])
    const known = list.find(t => t.domain === domain)
    team = known || { domain, token: forcedToken, user_id: agent.secret('SLACK_USER_ID', false) || '', name: domain, id: '' }
    team.token = forcedToken
  } else {
    team = pickWorkspace(await listWorkspaces(cookie), cfg.workspace)
  }
  const client = sessionClient({ cookie, token: team.token, domain: team.domain })

  let selfId = team.user_id
  const names = new Map()
  const chans = new Map()
  const files = new Map()
  let ws = null
  let stopped = false
  let seq = 1

  const userName = async id => {
    if (!id) return 'unknown'
    if (names.has(id)) return names.get(id)
    const r = await client.call('users.info', { user: id })
    const n = r.ok ? (r.user.profile?.display_name || r.user.real_name || r.user.name || id) : id
    names.set(id, n)
    return n
  }
  const chanLabel = async id => {
    if (chans.has(id)) return chans.get(id)
    let label = id
    const r = await client.call('conversations.info', { channel: id })
    if (r.ok) {
      const c = r.channel
      if (c.is_im) label = `DM with ${await userName(c.user)}`
      else if (c.is_mpim) label = 'group DM'
      else if (c.name) label = `#${c.name}`
    }
    chans.set(id, label)
    return label
  }

  return {
    label: `Slack (${team.name})`,
    supportsPairing: false, // the logged-in account is the owner
    historyNote: 'Reads come from your own Slack session.',
    extraInstructions: [
      `You are connected to the "${team.name}" Slack workspace as the owner's own account (${source}).`,
      'Slack formatting: *bold*, _italic_, `code`, <url|text>, mention with <@USERID>.',
      'Replies you send come from the owner\'s own Slack account. Write the way they would, and remember the owner-approval rule for anyone who is not them.',
    ].join('\n'),

    async start(onInbound, { setConnected, ensureOwner }) {
      const who = await client.call('auth.test')
      if (!who.ok) throw new Error(`Slack session rejected (${who.error}). The login may have expired; open Slack in the browser and sign in again.`)
      selfId = who.user_id
      const selfDm = await client.call('conversations.open', { users: selfId })
      const controlChat = selfDm.ok ? selfDm.channel.id : selfId
      agent._ownerChat = controlChat
      ensureOwner({ user_id: selfId, chat_id: controlChat, label: `you (@${who.user} in ${team.name})` })

      const connect = async () => {
        if (stopped) return
        const rtm = await client.call('rtm.connect')
        if (!rtm.ok) { agent.log('error', 'rtm.connect failed', { error: rtm.error }); setConnected(false); return setTimeout(connect, 5000) }
        ws = new WebSocket(rtm.url, { headers: { cookie: `d=${cookie}`, 'user-agent': UA, origin: 'https://app.slack.com' } })
        ws.on('open', () => setConnected(true))
        ws.on('close', () => { setConnected(false); if (!stopped) setTimeout(connect, 5000) })
        ws.on('error', e => agent.log('error', 'rtm socket error', { err: String(e.message || e) }))
        ws.on('message', async raw => {
          let ev
          try { ev = JSON.parse(raw) } catch { return }
          if (ev.type !== 'message' || ev.subtype && !['file_share', 'thread_broadcast'].includes(ev.subtype)) return
          if (ev.hidden || !ev.channel) return
          await handle(ev).catch(err => agent.log('error', 'handle failed', { err: String(err) }))
        })
      }

      const handle = async ev => {
        const isDm = ev.channel_type === 'im' || ev.channel.startsWith('D')
        const isGroup = ev.channel_type === 'mpim'
        const isSelfDm = ev.channel === controlChat
        const mentioned = (ev.text || '').includes(`<@${selfId}>`)
        // The person's own messages only matter in their self-DM control chat.
        if (ev.user === selfId && !isSelfDm) return
        let wanted = false
        if (isSelfDm) wanted = true
        else if (isDm) wanted = listen.has('my_dms') || listen.has('dm')
        else if (mentioned) wanted = listen.has('mention')
        else if (watch.has(ev.channel)) wanted = listen.has('channels')
        if (!wanted) return
        const att = (ev.files || []).map(f => `${f.name} (${f.mimetype}, ${Math.round((f.size || 0) / 1024)}KB)`)
        if (ev.files?.length) { files.set(`${ev.channel}:${ev.ts}`, ev.files); if (files.size > 500) files.delete(files.keys().next().value) }
        await onInbound({
          chat_id: ev.channel, message_id: ev.ts, user_id: ev.user, user: await userName(ev.user),
          text: ev.text || '', ts: new Date(Number(ev.ts) * 1000).toISOString(), thread_ts: ev.thread_ts,
          where: await chanLabel(ev.channel), is_dm: isSelfDm, attachments: att.length ? att.join('; ') : undefined,
        })
      }
      await connect()
    },

    async send(chatId, text, opts = {}) {
      if (opts.files?.length) {
        for (const [i, f] of opts.files.entries()) {
          const up = await client.call('files.getUploadURLExternal', { filename: basename(f), length: (await import('node:fs')).statSync(f).size })
          if (!up.ok) throw new Error(`upload init failed: ${up.error}`)
          const buf = (await import('node:fs')).readFileSync(f)
          await fetch(up.upload_url, { method: 'POST', headers: { 'user-agent': UA }, body: buf })
          const done = await client.call('files.completeUploadExternal', {
            files: [{ id: up.file_id, title: basename(f) }],
            channel_id: chatId, thread_ts: opts.thread_ts, initial_comment: i === 0 ? text : undefined,
          })
          if (!done.ok) throw new Error(`upload finish failed: ${done.error}`)
        }
        return {}
      }
      const r = await client.call('chat.postMessage', { channel: chatId, text, thread_ts: opts.thread_ts, unfurl_links: false, as_user: true })
      if (!r.ok) throw new Error(`postMessage failed: ${r.error}`)
      return { message_id: r.ts }
    },

    describe: chanLabel,

    async download(chatId, messageId) {
      const list = files.get(`${chatId}:${messageId}`) || []
      const out = []
      for (const f of list) {
        const url = f.url_private_download || f.url_private
        if (!url) continue
        const res = await fetch(url, { headers: { cookie: `d=${cookie}`, 'user-agent': UA } })
        if (!res.ok) throw new Error(`download ${f.name}: HTTP ${res.status}`)
        const dest = join(agent.stateDir, 'inbox', `${messageId}-${basename(f.name || f.id)}`)
        await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
        out.push(dest)
      }
      return out
    },

    async history(chatId, limit) {
      const r = await client.call('conversations.history', { channel: chatId, limit: Math.min(limit, 50) })
      const rows = []
      for (const m of (r.messages || []).reverse()) rows.push({ ts: new Date(Number(m.ts) * 1000).toISOString(), user: await userName(m.user), text: m.text || '' })
      return rows
    },

    async stop() { stopped = true; try { ws?.close() } catch {} },
  }
}

// ---------------------------------------------------------------- app backend (Socket Mode)

async function appBackend(agent, cfg, listen, watch) {
  const { SocketModeClient } = await import('@slack/socket-mode')
  const { WebClient } = await import('@slack/web-api')
  const appToken = agent.secret('SLACK_APP_TOKEN')
  const botToken = agent.secret('SLACK_BOT_TOKEN')
  const userToken = agent.secret('SLACK_USER_TOKEN', cfg.post_as === 'user' || listen.has('my_dms'))
  const bot = new WebClient(botToken, { logger: quietLogger })
  const user = userToken ? new WebClient(userToken, { logger: quietLogger }) : null
  const socket = new SocketModeClient({ appToken, logger: quietLogger })
  let botUserId = null, ownerUserId = null
  const names = new Map(), chans = new Map(), seen = new Set(), files = new Map()
  const remember = k => { if (seen.has(k)) return true; seen.add(k); if (seen.size > 4000) seen.delete(seen.values().next().value); return false }
  const userName = async id => { if (!id) return 'unknown'; if (names.has(id)) return names.get(id); try { const r = await bot.users.info({ user: id }); const n = r.user?.profile?.display_name || r.user?.real_name || r.user?.name || id; names.set(id, n); return n } catch { return id } }
  const chanLabel = async id => { if (chans.has(id)) return chans.get(id); let label = id; try { const r = await (user || bot).conversations.info({ channel: id }); const c = r.channel; if (c?.is_im) label = `DM with ${await userName(c.user)}`; else if (c?.is_mpim) label = 'group DM'; else if (c?.name) label = `#${c.name}` } catch {}; chans.set(id, label); return label }
  const clientFor = chatId => (cfg.post_as === 'user' && user && chatId !== agent._ownerChat) ? user : bot

  return {
    label: 'Slack',
    supportsPairing: !userToken,
    historyNote: 'Slack allows about 1 history request a minute for apps outside the Marketplace.',
    extraInstructions: ['Slack formatting: *bold*, _italic_, `code`, <url|text>. Mention with <@USERID>.', cfg.post_as === 'user' ? 'Replies to others post as the owner\'s own account.' : ''].filter(Boolean).join('\n'),
    async start(onInbound, { setConnected, ensureOwner }) {
      botUserId = (await bot.auth.test()).user_id
      if (user) { const ua = await user.auth.test(); ownerUserId = ua.user_id; const im = await bot.conversations.open({ users: ownerUserId }); agent._ownerChat = im.channel.id; ensureOwner({ user_id: ownerUserId, chat_id: im.channel.id, label: await userName(ownerUserId) }) }
      const handle = async (event, body) => {
        if (!event || event.bot_id || event.user === botUserId) return
        if (event.subtype && !['file_share', 'thread_broadcast'].includes(event.subtype)) return
        if (remember(`${event.channel}:${event.ts}`)) return
        const viaUser = body?.authorizations?.some(x => x.user_id === ownerUserId && !x.is_bot) && ownerUserId
        const isDm = event.channel_type === 'im' || event.channel_type === 'mpim'
        const isBotDm = isDm && !viaUser
        if (event.user === ownerUserId && event.channel !== agent._ownerChat) return
        let wanted = false
        if (event.type === 'app_mention') wanted = listen.has('mention')
        else if (isBotDm) wanted = true
        else if (viaUser && isDm) wanted = listen.has('my_dms')
        else if (watch.has(event.channel)) wanted = listen.has('channels')
        if (!wanted) return
        const att = (event.files || []).map(f => `${f.name} (${f.mimetype}, ${Math.round((f.size || 0) / 1024)}KB)`)
        if (event.files?.length) { files.set(`${event.channel}:${event.ts}`, event.files); if (files.size > 500) files.delete(files.keys().next().value) }
        await onInbound({ chat_id: event.channel, message_id: event.ts, user_id: event.user, user: await userName(event.user), text: event.text || '', ts: new Date(Number(event.ts) * 1000).toISOString(), thread_ts: event.thread_ts, where: await chanLabel(event.channel), is_dm: isBotDm, attachments: att.length ? att.join('; ') : undefined })
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
      if (opts.files?.length) { await client.filesUploadV2({ channel_id: chatId, thread_ts: opts.thread_ts, initial_comment: text, file_uploads: opts.files.map(f => ({ file: f, filename: basename(f) })) }); return {} }
      const r = await client.chat.postMessage({ channel: chatId, text, thread_ts: opts.thread_ts, unfurl_links: false })
      return { message_id: r.ts }
    },
    describe: chanLabel,
    async download(chatId, messageId) {
      const list = files.get(`${chatId}:${messageId}`) || []; const out = []
      for (const f of list) { const url = f.url_private_download || f.url_private; if (!url) continue; const res = await fetch(url, { headers: { Authorization: `Bearer ${userToken || botToken}` } }); if (!res.ok) throw new Error(`download ${f.name}: HTTP ${res.status}`); const dest = join(agent.stateDir, 'inbox', `${messageId}-${basename(f.name || f.id)}`); await pipeline(Readable.fromWeb(res.body), createWriteStream(dest)); out.push(dest) }
      return out
    },
    async history(chatId, limit) { const r = await (user || bot).conversations.history({ channel: chatId, limit: Math.min(limit, 15) }); const rows = []; for (const m of (r.messages || []).reverse()) rows.push({ ts: new Date(Number(m.ts) * 1000).toISOString(), user: await userName(m.user), text: m.text || '' }); return rows },
    async stop() { await socket.disconnect().catch(() => {}) },
  }
}

runChannel(async agent => {
  const cfg = agent.config
  const listen = new Set(cfg.listen || ['dm', 'mention'])
  listen.add('dm')
  const watch = new Set(cfg.watch_channels || [])
  return cfg.backend === 'app' ? appBackend(agent, cfg, listen, watch) : sessionBackend(agent, cfg, listen, watch)
})
