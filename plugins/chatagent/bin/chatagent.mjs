#!/usr/bin/env node
// chatagent: create, run and supervise Claude Code agents that are connected
// to apps. The skill drives this; people can also use it by hand.
//
//   chatagent setup [--with whatsapp]          install the channel runtime in ~/.chatagent/runtime
//   chatagent new <agent> --channel slack[,inbox] [--official discord] [--persona "..."]
//                     [--signature "..."] [--allow-tool <tool>]... [--set channel.key=value]...
//   chatagent secret <agent> <KEY> [value]     store a credential (prompts when value is omitted)
//   chatagent pair <agent> <code>              make the person who sent <code> the owner
//   chatagent access <agent> <channel> [policy owner|allowlist|all] [allow <id>] [deny <id>]
//                                                [auto on|off] [auto-to <chat_id>]
//   chatagent start|stop|restart <agent>       run the agent in a detached tmux session
//   chatagent status [agent]                   what is running, connected, waiting
//   chatagent logs <agent> [channel] [-n 50]
//   chatagent attach <agent>                   print the command to watch the session live
//   chatagent always-on <agent> [--off]        keep it running across crashes and reboots
//   chatagent watch <agent> <source> --url U --items-path P [--method POST --body JSON
//                     --headers JSON --version-field F --title T --every 120 --install]
//                                                poll any JSON API and push changes to the inbox
//   chatagent event <agent> <source> <text>    push a test event into the inbox
//   chatagent chat <agent> <text>              talk to the agent through the local inbox chat
//   chatagent outbox <agent> [--wait 60]       read what the agent sent through the inbox
//   chatagent slack-manifest <agent>           print the Slack app manifest for this agent
//   chatagent whatsapp-login <agent>           pair a Baileys WhatsApp device by QR code
//   chatagent remove <agent>                   stop it and delete its folder

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, chmodSync, cpSync, rmSync, statSync, openSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { chatagentHome, agentDir, readJson, writeJson, parseEnvFile, serverName } from '../channels/lib/agent.mjs'
import { Access, DEFAULT_ACCESS } from '../channels/lib/access.mjs'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = chatagentHome()
const RUNTIME = join(HOME, 'runtime')
const BUNDLED = ['slack', 'whatsapp', 'inbox']
const OFFICIAL = ['discord', 'telegram', 'imessage']
const SESSION = name => `ca-${name}`
const WIN = process.platform === 'win32'

const die = (msg, code = 1) => { process.stderr.write(`chatagent: ${msg}\n`); process.exit(code) }
const say = msg => process.stdout.write(msg + '\n')

function which(bin) {
  const r = WIN
    ? spawnSync('where', [bin], { encoding: 'utf8' })
    : spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : null
}

function tmuxBin() {
  return which('tmux') || ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find(existsSync) || null
}

function claudeBin() {
  if (process.env.CHATAGENT_CLAUDE) return process.env.CHATAGENT_CLAUDE
  if (WIN) {
    const home = process.env.USERPROFILE || process.env.HOME || ''
    return [join(home, '.local', 'bin', 'claude.cmd'), join(home, 'AppData', 'Local', 'claude', 'claude.exe')].find(existsSync) || which('claude.cmd') || which('claude')
  }
  return [join(process.env.HOME, '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].find(existsSync) || which('claude')
}

function parseArgs(argv) {
  const pos = []
  const opt = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      const val = next === undefined || next.startsWith('--') ? true : (i++, next)
      if (opt[key] === undefined) opt[key] = val
      else opt[key] = [].concat(opt[key], val)
    } else if (a === '-n') {
      opt.n = argv[++i]
    } else pos.push(a)
  }
  return { pos, opt }
}

const list = v => (v === undefined || v === true ? [] : [].concat(v).flatMap(x => String(x).split(',')).map(s => s.trim()).filter(Boolean))

function loadTop(name) {
  const dir = agentDir(name)
  const top = readJson(join(dir, 'agent.json'), null)
  if (!top) die(`no agent named ${name}. Create it with: chatagent new ${name} --channel <slack|whatsapp|inbox>`)
  return { dir, top }
}

function channelsOf(top) {
  return Object.keys(top.channels || {})
}

// ---------------------------------------------------------------- setup

function cmdSetup(opt) {
  if (!which('node')) die('node is not on PATH')
  const major = Number(process.versions.node.split('.')[0])
  const minor = Number(process.versions.node.split('.')[1])
  if (major < 22 || (major === 22 && minor < 5)) die(`node ${process.versions.node} is too old; chatagent needs 22.5 or newer for node:sqlite`)
  mkdirSync(RUNTIME, { recursive: true })
  cpSync(join(PLUGIN_ROOT, 'channels'), join(RUNTIME, 'channels'), { recursive: true })
  cpSync(join(PLUGIN_ROOT, 'vendor'), join(RUNTIME, 'vendor'), { recursive: true })
  cpSync(join(PLUGIN_ROOT, 'bin'), join(RUNTIME, 'bin'), { recursive: true })
  cpSync(join(PLUGIN_ROOT, 'templates'), join(RUNTIME, 'templates'), { recursive: true })
  const pkg = readJson(join(PLUGIN_ROOT, 'package.json'), {})
  if (list(opt.with).includes('whatsapp')) {
    // Exact pins: these are unofficial clients and a surprise major version can break pairing.
    pkg.dependencies['@whiskeysockets/baileys'] = '7.0.0-rc14'
    pkg.dependencies['qrcode-terminal'] = '0.12.0'
  }
  const prev = readJson(join(RUNTIME, 'package.json'), {})
  for (const k of Object.keys(prev.dependencies || {})) if (!pkg.dependencies[k]) pkg.dependencies[k] = prev.dependencies[k]
  writeJson(join(RUNTIME, 'package.json'), pkg)
  say('Installing channel dependencies (npm, pinned versions)…')
  const r = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: RUNTIME, stdio: 'inherit' })
  if (r.status !== 0) die('npm install failed')
  chmodSync(join(RUNTIME, 'bin', 'chatagent.mjs'), 0o755)
  const checks = [
    ['node', process.versions.node],
    ['claude', claudeBin() || 'MISSING'],
    ['python', (WIN ? which('python') : which('python3')) || 'MISSING (needed for always-on and watchers)'],
    ['bun', which('bun') || 'not installed (only needed for the official Discord, Telegram and iMessage channels)'],
  ]
  if (WIN) checks.push(['runner', 'Windows: agents run as a detached process. Live-agent prompts need WSL or a one-time interactive launch; connectors, watchers and always-on run natively.'])
  else checks.splice(1, 0, ['tmux', tmuxBin() || 'MISSING (brew install tmux / apt install tmux)'])
  say(`\nRuntime ready at ${RUNTIME}`)
  for (const [k, v] of checks) say(`  ${k.padEnd(8)} ${v}`)
}

function requireRuntime() {
  if (!existsSync(join(RUNTIME, 'node_modules', '@modelcontextprotocol'))) die('runtime not installed. Run: chatagent setup')
}

// ---------------------------------------------------------------- new

function renderTemplate(file, vars) {
  let t = readFileSync(join(existsSync(join(RUNTIME, 'templates')) ? RUNTIME : PLUGIN_ROOT, 'templates', file), 'utf8')
  for (const [k, v] of Object.entries(vars)) t = t.split(`{{${k}}}`).join(v)
  return t
}

function writeAgentFiles(name, top) {
  const dir = agentDir(name)
  const kinds = channelsOf(top)
  const servers = {}
  const allow = new Set(top.allow_tools || [])
  for (const kind of kinds) {
    const sn = serverName(name, kind)
    servers[sn] = {
      command: process.execPath,
      // node:sqlite (WhatsApp bridge reads) prints an experimental warning on Node 22.
      args: ['--disable-warning=ExperimentalWarning', join(RUNTIME, 'channels', `${kind}.mjs`)],
      env: { CHATAGENT_AGENT_DIR: dir, CHATAGENT_CHANNEL: kind, CHATAGENT_HOME: HOME },
    }
    for (const t of ['reply', 'notify_owner', 'list_drafts', 'download_attachment', 'fetch_history']) allow.add(`mcp__${sn}__${t}`)
  }
  writeJson(join(dir, '.mcp.json'), { mcpServers: servers })
  mkdirSync(join(dir, '.claude'), { recursive: true })
  const settingsPath = join(dir, '.claude', 'settings.json')
  const settings = readJson(settingsPath, {})
  settings.enabledMcpjsonServers = Object.keys(servers)
  // Normal permission mode, so any tool outside the allow list is asked about in
  // the owner's control chat instead of being decided silently.
  settings.permissions = { defaultMode: top.permission_mode || 'default', ...(settings.permissions || {}), allow: [...allow] }
  writeJson(settingsPath, settings)

  const claudeMd = join(dir, 'CLAUDE.md')
  if (!existsSync(claudeMd)) {
    const how = kinds.map(k => `- ${k}: messages arrive tagged source="${serverName(name, k)}"`).concat((top.official || []).map(k => `- ${k}: the official ${k} channel plugin`)).join('\n')
    writeFileSync(claudeMd, renderTemplate('agent-CLAUDE.md', {
      name,
      persona: top.persona || `${name}, an assistant that works for its owner`,
      channels: how,
      approval: top.approval === 'auto'
        ? 'Replies to other people go out immediately. Be careful: nobody checks them first.'
        : 'Replies to anyone other than the owner are held as drafts until the owner approves them in the control chat. The tool result tells you when a reply was held; do not send it again.',
      signature: top.signature ? `Every reply to someone other than the owner ends with: ${top.signature} (the channel adds it for you).` : 'No sign-off is added.',
      instructions: top.instructions || 'Answer what people ask. When you are unsure, ask the owner with notify_owner before acting.',
    }))
  }
}

function cmdNew(name, opt) {
  if (!name || !/^[a-z0-9][a-z0-9-]{1,30}$/.test(name)) die('agent name must be lowercase letters, digits and hyphens, 2 to 31 characters')
  requireRuntime()
  const dir = agentDir(name)
  if (existsSync(join(dir, 'agent.json')) && !opt.force) die(`${name} already exists (use --force to rewrite its config)`)
  const kinds = list(opt.channel)
  const official = list(opt.official)
  for (const k of kinds) if (!BUNDLED.includes(k)) die(`unknown channel ${k}. Bundled: ${BUNDLED.join(', ')}. Official plugins go in --official: ${OFFICIAL.join(', ')}`)
  for (const k of official) if (!OFFICIAL.includes(k)) die(`unknown official channel ${k}. Known: ${OFFICIAL.join(', ')}`)
  if (!kinds.length && !official.length) die('pick at least one --channel or --official')

  const channels = {}
  for (const k of kinds) channels[k] = {}
  for (const s of list(opt.set)) {
    const m = /^([a-z]+)\.([a-z_]+)=(.*)$/.exec(s)
    if (!m || !channels[m[1]]) die(`--set must look like <channel>.<key>=<value> for a channel of this agent: ${s}`)
    let v = m[3]
    try { v = JSON.parse(v) } catch {}
    channels[m[1]][m[2]] = v
  }

  mkdirSync(join(dir, 'state'), { recursive: true })
  const top = {
    name,
    created: new Date().toISOString(),
    persona: typeof opt.persona === 'string' ? opt.persona : '',
    instructions: typeof opt.instructions === 'string' ? opt.instructions : '',
    signature: typeof opt.signature === 'string' ? opt.signature : '',
    approval: opt.approval === 'auto' ? 'auto' : 'owner',
    model: typeof opt.model === 'string' ? opt.model : '',
    // Remember the Claude profile the agent was created from, so a supervisor
    // that restarts it later still uses the same login.
    claude_config_dir: process.env.CLAUDE_CONFIG_DIR || '',
    allow_tools: list(opt['allow-tool']),
    official,
    channels,
  }
  writeJson(join(dir, 'agent.json'), top)

  const secretsPath = join(dir, 'secrets.env')
  if (!existsSync(secretsPath)) writeFileSync(secretsPath, '# chatagent secrets for this agent. Mode 600. Never commit.\n', { mode: 0o600 })
  if (kinds.includes('inbox')) setSecret(name, 'INBOX_TOKEN', randomBytes(24).toString('hex'), true)
  for (const k of kinds) {
    const acc = new Access(join(dir, 'state', k))
    mkdirSync(join(dir, 'state', k), { recursive: true })
    if (!existsSync(acc.path)) acc.save({ ...DEFAULT_ACCESS, auto_send: top.approval === 'auto' })
  }
  writeAgentFiles(name, top)
  say(`Created agent ${name} at ${dir}`)
  const needs = []
  if (kinds.includes('slack')) {
    if (channels.slack.backend === 'app') needs.push(`Slack (app backend): chatagent slack-manifest ${name}, create the app from it, then store SLACK_APP_TOKEN and SLACK_BOT_TOKEN (and SLACK_USER_TOKEN for post_as=user or my_dms)`)
    else needs.push(`Slack: nothing to set up. It uses the Slack login already in your browser or Slack app${channels.slack.workspace ? ` (workspace "${channels.slack.workspace}")` : ''}. Be signed into Slack in Chrome, Brave, Edge, Arc or the Slack desktop app.`)
  }
  if (kinds.includes('whatsapp') && channels.whatsapp.backend === 'baileys') needs.push(`WhatsApp: chatagent setup --with whatsapp, then chatagent whatsapp-login ${name}`)
  for (const k of official) needs.push(`${k}: install the official plugin (/plugin install ${k}@claude-plugins-official) and configure its token, per references/platforms/${k}.md`)
  if (needs.length) { say('\nStill needed before start:'); for (const n of needs) say(`  - ${n}`) }
  say(`\nThen: chatagent start ${name}`)
}

// ---------------------------------------------------------------- secrets, pairing, access

function setSecret(name, key, value, quiet) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) die('secret names are UPPER_SNAKE_CASE')
  const path = join(agentDir(name), 'secrets.env')
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(l => !l.startsWith(`${key}=`)) : []
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  lines.push(`${key}=${value}`, '')
  writeFileSync(path, lines.join('\n'), { mode: 0o600 })
  chmodSync(path, 0o600)
  if (!quiet) say(`Stored ${key} for ${name} (${path}, mode 600). Restart the agent for it to take effect.`)
}

async function cmdSecret(name, key, value) {
  loadTop(name)
  if (!key) die('usage: chatagent secret <agent> <KEY> [value]')
  if (value === undefined) {
    if (!process.stdin.isTTY) {
      value = readFileSync(0, 'utf8').trim()
    } else {
      process.stdout.write(`${key}: `)
      value = await new Promise(res => {
        const rl = createInterface({ input: process.stdin, output: null, terminal: true })
        rl.question('', v => { rl.close(); process.stdout.write('\n'); res(v.trim()) })
      })
    }
  }
  if (!value) die('empty value')
  setSecret(name, key, value)
}

function cmdPair(name, code) {
  const { dir, top } = loadTop(name)
  if (!code) die('usage: chatagent pair <agent> <code>')
  for (const k of channelsOf(top)) {
    const acc = new Access(join(dir, 'state', k))
    if (acc.load().pending?.[code]) {
      const owner = acc.pair(code)
      say(`Paired. ${owner.label} (${owner.user_id}) now owns ${name} on ${k}.`)
      return
    }
  }
  die(`no pending pairing with code ${code}. Codes expire after 10 minutes; message the agent again.`)
}

function cmdAccess(name, kind, rest) {
  const { dir, top } = loadTop(name)
  if (!kind || !channelsOf(top).includes(kind)) die(`usage: chatagent access <agent> <${channelsOf(top).join('|')}> [...]`)
  const acc = new Access(join(dir, 'state', kind))
  const a = acc.load()
  for (let i = 0; i < rest.length; i += 2) {
    const [k, v] = [rest[i], rest[i + 1]]
    if (k === 'policy' && ['owner', 'allowlist', 'all'].includes(v)) a.policy = v
    else if (k === 'allow' && v) a.allow = [...new Set([...a.allow, v])]
    else if (k === 'deny' && v) a.allow = a.allow.filter(x => x !== v)
    else if (k === 'auto' && ['on', 'off'].includes(v)) a.auto_send = v === 'on'
    else if (k === 'auto-to' && v) a.auto_send_to = [...new Set([...a.auto_send_to, v])]
    else if (k === 'reset-owner' ) { a.owner = null; i-- }
    else die(`unknown access change: ${k} ${v ?? ''}`)
  }
  if (rest.length) acc.save(a)
  const { pending, ...shown } = a
  say(JSON.stringify({ ...shown, pending_pairings: Object.keys(pending || {}).length, drafts_waiting: Object.keys(acc.drafts()).length }, null, 2))
}

// ---------------------------------------------------------------- run

function tmux(...args) {
  const bin = tmuxBin()
  if (!bin) die('tmux is required (brew install tmux / apt install tmux)')
  return spawnSync(bin, args, { encoding: 'utf8' })
}

// On Windows there is no tmux, so an agent runs as a detached background process
// tracked by a pidfile under its state dir. macOS and Linux use tmux.
function pidFile(name) {
  return join(agentDir(name), 'state', 'agent.pid')
}

function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

function winRunning(name) {
  const rec = readJson(pidFile(name), null)
  return Boolean(rec && pidAlive(rec.pid))
}

function isRunning(name) {
  if (WIN) return winRunning(name)
  return tmux('has-session', '-t', SESSION(name)).status === 0
}

function launchCommand(name, top) {
  const claude = claudeBin()
  if (!claude) die('claude is not installed or not on PATH')
  const dev = channelsOf(top).map(k => `server:${serverName(name, k)}`)
  const official = (top.official || []).map(k => `plugin:${k}@claude-plugins-official`)
  const args = [claude]
  if (dev.length) args.push('--dangerously-load-development-channels', ...dev)
  if (official.length) args.push('--channels', ...official)
  if (top.model) args.push('--model', top.model)
  if (top.extra_args) args.push(...top.extra_args)
  return args
}

const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`

// Dialogs a fresh unattended session can stop on, and the key that accepts the
// safe answer. Each one is something the owner already chose by creating the agent.
const DIALOGS = [
  // The trust prompt defaults to "No, exit", so move down to "Yes, I trust this folder" first.
  { re: /Yes, I trust this folder/i, keys: ['Down', 'Enter'], what: 'folder trust' },
  { re: /I am using this for local development/i, keys: ['Enter'], what: 'development channel warning' },
  { re: /new MCP servers? found|Use this and all future MCP servers|enable.*mcp/i, keys: ['Enter'], what: 'project MCP servers' },
]

function capture(name) {
  return tmux('capture-pane', '-t', SESSION(name), '-p', '-S', '-60').stdout || ''
}

async function waitForReady(name, seconds = 90) {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const answered = []
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    await sleep(1500)
    if (!isRunning(name)) return { ok: false, answered, pane: '', reason: 'session exited' }
    const pane = capture(name)
    const d = DIALOGS.find(x => x.re.test(pane) && !answered.includes(x.what))
    if (d) {
      for (const k of d.keys) { tmux('send-keys', '-t', SESSION(name), k); await sleep(400) }
      answered.push(d.what)
      continue
    }
    // The prompt box with no dialog on screen means the session is listening.
    if (/(^|\n)\s*[>❯]\s/.test(pane) && !DIALOGS.some(x => x.re.test(pane.split('\n').slice(-15).join('\n')))) {
      return { ok: true, answered, pane }
    }
  }
  return { ok: false, answered, pane: capture(name), reason: 'timed out waiting for the prompt' }
}

// Windows: start the agent as a detached process, log to state/session.log, and
// record its pid. The one-time trust and development-channel prompts cannot be
// auto-answered without a terminal, so the owner pre-approves them (see below) or
// runs the live agent under WSL, where the tmux path applies.
async function winStart(name, dir, top, opt) {
  const argv = launchCommand(name, top)
  const env = { ...process.env }
  const cfgDir = top.claude_config_dir || process.env.CLAUDE_CONFIG_DIR
  if (cfgDir) env.CLAUDE_CONFIG_DIR = cfgDir
  for (const k of top.official || []) env[`${k.toUpperCase()}_STATE_DIR`] = join(dir, 'state', k)
  const logPath = join(dir, 'state', 'session.log')
  const out = openSync(logPath, 'a')
  const child = spawn(argv[0], argv.slice(1), { cwd: dir, detached: true, windowsHide: true, stdio: ['ignore', out, out], env })
  writeJson(pidFile(name), { pid: child.pid, started: new Date().toISOString() })
  child.unref()
  const startedAt = Date.now()
  const pendingKinds = new Set(channelsOf(top))
  const deadline = Date.now() + (Number(opt.timeout) || 90) * 1000
  while (pendingKinds.size && Date.now() < deadline) {
    if (!pidAlive(child.pid)) {
      say(`${name} exited at startup. Check ${logPath}. On Windows the first run may need the folder-trust and development-channel prompts answered once in an interactive terminal, or run the live agent under WSL.`)
      return false
    }
    for (const k of pendingKinds) {
      const hb = readJson(join(dir, 'state', k, 'heartbeat.json'), null)
      if (hb && Date.parse(hb.ts) >= startedAt - 2000 && hb.connected) pendingKinds.delete(k)
    }
    if (pendingKinds.size) await new Promise(r => setTimeout(r, 1000))
  }
  if (pendingKinds.size) {
    say(`${name} started (pid ${child.pid}) but these channels have not connected: ${[...pendingKinds].join(', ')}. See ${logPath}; a one-time prompt may be waiting. Logs: chatagent logs ${name}`)
    return false
  }
  say(`${name} is running (pid ${child.pid}). Logs: ${logPath}`)
  return true
}

async function cmdStart(name, opt = {}) {
  const { dir, top } = loadTop(name)
  requireRuntime()
  if (isRunning(name)) { say(`${name} is already running${WIN ? '' : ` (tmux session ${SESSION(name)})`}`); return true }
  writeAgentFiles(name, top) // keep paths current if the runtime moved
  if (WIN) return winStart(name, dir, top, opt)
  // tmux sessions inherit the tmux server's environment, not ours, so pass on
  // which Claude profile to use explicitly.
  const env = { ...Object.fromEntries((top.official || []).map(k => [`${k.toUpperCase()}_STATE_DIR`, join(dir, 'state', k)])) }
  const cfgDir = top.claude_config_dir || process.env.CLAUDE_CONFIG_DIR
  if (cfgDir) env.CLAUDE_CONFIG_DIR = cfgDir
  const envPrefix = Object.entries(env).map(([k, v]) => `${k}=${shq(v)}`).join(' ')
  const cmd = `${envPrefix ? `env ${envPrefix} ` : ''}${launchCommand(name, top).map(shq).join(' ')}`
  const r = tmux('new-session', '-d', '-s', SESSION(name), '-x', '200', '-y', '50', '-c', dir, cmd)
  if (r.status !== 0) die(`tmux could not start: ${r.stderr}`)
  const startedAt = Date.now()
  const res = await waitForReady(name, Number(opt.timeout) || 90)
  if (res.answered.length) say(`Accepted startup prompts: ${res.answered.join(', ')}`)
  if (!res.ok) {
    say(`${name} did not reach a ready prompt: ${res.reason}. Last screen:\n${res.pane.split('\n').slice(-25).join('\n')}`)
    return false
  }
  // The prompt can appear before the channel servers finish connecting. Wait
  // for each one to write a fresh heartbeat that says it is connected.
  const pendingKinds = new Set(channelsOf(top))
  const hbDeadline = Date.now() + 45_000
  while (pendingKinds.size && Date.now() < hbDeadline) {
    for (const k of pendingKinds) {
      const hb = readJson(join(dir, 'state', k, 'heartbeat.json'), null)
      if (hb && Date.parse(hb.ts) >= startedAt - 2000 && hb.connected) pendingKinds.delete(k)
    }
    if (pendingKinds.size) await new Promise(r => setTimeout(r, 1000))
  }
  if (pendingKinds.size) {
    say(`${name} started, but these channels have not connected: ${[...pendingKinds].join(', ')}. Check: chatagent logs ${name}`)
    return false
  }
  say(`${name} is running in tmux session ${SESSION(name)}. Watch it with: ${tmuxBin()} attach -t ${SESSION(name)}`)
  return true
}

function cmdStop(name) {
  loadTop(name)
  if (!isRunning(name)) { say(`${name} is not running`); return }
  if (WIN) {
    const rec = readJson(pidFile(name), null)
    try { process.kill(rec.pid) } catch {}
    rmSync(pidFile(name), { force: true })
    say(`Stopped ${name}`)
    return
  }
  tmux('kill-session', '-t', SESSION(name))
  say(`Stopped ${name}`)
}

function ago(iso) {
  if (!iso) return 'never'
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000)
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`
}

function cmdStatus(name) {
  const names = name ? [name] : existsSync(join(HOME, 'agents')) ? readdirSync(join(HOME, 'agents')) : []
  if (!names.length) { say('No agents yet. Create one with: chatagent new <name> --channel <slack|whatsapp|inbox>'); return }
  for (const n of names) {
    const { dir, top } = loadTop(n)
    say(`${n}: ${isRunning(n) ? 'running' : 'stopped'}${top.official?.length ? `  official: ${top.official.join(', ')}` : ''}`)
    for (const k of channelsOf(top)) {
      const hb = readJson(join(dir, 'state', k, 'heartbeat.json'), null)
      const acc = new Access(join(dir, 'state', k))
      const a = acc.load()
      say(`  ${k.padEnd(9)} ${hb ? (hb.connected ? 'connected' : 'NOT connected') : 'no heartbeat'}  heartbeat ${ago(hb?.ts)}  in ${hb?.inbound ?? 0} out ${hb?.outbound ?? 0}  owner ${a.owner ? a.owner.label || a.owner.user_id : 'not paired'}  policy ${a.policy}  drafts ${Object.keys(acc.drafts()).length}`)
    }
  }
}

function cmdLogs(name, kind, opt) {
  const { dir, top } = loadTop(name)
  const kinds = kind ? [kind] : channelsOf(top)
  const n = Number(opt.n) || 40
  for (const k of kinds) {
    const p = join(dir, 'state', k, 'channel.log')
    say(`== ${k} (${p})`)
    if (existsSync(p)) say(readFileSync(p, 'utf8').trim().split('\n').slice(-n).join('\n'))
  }
}

// ---------------------------------------------------------------- inbox helpers

function inboxCall(name, method, path, body) {
  const { dir, top } = loadTop(name)
  if (!top.channels?.inbox) die(`${name} has no inbox channel`)
  const port = top.channels.inbox.inbox_port || 8790
  const token = parseEnvFile(join(dir, 'secrets.env')).INBOX_TOKEN
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-chatagent-token': token },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))
}

async function cmdOutbox(name, opt) {
  const wait = Number(opt.wait) || 0
  const after = Number(opt.after) || 0
  const deadline = Date.now() + wait * 1000
  for (;;) {
    const r = await inboxCall(name, 'GET', `/outbox?after=${after}`)
    if (r.body.messages?.length || Date.now() > deadline) {
      say(JSON.stringify(r.body, null, 2))
      return
    }
    await new Promise(res => setTimeout(res, 2000))
  }
}

// ---------------------------------------------------------------- always-on

function daemonctl(args) {
  const py = which('python3')
  if (!py) die('python3 is required for always-on')
  const script = join(existsSync(join(RUNTIME, 'vendor')) ? RUNTIME : PLUGIN_ROOT, 'vendor', 'daemonctl', 'daemonctl.py')
  return spawnSync(py, [script, ...args], { encoding: 'utf8' })
}

function cmdAlwaysOn(name, opt) {
  loadTop(name)
  const slug = `chatagent-`
  if (opt.off) {
    const r = daemonctl(['uninstall', slug])
    say(r.stdout || r.stderr)
    return
  }
  let r = daemonctl(['new', slug, '--mode', 'service', '--interval', '30', '--name', `chatagent ${name}`,
    '--description', `Keeps the chatagent agent ${name} running in tmux`, '--set', `agent=${name}`,
    '--set', `cli=${join(RUNTIME, 'bin', 'chatagent.mjs')}`, '--set', `node=${process.execPath}`, '--force'])
  if (r.status !== 0) die(r.stderr || r.stdout)
  const daemonHome = process.env.DAEMON_AGENT_HOME || join(process.env.HOME, '.daemon-agent')
  const workerPath = join(daemonHome, 'daemons', slug, 'worker.py')
  const tpl = readFileSync(join(existsSync(join(RUNTIME, 'templates')) ? RUNTIME : PLUGIN_ROOT, 'templates', 'keepalive_worker.py'), 'utf8')
  writeFileSync(workerPath, tpl, { mode: 0o755 })
  if (opt['dry-run']) { say(`Prepared ${workerPath}. Not installed (dry run). Test it with: python3 ${workerPath} --echo`); return }
  r = daemonctl(['install', slug])
  say(r.stdout || r.stderr)
  if (r.status !== 0) die('install failed; run: chatagent always-on ' + name + ' --dry-run and test the worker by hand')
  r = daemonctl(['verify', slug])
  say(r.stdout || r.stderr)
}

// A watcher polls any JSON API (REST or GraphQL) and turns new or changed items
// into inbox events, so the agent can react to apps that have no push channel.
function cmdWatch(name, source, opt) {
  const { top } = loadTop(name)
  if (!top.channels?.inbox) die(`${name} needs the inbox channel for watchers. Recreate it with --channel inbox (plus any others).`)
  if (!source || !/^[a-z0-9-]{2,20}$/.test(source)) die('usage: chatagent watch <agent> <source-name> --url ... --items-path ... [options]')
  const slug = `cawatch-${name}-${source}`
  if (opt.off) { const r = daemonctl(['uninstall', slug]); say(r.stdout || r.stderr); return }
  if (typeof opt.url !== 'string') die('--url is required')
  if (typeof opt['items-path'] !== 'string') die('--items-path is required (dotted path to the list of items)')
  const sets = {
    agent: name, source, url: opt.url, method: opt.method || 'GET',
    items_path: opt['items-path'], id_field: opt['id-field'] || 'id', version_field: opt['version-field'] || '',
    title_template: opt.title || '{id}', url_field: opt['url-field'] || '', first_run: opt['first-run'] || 'skip',
  }
  if (typeof opt.body === 'string') sets.body = opt.body
  if (typeof opt.headers === 'string') sets.headers = opt.headers
  const args = ['new', slug, '--mode', 'interval', '--interval', String(Number(opt.every) || 120), '--name', `chatagent watch ${source} for ${name}`,
    '--description', `Polls ${source} and posts changes to chatagent agent ${name}`, '--force']
  for (const [k, v] of Object.entries(sets)) args.push('--set', `${k}=${v}`)
  let r = daemonctl(args)
  if (r.status !== 0) die(r.stderr || r.stdout)
  const daemonHome = process.env.DAEMON_AGENT_HOME || join(process.env.HOME, '.daemon-agent')
  const workerPath = join(daemonHome, 'daemons', slug, 'worker.py')
  writeFileSync(workerPath, readFileSync(join(existsSync(join(RUNTIME, 'templates')) ? RUNTIME : PLUGIN_ROOT, 'templates', 'watch_worker.py'), 'utf8'), { mode: 0o755 })
  const refs = [...String(sets.headers || '').matchAll(/\$\{([A-Z0-9_]+)\}/g)].map(m => m[1])
  say(`Prepared watcher ${slug}.`)
  if (refs.length) say(`Store its credentials first: python3 ${join(RUNTIME, 'vendor', 'daemonctl', 'daemonctl.py')} secret set ${refs[0]} <value>`)
  say(`Test one pass in the foreground: python3 ${join(RUNTIME, 'vendor', 'daemonctl', 'daemonctl.py')} run-once ${slug}`)
  if (opt.install) {
    r = daemonctl(['install', slug]); say(r.stdout || r.stderr)
    r = daemonctl(['verify', slug]); say(r.stdout || r.stderr)
  } else {
    say(`Install it so it runs every ${Number(opt.every) || 120}s: chatagent watch ${name} ${source} --install (with the same options)`)
  }
}

// ---------------------------------------------------------------- platform helpers

function cmdSlackManifest(name) {
  const { top } = loadTop(name)
  const c = top.channels?.slack || {}
  const listen = new Set(c.listen || ['dm', 'mention'])
  const asUser = c.post_as === 'user' || listen.has('my_dms')
  const manifest = {
    display_information: { name: top.persona?.split(',')[0]?.slice(0, 35) || name, description: `Claude Code agent ${name}, connected by chatagent` },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: name, always_online: true },
    },
    oauth_config: {
      scopes: {
        bot: ['app_mentions:read', 'chat:write', 'im:history', 'im:read', 'im:write', 'users:read', 'files:read', 'files:write', 'channels:read', 'groups:read', 'channels:history', 'groups:history'],
        ...(asUser ? { user: ['chat:write', 'im:history', 'im:read', 'mpim:history', 'mpim:read', 'users:read', 'files:read', 'files:write', 'channels:history', 'groups:history', 'channels:read', 'groups:read'] } : {}),
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: ['app_mention', 'message.im', ...(listen.has('channels') ? ['message.channels', 'message.groups'] : [])],
        ...(asUser ? { user_events: ['message.im', 'message.mpim'] } : {}),
      },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  }
  say(JSON.stringify(manifest, null, 2))
  process.stderr.write([
    '',
    'Create the app: https://api.slack.com/apps → Create New App → From a manifest → pick the workspace → paste the JSON above.',
    'Then: Basic Information → App-Level Tokens → Generate, scope connections:write → that is SLACK_APP_TOKEN (xapp-…).',
    `Install to workspace → OAuth & Permissions → Bot User OAuth Token is SLACK_BOT_TOKEN (xoxb-…)${asUser ? ', User OAuth Token is SLACK_USER_TOKEN (xoxp-…)' : ''}.`,
    `Store each: chatagent secret ${name} SLACK_APP_TOKEN   (it prompts, so the token stays out of shell history)`,
    '',
  ].join('\n'))
}

async function cmdWhatsappLogin(name) {
  const { dir, top } = loadTop(name)
  if (!top.channels?.whatsapp) die(`${name} has no whatsapp channel`)
  let B, qr
  try {
    B = await import(join(RUNTIME, 'node_modules', '@whiskeysockets', 'baileys', 'lib', 'index.js'))
    qr = (await import(join(RUNTIME, 'node_modules', 'qrcode-terminal', 'lib', 'main.js'))).default
  } catch (err) {
    die(`Baileys is not installed. Run: chatagent setup --with whatsapp (${err.message})`)
  }
  const makeWASocket = B.default?.default || B.default || B.makeWASocket
  const authDir = join(dir, 'state', 'whatsapp', 'baileys-auth')
  mkdirSync(authDir, { recursive: true })
  const silent = { level: 'silent', child() { return silent }, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} }
  const run = () => new Promise(async (resolveRun, reject) => {
    const { state, saveCreds } = await B.useMultiFileAuthState(authDir)
    const sock = makeWASocket({ auth: state, logger: silent, printQRInTerminal: false })
    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', u => {
      if (u.qr) { say('Scan with WhatsApp → Settings → Linked devices → Link a device:'); qr.generate(u.qr, { small: true }) }
      if (u.connection === 'open') { say(`Linked as ${sock.user?.id}. You can start the agent now.`); setTimeout(() => { sock.end?.(); resolveRun(true) }, 3000) }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode
        if (code === B.DisconnectReason.restartRequired) resolveRun(false) // normal after the first scan
        else if (code === B.DisconnectReason.loggedOut) reject(new Error('logged out'))
        else resolveRun(false)
      }
    })
  })
  for (let i = 0; i < 3; i++) if (await run()) return
  die('pairing did not complete')
}

function cmdRemove(name, opt) {
  const { dir } = loadTop(name)
  if (!opt.yes) die(`this deletes ${dir}, including its secrets and pairing. Re-run with --yes to confirm.`)
  if (isRunning(name)) tmux('kill-session', '-t', SESSION(name))
  daemonctl(['uninstall', `chatagent-`])
  rmSync(dir, { recursive: true, force: true })
  say(`Removed ${name}`)
}

// ---------------------------------------------------------------- main

const [, , cmd, ...rest] = process.argv
const { pos, opt } = parseArgs(rest)
const main = async () => {
  switch (cmd) {
    case 'setup': return cmdSetup(opt)
    case 'new': return cmdNew(pos[0], opt)
    case 'secret': return cmdSecret(pos[0], pos[1], pos[2])
    case 'pair': return cmdPair(pos[0], pos[1])
    case 'access': return cmdAccess(pos[0], pos[1], pos.slice(2))
    case 'start': { const ok = await cmdStart(pos[0], opt); process.exitCode = ok ? 0 : 2; return }
    case 'stop': return cmdStop(pos[0])
    case 'restart': cmdStop(pos[0]); { const ok = await cmdStart(pos[0], opt); process.exitCode = ok ? 0 : 2; return }
    case 'status': return cmdStatus(pos[0])
    case 'logs': return cmdLogs(pos[0], pos[1], opt)
    case 'attach': loadTop(pos[0]); return say(WIN ? `Watch the log: type ${join(agentDir(pos[0]), 'state', 'session.log')}` : `${tmuxBin()} attach -t ${SESSION(pos[0])}`)
    case 'always-on': return cmdAlwaysOn(pos[0], opt)
    case 'watch': return cmdWatch(pos[0], pos[1], opt)
    case 'event': { const r = await inboxCall(pos[0], 'POST', '/event', { source: pos[1], text: pos.slice(2).join(' ') }); return say(JSON.stringify(r)) }
    case 'chat': { const r = await inboxCall(pos[0], 'POST', '/chat', { text: pos.slice(1).join(' ') }); return say(JSON.stringify(r)) }
    case 'outbox': return cmdOutbox(pos[0], opt)
    case 'slack-manifest': return cmdSlackManifest(pos[0])
    case 'whatsapp-login': return cmdWhatsappLogin(pos[0])
    case 'remove': return cmdRemove(pos[0], opt)
    case undefined: case 'help': case '--help': case '-h':
      return say(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).slice(0, 30).map(l => l.slice(3)).join('\n'))
    default: die(`unknown command ${cmd}. Try: chatagent help`)
  }
}
main().catch(err => die(err.stack || String(err)))
