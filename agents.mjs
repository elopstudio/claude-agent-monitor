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
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'

const HISTORY = 600                 // normalised events kept per agent for a dialog opened later
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']
// the crown is not on offer: it marks the leader
const ACCS = ["ball","twin","phones","sprout","bolt"]
// { c: palette index 0-7, acc: headgear } — anything else means "the usual look from the name"
const avatarOf = (v) => (v && Number.isInteger(v.c) && v.c >= 0 && v.c < 8 && ACCS.includes(v.acc) ? { c: v.c, acc: v.acc } : null)

export function createAgents({ root, dataDir, mask, clip, clip2, describe, notifyPages, projectRoot, projectKey, askPage, attachedPaths, configPath, historyOf }) {
  const agents = new Map()          // id → agent

  // The list outlives the server: .runtime/agents.json holds who each agent is (folder, name, look, mode, model,
  // session) — never what was said. After a restart they come back stopped; the next message resumes the session.
  // One that was in the middle of a turn when the monitor went away (quit, crash, an update) carries on by itself.
  const FILE = path.join(dataDir || root, '.runtime', 'agents.json')
  const KEEP = ['id', 'cwd', 'key', 'name', 'nick', 'avatar', 'mode', 'model', 'fast', 'sessionId', 'newSessionId', 'startedAt', 'midTurn']
  const CARRY_ON = 'The agent monitor restarted (an update or a restart of the app) and cut your last turn short. Please carry on where you left off.'
  let shuttingDown = false   // stopping everything on the way out is not the end of their turns
  function save() {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true })
      fs.writeFileSync(FILE, JSON.stringify([...agents.values()].map((a) => Object.fromEntries(KEEP.map((k) => [k, a[k]]))), null, 1))
    } catch {}
  }
  async function load() {
    let list = []
    try { list = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return }
    for (const saved of Array.isArray(list) ? list : []) {
      if (!saved?.id || agents.has(saved.id) || !fs.existsSync(String(saved.cwd || ''))) continue
      const a = {
        ...saved, avatar: avatarOf(saved.avatar),
        // a list saved before the session id was recorded: the id it was started with is the one to resume
        sessionId: saved.sessionId || (saved.newSessionId && historyOf ? saved.newSessionId : ''), mode: MODES.includes(saved.mode) ? saved.mode : 'default',
        proc: null, state: 'stopped', stateSince: Date.now(), lastAt: 0, events: [], streams: new Set(), msg: null,
        activity: null, activityAt: 0, turns: 0, stopping: false,
      }
      agents.set(a.id, a)
      // the conversation so far, from its transcript, so the dialog is not empty after a restart
      if (a.sessionId && historyOf) { try { a.events = await historyOf(a.sessionId) } catch {} }
      a.events.push({ kind: 'note', text: a.midTurn ? 'monitor restarted — carrying on with the turn that was cut short' : 'monitor restarted — send a message to continue', at: Date.now() })
    }
    for (const a of agents.values()) if (a.midTurn) send(a, CARRY_ON, [])
    notifyPages()
  }

  function claudeExecutable() {
    if (configPath) return configPath
    try {
      for (const line of execFileSync('where.exe', ['claude'], { encoding: 'utf8' }).split(/\r?\n/)) {
        const exe = path.join(path.dirname(line.trim()), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
        if (line.trim() && fs.existsSync(exe)) return exe
      }
    } catch {}
    return process.platform === 'win32' ? 'claude.exe' : 'claude'
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
    if (!shuttingDown && a.midTurn !== (state === 'working')) { a.midTurn = state === 'working'; save() }
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
      if (o.session_id && o.session_id !== a.sessionId) { a.sessionId = o.session_id; save() }
      if (o.model) a.model = o.model
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
        emit(a, { kind: 'result', id: String(c.tool_use_id || ''), error: !!c.is_error, text: mask(clip2(raw, 3000)) })
      }
      return
    }
    if (o.type === 'result') {
      a.turns++
      // a failed turn says why (an API error, a limit…) instead of ending silently
      emit(a, { kind: 'turn', ok: !o.is_error, subtype: String(o.subtype || ''), ms: o.duration_ms || 0, ...(o.is_error ? { text: mask(clip(String(o.result || (o.errors || []).join('; ') || o.subtype || ''), 400)) } : {}) })
      setState(a, 'idle')
      if (a.restartAfterTurn) { a.restartAfterTurn = false; a.respawn = true; stop(a) }
    }
  }

  function spawnAgent(a) {
    const mcp = JSON.stringify({ mcpServers: { monitor: { command: process.execPath, args: [path.join(root, 'hooks', 'permission-mcp.mjs')], env: { MONITOR_AGENT: a.id, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } } } })
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
      '--permission-mode', a.mode, '--mcp-config', mcp, '--permission-prompt-tool', 'mcp__monitor__approve',
      // lets "All OK" (bypassPermissions) be chosen, at the start or later; it is on only while that mode is picked
      '--allow-dangerously-skip-permissions']
    if (a.model) args.push('--model', a.model)
    // quick start: only the monitor's own tool, none of the user's MCP servers and connectors
    if (a.fast) args.push('--strict-mcp-config')
    if (a.sessionId) args.push('--resume', a.sessionId)
    else args.push('--session-id', a.newSessionId)
    let child
    // a claudePath that cannot be run at all throws right here, not as an 'error' event
    try { child = spawn(claudeExecutable(), args, { cwd: a.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: process.env }) }
    catch (e) { emit(a, { kind: 'note', text: 'could not start claude: ' + e.message }); a.proc = null; setState(a, 'stopped'); return }
    a.proc = child
    if (!a.sessionId) { a.sessionId = a.newSessionId; save() }   // from now on this session is resumed, never created again
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
    if (!a.proc) spawnAgent(a)
    if (!a.proc) return false
    const msg = userMessage(text, files)
    try { a.proc.stdin.write(JSON.stringify(msg) + '\n') } catch { return false }
    emit(a, { kind: 'user', text: mask(clip2(text, 4000)), files: files.map((p) => p.split('/').pop().replace(/^[0-9a-z]+-/, '')) })
    setState(a, 'working')
    return true
  }

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
      fast: !!body.fast, avatar: avatarOf(body.avatar), nick: clip(String(body.nick || '').replace(/[\x00-\x1f<>]/g, ''), 16),
      id, cwd, key: projectKey(projectRoot(cwd)), name: 'monitor-' + id, mode, model: String(body.model || '').replace(/[^\w.:[\]-]/g, '') || '',
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

  async function handle(url, body) {
    const a = agents.get(String(body.id || ''))
    if (url.pathname === '/api/agents/start') return start(body)
    if (!a) return [404, {}]
    if (url.pathname === '/api/agents/send') {
      const text = clip(body.text, 8000), files = attachedPaths(body.files)
      if (!text && !files.length) return [400, {}]
      return send(a, text, files) ? [200, {}] : [500, {}]
    }
    if (url.pathname === '/api/agents/stop') { stop(a); return [200, {}] }
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
      if (typeof body.model === 'string') a.model = body.model.replace(/[^\w.:[\]-]/g, '')
      if (typeof body.nick === 'string') a.nick = clip(body.nick.replace(/[\x00-\x1f<>]/g, ''), 16)
      if (body.avatar !== undefined) a.avatar = avatarOf(body.avatar)
      if (typeof body.nick === 'string' || body.avatar !== undefined) { save(); notifyPages(); if (!('mode' in body) && !('model' in body)) return [200, {}] }
      save()
      const what = 'mode ' + a.mode + (a.model ? ' · model ' + a.model : '')
      if (!a.proc) { emit(a, { kind: 'note', text: what + ' — from the next message' }); notifyPages(); return [200, {}] }
      const asks = [...('mode' in body ? [{ subtype: 'set_permission_mode', mode: a.mode }] : []), ...('model' in body ? [{ subtype: 'set_model', ...(a.model ? { model: a.model } : {}) }] : [])]
      const answers = await Promise.all(asks.map((r) => control(a, r)))
      if (answers.every((r) => r.subtype === 'success')) emit(a, { kind: 'note', text: what + ' — now' })
      else if (a.state === 'working') { a.restartAfterTurn = true; emit(a, { kind: 'note', text: what + ' — after this turn' }) }
      else { a.respawn = true; stop(a); emit(a, { kind: 'note', text: what + ' — from the next message' }) }
      notifyPages()
      return [200, {}]
    }
    if (url.pathname === '/api/agents/close') { stop(a); agents.delete(a.id); save(); notifyPages(); return [200, {}] }
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
    return [...agents.values()].map((a) => ({
      managed: true, agentId: a.id, sessionId: a.sessionId || a.newSessionId, name: a.name, avatar: a.avatar, nick: a.nick, cwd: a.cwd, root: projectRoot(a.cwd), key: a.key,
      state: a.state === 'working' ? 'working' : a.state === 'idle' ? 'waiting' : 'resting', running: !!a.proc,
      statusSince: a.stateSince, startedAt: a.startedAt, mode: a.mode, model: a.model, activity: a.activity, activityAt: a.activityAt, lastEventAt: a.lastAt,
    }))
  }
  const byAgentSession = (sessionId) => [...agents.values()].find((a) => a.sessionId === sessionId || a.newSessionId === sessionId)

  function shutdown() { shuttingDown = true; for (const a of agents.values()) stop(a) }

  load()
  return { handle, stream, prompt, sessions, byAgentSession, shutdown, claudeExecutable }
}
