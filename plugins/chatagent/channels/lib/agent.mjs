// Loads one chatagent agent: its folder, config, secrets and log.
// Every channel server is started with CHATAGENT_AGENT_DIR pointing at
// ~/.chatagent/agents/<name>. Nothing here ever writes to stdout, because
// stdout belongs to the MCP transport.

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export function chatagentHome() {
  return process.env.CHATAGENT_HOME || join(homedir(), '.chatagent')
}

export function agentDir(name) {
  return join(chatagentHome(), 'agents', name)
}

export function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

// Atomic write: a crash mid-write never leaves half a JSON file behind.
export function writeJson(path, value, mode) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', mode ? { mode } : undefined)
  renameSync(tmp, path)
}

// KEY=value lines. Quotes around the value are optional.
export function parseEnvFile(path) {
  const out = {}
  if (!existsSync(path)) return out
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[line.slice(0, eq).trim()] = value
  }
  return out
}

// An agent can hold several channels (say Slack to talk to its owner, plus the
// inbox for Linear events). Each channel server gets its own state folder and
// sees the agent's top-level settings merged with its own block from
// agent.json "channels".
export function loadAgent(dir = process.env.CHATAGENT_AGENT_DIR, kind = process.env.CHATAGENT_CHANNEL) {
  if (!dir) throw new Error('CHATAGENT_AGENT_DIR is not set; start this server through chatagent')
  if (!kind) throw new Error('CHATAGENT_CHANNEL is not set; start this server through chatagent')
  const top = readJson(join(dir, 'agent.json'), null)
  if (!top) throw new Error(`no agent.json in ${dir}`)
  const { channels = {}, ...rest } = top
  const config = { ...rest, ...(channels[kind] || {}), kind }
  const stateDir = join(dir, 'state', kind)
  mkdirSync(join(stateDir, 'inbox'), { recursive: true })

  // Shell environment wins over the secrets file, so a one-off override is easy.
  const fileSecrets = parseEnvFile(join(dir, 'secrets.env'))
  const secret = (key, required = true) => {
    const v = process.env[key] ?? fileSecrets[key]
    if ((v === undefined || v === '') && required) {
      throw new Error(`missing secret ${key}. Store it with: chatagent secret ${config.name} ${key}`)
    }
    return v ?? ''
  }

  const logPath = join(stateDir, 'channel.log')
  const log = (level, msg, fields = {}) => {
    try {
      if (existsSync(logPath) && statSync(logPath).size > 5 * 1024 * 1024) renameSync(logPath, `${logPath}.1`)
      appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + '\n')
    } catch {}
    if (level === 'error') process.stderr.write(`chatagent ${config.name}: ${msg} ${JSON.stringify(fields)}\n`)
  }

  return { dir, stateDir, config, name: config.name, kind, serverName: serverName(config.name, kind), secret, log }
}

export function serverName(agentName, kind) {
  return `ca-${agentName}-${kind}`
}
