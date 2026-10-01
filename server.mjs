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
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createAgents } from './agents.mjs'
import { createAccount } from './account.mjs'
import { createCloud } from './cloud.mjs'
import { createAssistant } from './assistant.mjs'
import { tokensToday } from './tokens.mjs'
import { createProcesses } from './processes.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))   // the code: public/, hooks/
// the data: config.json, boards/, .runtime/ — the code's own folder unless MONITOR_HOME says otherwise
// (the desktop app points it at a writable folder; an installed app's own folder is read-only)
const DATA = process.env.MONITOR_HOME ? path.resolve(process.env.MONITOR_HOME) : ROOT
// where the hooks find the running monitor, wherever the monitor is installed
const LINK = process.env.MONITOR_LINK || path.join(os.homedir(), '.claude-agent-monitor', 'bridge.json')
const CLAUDE = process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude')
const SESSIONS_DIR = path.join(CLAUDE, 'sessions')
const PROJECTS_DIR = path.join(CLAUDE, 'projects')
const BOARDS_DIR = path.join(DATA, 'boards')
const PORT = Number(process.env.PORT) || 4777
const HOST = '127.0.0.1'
const TAIL_BYTES = 768 * 1024          // transcripts grow to tens of MB — read only the end
const WAITING_MS = 30 * 60 * 1000      // idle for less than this = "waiting", longer = "resting"
const STALL_MS = 10 * 60 * 1000        // "working" with no sign of life for this long = probably stuck
const RECENT_RESULTS = 20              // tool errors are counted over the last this many tool results
const MESSAGE_FEED = 14

// a look picked on the page for a VS Code session: config.json projects.<key>.avatars.<short name or name>
const LOOK_ACCS = ['ball', 'twin', 'phones', 'sprout', 'bolt']
const lookOf = (v) => (v && Number.isInteger(v.c) && v.c >= 0 && v.c < 8 && LOOK_ACCS.includes(v.acc) ? { c: v.c, acc: v.acc } : null)
function lookFor(config, key, name, short) {
  const av = config.projects?.[key]?.avatars || {}
  return lookOf(av[short]) || lookOf(av[name])
}
// a name the user picked: one for both languages (a string, as before) or one per language ({ en, ko }, either may be
// empty). A language left empty uses the other's name, so a name picked once is kept in both, as it always was.
const nickClean = (v) => clip(String(v || '').replace(/[\x00-\x1f<>]/g, ''), 16)
function nickStored(en, ko) {
  en = nickClean(en); ko = nickClean(ko)
  return !en && !ko ? '' : en === ko ? en : { en, ko }
}
function pinOf(v) {
  const raw = typeof v === 'string' ? { en: nickClean(v), ko: nickClean(v) } : v && typeof v === 'object' ? { en: nickClean(v.en), ko: nickClean(v.ko) } : null
  if (!raw || (!raw.en && !raw.ko)) return null
  return { en: raw.en || raw.ko, ko: raw.ko || raw.en, raw }
}
// a line the user wrote about what the agent is for ("infra and CI/CD"): config.json projects.<key>.descs.<short name or name>
const descOf = (v) => clip(String(v || '').replace(/[\x00-\x1f<>]/g, ' ').replace(/\s+/g, ' ').trim(), 80)
function descFor(config, key, name, short) {
  const d = config.projects?.[key]?.descs || {}
  return descOf(d[short] || d[name])
}
// writes the name and look into config.json, keeping everything else in it as it was
// config.json changes from the page: read it, change it, write it back in one step
async function editConfig(change) {
  const file = path.join(DATA, 'config.json')
  let config = {}
  try { config = JSON.parse(await fsp.readFile(file, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') return 409 }
  change(config)
  const tmp = file + '.' + process.pid + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(config, null, 2) + '\n')
  await fsp.rename(tmp, file)
  notifyPages()
  return 200
}

const PROJECT_KEY = /^[a-z0-9][a-z0-9._-]{0,80}$/

// the tab order dragged on the page; projects not on the page keep their place after the ones that are
async function saveOrder(body) {
  const order = Array.isArray(body.order) ? [...new Set(body.order.map((k) => String(k).toLowerCase()))] : []
  if (!order.length || order.length > 200 || !order.every((k) => PROJECT_KEY.test(k))) return 400
  return editConfig((config) => { config.order = [...order, ...(Array.isArray(config.order) ? config.order : []).filter((k) => !order.includes(k))] })
}

async function saveLook(body) {
  const key = String(body.project || '').toLowerCase(), who = String(body.session || '')
  if (!PROJECT_KEY.test(key) || !who || who.length > 120) return 400
  return editConfig((config) => {
  config.projects = config.projects || {}
  const p = (config.projects[key] = config.projects[key] || {})
  // nickKo too from the page; a caller sending only nick names it in both languages
  if (typeof body.nick === 'string' || typeof body.nickKo === 'string') {
    const nick = nickStored(body.nick, typeof body.nickKo === 'string' ? body.nickKo : body.nick)
    p.names = p.names || {}
    if (nick) p.names[who] = nick; else delete p.names[who]
  }
  if (body.avatar !== undefined) {
    const look = lookOf(body.avatar)
    p.avatars = p.avatars || {}
    if (look) p.avatars[who] = look; else delete p.avatars[who]
  }
  if (typeof body.desc === 'string') {
    const desc = descOf(body.desc)
    p.descs = p.descs || {}
    if (desc) p.descs[who] = desc; else delete p.descs[who]
  }
  })
}

// a project's name on the page, picked there: config.json projects.<key>.name. The folder (its key) stays as it is,
// and an empty name means the folder's own name again
async function saveProjectName(body) {
  const key = String(body.project || '').toLowerCase()
  if (!PROJECT_KEY.test(key)) return 400
  const name = clip(String(body.name || '').replace(/[\x00-\x1f<>]/g, '').replace(/\s+/g, ' ').trim(), 40)
  return editConfig((config) => {
    config.projects = config.projects || {}
    const p = (config.projects[key] = config.projects[key] || {})
    if (name && name !== key) p.name = name; else delete p.name
  })
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8')) } catch { return {} }
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

// the git repository a file belongs to, or null for a file outside any (a scratch folder, Claude Code's own notes)
const gitRootCache = new Map()
function gitRootOf(dir) {
  if (gitRootCache.has(dir)) return gitRootCache.get(dir)
  let d = path.resolve(dir), found = null
  for (let i = 0; i < 20 && d; i++) {
    if (fs.existsSync(path.join(d, '.git'))) { found = d; break }
    const up = path.dirname(d)
    if (up === d) break
    d = up
  }
  gitRootCache.set(dir, found)
  return found
}
const AWAY_MS = 30 * 60 * 1000   // a file changed in another project this recently: the session is working there
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
// another project the session has just been changing files in: its key (the folder name) and when — never the file
function awayOf(info, cwd, own, now) {
  if (!info?.lastEditPath || now - info.lastEditAt > AWAY_MS) return null
  const root = gitRootOf(path.dirname(path.resolve(cwd || '', info.lastEditPath)))
  const key = root && projectKey(root)
  return key && key !== own ? { key, at: info.lastEditAt } : null
}

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
    case 'Bash': case 'PowerShell': return a('shell', 'shell', clip(input.description || '', 240))
    case 'Read': return a('read', 'read', base(input.file_path))
    case 'Edit': case 'NotebookEdit': return a('edit', 'edit', base(input.file_path || input.notebook_path))
    case 'Write': return a('write', 'edit', base(input.file_path))
    case 'Grep': return a('grep', 'search')
    case 'Glob': return a('glob', 'search')
    case 'SendMessage': return a('message', 'talk', clip(input.summary || '', 240))
    case 'ListAgents': return a('team', 'talk')
    case 'Agent': return a('agent', 'agent', clip(input.description || '', 240))
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

const tailCache = new Map()   // sessionId → { file, offset, mtimeMs, info }
const emptyInfo = () => ({ title: '', activity: null, activityAt: 0, lastEventAt: 0, sent: [], context: 0, results: 0, errors: 0, lastErrorAt: 0, recent: [], lastEditPath: '', lastEditAt: 0 })

// One transcript line, oldest to newest: later lines simply overwrite the "latest" fields.
function applyLine(info, o) {
  const ts = o.timestamp ? Date.parse(o.timestamp) : 0
  if (ts) info.lastEventAt = ts
  if (o.type === 'ai-title' && o.aiTitle) info.title = clip(o.aiTitle, 200)
  // tool results: only whether each one failed, never what it said
  if (o.type === 'user' && !o.isSidechain && Array.isArray(o.message?.content)) {
    for (const c of o.message.content) if (c?.type === 'tool_result') info.recent.push({ e: !!c.is_error, ts })
    if (info.recent.length > RECENT_RESULTS) info.recent.splice(0, info.recent.length - RECENT_RESULTS)
  }
  if (o.type !== 'assistant' || o.isSidechain) return
  // how full the context is: the newest reply's input side (fresh + cache written + cache read)
  const u = o.message?.usage
  if (u) info.context = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
  if (!Array.isArray(o.message?.content)) return
  for (const c of o.message.content) {
    if (c?.type !== 'tool_use') continue
    info.activity = describe(c.name, c.input)
    info.activityAt = ts
    // the last file changed, to tell which project the session is really working in (kept on the server only)
    if (EDIT_TOOLS.has(c.name)) { const f = c.input?.file_path || c.input?.notebook_path; if (typeof f === 'string' && f) { info.lastEditPath = f; info.lastEditAt = ts } }
    // a send without a message is only an idle-notice subscription, not conversation
    if (c.name === 'SendMessage' && c.input?.to && c.input.message) {
      info.sent.push({ to: String(c.input.to), summary: clip(c.input.summary || '', 70), at: ts })
      if (info.sent.length > 60) info.sent.shift()
    }
  }
}
function finish(info) {
  info.results = info.recent.length
  info.errors = info.recent.filter((r) => r.e).length
  info.lastErrorAt = info.recent.reduce((t, r) => (r.e && r.ts > t ? r.ts : t), 0)
  return info
}
// bytes → complete lines; the part after the last newline is still being written and is read next time
function completeLines(buf) {
  const end = buf.lastIndexOf(0x0a)
  if (end < 0) return { lines: [], used: 0 }
  return { lines: buf.subarray(0, end).toString('utf8').split('\n'), used: end + 1 }
}

// Each transcript is read once from its tail; after that only what was appended since the last poll.
async function transcriptInfo(sessionId) {
  const file = await findTranscript(sessionId)
  if (!file) return null
  let st
  try { st = await fsp.stat(file) } catch { return null }
  const prev = tailCache.get(sessionId)
  if (prev && prev.file === file && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return prev.info
  const grew = prev && prev.file === file && st.size >= prev.offset && st.size - prev.offset <= TAIL_BYTES
  const from = grew ? prev.offset : Math.max(0, st.size - TAIL_BYTES)
  const info = grew ? prev.info : emptyInfo()
  if (!grew && prev?.info?.title) info.title = prev.info.title
  const fh = await fsp.open(file, 'r')
  let used = 0
  try {
    const n = st.size - from
    const buf = Buffer.alloc(n)
    if (n) await fh.read(buf, 0, n, from)
    let { lines, used: u } = completeLines(buf)
    used = u
    if (!grew && from > 0) lines = lines.slice(1)   // started mid-file: the first line is cut in half
    for (const l of lines) {
      if (!l) continue
      let o
      try { o = JSON.parse(l) } catch { continue }
      applyLine(info, o)
    }
  } finally { await fh.close() }
  tailCache.set(sessionId, { file, offset: from + used, size: st.size, mtimeMs: st.mtimeMs, info: finish(info) })
  return info
}

/* ── Nicknames ────────────────────────────────── */

// "-7f" is hard to tell apart from "-74", so every session also gets a person's name.
// The name comes from the session id, so it is the same on every page and every poll.
// Names are unique within a project: the oldest session keeps its pick, a later one that
// collides takes the next free name. config.json "names" overrides any of them.
// Each slot is an English and a Korean name; the page shows the one for its language.
const NAMES = [
  ['Tom', '민준'], ['Mark', '서연'], ['Anna', '지호'], ['Leo', '하은'], ['Mia', '도윤'], ['Sam', '수아'],
  ['Nora', '예준'], ['Jack', '지우'], ['Ella', '시우'], ['Max', '하린'], ['Ruby', '주원'], ['Owen', '서윤'],
  ['Lily', '건우'], ['Finn', '지안'], ['Zoe', '우진'], ['Hugo', '채원'], ['Ivy', '현우'], ['Noah', '다은'],
  ['Emma', '선우'], ['Theo', '유나'], ['Luna', '은호'], ['Ben', '소율'], ['Iris', '태오'], ['Kai', '나은'],
  ['Rose', '준서'], ['Dan', '하윤'], ['Maya', '연우'], ['Eli', '예린'], ['June', '승민'], ['Axel', '수빈'],
  ['Cleo', '민재'], ['Gus', '가은'], ['Hana', '도현'], ['Otto', '서아'], ['Vera', '재윤'], ['Rex', '아린'],
  ['Lucy', '윤호'], ['Ray', '지원'], ['Nina', '시현'], ['Paul', '은서'], ['Sara', '태민'], ['Ted', '하영'],
  ['Alma', '준호'], ['Joel', '미나'], ['Kate', '성민'], ['Milo', '보라'], ['Tara', '정우'], ['Ian', '혜진'],
]
function nameHash(s) { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return h }
// Runs over every session on the machine at once, so no two agents share a name even across projects
// (the page shows them side by side on the "all agents" tab). fixedFor(s) returns a name pinned in config.json.
// An automatic name, once given, is kept (.runtime/names.json, by session id; names only). It used to be worked out
// afresh on every look, in order of start, each taking the first free name from its hash — so a name picked for one
// agent, a take-over copying a name, or an earlier session going away moved others to new names, and a restart showed
// them renamed. Now only a picked name that is the very same moves an automatic one.
const NAMES_FILE = path.join(DATA, '.runtime', 'names.json')
const NAMES_KEEP_MS = 30 * 24 * 3600e3
let given = (() => { try { const g = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8')); return g && typeof g === 'object' ? g : {} } catch { return {} } })()   // fullId → { n: [en, ko], at }
function keepGiven(now) {
  for (const [id, g] of Object.entries(given)) if (!(now - (g?.at || 0) < NAMES_KEEP_MS)) delete given[id]
  try { fs.mkdirSync(path.dirname(NAMES_FILE), { recursive: true }); fs.writeFileSync(NAMES_FILE, JSON.stringify(given)) } catch {}
}
function assignNicks(sessions, fixedFor) {
  const taken = new Set(sessions.map(fixedFor).filter(Boolean).flatMap((f) => [f.en, f.ko]).map((n) => n.toLowerCase()))
  const free = (pair) => !pair.some((n) => taken.has(n.toLowerCase()))
  const take = (s, pair) => { [s.nick, s.nickKo] = pair; taken.add(pair[0].toLowerCase()); taken.add(pair[1].toLowerCase()) }
  const now = Date.now(), later = []
  let changed = false
  // the names picked by the user first, then the automatic names already given, then new ones from what is left
  for (const s of [...sessions].sort((a, b) => a.startedAt - b.startedAt || a.fullId.localeCompare(b.fullId))) {
    const fixed = fixedFor(s)
    // what the user typed, for the page's name fields: empty ones there mean "automatic"
    s.named = fixed ? fixed.raw : { en: '', ko: '' }
    if (fixed) { s.nick = fixed.en; s.nickKo = fixed.ko; continue }
    later.push(s)
  }
  const fresh = []
  for (const s of later) {
    const g = given[s.fullId]
    if (Array.isArray(g?.n) && g.n.length === 2 && g.n.every((x) => typeof x === 'string' && x) && free(g.n)) {
      take(s, g.n)
      if (now - (g.at || 0) > 3600e3) { g.at = now; changed = true }   // seen: kept another month
    } else fresh.push(s)
  }
  for (const s of fresh) {
    const start = nameHash(s.fullId) % NAMES.length
    let pick = null
    for (let i = 0; i < NAMES.length && !pick; i++) {
      const pair = NAMES[(start + i) % NAMES.length]
      if (free(pair)) pick = pair
    }
    take(s, pick || [s.short, s.short])
    if (s.fullId) { given[s.fullId] = { n: [s.nick, s.nickKo], at: now }; changed = true }
  }
  if (changed) keepGiven(now)
}

/* ── Subagents ─────────────────────────────────── */

// A session's subagents (the Agent tool): what kind, what for, whether still running, what they last did.
// Kept to the recent ones; each file is re-read only when it changed.
const SUB_RUNNING_MS = 45 * 1000, SUB_RECENT_MS = 3 * 60 * 60 * 1000, SUB_MAX = 12
const subCache = new Map()   // file → { mtimeMs, size, info }
// tokens used today by a session and its subagents
async function todayOf(sessionId) {
  const file = await findTranscript(sessionId)
  if (!file) return null
  const dir = path.join(file.replace(/.jsonl$/, ''), 'subagents')
  let subs = []
  try { subs = (await fsp.readdir(dir)).filter((n) => /^agent-[a-z0-9]+.jsonl$/.test(n)).map((n) => path.join(dir, n)) } catch {}
  return tokensToday([file, ...subs])
}

async function subagentsOf(sessionId) {
  const file = await findTranscript(sessionId)
  if (!file) return []
  const dir = path.join(file.replace(/\.jsonl$/, ''), 'subagents')
  let names = []
  try { names = await fsp.readdir(dir) } catch { return [] }
  const now = Date.now(), out = []
  for (const n of names) {
    const m = n.match(/^agent-([a-z0-9]+)\.jsonl$/)
    if (!m) continue
    const p = path.join(dir, n)
    let st
    try { st = await fsp.stat(p) } catch { continue }
    if (now - st.mtimeMs > SUB_RECENT_MS) continue
    let hit = subCache.get(p)
    if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
      let meta = {}
      try { meta = JSON.parse(await fsp.readFile(path.join(dir, 'agent-' + m[1] + '.meta.json'), 'utf8')) } catch {}
      const info = { tools: 0, activity: null, startedAt: 0 }
      try {
        const { lines } = await tailLines(p)
        for (const l of lines) {
          let o
          try { o = JSON.parse(l) } catch { continue }
          if (!info.startedAt && o.timestamp) info.startedAt = Date.parse(o.timestamp)
          if (o.type !== 'assistant' || !Array.isArray(o.message?.content)) continue
          for (const c of o.message.content) if (c?.type === 'tool_use') { info.tools++; info.activity = describe(c.name, c.input) }
        }
      } catch {}
      hit = { mtimeMs: st.mtimeMs, size: st.size, info: { ...info, type: clip(meta.agentType || 'subagent', 40), description: clip(meta.description || '', 120) } }
      subCache.set(p, hit)
    }
    out.push({ id: m[1], ...hit.info, lastAt: st.mtimeMs, running: now - st.mtimeMs < SUB_RUNNING_MS })
  }
  return out.sort((a, b) => (b.running - a.running) || b.lastAt - a.lastAt).slice(0, SUB_MAX)
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
  const bySession = new Map()

  const agentPids = new Set((agents ? agents.sessions(now) : []).map((m) => m.pid).filter(Boolean))
  const takenOver = new Map((agents ? agents.sessions(now) : []).filter((m) => m.forkedFrom).map((m) => [m.forkedFrom, m.name]))
  for (const s of reg) {
    if (agents?.byAgentSession(s.sessionId)) continue
    // a claude the monitor runs, by its process: one just taken over is registered under the VS Code session's id
    // until its first turn, and would otherwise show up as a second, ownerless card for that session
    if (agentPids.has(s.pid)) continue
    const root = projectRoot(s.cwd)
    const key = projectKey(root)
    if (!projects.has(key)) projects.set(key, { key, root, sessions: [], messages: [] })
    const info = await transcriptInfo(s.sessionId).catch(() => null)
    const short = s.name.toLowerCase().startsWith(key + '-') ? s.name.slice(key.length) : s.name
    if (!boards.has(key)) boards.set(key, await readBoard(key))
    const sess = {
      id: s.sessionId.slice(0, 8), fullId: s.sessionId, name: s.name, short, nick: '', nickKo: '', avatar: lookFor(config, key, s.name, short), desc: descFor(config, key, s.name, short), state: displayState(s, now),
      statusSince: s.statusUpdatedAt, startedAt: s.startedAt, kind: s.kind,
      role: '', title: info?.title || '', activity: info?.activity || null, activityAt: info?.activityAt || 0,
      lastEventAt: info?.lastEventAt || 0, sentCount: info?.sent.length || 0,
      mode: modes.get(s.sessionId)?.mode || '',
      listening: waiters.has(s.sessionId), queued: (inbox.get(s.sessionId) || []).length,
      context: info?.context || 0, errors: info?.errors || 0, results: info?.results || 0, lastErrorAt: info?.lastErrorAt || 0,
      // a hook call is a sign of life too, and arrives even while the transcript is quiet
      lastSignAt: Math.max(info?.lastEventAt || 0, modes.get(s.sessionId)?.at || 0),
      subagents: await subagentsOf(s.sessionId).catch(() => []), today: await todayOf(s.sessionId).catch(() => null),
    }
    sess.stalledFor = sess.state === 'working' && sess.lastSignAt && now - sess.lastSignAt > STALL_MS ? now - sess.lastSignAt : 0
    sess.away = awayOf(info, s.cwd, key, now)
    // taken over in the monitor and still open in VS Code: the page says which copy is the old one
    sess.takenOver = takenOver.get(s.sessionId) || ''
    sess.procs = processes.summary(s.pid, s.name)   // what it has running: counts only, no commands
    const p = projects.get(key)
    p.sessions.push(sess)
    bySession.set(s.sessionId, { sess, project: key })
    for (const m of info?.sent || []) {
      // replies are addressed to a socket — map it back to a name, never expose the address itself
      const sock = m.to.replace(/^uds:/, '')
      const name = bySocket.get(sock) || (m.to.startsWith('uds:') ? null : m.to)
      p.messages.push({ from: s.name, to: name, summary: m.summary, at: m.at })
    }
  }

  // agents the monitor runs itself
  for (const m of agents ? agents.sessions(now) : []) {
    if (!projects.has(m.key)) projects.set(m.key, { key: m.key, root: m.root, sessions: [], messages: [] })
    if (!boards.has(m.key)) boards.set(m.key, await readBoard(m.key))
    const info = await transcriptInfo(m.sessionId).catch(() => null)
    const sess = {
      id: m.sessionId.slice(0, 8), fullId: m.sessionId, name: m.name, short: m.name, nick: '', nickKo: '', pinNick: m.nick || '', avatar: m.avatar || null, desc: m.desc || '', state: m.state,
      statusSince: m.statusSince, startedAt: m.startedAt, kind: 'monitor', managed: true, agentId: m.agentId, running: m.running,
      loginLost: m.loginLost || 0, lastFail: m.lastFail || null,
      role: '', title: info?.title || '', activity: m.activity || info?.activity || null, activityAt: m.activityAt || info?.activityAt || 0,
      lastEventAt: m.lastEventAt || info?.lastEventAt || 0, sentCount: info?.sent.length || 0, mode: m.mode, model: m.model, effort: m.effort,
      listening: false, queued: 0, context: info?.context || 0, errors: info?.errors || 0, results: info?.results || 0, lastErrorAt: info?.lastErrorAt || 0,
      lastSignAt: m.lastEventAt || 0, subagents: await subagentsOf(m.sessionId).catch(() => []), today: await todayOf(m.sessionId).catch(() => null),
    }
    sess.stalledFor = sess.state === 'working' && sess.lastSignAt && now - sess.lastSignAt > STALL_MS ? now - sess.lastSignAt : 0
    sess.away = awayOf(info, m.cwd, m.key, now)
    sess.procs = processes.summary(m.pid, m.name)
    projects.get(m.key).sessions.push(sess)
    bySession.set(m.sessionId, { sess, project: m.key })
  }

  const allSessions = [...projects.values()].flatMap((p) => p.sessions.map((s) => ({ s, names: config.projects?.[p.key]?.names || {} })))
  const pinned = new Map(allSessions.map(({ s, names }) => [s, pinOf(names[s.name] || names[s.short]) || pinOf(s.pinNick)]))
  assignNicks(allSessions.map((x) => x.s), (s) => pinned.get(s))

  const out = []
  for (const p of projects.values()) {
    const cfg = config.projects?.[p.key] || {}
    const roles = boards.get(p.key)?.roles || {}
    const nickOf = new Map(p.sessions.map((s) => [s.name, s]))
    for (const s of p.sessions) {
      // a board may address a session by its short name, full name or nickname
      s.role = String(roles[s.short] || roles[s.name] || roles[s.nick] || roles[s.nickKo] || '')
      delete s.fullId   // used only to pick the nickname — the full id stays on the server
    }
    for (const m of p.messages) { const f = nickOf.get(m.from), t = nickOf.get(m.to); m.fromNick = f?.nick || ''; m.fromNickKo = f?.nickKo || ''; m.toNick = t?.nick || ''; m.toNickKo = t?.nickKo || '' }
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
      key: p.key, root: p.root, name: typeof cfg.name === 'string' ? clip(cfg.name, 40) : '', label: cfg.label || '', leader,
      sessions: p.sessions, messages: p.messages.slice(0, MESSAGE_FEED),
      board: boards.get(p.key) || null,
      counts: {
        working: p.sessions.filter((s) => s.state === 'working').length,
        waiting: p.sessions.filter((s) => s.state === 'waiting').length,
        resting: p.sessions.filter((s) => s.state === 'resting').length,
      },
    })
  }
  // each project lists the sessions from elsewhere that are changing its files right now
  for (const p of out) {
    p.guests = out.filter((q) => q.key !== p.key).flatMap((q) => q.sessions.filter((x) => x.away?.key === p.key)
      .map((x) => ({ name: x.name, nick: x.nick, nickKo: x.nickKo, isLeader: !!x.isLeader, from: q.key, at: x.away.at, state: x.state })))
  }
  const order = config.order || []
  out.sort((a, b) => {
    const ia = order.indexOf(a.key), ib = order.indexOf(b.key)
    if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    return b.counts.working - a.counts.working || a.key.localeCompare(b.key)
  })
  // requests waiting for a click — oldest first; the session is named, never its id
  const approvals = [...pending.values()].sort((a, b) => a.at - b.at).map((q) => {
    const hit = bySession.get(q.sessionId)
    const mine = !hit && q.sessionId && q.sessionId === agents?.assistantState()?.sessionId   // the assistant's own
    return {
      id: q.id, project: hit?.project || '', session: hit?.sess.name || (mine ? 'monitor-assistant' : ''), short: hit?.sess.short || '',
      nick: hit?.sess.nick || (mine ? 'Assistant' : ''), nickKo: hit?.sess.nickKo || (mine ? '비서' : ''), assistant: !!mine, isLeader: !!hit?.sess.isLeader, about: hit ? (hit.sess.role || hit.sess.title) : '',
      managed: !!q.managed, tool: q.tool, what: q.what, code: q.code, options: q.options, questions: q.questions || null, plan: q.plan || '', at: q.at, expiresAt: q.expiresAt,
    }
  })
  // the token rides along so an open page keeps working across server restarts; like the inline copy,
  // only a same-origin page can read it (no CORS headers, and the Host check stops DNS rebinding)
  // a prompt the page shows as its own approval is not repeated here
  const asking = new Set([...pending.values()].map((q) => q.sessionId))
  const inEditor = [...waiting.entries()].filter(([id]) => !asking.has(id) && bySession.has(id)).map(([id, w]) => {
    const hit = bySession.get(id)
    return { project: hit.project, session: hit.sess.name, short: hit.sess.short, nick: hit.sess.nick, nickKo: hit.sess.nickKo, isLeader: !!hit.sess.isLeader, type: w.type, message: w.message, at: w.at }
  }).sort((a, b) => a.at - b.at)
  const recent = outcomes.map((o) => { const hit = bySession.get(o.sessionId); return { at: o.at, agent: hit ? (hit.sess.nickKo || hit.sess.name) : '(other)', tool: o.tool, how: o.how, ms: o.ms } })
  return { now, version: VERSION, projects: out, approvals, inEditor, recent, token: TOKEN, usage: account.usageNow(), hooks: { ...hookStats, viewerSeenAgo: lastViewAt ? now - lastViewAt : null, openPages: streams.size } }
}

/* ── Hooks: approvals and permission mode ─────── */

// Claude Code runs hooks/bridge.mjs on PermissionRequest (and a few tool events). The bridge posts the hook
// input here with the token below; for a permission request the page can answer allow / deny.
// Pending requests live in memory only — they are never written to disk or logged.
const TOKEN = crypto.randomBytes(24).toString('hex')
const RUNTIME = path.join(DATA, '.runtime')
const APPROVAL_WAIT_MS = 60 * 1000     // after this the request goes back to VS Code / the terminal
const VIEWER_MS = 20 * 1000            // a poll this recent also counts as an open page
// Open pages keep an event stream (SSE) to the server. It is not throttled like a hidden tab's timers,
// so it says reliably that a page is open, and it tells the page at once when a request comes or goes.
const streams = new Set()
// the state is built at most once a second however many pages ask; any change builds it afresh
let stateCache = null
function cachedState() {
  if (stateCache && Date.now() - stateCache.at < 1000) return stateCache.p
  const p = buildState()
  stateCache = { at: Date.now(), p }
  p.catch(() => { stateCache = null })
  return p
}
function notifyPages() {
  stateCache = null; for (const res of streams) { try { res.write('event: changed\ndata: {}\n\n') } catch {} } }
const pageOpen = () => streams.size > 0 || Date.now() - lastViewAt < VIEWER_MS
let lastViewAt = 0
const modes = new Map()                // sessionId → { mode, at }
const pending = new Map()              // id → { id, sessionId, tool, what, code, at, expiresAt, done }
// Prompts that only VS Code can answer (held messages between sessions, one-time auto-mode checks, MCP forms…):
// Claude Code announces them with a Notification hook. The page can't answer these, but it can say who is waiting.
const waiting = new Map()              // sessionId → { type, message, at }
const handedBack = new Map()           // sessionId → when the monitor sent a request back to VS Code
const HANDBACK_MS = 2 * 60 * 1000
const handBack = (sessionId) => { if (sessionId) handedBack.set(sessionId, Date.now()) }

function writeRuntime() {
  fs.mkdirSync(RUNTIME, { recursive: true })
  const link = JSON.stringify({ port: PORT, token: TOKEN })
  fs.writeFileSync(path.join(RUNTIME, 'bridge.json'), link, { mode: 0o600 })
  fs.mkdirSync(path.dirname(LINK), { recursive: true })
  fs.writeFileSync(LINK, link, { mode: 0o600 })
}
function removeRuntime() { for (const f of [path.join(RUNTIME, 'bridge.json'), LINK]) { try { fs.unlinkSync(f) } catch {} } }

// What a human needs to judge the request, and nothing more.
function approvalDetail(tool, input = {}) {
  switch (tool) {
    case 'Bash': case 'PowerShell': return { what: clip(input.description || '', 120), code: clip(input.command || '', 600) }
    case 'Edit': case 'Write': case 'Read': case 'NotebookEdit': return { what: '', code: clip(input.file_path || input.notebook_path || '', 300) }
    case 'WebFetch': return { what: '', code: clip(input.url || '', 300) }
    case 'WebSearch': return { what: '', code: clip(input.query || '', 200) }
    case 'AskUserQuestion': return {
      what: '', code: '',
      questions: (Array.isArray(input.questions) ? input.questions : []).slice(0, 4).map((q) => ({
        question: clip(q.question || '', 400), header: clip(q.header || '', 30), multiSelect: !!q.multiSelect,
        options: (Array.isArray(q.options) ? q.options : []).slice(0, 6).map((o) => ({ label: clip(o.label || '', 80), description: clip(o.description || '', 200) })),
      })),
    }
    case 'ExitPlanMode': return { what: '', code: '', plan: clip(input.plan || '', 8000) }
    default: return { what: '', code: clip(JSON.stringify(input), 400) }
  }
}

// counts only — how many hook calls arrived and what became of permission requests, never their content
const hookStats = { events: {}, permission: { shown: 0, skippedNoViewer: 0, tools: {} }, notifications: {}, lastAt: 0 }

// A project's leader is told who its team is. With a prompt it receives, the monitor adds the other sessions of the
// project — the name to message each with (what ListAgents / SendMessage use), its names on the page, kind, role and
// state — but only when the team or its roles changed since the leader was last told, so it costs nothing otherwise.
const toldTeam = new Map()   // sessionId → the team as last told
async function teamContext(sessionId) {
  if (!sessionId) return ''
  const [data, reg] = await Promise.all([cachedState(), readRegistry()])
  const msgName = new Map(reg.map((r) => [r.sessionId, r.name]))
  const agentSession = new Map((agents ? agents.sessions(Date.now()) : []).map((m) => [m.agentId, m.sessionId]))
  const mine = agents?.byAgentSession(sessionId)
  const pageName = mine ? mine.name : msgName.get(sessionId)
  const p = (data.projects || []).find((x) => x.sessions.some((s) => s.name === pageName && s.isLeader))
  if (!p) { toldTeam.delete(sessionId); return '' }
  const me = p.sessions.find((s) => s.name === pageName)
  // a monitor agent whose claude is not running has no session to message: the page's message box wakes it
  const nameOf = (s) => (s.managed ? msgName.get(agentSession.get(s.agentId)) : s.name) || ''
  const others = p.sessions.filter((s) => s !== me)
  const who = (s) => [s.nickKo, s.nick].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' / ')
  const sig = JSON.stringify(others.map((s) => [nameOf(s), who(s), s.role]))
  if (toldTeam.get(sessionId) === sig) return ''
  toldTeam.set(sessionId, sig)
  const line = (s) => '- ' + (nameOf(s) || '(not running — cannot be messaged until it is started again)') + ' — ' + (who(s) || s.name) + ' · ' + (s.managed ? 'monitor agent' : 'VS Code session') + ' · ' + s.state +
    (s.role ? ' · role: ' + s.role : '') + (s.activity ? ' · last: ' + clip(describeActivity(s.activity), 80) : '')
  const text = 'Agent monitor: you are the leader of the project "' + p.key + '"' + (who(me) ? ', shown to the user as ' + who(me) : '') + '. ' +
    (others.length ? 'The other sessions working on it now (message them with SendMessage using the first name; the user knows them by the names after the dash):\n' + others.map(line).join('\n')
      : 'No other session is working on it right now.')
  return text
}
const describeActivity = (a) => [a.key, a.arg].filter(Boolean).join(' ')

// The language the person reads the monitor in (the page's EN / 한국어 switch), told to every session once and again
// when it changes, so replies to them come in that language. The page reports it with each poll; kept in memory.
const LANGS = { en: 'English', ko: 'Korean' }
let pageLang = ''
const toldLang = new Map()   // sessionId → the language last told
function langContext(sessionId) {
  if (!pageLang || toldLang.get(sessionId) === pageLang) return ''
  toldLang.set(sessionId, pageLang)
  return 'Agent monitor: the user has the monitor set to ' + LANGS[pageLang] + '. Write to the user in ' + LANGS[pageLang] + ' unless they ask for another language.'
}
// what a prompt gets added to it: the language, and for a leader its team
async function promptContext(sessionId) {
  if (!sessionId) return {}
  const text = [langContext(sessionId), await teamContext(sessionId)].filter(Boolean).join('\n\n')
  return text ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } } : {}
}

// how each permission request ended — tool name, agent, outcome and time only; the last 20, in memory
const outcomes = []
function recordOutcome(p, how) {
  outcomes.unshift({ at: Date.now(), sessionId: p.sessionId, tool: p.tool, how, ms: Date.now() - p.at })
  outcomes.length = Math.min(outcomes.length, 20)
}

function hookEvent(input, res, opts = {}) {
  const sessionId = String(input.session_id || '')
  const event = String(input.hook_event_name || 'unknown')
  hookStats.events[event] = (hookStats.events[event] || 0) + 1
  hookStats.lastAt = Date.now()
  if (sessionId && input.permission_mode) modes.set(sessionId, { mode: String(input.permission_mode), at: Date.now() })
  if (event === 'Notification') {
    const type = String(input.notification_type || 'other')
    hookStats.notifications[type] = (hookStats.notifications[type] || 0) + 1
    // "idle_prompt" is just "done, your turn" — the card already shows that as waiting
    const expected = Date.now() - (handedBack.get(sessionId) || 0) < HANDBACK_MS
    if (sessionId && type !== 'idle_prompt' && !expected) waiting.set(sessionId, { type, message: clip(input.message || '', 240), at: Date.now() })
    notifyPages()
    return Promise.resolve({})
  }
  // any other activity from the session means the prompt was answered
  if (sessionId && waiting.delete(sessionId)) notifyPages()
  if (event === 'UserPromptSubmit') return promptContext(sessionId).catch(() => ({}))
  if (event !== 'PermissionRequest') return Promise.resolve({})
  // nobody is watching the page — hand the request straight back to the normal prompt
  if (!opts.managed && agents?.byAgentSession(sessionId)) return Promise.resolve({})
  if (!opts.managed && !pageOpen()) { hookStats.permission.skippedNoViewer++; handBack(sessionId); return Promise.resolve({}) }
  hookStats.permission.shown++
  const toolName = String(input.tool_name || '')
  hookStats.permission.tools[toolName] = (hookStats.permission.tools[toolName] || 0) + 1
  return new Promise((resolve) => {
    const id = crypto.randomBytes(8).toString('hex')
    const done = (decision, how) => {
      const p = pending.get(id)
      if (!p) return
      clearTimeout(timer); pending.delete(id); recordOutcome(p, how); notifyPages(); resolve(decision)
    }
    // an agent the monitor runs has no VS Code to fall back to: it waits for the page (up to a day)
    const wait = opts.managed ? 24 * 60 * 60 * 1000 : APPROVAL_WAIT_MS
    const timer = setTimeout(() => { handBack(sessionId); done({}, 'timeout') }, wait)
    // Claude Code dropped the hook (the request was settled some other way): drop the card too
    res?.on('close', () => { if (!res.writableEnded) done({}, 'dropped by Claude Code') })
    // "Yes, and don't ask again for …" — kept exactly as Claude Code sent them, and handed back unchanged when picked
    const suggestions = Array.isArray(input.permission_suggestions) ? input.permission_suggestions.slice(0, 4) : []
    pending.set(id, {
      id, sessionId, tool: String(input.tool_name || ''), ...approvalDetail(input.tool_name, input.tool_input),
      input: input.tool_name === 'AskUserQuestion' ? input.tool_input : null,
      suggestions, options: suggestions.map(suggestionLabel), at: Date.now(), expiresAt: Date.now() + wait, managed: !!opts.managed, done,
    })
    notifyPages()
    // a linked PC tells the phone app (a push if the app is not open): who waits, and for which tool — nothing more
    cachedState().then((s) => {
      const a = s.approvals.find((x) => x.id === id)
      if (!a || !a.session) return
      cloud.notify({
        kind: a.questions ? 'question' : a.plan ? 'plan' : 'approval',
        agent: { name: a.session, managed: !!a.managed, ...(a.session.startsWith('monitor-') ? { agentId: a.session.slice(8) } : {}) },
        title: a.nickKo || a.nick || a.short || a.session, tool: a.tool,
      })
    }).catch(() => {})
  })
}

// A short label for a suggestion, whatever its shape: its own description, else the rules it would add.
function suggestionLabel(s = {}) {
  if (s.description) return clip(s.description, 120)
  const rules = Array.isArray(s.rules) ? s.rules : s.rule ? [s.rule] : []
  const text = rules.map((r) => typeof r === 'string' ? r : (r.toolName || '') + (r.ruleContent ? `(${r.ruleContent})` : '')).filter(Boolean)
  if (text.length) return clip(text.join(', '), 120)
  if (Array.isArray(s.directories)) return clip(s.directories.join(', '), 120)
  return clip(s.mode || s.type || 'this kind of request', 60)
}

const decision = (d) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } })
function decide(id, answer, pick, extra) {
  const p = pending.get(id)
  if (!p) return false
  if (answer === 'allow') p.done(decision({ behavior: 'allow' }), 'allowed on the page')
  else if (answer === 'always' && p.suggestions[pick]) p.done(decision({ behavior: 'allow', updatedPermissions: [p.suggestions[pick]] }), 'always-allowed on the page')
  else if (answer === 'answers' && p.input && Array.isArray(p.input.questions)) {
    const answers = {}
    for (const a of Array.isArray(extra) ? extra : []) {
      const q = p.input.questions[Number(a?.i)]
      const v = clip(a?.value, 1000)
      if (q && q.question && v) answers[q.question] = v
    }
    if (!Object.keys(answers).length) return false
    p.done(decision({ behavior: 'allow', updatedInput: { ...p.input, answers } }), 'answered on the page')
  }
  else if (answer === 'deny') p.done(decision({ behavior: 'deny', message: 'Denied from the agent monitor' }), 'denied on the page')
  else if (answer === 'stop') p.done(decision({ behavior: 'deny', message: 'Denied from the agent monitor — stopped to wait for the user', interrupt: true }), 'denied and stopped on the page')
  else { handBack(p.sessionId); p.done({}, 'sent back to VS Code') }   // "answer in VS Code" — the normal prompt appears right away
  return true
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}
const sameToken = (v) => typeof v === 'string' && v.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(TOKEN))

/* ── Live conversation view ─────────────────── */

// The detail dialog can follow one session's conversation as it happens, like the VS Code panel.
// It is streamed straight from the transcript file and never stored or logged, and personal data is masked
// on the way out: e-mail addresses, phone numbers, resident registration and card numbers, and anything
// that looks like a key or token.
const MASKS = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\b\d{6}-?[1-8]\d{6}\b/g, '[id-number]'],
  [/\b(?:\d[ -]?){13,16}\b/g, '[card]'],
  [/(?:\+?82[- ]?)?0?1[016789][- .]?\d{3,4}[- .]?\d{4}\b/g, '[phone]'],
  [/\b0\d{1,2}[- .]\d{3,4}[- .]\d{4}\b/g, '[phone]'],
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, '[secret]'],
  [/\b(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{40,}={0,2}/g, '[secret]'],
  [/((?:password|passwd|pwd|secret|token|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[secret]'],
]
const mask = (text) => MASKS.reduce((t, [re, to]) => t.replace(re, to), String(text ?? ''))
const LIVE_TEXT = 4000, LIVE_RESULT = 3000, LIVE_INPUT = 8000, LIVE_FIRST = 80

// One transcript line → zero or more view entries (the main conversation only; subagents' own chains are skipped).
function liveEntries(o, sidechain = false) {
  if (!o || o.isMeta || (!sidechain && o.isSidechain)) return []
  const at = o.timestamp ? Date.parse(o.timestamp) : 0
  const out = []
  const content = o.message?.content
  if (o.type === 'user') {
    const pushUser = (raw) => { const e = userEntry(raw, at); if (e) out.push({ ...e, text: mask(clip2(e.text, LIVE_TEXT)) }) }
    if (typeof content === 'string') pushUser(content)
    else if (Array.isArray(content)) for (const c of content) {
      if (c?.type === 'text' && c.text?.trim()) pushUser(c.text)
      if (c?.type === 'tool_result') {
        const raw = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x) => x?.type === 'text' ? x.text : '[' + (x?.type || 'data') + ']').join('\n') : ''
        // images in it (a screenshot read with Read…) go by count only: the page fetches them from /img/result
        const images = Array.isArray(c.content) ? c.content.filter((x) => x?.type === 'image').length : 0
        out.push({ role: 'result', id: String(c.tool_use_id || ''), error: !!c.is_error, text: mask(clip2(raw, LIVE_RESULT)), ...(images ? { images } : {}), at })
      }
    }
  } else if (o.type === 'assistant' && Array.isArray(content)) {
    for (const c of content) {
      if (c?.type === 'text' && c.text?.trim()) out.push({ role: 'assistant', text: mask(clip2(c.text, LIVE_TEXT)), at })
      if (c?.type === 'tool_use') out.push({ role: 'tool', id: String(c.id || ''), name: String(c.name || ''), action: describe(c.name, c.input), input: mask(clip2(JSON.stringify(c.input ?? {}, null, 1), LIVE_INPUT)), at })
    }
  }
  return out
}
// What Claude Code writes into the user side besides what a person typed — reminders, task notices, hook
// feedback, slash-command echoes — is reduced to a short note, or dropped, so the view reads like the chat.
const tagText = (text, tag) => { const m = String(text).match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>')); return m ? m[1].trim() : '' }
// an attachment this server saved, as the page may name it: "<session dir>/<stored name>"; anything else is not one
const uploadRef = (p) => { const m = String(p).replace(/\\/g, '/').match(/\/uploads\/([0-9a-z]{8})\/([^/]+)$/i); return m ? m[1] + '/' + m[2] : null }
// the list the monitor appends to a message it delivers: the text before it, and the files' names and references
function withAttached(text) {
  const [body, list = ''] = String(text).split(/\n?Attached files \(open them with the Read tool\):\n/)
  const paths = list.split('\n').map((l) => l.trim()).filter(Boolean)
  return { body, files: paths.map((p) => p.split('/').pop().replace(/^[0-9a-z]+-/, '')), refs: paths.map(uploadRef) }
}
function userEntry(raw, at) {
  let text = String(raw ?? '')
  // a message sent from this page, delivered by hooks/inbox.mjs
  const fromPage = text.match(/Message\(s\) the user typed on the agent monitor page[^\n]*\n([\s\S]*?)(?:<\/system-reminder>|$)/)
  if (fromPage) {
    // the paths of attached files become their names; the view shows them as chips
    const { body, files, refs } = withAttached(fromPage[1])
    const lines = body.split('\n').map((l) => l.replace(/^- /, '').trim()).filter(Boolean)
    return lines.length || files.length ? { role: 'monitor', text: lines.join('\n'), files, refs, at } : null
  }
  if (text.includes('<task-notification>')) {
    const summary = tagText(text, 'summary') || tagText(text, 'status')
    return { role: 'note', text: '⚙ ' + (summary || 'background task update'), at }
  }
  const command = tagText(text, 'command-name')
  if (command) return { role: 'note', text: '⌘ ' + command + (tagText(text, 'command-args') ? ' ' + tagText(text, 'command-args') : ''), at }
  const bash = tagText(text, 'bash-input')
  if (bash) return { role: 'note', text: '! ' + bash, at }
  text = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(local-command-[a-z]+|bash-std(?:out|err)|command-message|command-args)>[\s\S]*?<\/\1>/g, '')
    .trim()
  if (!text) return null
  // "[Request interrupted by user]" and similar stay, as notes
  if (/^\[[^\]]{3,80}\]$/.test(text)) return { role: 'note', text, at }
  // a monitor agent's message keeps its attachments in the transcript as that same list
  if (/Attached files \(open them with the Read tool\):/.test(text)) { const { body, files, refs } = withAttached(text); return { role: 'user', text: body.trim(), files, refs, at } }
  return { role: 'user', text, at }
}

// like clip() but keeps line breaks
const clip2 = (v, n) => { const t = String(v ?? ''); return t.length > n ? t.slice(0, n) + '\n… (' + (t.length - n) + ' more characters)' : t }

// An image a tool returned (a screenshot read with Read, an image an MCP tool made), from the session's transcript, for
// the conversation view. Not under /api/, so the phone app's relay never carries it: an image cannot be masked, so it
// is shown on this PC only. Nothing is kept beyond a few recent ones in memory.
const resultImages = new Map()   // transcript + tool id → [{ type, data }]
async function resultImage(req, res, url) {
  const name = url.searchParams.get('session') || '', id = url.searchParams.get('tool') || '', i = Number(url.searchParams.get('i')) || 0
  if (!/^[\w-]{1,80}$/.test(id)) { res.writeHead(400).end(); return }
  const target = (await readRegistry()).find((x) => x.name === name) || agents?.sessions().find((x) => x.name === name)
  const file = target && await findTranscript(target.sessionId)
  if (!file) { res.writeHead(404).end(); return }
  const key = file + '\n' + id
  let list = resultImages.get(key)
  if (!list) {
    list = []
    const needle = '"tool_use_id":"' + id + '"'
    // newest first: the result is usually near the end
    const text = await fsp.readFile(file, 'utf8')
    for (const l of text.split('\n').reverse()) {
      if (!l.includes(needle)) continue
      try {
        for (const c of JSON.parse(l).message?.content || []) {
          if (c?.type === 'tool_result' && c.tool_use_id === id && Array.isArray(c.content)) list = c.content.filter((x) => x?.type === 'image' && x.source?.type === 'base64').map((x) => x.source)
        }
      } catch {}
      if (list.length) break
    }
    resultImages.set(key, list)
    if (resultImages.size > 30) resultImages.delete(resultImages.keys().next().value)
  }
  const img = list[i]
  const type = /^image\/(png|jpeg|gif|webp)$/.test(img?.media_type || '') ? img.media_type : ''
  if (!type) { res.writeHead(404).end(); return }
  res.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' })
  res.end(Buffer.from(String(img.data || ''), 'base64'))
}

async function streamSession(req, res, name, sub) {
  const target = (await readRegistry()).find((x) => x.name === name) || agents?.sessions().find((x) => x.name === name)
  let file = target && await findTranscript(target.sessionId)
  if (file && sub) file = /^[a-z0-9]+$/.test(sub) ? path.join(file.replace(/\.jsonl$/, ''), 'subagents', 'agent-' + sub + '.jsonl') : null
  if (file && !fs.existsSync(file)) file = null
  const side = !!sub
  if (!file) { res.writeHead(404).end(); return }
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
  const send = (event, data) => { try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n') } catch {} }
  const { lines, size } = await tailLines(file)
  const first = []
  for (const l of lines) { try { first.push(...liveEntries(JSON.parse(l), side)) } catch {} }
  send('init', first.slice(-LIVE_FIRST))
  let pos = size, rest = ''
  let busy = false
  const timer = setInterval(async () => {
    if (busy) return
    busy = true
    try {
      const st = await fsp.stat(file)
      if (st.size < pos) { pos = st.size; rest = '' }   // rewritten — start over from the end
      if (st.size > pos) {
        const fh = await fsp.open(file, 'r')
        try {
          const n = Math.min(st.size - pos, 4 * 1024 * 1024)
          const buf = Buffer.alloc(n)
          await fh.read(buf, 0, n, pos)
          pos += n
          const parts = (rest + buf.toString('utf8')).split('\n')
          rest = parts.pop()
          const add = []
          for (const l of parts) { if (l) try { add.push(...liveEntries(JSON.parse(l), side)) } catch {} }
          if (add.length) send('add', add)
        } finally { await fh.close() }
      }
    } catch {}
    busy = false
  }, 1000)
  const ping = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 15000)
  req.on('close', () => { clearInterval(timer); clearInterval(ping) })
}

/* ── Messages from the page to an agent ───────── */

// hooks/inbox.mjs runs in the background after each turn (Stop hook with asyncRewake) and waits here.
// A message typed on the page is handed to that waiter, which prints it and exits 2 — Claude Code then wakes
// the session with the text. Messages live in memory only; one waiter per session (a newer one replaces it).
const INBOX_WAIT_MS = 25 * 60 * 1000
const inbox = new Map()                // sessionId → [{ text, at }]
const waiters = new Map()              // sessionId → (reply) => void

function deliver(sessionId) {
  const w = waiters.get(sessionId), q = inbox.get(sessionId)
  if (!w || !q || !q.length) return
  waiters.delete(sessionId)
  inbox.delete(sessionId)
  w({ messages: q })
}
function waitForMessage(sessionId) {
  return new Promise((resolve) => {
    const old = waiters.get(sessionId)
    if (old) old({ superseded: true })
    const timer = setTimeout(() => { if (waiters.get(sessionId) === reply) waiters.delete(sessionId); resolve({}) }, INBOX_WAIT_MS)
    const reply = (r) => { clearTimeout(timer); resolve(r) }
    waiters.set(sessionId, reply)
    deliver(sessionId)
    notifyPages()
  })
}
/* Files attached on the page: kept in .runtime/uploads only until the agent has had time to read them —
   removed after a day, and all of them whenever the server starts. The message carries their paths. */
const UPLOADS = path.join(RUNTIME, 'uploads')
const UPLOAD_MAX = 20 * 1024 * 1024, UPLOAD_KEEP_MS = 24 * 60 * 60 * 1000, FILES_PER_MESSAGE = 5
function cleanUploads(all) {
  let dirs = []
  try { dirs = fs.readdirSync(UPLOADS) } catch { return }
  for (const d of dirs) {
    const dir = path.join(UPLOADS, d)
    let files = []
    try { files = fs.readdirSync(dir) } catch { continue }
    for (const file of files) {
      const p = path.join(dir, file)
      try { if (all || Date.now() - fs.statSync(p).mtimeMs > UPLOAD_KEEP_MS) fs.unlinkSync(p) } catch {}
    }
    try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir) } catch {}
  }
}
const safeName = (n) => String(n || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(-120) || 'file'
async function saveUpload(req, url) {
  const name = String(url.searchParams.get('session') || '')
  const target = (await readRegistry()).find((x) => x.name === name) || agents?.sessions().find((x) => x.name === name)
    // the assistant is not among the agents shown; its files go in a folder of its own until it has a session id
    || (name === 'monitor-assistant' && agents?.assistantState() ? { sessionId: agents.assistantState().sessionId || 'assistant' } : null)
  if (!target) return [404, {}]
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > UPLOAD_MAX) return [413, {}]
    chunks.push(c)
  }
  if (!size) return [400, {}]
  const dir = path.join(UPLOADS, target.sessionId.slice(0, 8))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, Date.now().toString(36) + '-' + safeName(url.searchParams.get('name')))
  await fsp.writeFile(file, Buffer.concat(chunks))
  return [200, { path: file.replace(/\\/g, '/'), size }]
}
// an attachment read back for the page's preview: only a file this server saved, never anything that could run as a page
const UPLOAD_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.pdf': 'application/pdf' }
const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|js|mjs|cjs|ts|tsx|jsx|vue|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|swift|php|sh|ps1|bat|sql|csv|tsv|log|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|scss|less|svg|diff|patch)$/i
function readUpload(res, ref) {
  const m = /^([0-9a-z]{8})\/([^/\\]+)$/i.exec(String(ref || ''))
  const file = m && path.resolve(UPLOADS, m[1], m[2])
  // a file, not a folder: "<dir>/." passes the path check, and reading a folder would throw
  let st = null
  try { st = file && file.startsWith(path.resolve(UPLOADS) + path.sep) ? fs.statSync(file) : null } catch {}
  if (!st || !st.isFile()) { res.writeHead(404).end(); return }
  const ext = path.extname(file).toLowerCase()
  const type = UPLOAD_TYPES[ext] || (TEXT_EXT.test(file) ? 'text/plain; charset=utf-8' : 'application/octet-stream')
  res.writeHead(200, {
    'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    // opened on its own it still cannot run anything (an SVG or HTML file is sent as text anyway)
    'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    'content-disposition': "inline; filename*=UTF-8''" + encodeURIComponent(m[2].replace(/^[0-9a-z]+-/, '')),
  })
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res)
}
// only files this server saved can be named in a message
function attachedPaths(list) {
  const root = path.resolve(UPLOADS) + path.sep
  return (Array.isArray(list) ? list : []).slice(0, FILES_PER_MESSAGE).map((p) => path.resolve(String(p)))
    .filter((p) => p.startsWith(root) && fs.existsSync(p)).map((p) => p.replace(/\\/g, '/'))
}

// "Take over in the monitor": a VS Code session's conversation carried on as a monitor agent (a copy, see
// agents.fork), in its folder, under the name the page shows for it and with its permission mode
async function forkSession(body) {
  const target = (await readRegistry()).find((x) => x.name === String(body.session || ''))
  if (!target) return [404, {}]
  if (agents.byAgentSession(target.sessionId)) return [400, { error: 'already a monitor agent' }]
  // once is enough: a second copy of the same conversation would be a third agent working on it
  const copy = agents.sessions(Date.now()).find((m) => m.forkedFrom === target.sessionId)
  if (copy) return [409, { error: 'already taken over', name: copy.name }]
  const shown = (await cachedState()).projects.flatMap((p) => p.sessions).find((x) => x.name === target.name)
  // not in the middle of a turn: the copy would start from a transcript with a tool call still open
  if (shown?.state === 'working') return [409, { error: 'working' }]
  return agents.fork({ cwd: target.cwd, sessionId: target.sessionId, nick: { en: shown?.nick || '', ko: shown?.nickKo || '' }, desc: shown?.desc || '', mode: modes.get(target.sessionId)?.mode || 'default' })
}

/* ── A folder's earlier conversations, to carry one on as a new agent ── */

// Claude Code keeps a folder's transcripts in ~/.claude/projects/<its path, every other character a dash>. Listed: the
// newest 30 with anything said in them, each with its title (Claude's own, or the first thing asked, masked) and when
// it last changed. Nothing of it is kept.
const transcriptDirOf = (cwd) => path.join(PROJECTS_DIR, path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'))
async function titleOf(file, size) {
  const fh = await fsp.open(file, 'r')
  try {
    const read = async (pos, n) => { const b = Buffer.alloc(n); await fh.read(b, 0, n, pos); return b.toString('utf8').split('\n') }
    const n = Math.min(size, 65536)
    for (const l of (await read(size - n, n)).reverse()) {
      if (!l.includes('-title"')) continue
      try { const o = JSON.parse(l); const v = o.customTitle || o.aiTitle; if (v) return mask(clip(String(v), 80)) } catch {}
    }
    for (const l of await read(0, n)) {
      if (!l.includes('"type":"user"')) continue
      try {
        const o = JSON.parse(l), c = o.message?.content
        const v = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text).join(' ') : ''
        if (v && !o.isMeta && !v.startsWith('<')) return mask(clip(v.replace(/\s+/g, ' ').trim(), 80))
      } catch {}
    }
    return ''
  } finally { await fh.close() }
}
async function pastSessions(body) {
  const dir = transcriptDirOf(String(body.cwd || ''))
  let files = []
  try { files = (await fsp.readdir(dir)).filter((f) => /^[0-9a-f-]{36}\.jsonl$/i.test(f)) } catch { return [200, { list: [] }] }
  const stats = (await Promise.all(files.map((f) => fsp.stat(path.join(dir, f)).then((st) => ({ f, at: st.mtimeMs, size: st.size }), () => null)))).filter(Boolean)
  const live = new Set((await readRegistry()).map((x) => x.sessionId))
  const list = []
  for (const s of stats.sort((x, y) => y.at - x.at)) {
    if (list.length >= 30) break
    let title = ''
    try { title = await titleOf(path.join(dir, s.f), s.size) } catch {}
    if (!title) continue   // nothing was said in it
    const sessionId = s.f.slice(0, -6)
    list.push({ sessionId, at: s.at, title, live: live.has(sessionId), inUse: !!agents.byAgentSession(sessionId) })
  }
  return [200, { list }]
}
async function resumeSession(body) {
  const cwd = path.resolve(String(body.cwd || '')), sessionId = String(body.sessionId || '')
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return [400, {}]
  if (!fs.existsSync(path.join(transcriptDirOf(cwd), sessionId + '.jsonl'))) return [404, {}]
  if (agents.byAgentSession(sessionId)) return [409, { error: 'already open' }]
  // still open in VS Code (or a terminal): copied, as a take-over is, so the two never write to one transcript
  const open = (await readRegistry()).find((x) => x.sessionId === sessionId)
  if (open) return forkSession({ session: open.name })
  return agents.adopt({ cwd, sessionId, note: 'an earlier conversation of this folder, carried on' })
}

async function sendMessage(body) {
  const name = String(body.session || '')
  const files = attachedPaths(body.files)
  let text = clip(body.text, 2000)
  if (files.length) text = (text ? text + '\n' : '') + 'Attached files (open them with the Read tool):\n' + files.map((p) => '  ' + p).join('\n')
  if (!name || !text) return 400
  const target = (await readRegistry()).find((x) => x.name === name)
  if (!target) return 404
  queueText(target.sessionId, text)
  return 200
}
function queueText(sessionId, text) {
  const q = inbox.get(sessionId) || []
  q.push({ text, at: Date.now() })
  inbox.set(sessionId, q.slice(-10))
  deliver(sessionId)
  notifyPages()
}

/* ── A command typed on the page (a message starting with !) ── */

// Like `!` in Claude Code: the person at this PC runs a command in the agent's folder, with their own rights,
// and the agent gets what it printed. It is typed by that person, so no permission check applies — the token
// the page holds is what keeps any other page from doing this. Nothing of it is written to disk.
const RUN_TIMEOUT_MS = 2 * 60 * 1000, RUN_KEEP = 1024 * 1024, RUN_TO_AGENT = 12000, RUN_TO_PAGE = 60000
let runShell = null
function userShell() {
  if (runShell) return runShell
  if (process.platform !== 'win32') return (runShell = { exe: process.env.SHELL || '/bin/sh', args: ['-lc'], name: path.basename(process.env.SHELL || 'sh') })
  // Git Bash, as Claude Code uses on Windows (never System32\bash.exe, which is WSL); else PowerShell
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const tries = [process.env.CLAUDE_CODE_GIT_BASH_PATH, path.join(pf, 'Git', 'bin', 'bash.exe'), path.join(process.env['ProgramFiles(x86)'] || pf, 'Git', 'bin', 'bash.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Git', 'bin', 'bash.exe')]
  try { for (const line of execFileSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)) if (line.trim()) tries.push(path.join(path.dirname(line.trim()), '..', 'bin', 'bash.exe')) } catch {}
  for (const p of tries) if (p && fs.existsSync(p)) return (runShell = { exe: path.resolve(p), args: ['-c'], name: 'bash' })
  return (runShell = { exe: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command'], name: 'powershell', prefix: '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' })
}
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g
const keepEnds = (t, n) => (t.length <= n ? t : t.slice(0, n / 4) + '\n… (' + (t.length - n) + ' characters left out) …\n' + t.slice(-(n * 3) / 4))
function runIn(cwd, command) {
  const sh = userShell(), started = Date.now()
  return new Promise((resolve) => {
    let child
    try { child = spawn(sh.exe, [...sh.args, (sh.prefix || '') + command], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: process.env, detached: process.platform !== 'win32' }) }
    catch (e) { resolve({ code: null, error: String(e.message || e), stdout: '', stderr: '', ms: 0, shell: sh.name }); return }
    const out = { stdout: [], stderr: [] }, size = { stdout: 0, stderr: 0 }
    for (const k of ['stdout', 'stderr']) child[k].on('data', (c) => { if (size[k] < RUN_KEEP) { out[k].push(c); size[k] += c.length } })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
      else { try { process.kill(-child.pid, 'SIGTERM') } catch {} }
    }, RUN_TIMEOUT_MS)
    let finished = false
    const done = (code, error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      const text = (k) => Buffer.concat(out[k]).toString('utf8').replace(ANSI, '').replace(/\r\n?/g, '\n')
      resolve({ code, error, timedOut, stdout: text('stdout'), stderr: text('stderr'), ms: Date.now() - started, shell: sh.name })
    }
    child.on('error', (e) => done(null, String(e.message || e)))
    child.on('close', (code) => done(code, null))
    // something the command left running in the background (an ssh-agent, a server) can hold the output open:
    // once the command itself has ended, wait a moment for the rest and then answer anyway
    child.on('exit', (code) => setTimeout(() => done(code, null), 500))
  })
}
async function runCommand(body) {
  const command = String(body.command || '').trim()
  if (!command || command.length > 4000) return [400, {}]
  let cwd = null, target = null
  if (body.id) cwd = agents.cwdOf(body.id)
  else {
    target = (await readRegistry()).find((x) => x.name === String(body.session || ''))
    cwd = target?.cwd || null
  }
  if (!cwd || !fs.existsSync(cwd)) return [404, {}]
  const r = await runIn(cwd, command)
  // handed over the way Claude Code shows a command the user ran with !
  const status = r.error ? 'could not start: ' + r.error : r.timedOut ? 'stopped after ' + RUN_TIMEOUT_MS / 1000 + ' s' : 'exit code ' + r.code
  const text = 'I ran this command myself from the agent monitor, in ' + cwd.replace(/\\/g, '/') + ' (' + r.shell + ', ' + status + ', ' + (r.ms / 1000).toFixed(1) + ' s):\n' +
    '<bash-input>' + command + '</bash-input>\n<bash-stdout>' + keepEnds(r.stdout, RUN_TO_AGENT) + '</bash-stdout>' + (r.stderr ? '<bash-stderr>' + keepEnds(r.stderr, RUN_TO_AGENT / 2) + '</bash-stderr>' : '')
  const delivered = body.id ? agents.sendText(body.id, text) : (queueText(target.sessionId, text), true)
  return [200, { code: r.code, error: r.error, timedOut: r.timedOut, ms: r.ms, shell: r.shell, stdout: keepEnds(r.stdout, RUN_TO_PAGE), stderr: keepEnds(r.stderr, RUN_TO_PAGE / 2), delivered }]
}

/* ── Board edits from the page ────────────────── */

// The leader writes the same file, so every edit re-reads it, checks that the item the page meant is still
// there (by position and title), changes only that, and replaces the file in one step.
const BOARD_KEY = /^[a-z0-9][a-z0-9._-]{0,80}$/
async function editBoard(body) {
  const key = String(body.project || '').toLowerCase()
  if (!BOARD_KEY.test(key)) return 400
  const file = path.join(BOARDS_DIR, key + '.json')
  let b
  try { b = JSON.parse(await fsp.readFile(file, 'utf8')) } catch (e) {
    if (e.code !== 'ENOENT' || body.op !== 'add') return e.code === 'ENOENT' ? 404 : 409
    b = { tasks: [], decisions: [] }
  }
  if (!Array.isArray(b.tasks)) b.tasks = []
  if (!Array.isArray(b.decisions)) b.decisions = []
  const now = new Date().toISOString()
  const same = (item, title) => item && String(item.title) === String(title)
  if (body.op === 'answer') {
    const d = b.decisions[Number(body.index)]
    const answer = clip(body.answer, 1000)
    if (!same(d, body.title)) return 409
    if (!answer) return 400
    Object.assign(d, { status: 'answered', answer, answeredAt: now, answeredBy: 'monitor' })
  } else if (body.op === 'reorder') {
    // body.order: task positions in their new queue order, e.g. [4, 2, 7]
    const list = Array.isArray(body.order) ? body.order.map(Number) : []
    const titles = Array.isArray(body.titles) ? body.titles : []
    if (!list.length || list.some((i, n) => !same(b.tasks[i], titles[n]))) return 409
    list.forEach((i, n) => { b.tasks[i].order = n + 1 })
  } else if (body.op === 'add') {
    const title = clip(body.title, 300)
    if (!title) return 400
    const maxOrder = Math.max(0, ...b.tasks.map((x) => Number(x.order) || 0))
    const task = { title, status: 'queued', order: maxOrder + 1, addedBy: 'monitor', addedAt: now }
    if (body.session) task.session = clip(body.session, 80)
    b.tasks.push(task)
  } else return 400
  b.updatedAt = now
  fs.mkdirSync(BOARDS_DIR, { recursive: true })
  const tmp = file + '.' + process.pid + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(b, null, 2) + '\n')
  await fsp.rename(tmp, file)
  notifyPages()
  return 200
}

const slash = (p) => p.replace(/\\/g, '/')
async function listDirs(p) {
  if (!p) {
    // the starting point: the drives on Windows, the home folder elsewhere
    if (process.platform === 'win32') {
      const drives = []
      for (const c of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (fs.existsSync(c + ':\\')) drives.push(c + ':/')
      return { path: '', parent: null, dirs: drives.map((d) => ({ name: d, path: d })) }
    }
    p = os.homedir()
  }
  const dir = path.resolve(p)
  let entries = []
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return { path: slash(dir), parent: null, dirs: [], error: 'cannot open' } }
  const dirs = entries.filter((e) => e.isDirectory() && !/^[.$]/.test(e.name) && !/^(node_modules|System Volume Information)$/i.test(e.name))
    .map((e) => e.name).sort((a, b) => a.localeCompare(b)).slice(0, 500)
    .map((name) => ({ name, path: slash(path.join(dir, name)) }))
  const up = path.dirname(dir)
  return { path: slash(dir), parent: up === dir ? '' : slash(up), dirs }
}

// a session's conversation from its transcript, in the agent view's own shapes (masked like the live view)
async function transcriptEvents(sessionId) {
  const file = await findTranscript(sessionId)
  if (!file) return []
  const { lines } = await tailLines(file)
  const out = []
  let n = 0
  for (const l of lines) {
    let o
    try { o = JSON.parse(l) } catch { continue }
    for (const e of liveEntries(o)) {
      if (e.role === 'assistant') out.push({ kind: 'block', msg: 'h' + n++, index: 0, type: 'text', text: e.text, done: true, at: e.at })
      else if (e.role === 'user' || e.role === 'monitor') out.push({ kind: 'user', text: e.text, files: e.files || [], refs: e.refs || [], at: e.at })
      else if (e.role === 'tool') out.push({ kind: 'tool', id: e.id, name: e.name, action: e.action, input: e.input, at: e.at })
      else if (e.role === 'result') out.push({ kind: 'result', id: e.id, error: e.error, text: e.text, ...(e.images ? { images: e.images } : {}), at: e.at })
      else if (e.role === 'note') out.push({ kind: 'note', text: e.text, at: e.at })
    }
  }
  return out.slice(-300)
}
const agents = createAgents({
  root: ROOT, dataDir: DATA, mask, clip, clip2, describe, notifyPages, projectRoot, projectKey, attachedPaths,
  askPage: (input, opts) => hookEvent(input, null, opts),
  configPath: loadConfig().claudePath || '',
  // an agent brought back after a restart shows its conversation from the transcript
  historyOf: transcriptEvents,
})
// the monitor's assistant behind the floating chat button (assistant.mjs)
const assistant = createAssistant({
  agents, dataDir: DATA, state: () => cachedState(), notifyPages,
  decide: (id, answer) => decide(id, answer), sendTo: (session, text) => sendMessage({ session, text }),
  requestSession: (id) => pending.get(id)?.sessionId,
  lang: () => LANGS[pageLang] || '',
  // what the person lets it do (config.json "assistant"): how far it may answer requests, what it is told about
  options: () => loadConfig().assistant,
  saveOptions: (o) => editConfig((c) => { c.assistant = o }),
  // whether Claude Code is logged in, and to whom only as a hash kept in memory: no address or name reaches the model
  login: async () => {
    const i = await account.info(false)
    return { loggedIn: !!i.loggedIn, plan: i.plan || null, who: i.email ? crypto.createHash('sha256').update('crew:' + i.email).digest('hex').slice(0, 12) : '' }
  },
  // the last of an agent's conversation, for the assistant to see what it said and did
  conversation: async (name) => {
    const t = (await readRegistry()).find((x) => x.name === name) || agents.sessions(Date.now()).find((x) => x.name === name)
    return t?.sessionId ? transcriptEvents(t.sessionId) : []
  },
})
const processes = createProcesses({ mask, clip })
// every session's process, with what the page knows of it, for the processes dialog and for ending one of its children
async function processRoots() {
  const st = await cachedState()
  const known = new Map(st.projects.flatMap((p) => p.sessions.map((x) => [x.name, { name: x.name, nick: x.nick, nickKo: x.nickKo, project: p.key, isLeader: !!x.isLeader, managed: !!x.managed, state: x.state }])))
  const roots = (await readRegistry()).filter((r) => known.has(r.name)).map((r) => ({ pid: r.pid, info: known.get(r.name) }))
  for (const m of agents ? agents.sessions(Date.now()) : []) if (m.pid && known.has(m.name)) roots.push({ pid: m.pid, info: known.get(m.name) })
  return roots
}
const account = createAccount({ claudeExecutable: agents.claudeExecutable, dataDir: DATA })

/* ── HTTP ─────────────────────────────────────── */

const INDEX = path.join(ROOT, 'public', 'index.html')
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '' } catch { return '' } })()
// this PC linked to an account on crew.elopstudio.com
// the mobile app's calls come through the relay and are answered by this server's own API, with its token added there
const cloud = createCloud({ dataDir: DATA, version: VERSION, notifyPages, local: { port: PORT, token: () => TOKEN } })
// the about dialog's files: the maker's logo for light and dark, and the licence
const ABOUT_FILES = {
  '/brand/elop-logo-black.png': [path.join(ROOT, 'docs', 'elop-logo-black.png'), 'image/png'],
  '/brand/elop-logo-white.png': [path.join(ROOT, 'docs', 'elop-logo-white.png'), 'image/png'],
  '/license.txt': [path.join(ROOT, 'LICENSE'), 'text/plain; charset=utf-8'],
}
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
    const json = (code, o) => res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(o))
    if (req.method === 'POST') {
      // Every write needs the token in a custom header. Another web page cannot read the token, and a
      // cross-origin request with a custom header needs a CORS preflight this server never answers.
      if (!sameToken(req.headers['x-monitor-token'])) { res.writeHead(403).end(); return }
      if (url.pathname === '/api/upload') { const [code, o] = await saveUpload(req, url); json(code, o); return }
      const body = await readBody(req)
      if (url.pathname === '/hook/prompt') { json(200, await agents.prompt(body)); return }
      if (url.pathname === '/hook/assistant') { json(200, { text: await assistant.tool(body) }); return }
      if (url.pathname === '/api/assistant/start') { json(200, await assistant.start()); return }
      if (url.pathname === '/api/assistant/settings') { json(await assistant.setOptions(body), {}); return }
      if (url.pathname.startsWith('/api/account/')) { const [code, o] = await account.handle(url); json(code, o); return }
      if (url.pathname.startsWith('/api/cloud/')) { const [code, o] = await cloud.handle(url); json(code, o); return }
      if (url.pathname === '/api/agents/fork') { const [code, o] = await forkSession(body); json(code, o); return }
      if (url.pathname === '/api/agents/past') { const [code, o] = await pastSessions(body); json(code, o); return }
      if (url.pathname === '/api/agents/resume') { const [code, o] = await resumeSession(body); json(code, o); return }
      if (url.pathname.startsWith('/api/agents/')) { const [code, o] = await agents.handle(url, body); json(code, o); return }
      if (url.pathname === '/hook') { const r = await hookEvent(body, res); if (!res.writableEnded && !res.destroyed) json(200, r); return }
      if (url.pathname === '/hook/wait') { json(200, await waitForMessage(String(body.session_id || ''))); return }
      if (url.pathname === '/api/message') { json(await sendMessage(body), {}); return }
      if (url.pathname === '/api/run') { const [code, o] = await runCommand(body); json(code, o); return }
      if (url.pathname === '/api/look') { json(await saveLook(body), {}); return }
      if (url.pathname === '/api/project-name') { json(await saveProjectName(body), {}); return }
      if (url.pathname === '/api/order') { json(await saveOrder(body), {}); return }
      if (url.pathname === '/api/processes/kill') { json(await processes.kill(Number(body.pid), await processRoots()), {}); return }
      if (url.pathname === '/api/board') { const code = await editBoard(body); json(code, {}); return }
      if (url.pathname === '/api/decide') { json(decide(String(body.id || ''), String(body.answer || ''), Number(body.pick), body.answers) ? 200 : 404, {}); return }
      res.writeHead(404).end(); return
    }
    if (req.method !== 'GET') { res.writeHead(405).end(); return }
    if (url.pathname === '/api/dirs') {
      // folder picker for a new agent: sub-folders only, never files; needs the token like every other private read
      if (!sameToken(url.searchParams.get('token') || '')) { res.writeHead(403).end(); return }
      json(200, await listDirs(url.searchParams.get('path') || ''))
      return
    }
    if (url.pathname === '/api/account') {
      // the account's email is private like the conversations: the token is needed to read it
      if (!sameToken(url.searchParams.get('token') || '')) { res.writeHead(403).end(); return }
      json(200, await account.info(url.searchParams.get('fresh') === '1'))
      return
    }
    if (url.pathname === '/api/assistant') {
      if (!sameToken(url.searchParams.get('token') || '')) { res.writeHead(403).end(); return }
      json(200, { assistant: assistant.info() })
      return
    }
    if (url.pathname === '/api/cloud') {
      // whose account this PC is linked to is private too
      if (!sameToken(url.searchParams.get('token') || '')) { res.writeHead(403).end(); return }
      json(200, await cloud.info(url.searchParams.get('fresh') === '1'))
      return
    }
    if (url.pathname === '/api/processes') {
      // command lines are private like the conversations: the token is needed, and they come masked
      if (!sameToken(url.searchParams.get('token') || '')) { res.writeHead(403).end(); return }
      json(200, await processes.list(await processRoots()))
      return
    }
    if (url.pathname === '/api/upload-file') {
      if (!sameToken(url.searchParams.get('token') || '')) { res.writeHead(403).end(); return }
      readUpload(res, url.searchParams.get('ref'))
      return
    }
    if (url.pathname === '/api/agent-stream') {
      if (!sameToken(url.searchParams.get('token') || '')) { res.writeHead(403).end(); return }
      agents.stream(req, res, url.searchParams.get('id') || '')
      return
    }
    if (url.pathname === '/img/result') {
      if (!sameToken(url.searchParams.get('token') || '')) { res.writeHead(403).end(); return }
      await resultImage(req, res, url)
      return
    }
    if (url.pathname === '/api/live') {
      if (!sameToken(url.searchParams.get('token') || '')) { res.writeHead(403).end(); return }
      await streamSession(req, res, url.searchParams.get('session') || '', url.searchParams.get('sub') || '')
      return
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write('retry: 2000\n\n')
      streams.add(res)
      const ping = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 15000)
      req.on('close', () => { clearInterval(ping); streams.delete(res) })
      return
    }
    if (url.pathname === '/api/state') {
      if (url.searchParams.get('visible') === '1') lastViewAt = Date.now()
      if (LANGS[url.searchParams.get('lang')]) pageLang = url.searchParams.get('lang')
      json(200, await cachedState())
      return
    }
    if (ABOUT_FILES[url.pathname]) {
      const [file, type] = ABOUT_FILES[url.pathname]
      try { res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=3600' }).end(await fsp.readFile(file)) } catch { res.writeHead(404).end() }
      return
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      // the page gets the token inline; only a same-origin page can read it
      const html = (await fsp.readFile(INDEX, 'utf8')).replace('__MONITOR_TOKEN__', TOKEN)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html)
      return
    }
    res.writeHead(404).end()
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('error')
    console.error(e)
  }
})

cleanUploads(true)
setInterval(() => cleanUploads(false), 60 * 60 * 1000).unref()
server.listen(PORT, HOST, () => { writeRuntime(); console.log(`ELOP Crew → http://${HOST}:${PORT}`) })
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { agents.shutdown(); removeRuntime(); process.exit(0) })
// a host that runs the server in its own process (the desktop app) stops it this way before quitting
globalThis.agentMonitorShutdown = () => { agents.shutdown(); cloud.stop(); removeRuntime(); try { server.close() } catch {} }
