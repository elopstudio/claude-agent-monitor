#!/usr/bin/env node
// 로컬 Claude Code 세션 모니터 — 읽기 전용, 127.0.0.1 에만 뜬다.
//
// 읽는 것
//   ~/.claude/sessions/<pid>.json        세션 목록(이름·작업 폴더·busy/idle) — *.key 등 다른 파일은 열지 않는다
//   ~/.claude/projects/*/<id>.jsonl      대화 기록의 **끝부분만** — 세션 제목·마지막 도구 동작·세션 간 메시지 요약
//   ./boards/<프로젝트>.json             리더가 쓰는 작업판(선택)
// 내보내지 않는 것
//   사용자 프롬프트·대화 본문·도구 결과·메시지 본문·소켓 주소·토큰. 도구 동작은 이름과 짧은 표지(파일 이름, 명령 설명)만.
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
const TAIL_BYTES = 768 * 1024          // 대화 기록은 세션당 수십 MB — 끝부분만 읽는다
const WAITING_MS = 30 * 60 * 1000      // idle 이 이보다 짧으면 「대기」, 길면 「쉬는 중」
const MESSAGE_FEED = 14

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')) } catch { return {} }
}

/* ── 세션 목록 ─────────────────────────────── */

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

async function readRegistry() {
  let files = []
  try { files = await fsp.readdir(SESSIONS_DIR) } catch { return [] }
  const out = []
  for (const f of files) {
    if (!/^\d+\.json$/.test(f)) continue   // <pid>.json 만 — 키 파일은 열지 않는다
    try {
      const o = JSON.parse(await fsp.readFile(path.join(SESSIONS_DIR, f), 'utf8'))
      if (!o.sessionId || !o.pid) continue
      out.push({
        pid: o.pid, sessionId: o.sessionId, cwd: o.cwd || '', name: o.name || o.sessionId.slice(0, 8),
        status: o.status || 'unknown', statusUpdatedAt: o.statusUpdatedAt || o.updatedAt || 0,
        startedAt: o.startedAt || 0, kind: o.kind || '', socket: o.messagingSocketPath || '',
      })
    } catch { /* 쓰는 중인 파일 — 다음 폴링에 */ }
  }
  return out.filter((s) => alive(s.pid))
}

/* ── 프로젝트 = 작업 폴더의 git 루트 ─────────── */

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

/* ── 대화 기록 끝부분 ───────────────────────── */

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
    if (n < size) lines = lines.slice(1)   // 잘린 첫 줄
    return { lines: lines.filter(Boolean), size, mtimeMs }
  } finally { await fh.close() }
}

const clip = (s, n = 90) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const base = (p) => (typeof p === 'string' ? p.split(/[\\/]/).pop() : '')

function describe(name, input = {}) {
  switch (name) {
    case 'Bash': case 'PowerShell': return { kind: 'shell', text: clip(input.description || '명령 실행') }
    case 'Read': return { kind: 'read', text: '읽기 · ' + base(input.file_path) }
    case 'Edit': case 'NotebookEdit': return { kind: 'edit', text: '수정 · ' + base(input.file_path || input.notebook_path) }
    case 'Write': return { kind: 'edit', text: '쓰기 · ' + base(input.file_path) }
    case 'Grep': return { kind: 'search', text: '코드 검색' }
    case 'Glob': return { kind: 'search', text: '파일 찾기' }
    case 'SendMessage': return { kind: 'talk', text: '메시지 · ' + clip(input.summary || '', 60) }
    case 'ListAgents': return { kind: 'talk', text: '팀 둘러보기' }
    case 'Agent': return { kind: 'agent', text: '하위 에이전트 · ' + clip(input.description || '', 60) }
    case 'WebFetch': case 'WebSearch': return { kind: 'web', text: '웹 조회' }
    case 'Artifact': return { kind: 'publish', text: '페이지 게시' }
    case 'ArtifactData': return { kind: 'publish', text: '작업판 갱신' }
    case 'Skill': return { kind: 'skill', text: '스킬 · ' + clip(input.skill || '', 40) }
    case 'ToolSearch': return { kind: 'skill', text: '도구 불러오기' }
    case 'TaskStop': return { kind: 'shell', text: '백그라운드 작업 멈춤' }
    case 'Monitor': return { kind: 'shell', text: '진행 지켜보기' }
    default:
      if (name?.startsWith('mcp__')) return { kind: 'web', text: '연결 도구 · ' + clip(name.split('__')[1] || '', 30) }
      return { kind: 'other', text: clip(name || '작업', 40) }
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
      if (c.name === 'SendMessage' && c.input?.to && (c.input.message || c.input.summary)) {
        info.sent.push({ to: String(c.input.to), summary: clip(c.input.summary || '', 70), at: ts, pure: !c.input.message })
      }
    }
  }
  info.sent = info.sent.filter((m) => !m.pure)   // 알림 신청만 한 것은 대화가 아니다
  tailCache.set(sessionId, { size, mtimeMs, info })
  return info
}

/* ── 상태 조립 ─────────────────────────────── */

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
      // 답장은 주소(소켓)로 가므로 이름으로 되돌린다 — 주소 자체는 내보내지 않는다
      const sock = m.to.replace(/^uds:/, '')
      const to = bySocket.get(sock) || (m.to.startsWith('uds:') ? '(답장)' : m.to)
      p.messages.push({ from: s.name, to, summary: m.summary, at: m.at })
    }
  }

  const out = []
  for (const p of projects.values()) {
    const cfg = config.projects?.[p.key] || {}
    // 리더: 설정 > 메시지를 가장 많이 보낸 세션(3건 이상)
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

/* ── HTTP ──────────────────────────────────── */

const INDEX = path.join(ROOT, 'public', 'index.html')
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  try {
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
