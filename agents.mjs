// Agents the monitor runs itself — the way the VS Code extension does it: the installed `claude` program in
// headless mode (--print with stream-json in and out), on the user's own Claude Code login.
//
//   start   spawns `claude -p --input-format stream-json --output-format stream-json --include-partial-messages`
//   send    writes a user message (text, and images as image blocks) to its stdin; stdin stays open between turns
//   stop    ends the process; the next message resumes the same session with --resume
//   prompts permission prompts and questions go to hooks/permission-mcp.mjs (--permission-prompt-tool),
//           which asks the page and waits for an answer
//
// What the page receives is normalised and masked like the conversation view: text arrives as the whole block
// so far (so a pattern split across two chunks is still masked), tool calls and results as whole entries.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'

const HISTORY = 600                 // normalised events kept per agent for a dialog opened later
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']   // claude's --effort; none = its own default
const effortOf = (v) => (EFFORTS.includes(v) ? v : '')
// the crown is not on offer: it marks the leader
const ACCS = ["ball","twin","phones","sprout","bolt"]
// { c: palette index 0-7, acc: headgear } — anything else means "the usual look from the name"
const avatarOf = (v) => (v && Number.isInteger(v.c) && v.c >= 0 && v.c < 8 && ACCS.includes(v.acc) ? { c: v.c, acc: v.acc } : null)
// the assistant may also keep the crown it wears by default (the leader's mark on the cards, where it never appears)
const assistantLookOf = (v) => (v && v.acc === 'crown' && Number.isInteger(v.c) && v.c >= 0 && v.c < 8 ? { c: v.c, acc: 'crown' } : avatarOf(v))

export function createAgents({ root, dataDir, mask, clip, clip2, describe, notifyPages, projectRoot, projectKey, askPage, attachedPaths, configPath, historyOf }) {
  // what the agent is for, one line written by the user (shown under its name)
  const descOf = (v) => clip(String(v || '').replace(/[\x00-\x1f<>]/g, ' ').replace(/\s+/g, ' ').trim(), 80)
  // its name: one for both languages (a string) or one per language ({ en, ko }); the server reads both shapes
  const nickClean = (v) => clip(String(v || '').replace(/[\x00-\x1f<>]/g, ''), 16)
  const nickOf = (en, ko) => { en = nickClean(en); ko = nickClean(ko); return !en && !ko ? '' : en === ko ? en : { en, ko } }
  const agents = new Map()          // id → agent

  // The list outlives the server: .runtime/agents.json holds who each agent is (folder, name, look, mode, model,
  // session) — never what was said. After a restart they come back stopped; the next message resumes the session.
  // One that was in the middle of a turn when the monitor went away (quit, crash, an update) carries on by itself, and
  // one whose turn had ended just before is asked whether that turn was waiting for this restart (an install it started).
  const FILE = path.join(dataDir || root, '.runtime', 'agents.json')
  const KEEP = ['id', 'kind', 'cwd', 'key', 'name', 'nick', 'desc', 'avatar', 'mode', 'model', 'effort', 'fast', 'sessionId', 'newSessionId', 'startedAt', 'midTurn', 'turnEndedAt', 'loginLost', 'limitHit', 'forkFrom', 'forkedFrom']
  const CARRY_ON = 'The agent monitor restarted (an update or a restart of the app) and cut your last turn short. Please carry on where you left off, and keep replying in the language you have been using with the user.'
  const JUST_AFTER = 'The agent monitor restarted (an update or a restart of the app) right after your last turn ended. If that turn started something this restart was part of — installing or updating the app, a restart you asked for — check now that it worked and tell the user what you found. If it had nothing to do with it, just say so in one line.'
  const JUST_AFTER_MS = 2 * 60 * 1000   // how soon after a turn ends a restart counts as "right after"
  // a turn that may have set off the restart: an installer run, a build or release of the app, a restart spoken of
  const RESTARTING = /--force-run|Setup[^\n"]*\.exe|am-setup|npm run (dist|release|try)|electron-builder|quitAndInstall|Start-Process[^\n]*(install|setup)|\brestart(s|ed|ing)?\b|reinstall|재시작|재설치|다시 설치/i
  // Claude Code logged out under a running agent (a login that ran out, a switch to another account): its turn fails with
  // "Not logged in". The agent is stopped, since a process that keeps running keeps the login it started with, and once
  // Claude Code is logged in again it is started afresh and carries on with what it was doing
  const LOGIN_LOST = /Not logged in|Please run \/login|authentication_failed|OAuth token (has )?expired|invalid.{0,20}(api key|bearer token)/i
  const LOGGED_BACK = 'Claude Code was logged out while you were working (a login that ran out, or a switch to another account), so your last turn failed with "Not logged in". It is logged in again now. Please carry on where you left off, and keep replying in the language you have been using with the user.'
  const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  // A usage limit reached ("You've hit your session limit · resets 4:50pm"): the turn fails, and nothing woke the agent
  // once the limit had reset — on 1 Oct four agents and the assistant sat from 15:30 until long after 16:50. Now it is
  // asked to carry on just after the time the message gave (without one: after half an hour, then longer each time).
  const LIMIT_HIT = /hit your (session |weekly |opus |sonnet |usage )?limit|usage limit reached|limit reached\|\d{10}/i
  const LIMIT_BACK = 'Your Claude usage limit was reached while you were working, so your last turn failed. The limit has reset now. Please carry on where you left off, and keep replying in the language you have been using with the user.'
  const LIMIT_GRACE_MS = 90 * 1000, LIMIT_RETRY_MS = 30 * 60 * 1000
  // when it resets, from its words: "resets 4:50pm", "resets Oct 4, 9am", or the older "…limit reached|1759377600"
  // (a time of day is taken as this PC's, the zone the message names being the account's, usually the same)
  function resetOf(text, now) {
    const s = String(text || '')
    const epoch = s.match(/\|(\d{10})\b/)
    if (epoch) return Number(epoch[1]) * 1000
    const m = s.match(/resets\s+(?:([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/i)
    if (!m) return 0
    const d = new Date(now)
    d.setHours(Number(m[3]) % 12 + (m[5].toLowerCase() === 'p' ? 12 : 0), Number(m[4] || 0), 0, 0)
    if (m[1]) {
      const month = new Date(m[1] + ' 1, 2000').getMonth()
      if (Number.isNaN(month)) return 0
      d.setMonth(month, Number(m[2]))
      if (d.getTime() < now - 12 * 3600e3) d.setFullYear(d.getFullYear() + 1)
    } else if (d.getTime() <= now) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  let shuttingDown = false   // stopping everything on the way out is not the end of their turns
  function save() {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true })
      fs.writeFileSync(FILE, JSON.stringify([...agents.values()].map((a) => Object.fromEntries(KEEP.map((k) => [k, a[k]]))), null, 1))
    } catch {}
  }
  // Agents put away as they were ended (End agent → keep in the archive): who each was and which conversation, never
  // what was said, so a new agent can carry that conversation on later. .runtime/archive.json, newest first, up to 100.
  const ARCHIVE = path.join(dataDir || root, '.runtime', 'archive.json')
  const ARCHIVE_KEEP = ['cwd', 'key', 'nick', 'desc', 'avatar', 'mode', 'model', 'effort', 'sessionId']
  const isSessionId = (v) => /^[0-9a-f-]{36}$/i.test(String(v || ''))
  function archived() {
    try { const l = JSON.parse(fs.readFileSync(ARCHIVE, 'utf8')); return Array.isArray(l) ? l.filter((x) => x && x.id && isSessionId(x.sessionId)) : [] } catch { return [] }
  }
  function saveArchive(list) {
    try { fs.mkdirSync(path.dirname(ARCHIVE), { recursive: true }); fs.writeFileSync(ARCHIVE, JSON.stringify(list.slice(0, 100), null, 1)) } catch {}
  }
  async function load() {
    let list = []
    try { list = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return }
    for (const saved of Array.isArray(list) ? list : []) {
      if (!saved?.id || agents.has(saved.id) || !fs.existsSync(String(saved.cwd || ''))) continue
      const a = {
        ...saved, avatar: saved.id === 'assistant' ? assistantLookOf(saved.avatar) : avatarOf(saved.avatar),
        kind: saved.kind || (saved.id === 'assistant' ? 'assistant' : undefined),
        // a list saved before the session id was recorded: the id it was started with is the one to resume
        // taken over but not forked yet (no first turn before the restart): fork again from the VS Code session —
        // its newSessionId was never created, and resuming that left the agent with "No conversation found"
        forkedFrom: saved.forkedFrom || saved.forkFrom || '',   // lists saved before forkedFrom: a fork still pending knows it
        sessionId: saved.forkFrom ? '' : saved.sessionId || '', mode: MODES.includes(saved.mode) ? saved.mode : 'default',
        proc: null, state: 'stopped', stateSince: Date.now(), lastAt: 0, events: [], streams: new Set(), msg: null,
        activity: null, activityAt: 0, turns: 0, stopping: false,
      }
      agents.set(a.id, a)
      // the conversation so far, from its transcript, so the dialog is not empty after a restart
      if ((a.sessionId || a.forkFrom) && historyOf) { try { a.events = await historyOf(a.sessionId || a.forkFrom) } catch {} }
      // saved before the id was kept on claude's word: an id it was started with counts only if its conversation exists
      if (historyOf && !a.forkFrom) {
        if (!a.sessionId && saved.newSessionId) { try { const h = await historyOf(saved.newSessionId); if (h.length) { a.sessionId = saved.newSessionId; a.events = h } } catch {} }
        else if (a.sessionId && a.sessionId === saved.newSessionId && !a.events.length) a.sessionId = ''
      }
      // asked only if that last turn could have started this restart (it installed, built or restarted the app): any
      // other agent paid a reload of its whole conversation into a cold cache to answer "nothing to do with me" —
      // 14 such checks cost about 10M tokens in a week
      const turnStart = a.events.map((e) => e.kind).lastIndexOf('user')
      const restarting = a.events.slice(turnStart + 1).some((e) => (e.kind === 'tool' && RESTARTING.test(String(e.input || ''))) || (e.kind === 'block' && RESTARTING.test(String(e.text || ''))))
      a.justAfter = !a.midTurn && a.turnEndedAt > 0 && Date.now() - a.turnEndedAt < JUST_AFTER_MS && restarting
      // its conversation ended on the usage limit (a list from before limits were kept, or one kept): carried on after
      // the reset like one that hits it now — at once if that time has passed
      const lastSaid = a.events.filter((e) => e.kind === 'block' || e.kind === 'user').pop()
      if (!a.limitHit && !a.midTurn && lastSaid?.kind === 'block' && LIMIT_HIT.test(lastSaid.text) && Date.now() - (lastSaid.at || 0) < 24 * 3600e3) {
        a.limitHit = { at: lastSaid.at || Date.now(), until: resetOf(lastSaid.text, lastSaid.at || Date.now()) || 0 }
      }
      a.events.push({ kind: 'note', text: a.midTurn ? 'monitor restarted — carrying on with the turn that was cut short' : a.justAfter ? 'monitor restarted right after the last turn — asked to check on it' : 'monitor restarted — send a message to continue', at: Date.now() })
    }
    for (const a of agents.values()) {
      const why = a.midTurn ? CARRY_ON : a.justAfter ? JUST_AFTER : ''
      delete a.justAfter
      if (!why) continue
      // the assistant waits for its role (ensureAssistant, a moment later): started without it, it would not know
      // what it is, and its own tools would ask the person
      if (a.kind === 'assistant' && !a.system) { a.resumeWith = why; continue }
      send(a, why, [])
    }
    notifyPages()
  }

  // Where `claude` actually is.
  //
  // An app opened from Finder never goes through a login shell, so it gets
  // launchd's bare PATH (/usr/bin:/bin:/usr/sbin:/sbin) and nothing that .zshrc
  // adds: nvm, Homebrew on Apple silicon, ~/.local/bin. Started from a terminal
  // the same code finds claude straight away, which is why this only ever breaks
  // for the packaged app.
  //
  // So: the configured path wins, then the known install locations, then the
  // login shell is asked once. The answer is kept for the life of the process;
  // an agent that starts and stops all day must not pay for a shell each time.
  let foundClaude = null
  function runnable(p) {
    try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile() } catch { return false }
  }
  function claudeExecutable() {
    if (configPath) return configPath
    if (foundClaude) return foundClaude
    if (process.platform === 'win32') {
      try {
        for (const line of execFileSync('where.exe', ['claude'], { encoding: 'utf8' }).split(/\r?\n/)) {
          const exe = path.join(path.dirname(line.trim()), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
          if (line.trim() && fs.existsSync(exe)) return exe
        }
      } catch {}
      return 'claude.exe'
    }

    // 1. the usual places, cheapest first. nvm keeps one bin dir per node version,
    //    so that one is a glob rather than a fixed path.
    const home = os.homedir()
    const fixed = [
      path.join(home, '.claude', 'local', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      path.join(home, '.local', 'bin', 'claude'),
      path.join(home, '.bun', 'bin', 'claude'),
    ]
    for (const c of fixed) if (runnable(c)) return (foundClaude = c)
    try {
      const vers = path.join(home, '.nvm', 'versions', 'node')
      // newest version first, so a machine with several keeps using the current one
      for (const v of fs.readdirSync(vers).sort().reverse()) {
        const c = path.join(vers, v, 'bin', 'claude')
        if (runnable(c)) return (foundClaude = c)
      }
    } catch {}

    // 2. ask the login shell. -i so interactive-only rc files are read too, which
    //    is where nvm usually lands. Bounded, and a failure just falls through.
    try {
      const sh = process.env.SHELL || '/bin/zsh'
      const out = execFileSync(sh, ['-ilc', 'command -v claude'], {
        encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().split('\n').pop().trim()
      if (out && runnable(out)) return (foundClaude = out)
    } catch {}

    // Nothing found. Return the bare name so spawn fails with ENOENT and the
    // dialog shows 'could not start claude', rather than failing silently.
    return 'claude'
  }

  function emit(a, ev) {
    ev.at = ev.at || Date.now()
    a.events.push(ev)
    if (a.events.length > HISTORY) a.events.splice(0, a.events.length - HISTORY)
    const line = 'event: e\ndata: ' + JSON.stringify(ev) + '\n\n'
    for (const res of a.streams) { try { res.write(line) } catch {} }
  }
  function setState(a, state) {
    if (a.state === state) return
    a.state = state
    a.stateSince = Date.now()
    // written down as it happens, so even a monitor that is killed knows afterwards who was mid-turn
    if (!shuttingDown && a.midTurn !== (state === 'working')) { a.midTurn = state === 'working'; if (!a.midTurn) a.turnEndedAt = Date.now(); save() }
    emit(a, { kind: 'state', state })
    notifyPages()
  }

  // one line of stream-json from the child → zero or more page events
  function onLine(a, line) {
    let o
    try { o = JSON.parse(line) } catch { return }
    a.lastAt = Date.now()
    if (o.type === 'control_response') {
      const r = o.response || {}, done = a.controls?.get(r.request_id)
      if (done) { a.controls.delete(r.request_id); done(r) }
      return
    }
    if (o.type === 'system' && o.subtype === 'init') {
      if (o.session_id && o.session_id !== a.sessionId) { a.sessionId = o.session_id; delete a.forkFrom; save() }
      // the model claude says it runs is written down only when it changed under it (/model): an alias picked
      // here (sonnet) stays an alias rather than becoming the version it stands for today
      if (o.model) { if (a.initModel && o.model !== a.initModel) a.model = o.model; a.initModel = o.model }
      if (o.permissionMode) a.mode = o.permissionMode
      notifyPages()
      return
    }
    if (o.type === 'stream_event' && o.event) {
      const e = o.event
      if (o.parent_tool_use_id) return   // a subagent's own stream stays out of the main conversation
      if (e.type === 'message_start') { a.msg = { id: e.message?.id || crypto.randomUUID(), blocks: {} }; setState(a, 'working') }
      else if (e.type === 'content_block_start' && a.msg) {
        const b = e.content_block || {}
        if (b.type === 'text' || b.type === 'thinking') a.msg.blocks[e.index] = { type: b.type, text: '' }
      } else if (e.type === 'content_block_delta' && a.msg) {
        const blk = a.msg.blocks[e.index]
        const d = e.delta || {}
        if (blk && d.type === 'text_delta') blk.text += d.text || ''
        else if (blk && d.type === 'thinking_delta') blk.text += d.thinking || ''
        else return
        const now = Date.now()
        if (now - (blk.sentAt || 0) > 120) { blk.sentAt = now; emit(a, { kind: 'block', msg: a.msg.id, index: e.index, type: blk.type, text: mask(clip2(blk.text, 20000)) }) }
      } else if (e.type === 'content_block_stop' && a.msg) {
        const blk = a.msg.blocks[e.index]
        if (blk) emit(a, { kind: 'block', msg: a.msg.id, index: e.index, type: blk.type, text: mask(clip2(blk.text, 20000)), done: true })
      }
      return
    }
    if (o.type === 'assistant' && o.error === 'authentication_failed') a.loginFailed = true
    if (o.type === 'assistant' && o.error === 'rate_limit') a.limitFailed = true
    // a slash command's answer (/context, /usage, /model…) is no model reply: claude writes it as one whole message
    // with no stream before it, so it is shown here, as the agent's text
    if (o.type === 'assistant' && o.message?.model === '<synthetic>' && !o.parent_tool_use_id && Array.isArray(o.message.content)) {
      const text = o.message.content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n')
      if (text) emit(a, { kind: 'block', msg: String(o.message.id || crypto.randomUUID()), index: 0, type: 'text', text: mask(clip2(text, 20000)), done: true })
      const eff = /^Set effort level to (\w+)/.exec(text)
      if (eff) { a.effort = effortOf(eff[1]); save(); notifyPages() }
      return
    }
    // /clear: a new conversation in the same process; its id comes with the next init
    if (o.type === 'conversation_reset') { emit(a, { kind: 'note', text: 'a new conversation — the earlier one stays on disk' }); return }
    if (o.type === 'assistant' && !o.parent_tool_use_id && Array.isArray(o.message?.content)) {
      for (const c of o.message.content) {
        if (c?.type === 'tool_use') {
          a.activity = describe(c.name, c.input)
          a.activityAt = Date.now()
          emit(a, { kind: 'tool', id: String(c.id || ''), name: String(c.name || ''), action: a.activity, input: mask(clip2(JSON.stringify(c.input ?? {}, null, 1), 8000)) })
        }
      }
      return
    }
    if (o.type === 'user' && !o.parent_tool_use_id && Array.isArray(o.message?.content)) {
      for (const c of o.message.content) {
        if (c?.type !== 'tool_result') continue
        const raw = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x) => x?.type === 'text' ? x.text : '[' + (x?.type || 'data') + ']').join('\n') : ''
        // images in it go by count only; the page fetches them from the transcript (/img/result in server.mjs)
        const images = Array.isArray(c.content) ? c.content.filter((x) => x?.type === 'image').length : 0
        emit(a, { kind: 'result', id: String(c.tool_use_id || ''), error: !!c.is_error, text: mask(clip2(raw, 3000)), ...(images ? { images } : {}) })
      }
      return
    }
    if (o.type === 'result') {
      a.turns++
      // a failed turn says why (an API error, a limit…) instead of ending silently
      emit(a, { kind: 'turn', ok: !o.is_error, subtype: String(o.subtype || ''), ms: o.duration_ms || 0, ...(o.is_error ? { text: mask(clip(String(o.result || (o.errors || []).join('; ') || o.subtype || ''), 400)) } : {}) })
      setState(a, 'idle')
      const why = String(o.result || (o.errors || []).join('; '))
      const failed = o.is_error && (a.loginFailed || LOGIN_LOST.test(why))
      const limited = o.is_error && !failed && (a.limitFailed || LIMIT_HIT.test(why))
      a.loginFailed = false; a.limitFailed = false
      // why its last turn failed (an API error, a limit, the login), for the page and the assistant; cleared by a good one
      a.lastFail = o.is_error ? { text: mask(clip(String(o.result || (o.errors || []).join('; ') || o.subtype || ''), 200)), at: Date.now() } : null
      if (!o.is_error) { a.loginTriedAt = 0; a.limitTries = 0; if (a.limitHit) { a.limitHit = null; save() } }
      if (failed) { loggedOut(a); return }
      if (limited) limitReached(a, why)
      if (a.restartAfterTurn) { a.restartAfterTurn = false; a.respawn = true; stop(a) }
    }
  }

  // The slash commands claude offers in a folder (its built-ins, the user's and the project's skills and commands,
  // plugins'), for the "/" list in the message box: a claude started only to ask its initialize request, without
  // hooks or MCP servers and without a message, so no session is made and no one is billed. Kept a few minutes per folder.
  // The few that only mean something in the terminal (colours, the focus view) are left out, as claude itself does.
  const TERMINAL_ONLY = new Set(['color', 'focus', 'reload-plugins', 'heapdump'])
  const commandCache = new Map()   // cwd → { at, list | promise }
  function commandsIn(cwd) {
    const hit = commandCache.get(cwd)
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.list
    const list = new Promise((resolve) => {
      let child, rest = '', done = false
      const end = (v) => { if (done) return; done = true; clearTimeout(timer); try { child?.kill() } catch {}; resolve(v) }
      const timer = setTimeout(() => end([]), 20000)
      try {
        child = spawn(claudeExecutable(), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--settings', JSON.stringify({ disableAllHooks: true })],
          { cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: process.env })
      } catch { return end([]) }
      child.on('error', () => end([]))
      child.on('exit', () => end([]))
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        const parts = (rest + chunk).split('\n')
        rest = parts.pop()
        for (const l of parts) {
          let o
          try { o = JSON.parse(l) } catch { continue }
          if (o.type !== 'control_response') continue
          const cmds = (o.response?.response || o.response || {}).commands
          end((Array.isArray(cmds) ? cmds : []).filter((c) => c && typeof c.name === 'string' && !c.name.startsWith('__') && !TERMINAL_ONLY.has(c.name)).slice(0, 300).map((c) => ({
            name: clip(c.name, 80), desc: clip(String(c.description || '').replace(/\s+/g, ' '), 240), hint: clip(String(c.argumentHint || ''), 80),
            aliases: Array.isArray(c.aliases) ? c.aliases.filter((x) => typeof x === 'string').slice(0, 5) : [], builtin: !!c.builtin,
          })))
        }
      })
      try { child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'cmds', request: { subtype: 'initialize' } }) + '\n') } catch { end([]) }
    })
    commandCache.set(cwd, { at: Date.now(), list })
    list.then((v) => { if (!v.length) commandCache.delete(cwd) })   // none came back: ask again next time
    return list
  }

  function spawnAgent(a) {
    // MONITOR_LINK: a second monitor (the test app) has its own link file, and its agents' tools must reach it, not the installed one
    const nodeEnv = { MONITOR_AGENT: a.id, ...(process.env.MONITOR_LINK ? { MONITOR_LINK: process.env.MONITOR_LINK } : {}), ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
    const servers = { monitor: { command: process.execPath, args: [path.join(root, 'hooks', 'permission-mcp.mjs')], env: nodeEnv } }
    // the assistant (see assistant.mjs) also gets the monitor's own tools: look at every agent, message, answer, alert
    if (a.kind === 'assistant') servers.assistant = { command: process.execPath, args: [path.join(root, 'hooks', 'assistant-mcp.mjs')], env: nodeEnv }
    const mcp = JSON.stringify({ mcpServers: servers })
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
      '--permission-mode', a.mode, '--mcp-config', mcp, '--permission-prompt-tool', 'mcp__monitor__approve',
      // lets "All OK" (bypassPermissions) be chosen, at the start or later; it is on only while that mode is picked
      '--allow-dangerously-skip-permissions']
    // the assistant: its role, and its monitor tools used without a prompt (anything else still asks the person)
    // its own tools never ask, with or without its role; the role itself once the assistant module has given it
    if (a.kind === 'assistant') args.push('--allowedTools', 'mcp__assistant')
    if (a.kind === 'assistant' && a.system) args.push('--append-system-prompt', a.system)
    a.procHasRole = a.kind === 'assistant' && !!a.system
    if (a.model) args.push('--model', a.model)
    if (a.effort) args.push('--effort', a.effort)
    // quick start: only the monitor's own tool, none of the user's MCP servers and connectors
    if (a.fast) args.push('--strict-mcp-config')
    if (a.sessionId) args.push('--resume', a.sessionId)
    // taken over from a VS Code session: a copy of that conversation with an id of its own, so the original can
    // stay open in VS Code without the two writing to one transcript; claude tells the new id on its first turn
    else if (a.forkFrom) args.push('--resume', a.forkFrom, '--fork-session')
    else args.push('--session-id', a.newSessionId)
    let child
    // a claudePath that cannot be run at all throws right here, not as an 'error' event
    try { child = spawn(claudeExecutable(), args, { cwd: a.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: process.env }) }
    catch (e) { emit(a, { kind: 'note', text: 'could not start claude: ' + e.message }); a.proc = null; setState(a, 'stopped'); return }
    a.proc = child
    // the session id is kept only once claude has said it (its first output, above): an agent started and then
    // restarted before its first turn has no conversation yet, and resuming one left it with "No conversation found"
    let rest = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      const parts = (rest + chunk).split('\n')
      rest = parts.pop()
      for (const l of parts) if (l.trim()) onLine(a, l)
    })
    let errTail = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000) })
    child.on('error', (e) => { emit(a, { kind: 'note', text: 'could not start claude: ' + e.message }); a.proc = null; setState(a, 'stopped') })
    child.on('exit', (code) => {
      if (a.proc !== child) return
      a.proc = null
      for (const done of a.controls?.values() || []) done({ subtype: 'error', error: 'claude exited' })
      a.controls = null
      if (a.respawn) { a.respawn = false; a.stopping = false; spawnAgent(a); setState(a, 'idle'); return }
      if (!a.stopping && code) emit(a, { kind: 'note', text: 'claude exited (' + code + ')' + (errTail ? ': ' + mask(clip(errTail, 300)) : '') })
      if (/No conversation found with session ID/i.test(errTail) && a.sessionId) {
        a.sessionId = ''; a.newSessionId = crypto.randomUUID(); a.midTurn = false; save()
        emit(a, { kind: 'note', text: 'its earlier conversation could not be found — the next message starts a new one' })
      }
      a.stopping = false
      setState(a, 'stopped')
    })
  }

  // a control request to the running claude (a new mode or model without a restart); resolves with its answer
  let controlSeq = 0
  function control(a, request) {
    return new Promise((resolve) => {
      if (!a.proc) return resolve({ subtype: 'error', error: 'not running' })
      const id = 'm' + (++controlSeq)
      a.controls = a.controls || new Map()
      const timer = setTimeout(() => { a.controls?.delete(id); resolve({ subtype: 'error', error: 'no answer' }) }, 5000)
      a.controls.set(id, (r) => { clearTimeout(timer); resolve(r) })
      try { a.proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n') } catch { a.controls.delete(id); clearTimeout(timer); resolve({ subtype: 'error', error: 'write failed' }) }
    })
  }

  // a user message: text plus attachments — images inline as image blocks, other files by path
  function userMessage(text, files) {
    const content = []
    const others = []
    for (const p of files) {
      const type = IMAGE_TYPES[path.extname(p).toLowerCase()]
      if (type) { try { content.push({ type: 'image', source: { type: 'base64', media_type: type, data: fs.readFileSync(p).toString('base64') } }); continue } catch {} }
      others.push(p)
    }
    const body = [text, others.length ? 'Attached files (open them with the Read tool):\n' + others.map((p) => '  ' + p).join('\n') : ''].filter(Boolean).join('\n')
    if (body) content.push({ type: 'text', text: body })
    return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }
  }

  function send(a, text, files) {
    // a message sent by hand to an agent waiting for the login: it goes now, in a new process with the login there is
    if (a.loginLost) { a.loginLost = 0; save() }
    // and one stopped at the usage limit: a turn that fails again marks it again, with the new time
    if (a.limitHit) { a.limitHit = null; save() }
    if (!a.proc) spawnAgent(a)
    if (!a.proc) return false
    const msg = userMessage(text, files)
    try { a.proc.stdin.write(JSON.stringify(msg) + '\n') } catch { return false }
    // the files' names for the chips, and their place in the uploads folder ("<dir>/<stored name>") for the preview
    emit(a, { kind: 'user', text: mask(clip2(text, 4000)), files: files.map((p) => p.split('/').pop().replace(/^[0-9a-z]+-/, '')), refs: files.map((p) => p.split('/').slice(-2).join('/')) })
    setState(a, 'working')
    return true
  }

  // its turn failed for want of a login: stop it, and say it will carry on by itself
  function loggedOut(a) {
    a.loginLost = Date.now()
    save()
    stop(a)
    emit(a, { kind: 'note', text: 'Claude Code is not logged in — this agent carries on by itself once it is logged in again' })
    notifyPages()
  }
  // its turn failed at the usage limit: noted with when the limit resets, to carry on then (its claude stays: the
  // limit is the account's, not the process's)
  function limitReached(a, why) {
    const now = Date.now()
    a.limitHit = { at: now, until: resetOf(why, now) || 0 }
    a.limitTries = (a.limitTries || 0) + 1
    save()
    const at = a.limitHit.until ? new Date(a.limitHit.until).toTimeString().slice(0, 5) : ''
    emit(a, { kind: 'note', text: 'usage limit reached — this agent carries on by itself ' + (at ? 'after it resets at ' + at : 'once it has reset (tried again in a while)') })
    notifyPages()
  }
  // is Claude Code logged in now, and when were its login files last written
  function loginNow() {
    let at = 0, cred = null, state = null
    const credFile = path.join(CONFIG_DIR, '.credentials.json')
    const stateFile = process.env.CLAUDE_CONFIG_DIR ? path.join(CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json')
    try { cred = JSON.parse(fs.readFileSync(credFile, 'utf8')); at = fs.statSync(credFile).mtimeMs } catch {}
    // on macOS the token is in the keychain: the account in .claude.json is all there is to see
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (process.platform === 'darwin') at = Math.max(at, fs.statSync(stateFile).mtimeMs) } catch {}
    return { ok: !!process.env.ANTHROPIC_API_KEY || !!(state?.oauthAccount && (cred?.claudeAiOauth?.accessToken || process.platform === 'darwin')), at }
  }
  // every 15 s while an agent waits for the login. It is tried again once logged in — at once if the login was
  // written since it failed, else once (it may have failed on a login it held from before) — and then not again
  // until the login changes, so a login that still does not work is not tried over and over
  setInterval(() => {
    if (shuttingDown) return
    const now = Date.now()
    // stopped at the usage limit: carried on just after it resets (a minute and a half late, to be on the safe side);
    // with no time to go by, after half an hour, then an hour, up to two
    for (const a of agents.values()) {
      const l = a.limitHit
      if (!l || a.loginLost || a.state === 'working') continue
      const due = l.until ? l.until + LIMIT_GRACE_MS : l.at + LIMIT_RETRY_MS * Math.min(4, a.limitTries || 1)
      if (now < due) continue
      emit(a, { kind: 'note', text: 'the usage limit should have reset — carrying on' })
      send(a, LIMIT_BACK, [])
    }
    const waiting = [...agents.values()].filter((a) => a.loginLost)
    if (!waiting.length) return
    const login = loginNow()
    if (!login.ok) return
    for (const a of waiting) {
      if (a.proc || now - a.loginLost < 20000) continue
      if (!(login.at > a.loginLost || !a.loginTriedAt) || now - (a.loginTriedAt || 0) < 60000) continue
      a.loginTriedAt = now
      emit(a, { kind: 'note', text: 'Claude Code is logged in again — carrying on' })
      send(a, LOGGED_BACK, [])
    }
  }, 15000).unref?.()

  function stop(a) {
    if (!a.proc) return
    a.stopping = true
    const pid = a.proc.pid
    // the whole tree: claude may be running a command of its own
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
    else { try { a.proc.kill('SIGTERM') } catch {} }
    emit(a, { kind: 'note', text: 'stopped' })
  }

  /* ── API ── */
  async function start(body) {
    const cwd = path.resolve(String(body.cwd || ''))
    try { if (!fs.statSync(cwd).isDirectory()) return [400, { error: 'not a folder' }] } catch { return [400, { error: 'no such folder' }] }
    const mode = MODES.includes(body.mode) ? body.mode : 'default'
    const id = crypto.randomBytes(4).toString('hex')
    const a = {
      // a look and a name picked in the new-agent dialog (both optional)
      fast: !!body.fast, avatar: avatarOf(body.avatar), nick: nickOf(body.nick, typeof body.nickKo === 'string' ? body.nickKo : body.nick), desc: descOf(body.desc),
      id, cwd, key: projectKey(projectRoot(cwd)), name: 'monitor-' + id, mode, model: String(body.model || '').replace(/[^\w.:[\]-]/g, '') || '', effort: effortOf(body.effort),
      newSessionId: crypto.randomUUID(), sessionId: '', proc: null, state: 'idle', stateSince: Date.now(), startedAt: Date.now(), lastAt: 0,
      events: [], streams: new Set(), msg: null, activity: null, activityAt: 0, turns: 0, stopping: false,
    }
    agents.set(id, a)
    save()
    const text = clip(body.text, 8000)
    const files = attachedPaths(body.files)
    // claude takes a while to start; start it now, so it is ready by the time the first message is typed
    if (text || files.length) send(a, text, files)
    else spawnAgent(a)
    notifyPages()
    return [200, { id, name: a.name }]
  }

  // a VS Code session's conversation, carried on as a monitor agent in the same folder, under the same name and mode
  async function fork({ cwd, sessionId, nick, desc, mode }) {
    if (!/^[0-9a-f-]{36}$/i.test(String(sessionId || ''))) return [400, {}]
    try { if (!fs.statSync(cwd).isDirectory()) return [400, { error: 'no such folder' }] } catch { return [400, { error: 'no such folder' }] }
    const id = crypto.randomBytes(4).toString('hex')
    const a = {
      fast: false, avatar: null, nick: nick && typeof nick === 'object' ? nickOf(nick.en, nick.ko) : nickOf(nick, nick), desc: descOf(desc),
      id, cwd, key: projectKey(projectRoot(cwd)), name: 'monitor-' + id, mode: MODES.includes(mode) ? mode : 'default', model: '', effort: '',
      newSessionId: crypto.randomUUID(), sessionId: '', forkFrom: sessionId, forkedFrom: sessionId, proc: null, state: 'idle', stateSince: Date.now(), startedAt: Date.now(), lastAt: 0,
      events: [], streams: new Set(), msg: null, activity: null, activityAt: 0, turns: 0, stopping: false,
    }
    // the conversation so far, so the dialog shows where it left off
    if (historyOf) { try { a.events = await historyOf(sessionId) } catch {} }
    a.events.push({ kind: 'note', text: 'taken over from VS Code — the original session is still there; close it in VS Code if you will not use it', at: Date.now() })
    agents.set(id, a)
    save()
    spawnAgent(a)
    notifyPages()
    return [200, { id, name: a.name }]
  }

  // a conversation carried on as it is, under its own id: one from the archive, or an earlier one of the folder that
  // nothing has open now (one still open in VS Code is copied instead, as a take-over is — see fork)
  async function adopt({ cwd, sessionId, nick, desc, avatar, mode, model, effort, note }) {
    if (!isSessionId(sessionId)) return [400, {}]
    try { if (!fs.statSync(cwd).isDirectory()) return [400, { error: 'no such folder' }] } catch { return [400, { error: 'no such folder' }] }
    if (byAgentSession(sessionId)) return [409, { error: 'already open' }]
    const id = crypto.randomBytes(4).toString('hex')
    const a = {
      fast: false, avatar: avatarOf(avatar), nick: nick && typeof nick === 'object' ? nickOf(nick.en, nick.ko) : nickOf(nick, nick), desc: descOf(desc),
      id, cwd, key: projectKey(projectRoot(cwd)), name: 'monitor-' + id, mode: MODES.includes(mode) ? mode : 'default',
      model: String(model || '').replace(/[^\w.:[\]-]/g, ''), effort: effortOf(effort),
      newSessionId: crypto.randomUUID(), sessionId, proc: null, state: 'idle', stateSince: Date.now(), startedAt: Date.now(), lastAt: 0,
      events: [], streams: new Set(), msg: null, activity: null, activityAt: 0, turns: 0, stopping: false,
    }
    if (historyOf) { try { a.events = await historyOf(sessionId) } catch {} }
    a.events.push({ kind: 'note', text: note || 'an earlier conversation, carried on', at: Date.now() })
    agents.set(id, a)
    save()
    // carried on: it is no longer put away
    saveArchive(archived().filter((x) => x.sessionId !== sessionId))
    spawnAgent(a)
    notifyPages()
    return [200, { id, name: a.name }]
  }

  async function handle(url, body) {
    const a = agents.get(String(body.id || ''))
    if (url.pathname === '/api/agents/start') return start(body)
    if (url.pathname === '/api/agents/archived') return [200, { list: archived().map((x) => ({ ...x, exists: fs.existsSync(String(x.cwd || '')), inUse: !!byAgentSession(x.sessionId) })) }]
    if (url.pathname === '/api/agents/unarchive') { saveArchive(archived().filter((x) => x.id !== String(body.archiveId || ''))); return [200, {}] }
    if (url.pathname === '/api/agents/restore') {
      const x = archived().find((y) => y.id === String(body.archiveId || ''))
      if (!x) return [404, {}]
      if (byAgentSession(x.sessionId)) return [409, { error: 'already open' }]
      return adopt({ ...x, note: 'brought back from the archive — carrying on the same conversation' })
    }
    if (!a) return [404, {}]
    if (url.pathname === '/api/agents/send') {
      const text = clip(body.text, 8000), files = attachedPaths(body.files)
      if (!text && !files.length) return [400, {}]
      return send(a, text, files) ? [200, {}] : [500, {}]
    }
    if (url.pathname === '/api/agents/stop') { stop(a); return [200, {}] }
    if (url.pathname === '/api/agents/commands') return [200, { commands: await commandsIn(a.cwd) }]
    // looks stuck: stop it, wait until claude is really gone, then ask it to carry on in the same session
    if (url.pathname === '/api/agents/nudge') {
      const proc = a.proc, text = clip(body.text, 2000)
      if (!text) return [400, {}]
      stop(a)
      if (proc) await new Promise((r) => { if (proc.exitCode !== null) return r(); proc.once('exit', r); setTimeout(r, 5000) })
      return send(a, text, []) ? [200, {}] : [500, {}]
    }
    // the dialog of a stopped agent was opened: get claude ready in the background
    if (url.pathname === '/api/agents/warm') { if (!a.proc) { spawnAgent(a); setState(a, 'idle') } return [200, {}] }
    if (url.pathname === '/api/agents/settings') {
      // takes effect from the next message: the process is restarted on the same session
      if (MODES.includes(body.mode)) a.mode = body.mode
      if (typeof body.model === 'string') { a.model = body.model.replace(/[^\w.:[\]-]/g, ''); a.initModel = '' }
      if (typeof body.effort === 'string') a.effort = effortOf(body.effort)
      if (typeof body.nick === 'string' || typeof body.nickKo === 'string') a.nick = nickOf(body.nick, typeof body.nickKo === 'string' ? body.nickKo : body.nick)
      if (body.avatar !== undefined) a.avatar = a.kind === 'assistant' ? assistantLookOf(body.avatar) : avatarOf(body.avatar)
      if (typeof body.desc === 'string') a.desc = descOf(body.desc)
      if (typeof body.nick === 'string' || typeof body.nickKo === 'string' || body.avatar !== undefined || typeof body.desc === 'string') { save(); notifyPages(); if (!('mode' in body) && !('model' in body) && !('effort' in body)) return [200, {}] }
      save()
      const what = 'mode ' + a.mode + (a.model ? ' · model ' + a.model : '') + (a.effort ? ' · effort ' + a.effort : '')
      if (!a.proc) { emit(a, { kind: 'note', text: what + ' — from the next message' }); notifyPages(); return [200, {}] }
      const asks = [...('mode' in body ? [{ subtype: 'set_permission_mode', mode: a.mode }] : []), ...('model' in body ? [{ subtype: 'set_model', ...(a.model ? { model: a.model } : {}) }] : []),
        // effort has no request of its own: it goes in as the session's effortLevel setting
        ...('effort' in body ? [{ subtype: 'apply_flag_settings', settings: { effortLevel: a.effort || null } }] : [])]
      const answers = await Promise.all(asks.map((r) => control(a, r)))
      if (answers.every((r) => r.subtype === 'success')) emit(a, { kind: 'note', text: what + ' — now' })
      else if (a.state === 'working') { a.restartAfterTurn = true; emit(a, { kind: 'note', text: what + ' — after this turn' }) }
      else { a.respawn = true; stop(a); emit(a, { kind: 'note', text: what + ' — from the next message' }) }
      notifyPages()
      return [200, {}]
    }
    if (url.pathname === '/api/agents/close') {
      // kept in the archive when asked — only one with a conversation to carry on
      if (body.archive && isSessionId(a.sessionId) && a.kind !== 'assistant') {
        // a name and a note of the person's own, to find it again later (the conversation's title is not always memorable)
        const title = clip(String(body.title || '').replace(/[\x00-\x1f<>]/g, ' ').replace(/\s+/g, ' ').trim(), 60)
        const note = clip(String(body.note || '').replace(/[\x00-\x1f<>]/g, ' ').replace(/\s+/g, ' ').trim(), 200)
        saveArchive([{ id: crypto.randomBytes(4).toString('hex'), ...Object.fromEntries(ARCHIVE_KEEP.map((k) => [k, a[k]])), title, note, archivedAt: Date.now() }, ...archived().filter((x) => x.sessionId !== a.sessionId)])
      }
      stop(a); agents.delete(a.id); save(); notifyPages(); return [200, {}]
    }
    return [404, {}]
  }

  function stream(req, res, id) {
    const a = agents.get(id)
    if (!a) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write('event: init\ndata: ' + JSON.stringify({ events: a.events, state: a.state }) + '\n\n')
    a.streams.add(res)
    const ping = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 15000)
    req.on('close', () => { clearInterval(ping); a.streams.delete(res) })
  }

  // the prompt tool's request: show it like any other approval, and wait for a person as long as it takes
  async function prompt(body) {
    const a = agents.get(String(body.agent || ''))
    if (!a) return { behavior: 'deny', message: 'Unknown monitor agent' }
    const input = body.input && typeof body.input === 'object' ? body.input : {}
    const r = await askPage({ hook_event_name: 'PermissionRequest', session_id: a.sessionId, tool_name: String(body.tool_name || ''), tool_input: input, permission_mode: a.mode }, { managed: true })
    const d = r?.hookSpecificOutput?.decision
    if (!d) return { behavior: 'deny', message: 'No answer from the monitor' }
    if (d.behavior === 'allow') return { behavior: 'allow', updatedInput: d.updatedInput || input, ...(d.updatedPermissions ? { updatedPermissions: d.updatedPermissions } : {}) }
    return { behavior: 'deny', message: d.message || 'Denied from the agent monitor', ...(d.interrupt ? { interrupt: true } : {}) }
  }

  // agents for the state API, shaped like registry sessions
  function sessions(now) {
    return [...agents.values()].filter((a) => a.kind !== 'assistant').map((a) => ({
      // forkedFrom: the VS Code session it was taken over from, for good (forkFrom only lasts until its first turn)
      managed: true, agentId: a.id, pid: a.proc?.pid || 0, loginLost: a.loginLost || 0, limitHit: a.limitHit || null, lastFail: a.lastFail || null, forkedFrom: a.forkedFrom || '', sessionId: a.sessionId || a.newSessionId, name: a.name, avatar: a.avatar, nick: a.nick, desc: a.desc || '', cwd: a.cwd, root: projectRoot(a.cwd), key: a.key,
      state: a.state === 'working' ? 'working' : a.state === 'idle' ? 'waiting' : 'resting', running: !!a.proc,
      statusSince: a.stateSince, startedAt: a.startedAt, mode: a.mode, model: a.model, effort: a.effort || '', activity: a.activity, activityAt: a.activityAt, lastEventAt: a.lastAt,
    }))
  }
  const byAgentSession = (sessionId) => [...agents.values()].find((a) => a.sessionId === sessionId || a.newSessionId === sessionId)

  function shutdown() { shuttingDown = true; for (const a of agents.values()) stop(a) }

  // for a command run from the page: where the agent works, and handing it the result as a message
  const cwdOf = (id) => agents.get(String(id))?.cwd || null
  const sendText = (id, text) => { const a = agents.get(String(id)); return !!a && send(a, text, []) }

  const loaded = load()   // the saved list is read before anything asks for an agent by id
  // the monitor's own assistant: one fixed agent, kept in the list like the others, never shown with a project
  function ensureAssistant({ cwd, system, model, nick }) {
    let a = agents.get('assistant')
    if (!a) {
      fs.mkdirSync(cwd, { recursive: true })
      a = {
        kind: 'assistant', fast: false, avatar: null, nick: nick || '', id: 'assistant', cwd, key: '', name: 'monitor-assistant', mode: 'default',
        model: model || 'sonnet', effort: '', newSessionId: crypto.randomUUID(), sessionId: '', proc: null, state: 'idle', stateSince: Date.now(),
        startedAt: Date.now(), lastAt: 0, events: [], streams: new Set(), msg: null, activity: null, activityAt: 0, turns: 0, stopping: false,
      }
      agents.set(a.id, a)
      save()
    }
    a.kind = 'assistant'   // a list saved by 312f266 lost it (KEEP had no kind): the fixed id is enough
    a.system = system   // the role as this version of the monitor writes it, never saved
    // a claude started before it had its role gets it now: at once when free, else once its turn is over
    if (a.proc && !a.procHasRole) { if (a.state === 'working') a.restartAfterTurn = true; else { a.respawn = true; stop(a) } }
    // cut short by a restart: carry on now that it knows what it is
    // (not into a claude still on its way out: once the one with the role is there)
    if (a.resumeWith) {
      const why = a.resumeWith
      delete a.resumeWith
      const go = (n) => (a.proc && !a.procHasRole && n < 50 ? setTimeout(() => go(n + 1), 200) : send(a, why, []))
      go(0)
    }
    return a
  }
  const assistantState = () => { const a = agents.get('assistant'); return a ? { state: a.state, running: !!a.proc, mode: a.mode, model: a.model, effort: a.effort || '', sessionId: a.sessionId, avatar: a.avatar || null, limitHit: a.limitHit || null } : null }
  // a line in the assistant's chat that is not a message: an alert, or something it did on its own
  const noteTo = (id, ev) => { const a = agents.get(id); if (a) emit(a, ev) }

  return { handle, stream, prompt, sessions, byAgentSession, shutdown, claudeExecutable, cwdOf, sendText, fork, adopt, ensureAssistant, assistantState, noteTo, loaded }
}
