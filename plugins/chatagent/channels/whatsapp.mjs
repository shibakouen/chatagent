#!/usr/bin/env node
// WhatsApp channel. Two backends:
//
//   bridge   reuse a running lharries/whatsapp-mcp Go bridge (whatsmeow). Reads its
//            SQLite store read-only and sends through its local REST API. Nothing new
//            to pair, and only one WhatsApp linked device in play.
//   baileys  a linked device of its own via @whiskeysockets/baileys. Pair once with
//            `chatagent whatsapp-login <agent>` (QR code), then this server reuses it.
//
// Both are unofficial WhatsApp Web clients. WhatsApp's terms bar automated use of
// personal accounts, so the account can be restricted. The official route is the
// WhatsApp Business Cloud API with a business number (see references/platforms/whatsapp.md).
//
// The owner's control chat is "Message yourself". Messages the agent writes there
// start with a robot marker so it never reads its own output back as an instruction.
//
// agent.json config:
//   backend          "bridge" | "baileys"
//   bridge_dir       path to whatsapp-bridge (default ~/whatsapp-mcp/whatsapp-bridge)
//   bridge_url       default http://127.0.0.1:8080/api
//   listen           ["dms"] or ["dms", "groups"]

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { runChannel } from './lib/core.mjs'
import { readJson, writeJson } from './lib/agent.mjs'

const MARK = '🤖 '

const bare = jid => {
  if (!jid) return ''
  const [user, server] = jid.split('@')
  return `${user.split(':')[0]}@${server}`
}

function bridgeBackend(agent) {
  const dir = (agent.config.bridge_dir || join(homedir(), 'whatsapp-mcp', 'whatsapp-bridge')).replace(/^~/, homedir())
  const api = agent.config.bridge_url || 'http://127.0.0.1:8080/api'
  const msgDb = new DatabaseSync(join(dir, 'store', 'messages.db'), { readOnly: true })
  const waDb = new DatabaseSync(join(dir, 'store', 'whatsapp.db'), { readOnly: true })
  const wmPath = join(agent.stateDir, 'whatsapp-watermark.json')

  const dev = waDb.prepare('select jid, lid from whatsmeow_device limit 1').get()
  if (!dev) throw new Error(`no linked device in ${dir}/store/whatsapp.db; is the bridge paired?`)
  const selfPn = bare(dev.jid)
  const selfLid = dev.lid ? bare(dev.lid) : null
  const isSelf = jid => jid === selfPn || (selfLid && jid === selfLid)

  const nameOf = jid => {
    try {
      const pn = jid.endsWith('@lid') ? waDb.prepare('select pn from whatsmeow_lid_map where lid = ?').get(jid.split('@')[0])?.pn : null
      const key = pn ? `${pn}@s.whatsapp.net` : jid
      const c = waDb.prepare('select full_name, push_name, business_name from whatsmeow_contacts where their_jid = ?').get(key)
      if (c) return c.full_name || c.push_name || c.business_name
      const chat = msgDb.prepare('select name from chats where jid = ?').get(jid)
      return chat?.name || jid.split('@')[0]
    } catch { return jid.split('@')[0] }
  }

  return {
    selfJid: selfPn,
    isSelf,
    nameOf,
    async poll(onRow) {
      const max = msgDb.prepare('select max(rowid) as m from messages').get().m || 0
      const saved = readJson(wmPath, {}).rowid
      // Replay a short gap after a restart; jump ahead after a long one so a
      // restart never floods the agent with a day of old messages.
      let mark = saved && max - saved <= 50 ? saved : max
      const stmt = msgDb.prepare('select rowid, id, chat_jid, sender, content, timestamp, is_from_me, media_type, filename from messages where rowid > ? order by rowid limit 200')
      const tick = async () => {
        try {
          for (const r of stmt.all(mark)) {
            mark = r.rowid
            await onRow(r)
          }
          writeJson(wmPath, { rowid: mark })
        } catch (err) {
          agent.log('error', 'poll failed', { err: String(err) })
        }
      }
      return setInterval(tick, 1500)
    },
    async send(jid, text, files = []) {
      const post = async body => {
        const res = await fetch(`${api}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        const j = await res.json().catch(() => ({}))
        if (!res.ok || j.success === false) throw new Error(`bridge send failed: ${j.message || res.status}`)
        return j
      }
      if (files.length) {
        // The bridge sends one file per message, with the text as its caption.
        for (const [i, f] of files.entries()) await post({ recipient: jid, message: i === 0 ? text : '', media_path: f })
        return {}
      }
      await post({ recipient: jid, message: text })
      return {}
    },
    async download(jid, messageId) {
      const res = await fetch(`${api}/download`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message_id: messageId, chat_jid: jid }) })
      const j = await res.json().catch(() => ({}))
      if (!j.success) throw new Error(`bridge download failed: ${j.message || res.status}`)
      return [j.path]
    },
  }
}

async function baileysBackend(agent) {
  let B
  try {
    B = await import('@whiskeysockets/baileys')
  } catch {
    throw new Error('Baileys is not installed. Run: chatagent setup --with whatsapp')
  }
  const makeWASocket = B.default?.default || B.default || B.makeWASocket
  const authDir = join(agent.stateDir, 'baileys-auth')
  if (!existsSync(join(authDir, 'creds.json'))) throw new Error(`not paired yet. Run: chatagent whatsapp-login ${agent.name}`)
  mkdirSync(authDir, { recursive: true })
  const { state, saveCreds } = await B.useMultiFileAuthState(authDir)
  const silent = { level: 'silent', child() { return silent }, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} }
  let sock
  let handler = null
  const names = new Map()

  const connect = () => {
    sock = makeWASocket({ auth: state, logger: silent, printQRInTerminal: false, markOnlineOnConnect: false, syncFullHistory: false })
    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', u => {
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode
        if (code === B.DisconnectReason.loggedOut) agent.log('error', 'whatsapp logged out; pair again with chatagent whatsapp-login')
        else setTimeout(connect, 3000)
      }
    })
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' || !handler) return
      for (const m of messages) {
        const text = m.message?.conversation || m.message?.extendedTextMessage?.text || m.message?.imageMessage?.caption || m.message?.documentMessage?.caption || ''
        const chat = m.key.remoteJid
        if (m.pushName && !m.key.fromMe) names.set(bare(m.key.participant || chat), m.pushName)
        await handler({
          id: m.key.id, chat_jid: chat, sender: m.key.participant || chat, content: text,
          timestamp: new Date(Number(m.messageTimestamp) * 1000).toISOString(),
          is_from_me: m.key.fromMe ? 1 : 0, media_type: m.message?.imageMessage ? 'image' : m.message?.documentMessage ? 'document' : null,
        })
      }
    })
  }
  connect()
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('whatsapp connection timed out')), 60_000)
    sock.ev.on('connection.update', u => { if (u.connection === 'open') { clearTimeout(t); resolve() } })
  })
  const selfJid = bare(sock.user.id)
  const selfLid = sock.user.lid ? bare(sock.user.lid) : null
  return {
    selfJid,
    isSelf: jid => jid === selfJid || (selfLid && jid === selfLid),
    nameOf: jid => names.get(bare(jid)) || jid.split('@')[0],
    async poll(onRow) { handler = onRow; return null },
    async send(jid, text, files = []) {
      if (!files.length) { const r = await sock.sendMessage(jid, { text }); return { message_id: r?.key?.id } }
      for (const [i, f] of files.entries()) {
        const isImage = /\.(png|jpe?g|webp|gif)$/i.test(f)
        await sock.sendMessage(jid, isImage ? { image: { url: f }, caption: i === 0 ? text : undefined } : { document: { url: f }, fileName: f.split('/').pop(), caption: i === 0 ? text : undefined })
      }
      return {}
    },
    stop() { sock?.end?.() },
  }
}

runChannel(async agent => {
  const cfg = agent.config
  const listen = new Set(cfg.listen || ['dms'])
  const be = cfg.backend === 'baileys' ? await baileysBackend(agent) : bridgeBackend(agent)
  let timer

  return {
    label: 'WhatsApp',
    supportsPairing: false, // the account holder is the owner; "Message yourself" is the control chat
    controlPrefix: MARK,
    extraInstructions: 'WhatsApp formatting: *bold*, _italic_, ~strike~. Keep messages short; people read them on a phone.',

    async start(onInbound, { setConnected, ensureOwner }) {
      ensureOwner({ user_id: be.selfJid, chat_id: be.selfJid, label: 'you (Message yourself)' })
      timer = await be.poll(async r => {
        const chat = r.chat_jid
        const self = be.isSelf(chat)
        const text = r.content || ''
        if (r.is_from_me) {
          // Only your own words in "Message yourself" reach the agent, and never its own output.
          if (!self || text.startsWith(MARK.trim())) return
        }
        const isGroup = chat.endsWith('@g.us')
        if (isGroup && !listen.has('groups')) return
        if (!isGroup && !self && !listen.has('dms')) return
        const senderJid = r.is_from_me ? be.selfJid : bare(isGroup ? r.sender : chat)
        await onInbound({
          chat_id: self ? be.selfJid : chat,
          message_id: r.id,
          user_id: r.is_from_me ? be.selfJid : senderJid,
          user: r.is_from_me ? 'you' : be.nameOf(senderJid),
          text,
          ts: r.timestamp,
          where: self ? 'Message yourself' : isGroup ? `group ${be.nameOf(chat)}` : `chat with ${be.nameOf(chat)}`,
          is_dm: !isGroup,
          attachments: r.media_type ? `${r.filename || r.media_type} (${r.media_type})` : undefined,
        })
      })
      setConnected(true)
    },

    send: (chatId, text, opts = {}) => be.send(chatId, text, opts.files || []),
    describe: chatId => (be.isSelf(chatId) ? 'you' : be.nameOf(chatId)),
    download: be.download ? (chatId, messageId) => be.download(chatId, messageId) : undefined,
    stop() { if (timer) clearInterval(timer); be.stop?.() },
  }
})
