// What the Claude Code sessions have started — shells, dev servers, MCP servers, background tasks — with their CPU and
// memory, so a slow PC can be traced to the agent behind it.
//
// One system query lists every process (it takes a few seconds on Windows, so it runs in the background, at most every
// few seconds, and only while someone asks); each session's own descendants are picked from it by parent id. Command
// lines are masked before they leave the server, and only a session's descendants — never the session itself or any
// other process — can be ended from the page.

import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const WIN = process.platform === 'win32'
const CORES = Math.max(1, os.cpus().length)
// the monitor's own helpers that Claude Code runs for every session: bundled apart, not counted as the agent's work
const HOOK = /[\\/]hooks[\\/](inbox|bridge|permission-mcp)\.mjs/i
const CONSOLE = /^(conhost|OpenConsole)\.exe$/i

function queryWindows() {
  const ps = "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,KernelModeTime,UserModeTime,CreationDate | ForEach-Object { [pscustomobject]@{ i = $_.ProcessId; p = $_.ParentProcessId; n = $_.Name; c = $_.CommandLine; m = [double]$_.WorkingSetSize; t = [double]($_.KernelModeTime + $_.UserModeTime) / 10000; s = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }) } } | ConvertTo-Json -Compress"
  return new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30000 }, (err, out) => {
    if (err) return resolve(null)
    try { const list = JSON.parse(String(out).replace(/^﻿/, '')); resolve((Array.isArray(list) ? list : [list]).map((x) => ({ pid: x.i, ppid: x.p, name: x.n || '', cmd: x.c || '', mem: x.m || 0, cpuMs: x.t || 0, start: Date.parse(x.s) || 0 }))) } catch { resolve(null) }
  }))
}
// ps: cumulative CPU as [[dd-]hh:]mm:ss, resident memory in KB
function queryPs() {
  const secs = (v) => { const [d, rest] = v.includes('-') ? v.split('-') : ['0', v]; return rest.split(':').map(Number).reduce((a, b) => a * 60 + b, 0) + Number(d) * 86400 }
  return new Promise((resolve) => execFile('ps', ['-A', '-o', 'pid=,ppid=,rss=,time=,etime=,args='], { maxBuffer: 64 * 1024 * 1024, timeout: 30000 }, (err, out) => {
    if (err) return resolve(null)
    const now = Date.now()
    resolve(String(out).split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/)).filter(Boolean).map((m) => ({
      pid: +m[1], ppid: +m[2], mem: +m[3] * 1024, cpuMs: secs(m[4]) * 1000, start: now - secs(m[5]) * 1000, cmd: m[6], name: path.basename(m[6].split(' ')[0]),
    })))
  }))
}

export function createProcesses({ mask, clip }) {
  let snap = null        // { at, list, byParent: Map(ppid → [proc]), byPid: Map }
  let running = null
  let before = new Map()  // pid → { cpuMs, at } from the last snapshot, for CPU use since then

  function refresh() {
    if (running) return running
    running = (WIN ? queryWindows() : queryPs()).then((list) => {
      if (!list) return snap
      const at = Date.now(), next = new Map()
      for (const p of list) {
        const b = before.get(p.pid)
        // CPU use since the last look, as a share of the whole machine (all cores = 100 %)
        p.cpu = b && at > b.at && p.cpuMs >= b.cpuMs ? Math.min(100, ((p.cpuMs - b.cpuMs) / (at - b.at)) * 100 / CORES) : null
        next.set(p.pid, { cpuMs: p.cpuMs, at })
      }
      before = next
      const byParent = new Map(), byPid = new Map()
      for (const p of list) { byPid.set(p.pid, p); if (!byParent.has(p.ppid)) byParent.set(p.ppid, []); byParent.get(p.ppid).push(p) }
      snap = { at, list, byParent, byPid }
      return snap
    }).finally(() => { running = null })
    return running
  }
  // the snapshot, asked again in the background once it is older than maxAge
  function current(maxAge) { if (!snap || Date.now() - snap.at > maxAge) refresh(); return snap }
  async function fresh(maxAge) { if (!snap || Date.now() - snap.at > maxAge) await refresh(); return snap }

  const kindOf = (p) => (CONSOLE.test(p.name) ? 'console' : HOOK.test(p.cmd) ? 'hook' : /^(bash|sh|zsh|pwsh|powershell|cmd)(\.exe)?$/i.test(p.name) ? 'shell' : /\bmcp\b|mcp[-_]|[-_]mcp/i.test(p.cmd) ? 'mcp' : '')
  // everything a process started, depth first, without the console hosts
  function descendants(s, pid) {
    const out = []
    const walk = (id, depth, seen) => {
      for (const c of s.byParent.get(id) || []) {
        if (seen.has(c.pid)) continue
        seen.add(c.pid)
        const kind = kindOf(c)
        if (kind !== 'console') out.push({ pid: c.pid, name: c.name, kind, depth, cpu: c.cpu, mem: c.mem, start: c.start, cmd: mask(clip(c.cmd, 400)) })
        walk(c.pid, kind === 'console' ? depth : depth + 1, seen)
      }
    }
    walk(pid, 0, new Set([pid]))
    return out
  }
  const totals = (list) => {
    const work = list.filter((p) => p.kind !== 'hook')
    return { n: work.length, cpu: work.reduce((a, p) => a + (p.cpu || 0), 0), mem: work.reduce((a, p) => a + p.mem, 0), hooks: list.length - work.length }
  }
  // for a card: how much the session has running, from the last snapshot (refreshed in the background)
  function summary(pid) {
    const s = current(20000)
    if (!s || !pid || !s.byPid.has(pid)) return null
    return totals(descendants(s, pid))
  }
  // for the processes dialog: every session's descendants, the session itself first
  async function list(roots) {
    const s = await fresh(4000)
    if (!s) return { at: null, sessions: [] }
    return {
      at: s.at, cores: CORES,
      sessions: roots.filter((r) => r.pid && s.byPid.has(r.pid)).map((r) => {
        const self = s.byPid.get(r.pid), procs = descendants(s, r.pid)
        return { ...r.info, self: { cpu: self.cpu, mem: self.mem, start: self.start }, total: totals(procs), procs }
      }),
    }
  }
  // end one of a session's descendants, with what it started in turn
  async function kill(pid, roots) {
    const s = await fresh(2000)
    const target = s && s.byPid.get(pid)
    if (!target || roots.some((r) => r.pid === pid)) return 404
    const owned = roots.some((r) => r.pid && descendants(s, r.pid).some((p) => p.pid === pid))
    if (!owned) return 403
    await new Promise((resolve) => {
      if (WIN) execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
      else { try { process.kill(pid, 'SIGTERM') } catch {} resolve() }
    })
    refresh()
    return 200
  }
  return { summary, list, kill }
}
