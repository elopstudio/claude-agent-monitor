#!/usr/bin/env node
// Local Claude Code session monitor — read-only, listens on 127.0.0.1 only.
//
// Reads
//   ~/.claude/sessions/<pid>.json        session registry (name, cwd, busy/idle) — other files (*.key etc.) are never opened
//   ~/.claude/projects/*/<id>.jsonl      only the TAIL of each transcript — last tool action, summaries of messages between sessions
//   ./boards/<project>.json              task board written by the project's leader (optional)
// Never exposes
//   user prompts, conversation text, tool results, message bodies, socket paths, tokens.
//   Tool actions are reduced to a kind plus a short label (file name, command description).
//   Human-readable wording is left to the page, so it can be shown in any language.
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const CLAUDE = process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude')
const SESSIONS_DIR = path.join(CLAUDE, 'sessions')
const PROJECTS_DIR = path.join(CLAUDE, 'projects')
const BOARDS_DIR = path.join(ROOT, 'boards')
const PORT = Number(process.env.PORT) || 4777
const HOST = '127.0.0.1'
const TAIL_BYTES = 768 * 1024          // transcripts grow to tens of MB — read only the end
const WAITING_MS = 30 * 60 * 1000      // idle for less than this = "waiting", longer = "resting"
const MESSAGE_FEED = 14

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')) } catch { return {} }
}

/* ── Session registry ─────────────────────────── */

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

async function readRegistry() {
  let files = []
  try { files = await fsp.readdir(SESSIONS_DIR) } catch { return [] }
  const out = []
  for (const f of files) {
    if (!/^\d+\.json$/.test(f)) continue   // <pid>.json only — key files are never opened
    try {
      const o = JSON.parse(await fsp.readFile(path.join(SESSIONS_DIR, f), 'utf8'))
      if (!o.sessionId || !o.pid) continue
      out.push({
        pid: o.pid, sessionId: o.sessionId, cwd: o.cwd || '', name: o.name || o.sessionId.slice(0, 8),
        status: o.status || 'unknown', statusUpdatedAt: o.statusUpdatedAt || o.updatedAt || 0,
        startedAt: o.startedAt || 0, kind: o.kind || '', socket: o.messagingSocketPath || '',
      })
    } catch { /* file being written — pick it up on the next poll */ }
  }
  return out.filter((s) => alive(s.pid))
}

/* ── Project = git root of the session's working directory ── */

const rootCache = new Map()
function projectRoot(cwd) {
  if (rootCache.has(cwd)) return rootCache.get(cwd)
  let dir = path.resolve(cwd), found = null
  for (let i = 0; i < 12 && dir; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) { found = dir; break }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  const root = found || path.resolve(cwd)
  rootCache.set(cwd, root)
  return root
}
const projectKey = (root) => path.basename(root).toLowerCase()

/* ── Transcript tail ──────────────────────────── */

const transcriptPath = new Map()
async function findTranscript(sessionId) {
  const hit = transcriptPath.get(sessionId)
  if (hit && fs.existsSync(hit)) return hit
  let dirs = []
  try { dirs = await fsp.readdir(PROJECTS_DIR) } catch { return null }
  for (const d of dirs) {
    const p = path.join(PROJECTS_DIR, d, sessionId + '.jsonl')
    if (fs.existsSync(p)) { transcriptPath.set(sessionId, p); return p }
  }
  return null
}

async function tailLines(file) {
  const fh = await fsp.open(file, 'r')
  try {
    const { size, mtimeMs } = await fh.stat()
    const n = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(n)
    await fh.read(buf, 0, n, size - n)
    let lines = buf.toString('utf8').split('\n')
    if (n < size) lines = lines.slice(1)   // first line is cut in half
    return { lines: lines.filter(Boolean), size, mtimeMs }
  } finally { await fh.close() }
}

const clip = (s, n = 90) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const base = (p) => (typeof p === 'string' ? p.split(/[\\/]/).pop() : '')

// A tool call becomes { kind, key, arg }: kind picks the icon, key picks the page's wording, arg is a short label.
function describe(name, input = {}) {
  const a = (key, kind, arg = '') => ({ kind, key, arg })
  switch (name) {
    case 'Bash': case 'PowerShell': return a('shell', 'shell', clip(input.description || ''))
    case 'Read': return a('read', 'read', base(input.file_path))
    case 'Edit': case 'NotebookEdit': return a('edit', 'edit', base(input.file_path || input.notebook_path))
    case 'Write': return a('write', 'edit', base(input.file_path))
    case 'Grep': return a('grep', 'search')
    case 'Glob': return a('glob', 'search')
    case 'SendMessage': return a('message', 'talk', clip(input.summary || '', 60))
    case 'ListAgents': return a('team', 'talk')
    case 'Agent': return a('agent', 'agent', clip(input.description || '', 60))
    case 'WebFetch': case 'WebSearch': return a('web', 'web')
    case 'Artifact': return a('publish', 'publish')
    case 'ArtifactData': return a('board', 'publish')
    case 'Skill': return a('skill', 'skill', clip(input.skill || '', 40))
    case 'ToolSearch': return a('tools', 'skill')
    case 'TaskStop': return a('stop', 'shell')
    case 'Monitor': return a('monitor', 'shell')
    default:
      if (name?.startsWith('mcp__')) return a('connector', 'web', clip(name.split('__')[1] || '', 30))
      return a('other', 'other', clip(name || '', 40))
  }
}

const tailCache = new Map()   // sessionId → { size, mtimeMs, info }
async function transcriptInfo(sessionId) {
  const file = await findTranscript(sessionId)
  if (!file) return null
  let st
  try { st = await fsp.stat(file) } catch { return null }
  const prev = tailCache.get(sessionId)
  if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return prev.info
  const { lines, size, mtimeMs } = await tailLines(file)
  const info = { title: prev?.info?.title || '', activity: null, activityAt: 0, lastEventAt: 0, sent: [] }
  let titleSeen = false
  for (let i = lines.length - 1; i >= 0; i--) {
    let o
    try { o = JSON.parse(lines[i]) } catch { continue }
    const ts = o.timestamp ? Date.parse(o.timestamp) : 0
    if (!info.lastEventAt && ts) info.lastEventAt = ts
    if (!titleSeen && o.type === 'ai-title' && o.aiTitle) { info.title = clip(o.aiTitle, 70); titleSeen = true }
    if (o.type !== 'assistant' || o.isSidechain || !Array.isArray(o.message?.content)) continue
    for (let j = o.message.content.length - 1; j >= 0; j--) {
      const c = o.message.content[j]
      if (c?.type !== 'tool_use') continue
      if (!info.activity) { info.activity = describe(c.name, c.input); info.activityAt = ts }
      // a send without a message is only an idle-notice subscription, not conversation
      if (c.name === 'SendMessage' && c.input?.to && c.input.message) {
        info.sent.push({ to: String(c.input.to), summary: clip(c.input.summary || '', 70), at: ts })
      }
    }
  }
  tailCache.set(sessionId, { size, mtimeMs, info })
  return info
}

/* ── State ────────────────────────────────────── */

function displayState(s, now) {
  if (s.status === 'busy') return 'working'
  if (s.status === 'idle') return now - s.statusUpdatedAt < WAITING_MS ? 'waiting' : 'resting'
  return 'resting'
}

async function readBoard(key) {
  try { return JSON.parse(await fsp.readFile(path.join(BOARDS_DIR, key + '.json'), 'utf8')) } catch { return null }
}

async function buildState() {
  const now = Date.now()
  const config = loadConfig()
  const reg = await readRegistry()
  const bySocket = new Map(reg.filter((s) => s.socket).map((s) => [s.socket, s.name]))
  const projects = new Map()
  const boards = new Map()

  for (const s of reg) {
    const root = projectRoot(s.cwd)
    const key = projectKey(root)
    if (!projects.has(key)) projects.set(key, { key, root, sessions: [], messages: [] })
    const info = await transcriptInfo(s.sessionId).catch(() => null)
    const short = s.name.toLowerCase().startsWith(key + '-') ? s.name.slice(key.length) : s.name
    if (!boards.has(key)) boards.set(key, await readBoard(key))
    const roles = boards.get(key)?.roles || {}
    const sess = {
      id: s.sessionId.slice(0, 8), name: s.name, short, state: displayState(s, now),
      statusSince: s.statusUpdatedAt, startedAt: s.startedAt, kind: s.kind,
      role: String(roles[short] || roles[s.name] || ''), title: info?.title || '', activity: info?.activity || null, activityAt: info?.activityAt || 0,
      lastEventAt: info?.lastEventAt || 0, sentCount: info?.sent.length || 0,
    }
    const p = projects.get(key)
    p.sessions.push(sess)
    for (const m of info?.sent || []) {
      // replies are addressed to a socket — map it back to a name, never expose the address itself
      const sock = m.to.replace(/^uds:/, '')
      const name = bySocket.get(sock) || (m.to.startsWith('uds:') ? null : m.to)
      p.messages.push({ from: s.name, to: name, summary: m.summary, at: m.at })
    }
  }

  const out = []
  for (const p of projects.values()) {
    const cfg = config.projects?.[p.key] || {}
    // leader: config first, otherwise the session that sent the most messages (at least 3)
    let leader = cfg.leader && p.sessions.find((s) => s.name === cfg.leader) ? cfg.leader : null
    if (!leader) {
      const top = [...p.sessions].sort((a, b) => b.sentCount - a.sentCount)[0]
      if (top && top.sentCount >= 3 && p.sessions.length > 1) leader = top.name
    }
    for (const s of p.sessions) s.isLeader = s.name === leader
    p.sessions.sort((a, b) => (b.isLeader - a.isLeader) || a.name.localeCompare(b.name))
    p.messages.sort((a, b) => b.at - a.at)
    out.push({
      key: p.key, label: cfg.label || '', leader,
      sessions: p.sessions, messages: p.messages.slice(0, MESSAGE_FEED),
      board: boards.get(p.key) || null,
      counts: {
        working: p.sessions.filter((s) => s.state === 'working').length,
        waiting: p.sessions.filter((s) => s.state === 'waiting').length,
        resting: p.sessions.filter((s) => s.state === 'resting').length,
      },
    })
  }
  const order = config.order || []
  out.sort((a, b) => {
    const ia = order.indexOf(a.key), ib = order.indexOf(b.key)
    if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    return b.counts.working - a.counts.working || a.key.localeCompare(b.key)
  })
  return { now, projects: out }
}

/* ── HTTP ─────────────────────────────────────── */

const INDEX = path.join(ROOT, 'public', 'index.html')
// Listening on 127.0.0.1 is not enough: a web page can rebind its own domain to 127.0.0.1 (DNS rebinding)
// and read the API. Only answer requests addressed to this machine by a loopback name.
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
function localHost(host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '')
  return LOCAL_HOSTS.has(h)
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  try {
    if (!localHost(req.headers.host)) { res.writeHead(421).end(); return }
    if (req.method !== 'GET') { res.writeHead(405).end(); return }
    if (url.pathname === '/api/state') {
      const body = JSON.stringify(await buildState())
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(body)
      return
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      fs.createReadStream(INDEX).pipe(res)
      return
    }
    res.writeHead(404).end()
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('error')
    console.error(e)
  }
})

server.listen(PORT, HOST, () => console.log(`claude-agent-monitor → http://${HOST}:${PORT}`))
