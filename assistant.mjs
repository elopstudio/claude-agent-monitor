// The monitor's assistant: one fixed monitor agent, behind the floating chat button, that looks after all the
// others for the person. It works only through the tools in hooks/assistant-mcp.mjs (answered here) and is told
// about what matters as it happens: a permission request (at once, so it can answer before a VS Code session's
// request goes back to VS Code), a question or plan left waiting, an agent that finished, failed or looks stuck, the
// login going away or coming back, the plan running out. Nothing here is stored beyond what the agent list already
// keeps; events are held in memory until passed on, and the account is known to it only as logged in or not.
import path from 'node:path'

const SYSTEM = `You are the assistant of ELOP Crew (the AI Agent Monitor) on this PC: a dashboard of every Claude Code session here — the agents
the monitor runs itself and the sessions open in VS Code — grouped by project. The person talks to you in a chat
window on that dashboard. Your job is to look after the agents for them: know what each is doing, keep work moving,
answer what is routine yourself, and bring the person only what needs them — with what you recommend.

Your tools (mcp__assistant__*):
- status: every project (with its folder) and agent, what it is doing, stuck, failed or waiting-for-login ones, the
  requests waiting for an answer, whether Claude Code is logged in, and the plan's usage. Look before you act or
  report; never guess at state.
- conversation: the last of one agent's conversation — what it was asked, what it said, the tools it used. Read it
  before judging what an agent is doing, why it failed or what should come next.
- send_message: tell an agent something (to carry on, retry, report, or a reminder).
- answer_request: allow or deny a waiting permission request.
- nudge: stop a stuck monitor agent and ask it to carry on.
- notify_user: get the person's attention (desktop notification and a badge).

How you work
- Messages that start with "[Monitor events]" come from the monitor, not the person. For each batch: call status,
  act on what you can, then write to the person — one short line when nothing needs them.
- Be decisive: handle what is routine yourself. When something is the person's to decide, put it in one line with
  your recommendation and why ("허용 추천: …" / "Recommend allowing: …"), so they can answer at a glance.
- Be ahead of the person: when an agent finishes or fails, read its conversation if it matters and say in a line or
  two what happened and the next step you suggest — or take it (tell the agent to carry on, retry or report). Do not
  report routine progress nobody needs.

Permission requests (they reach you at once; a VS Code session's request goes back to VS Code when its time runs
out — status shows how long it has — so answer those first)
Allow, without asking, work inside the agent's own project folder that can be undone:
- reading, listing and searching files; git status, diff, log, show, branch;
- creating and editing files in the project;
- building, type-checking, linting, formatting, running the tests and the project's own scripts (npm/pnpm/yarn run,
  npx of the project's tools, pytest, cargo, go test, make …);
- installing the project's dependencies inside it (npm install, pip install in its virtualenv) — never global installs;
- local git that can be undone: add, commit, creating or switching a branch, stash;
- starting or stopping the project's dev server; requests to localhost.
Leave to the person, with your recommendation: any git push, force, reset --hard, rebase or other history rewrites;
deleting files other than build output; anything outside the project folder; credentials, tokens, keys, .env files;
deploys and releases; money; sending messages or e-mail; network calls to hosts other than package registries and the
project's own; global installs and system settings; anything you cannot tell is safe.
Deny only what is clearly wrong for the task, and tell the person why.
Questions an agent asks the person, and plans to approve, are always the person's: say in a line what is asked and
what you would pick.

The login
- When the monitor says Claude Code was logged out, every agent that tries to work fails with "Not logged in". Tell
  the person once, plainly, that Claude Code needs to be logged in again (Account in the page's menu, or
  \`claude auth login\` in a terminal) and which agents are held up. Monitor agents waiting for the login carry on by
  themselves once it is back: do not nudge or message them about it. VS Code sessions need a new message in VS Code.
- When it is back, say so in a line; if it is another account than before, add that usage and limits are now that
  account's.

Agents
- One that looks stuck: read its conversation; nudge a monitor agent if it really is stuck, tell the person about a VS
  Code session (it is stopped in its own panel).
- A failed turn: a passing error (overloaded, network, rate limit) — nudge or message it once to retry; one that needs
  the person (the login, a usage limit reached, billing) — tell them.

Write to the person in the language the monitor tells you they use, briefly, with agent names as status shows them.
Every answer you give a request is shown to the person with your reason; keep it short and concrete.
You have no project of your own: do not edit files or run commands unless the person asks you to.`

const WAIT_TELL_MS = 2 * 60 * 1000   // a question or plan left this long is passed on (they are the person's)
const WORKED_MS = 60 * 1000          // a turn this long, ended, is passed on as finished
const TICK_MS = 15 * 1000

export function createAssistant({ agents, dataDir, state, decide, sendTo, requestSession, notifyPages, lang, login, conversation }) {
  // a request the assistant itself is waiting on (its own tool calls): never for it to answer
  const ownRequest = (id) => { const me = agents.assistantState(); return !!me?.sessionId && requestSession(id) === me.sessionId }
  let on = false
  const cwd = path.join(dataDir, '.runtime', 'assistant')

  // created the first time the chat is opened, and from then on kept like any monitor agent
  async function start() {
    await agents.loaded
    agents.ensureAssistant({ cwd, system: SYSTEM, model: 'sonnet' })
    on = true
    return { id: 'assistant' }
  }
  // after a restart: an assistant from before is there already — give it its role again and keep watching
  agents.loaded.then(() => { if (agents.assistantState()) start() }).catch(() => {})

  const who = (s) => s.nickKo || s.nick || s.name
  const allSessions = (data) => (data.projects || []).flatMap((p) => p.sessions.map((s) => ({ ...s, project: p.key, root: p.root })))
  function findAgent(data, name) {
    const n = String(name || '').trim().toLowerCase()
    return allSessions(data).find((s) => [s.nickKo, s.nick, s.name, s.short].some((x) => x && String(x).toLowerCase() === n))
  }
  const mins = (ms) => Math.max(0, Math.round(ms / 60000))
  let loginNow = null   // { loggedIn, plan, who } — who is a hash, compared here and never shown

  function statusText(data) {
    const now = Date.now(), lines = []
    if (loginNow) lines.push('Claude Code login: ' + (loginNow.loggedIn ? 'logged in' + (loginNow.plan ? ' (plan ' + loginNow.plan + ')' : '') : 'NOT LOGGED IN — every agent that tries to work fails'))
    if (lang?.()) lines.push("The person's language: " + lang())
    for (const p of data.projects || []) {
      lines.push(...(lines.length ? [''] : []), `Project ${p.key}${p.name ? ' "' + p.name + '"' : ''}${p.label ? ' (' + p.label + ')' : ''} — folder ${p.root || '?'}:`)
      for (const s of p.sessions) {
        const act = s.activity ? [s.activity.key, s.activity.arg].filter(Boolean).join(' ') : ''
        lines.push(`- ${who(s)}${s.isLeader ? ' [leader]' : ''} · ${s.managed ? 'monitor agent' : 'VS Code session'} · ${s.state}` +
          (s.title ? ` · on: ${s.title}` : '') + (s.role ? ` · role: ${s.role}` : '') + (act ? ` · ${act}` : '') +
          (s.loginLost ? ' · STOPPED, WAITING FOR THE LOGIN (carries on by itself once logged in)' : '') +
          (s.lastFail ? ` · last turn failed ${mins(now - s.lastFail.at)} min ago: ${s.lastFail.text}` : '') +
          (s.stalledFor ? ` · LOOKS STUCK for ${mins(now - s.stalledFor)} min` : '') +
          (s.errors ? ` · ${s.errors}/${s.results} recent tool results failed` : '') + (s.mode ? ` · mode ${s.mode}` : ''))
      }
    }
    const asks = (data.approvals || []).filter((a) => !ownRequest(a.id))
    lines.push('', asks.length ? 'Waiting for an answer:' : 'No requests waiting.')
    for (const a of asks) {
      const kind = a.questions ? 'question for the person' : a.plan ? 'plan to approve (for the person)' : 'permission'
      const left = a.expiresAt ? Math.round((a.expiresAt - now) / 1000) : 0
      lines.push(`- id ${a.id} · ${a.nickKo || a.nick || a.session} (${a.project || '?'}, ${a.managed ? 'monitor agent' : 'VS Code session'}) · ${kind} · ${a.tool}` +
        (a.what ? ': ' + a.what : '') + (a.code ? ' · ' + String(a.code).slice(0, 800) : '') + ` · waiting ${Math.round((now - a.at) / 1000)} s` +
        (!a.managed && left > 0 && !a.questions && !a.plan ? ` · goes back to VS Code in ${left} s` : ''))
    }
    for (const x of data.usage?.limits || []) lines.push(`Usage ${x.kind}${x.model ? ' ' + x.model : ''}: ${Math.round(x.percent)}%`)
    return lines.join('\n')
  }

  // the last of a conversation, as lines: what it was asked, what it said, the tools it used and what failed
  function conversationText(events) {
    const out = []
    for (const e of events.slice(-40)) {
      if (e.kind === 'user') out.push('asked: ' + String(e.text || '').slice(0, 400))
      else if (e.kind === 'block' && e.text) out.push('said: ' + String(e.text).slice(0, 700))
      else if (e.kind === 'tool') out.push('tool: ' + (e.action ? [e.action.key, e.action.arg].filter(Boolean).join(' ') : e.name))
      else if (e.kind === 'result' && e.error) out.push('tool failed: ' + String(e.text || '').slice(0, 200))
      else if (e.kind === 'note') out.push('(' + String(e.text || '').slice(0, 200) + ')')
    }
    return out.slice(-16).join('\n')
  }

  // a tool call from the assistant's MCP server
  async function tool(body) {
    if (String(body.agent || '') !== 'assistant') return 'Only the monitor\'s assistant has these tools.'
    const args = body.args || {}
    const data = await state()
    switch (String(body.tool || '')) {
      case 'status': return statusText(data)
      case 'conversation': {
        const s = findAgent(data, args.agent)
        if (!s) return `No agent called "${args.agent}". Use the names from status.`
        const text = conversationText(await conversation(s.name).catch(() => []))
        return text ? `The last of ${who(s)}'s conversation:\n${text}` : `Nothing to show for ${who(s)} yet.`
      }
      case 'send_message': {
        const s = findAgent(data, args.agent)
        const text = String(args.text || '').trim().slice(0, 4000)
        if (!s) return `No agent called "${args.agent}". Use the names from status.`
        if (!text) return 'Nothing to send.'
        const line = '[From the monitor\'s assistant] ' + text
        if (s.managed) return agents.sendText(s.agentId, line) ? `Sent to ${who(s)}.` : `Could not send to ${who(s)}.`
        const code = await sendTo(s.name, line)
        if (code !== 200) return `Could not send to ${who(s)}.`
        return s.listening || s.state === 'working' ? `Sent to ${who(s)}.` : `Queued for ${who(s)}, but it is not listening: it gets it only after its next turn in VS Code.`
      }
      case 'answer_request': {
        const a = (data.approvals || []).find((x) => x.id === String(args.id || ''))
        if (!a) return 'No such request waiting (answered or timed out already?). Check status.'
        if (ownRequest(a.id)) return 'You cannot answer your own requests; the person does.'
        if (a.questions || a.plan) return 'Questions and plans are for the person to answer.'
        const decision = args.decision === 'allow' ? 'allow' : 'deny'
        const reason = String(args.reason || '').trim().slice(0, 300)
        if (!decide(a.id, decision)) return 'It could not be answered (gone just now?).'
        // the person sees every answer given for them, with why
        agents.noteTo('assistant', { kind: 'notice', level: decision === 'allow' ? 'info' : 'warn', text: `${decision === 'allow' ? '✓' : '✕'} ${a.nickKo || a.nick || a.session}: ${a.tool}${a.what ? ' — ' + a.what : ''}${reason ? ' · ' + reason : ''}`, act: decision })
        notifyPages()
        return `${decision === 'allow' ? 'Allowed' : 'Denied'}.`
      }
      case 'nudge': {
        const s = findAgent(data, args.agent)
        if (!s) return `No agent called "${args.agent}".`
        if (!s.managed) return `${who(s)} is a VS Code session: it has to be stopped in its panel (Esc). Tell the person.`
        if (s.loginLost) return `${who(s)} is waiting for the login and carries on by itself once Claude Code is logged in; nudging it now would only fail again.`
        const [code] = await agents.handle(new URL('http://x/api/agents/nudge'), { id: s.agentId, text: 'It looked like you were stuck, so you were stopped. Please carry on with what you were doing.' })
        return code === 200 ? `Stopped ${who(s)} and asked it to carry on.` : `Could not nudge ${who(s)}.`
      }
      case 'notify_user': {
        const text = String(args.text || '').trim().slice(0, 500)
        if (!text) return 'Nothing to say.'
        agents.noteTo('assistant', { kind: 'notice', level: args.level === 'warn' ? 'warn' : 'info', text, alert: true })
        notifyPages()
        return 'The person has been notified.'
      }
    }
    return 'No such tool.'
  }

  // what is passed on: each thing once, and again only after it went away and came back
  const told = { asks: new Set(), stuck: new Set(), usage: new Map(), login: new Set(), fail: new Map() }
  const workingSince = new Map()   // agent → when it was first seen working this turn
  let lastWho = ''                 // the last account seen logged in (a hash), to tell a switch from a return
  let queue = []
  async function watch() {
    if (!on) return
    let data
    try { data = await state() } catch { return }
    const now = Date.now()
    // the login: gone, back (the same account or another), or switched
    try {
      const l = await login()
      if (loginNow) {
        if (loginNow.loggedIn && !l.loggedIn) {
          queue.push('Claude Code was logged out: agents that try to work now fail with "Not logged in" until it is logged in again')
          // the assistant cannot say it itself (it needs the login too): the monitor puts it in the chat, with an alert
          agents.noteTo('assistant', { kind: 'notice', level: 'warn', alert: true, text: lang?.() === 'Korean'
            ? 'Claude Code 로그인이 풀렸습니다. 다시 로그인할 때까지 에이전트가 일을 하지 못합니다 — 메뉴의 계정에서 로그인하거나 터미널에서 claude auth login. 모니터 에이전트는 로그인되면 스스로 이어 갑니다.'
            : 'Claude Code is logged out. Agents cannot work until it is logged in again — log in from Account in the menu, or run claude auth login in a terminal. Monitor agents carry on by themselves once it is back.' })
          notifyPages()
        }
        else if (!loginNow.loggedIn && l.loggedIn) queue.push('Claude Code is logged in again' + (lastWho && l.who && l.who !== lastWho ? ', as another account than before' : '') + '; monitor agents that were waiting for it carry on by themselves')
        else if (loginNow.loggedIn && l.loggedIn && loginNow.who && l.who && loginNow.who !== l.who) queue.push('Claude Code is now logged in as another account than before')
      }
      if (l.loggedIn && l.who) lastWho = l.who
      loginNow = l
    } catch {}
    const asks = (data.approvals || []).filter((a) => !ownRequest(a.id))
    for (const a of asks) {
      if (told.asks.has(a.id)) continue
      const forPerson = a.questions || a.plan
      // a permission request at once, for the assistant to answer; a question or plan once it has waited a while
      if (forPerson && now - a.at < WAIT_TELL_MS) continue
      told.asks.add(a.id)
      const left = a.expiresAt ? Math.round((a.expiresAt - now) / 1000) : 0
      queue.push(forPerson
        ? `${a.nickKo || a.nick || a.session} (${a.project}) has waited ${mins(now - a.at)} min for the person: ${a.questions ? 'a question' : 'a plan to approve'} (id ${a.id})`
        : `${a.nickKo || a.nick || a.session} (${a.project}, ${a.managed ? 'monitor agent' : 'VS Code session'}) asks permission: ${a.tool}${a.what ? ' — ' + a.what : ''} (id ${a.id})${!a.managed && left > 0 ? `; it goes back to VS Code in ${left} s` : ''}`)
    }
    for (const id of told.asks) if (!asks.some((a) => a.id === id)) told.asks.delete(id)
    const sessions = allSessions(data)
    const held = []
    for (const s of sessions) {
      if (s.stalledFor && !told.stuck.has(s.name)) { told.stuck.add(s.name); queue.push(`${who(s)} (${s.project}, ${s.managed ? 'monitor agent' : 'VS Code session'}) is working but has shown no sign of activity for ${mins(now - s.stalledFor)} min`) }
      if (!s.stalledFor) told.stuck.delete(s.name)
      if (s.loginLost && !told.login.has(s.name)) { told.login.add(s.name); held.push(who(s) + ' (' + s.project + ')') }
      if (!s.loginLost) told.login.delete(s.name)
      // a failed turn, once each (the login has its own line)
      if (s.lastFail && !s.loginLost && told.fail.get(s.name) !== s.lastFail.at) { told.fail.set(s.name, s.lastFail.at); queue.push(`${who(s)} (${s.project}): its last turn failed — ${s.lastFail.text}`) }
      // a turn of some length that ended well: what it was on, for the assistant to judge whether the person needs it
      if (s.state === 'working') { if (!workingSince.has(s.name)) workingSince.set(s.name, now) }
      else if (workingSince.has(s.name)) {
        const since = workingSince.get(s.name)
        workingSince.delete(s.name)
        if (now - since >= WORKED_MS && !s.lastFail && !s.loginLost) queue.push(`${who(s)} (${s.project}, ${s.managed ? 'monitor agent' : 'VS Code session'}) finished a turn after ${mins(now - since)} min${s.title ? ' — on: ' + s.title : ''}`)
      }
    }
    for (const name of workingSince.keys()) if (!sessions.some((s) => s.name === name)) workingSince.delete(name)
    if (held.length) queue.push('Stopped and waiting for the Claude Code login (they carry on by themselves once it is back): ' + held.join(', '))
    for (const x of data.usage?.limits || []) {
      const level = x.percent >= 95 ? 95 : x.percent >= 80 ? 80 : 0, k = x.kind + (x.model || '')
      if (level > (told.usage.get(k) || 0)) queue.push(`The plan's ${x.kind}${x.model ? ' ' + x.model : ''} usage is at ${Math.round(x.percent)}%`)
      told.usage.set(k, level)
    }
    // one message for all of it, when the assistant is free (and not for want of a login it cannot work without)
    const st = agents.assistantState()
    if (queue.length && st && st.state !== 'working' && loginNow?.loggedIn !== false) {
      const text = '[Monitor events]\n' + queue.slice(-25).map((q) => '- ' + q).join('\n')
      queue = []
      agents.sendText('assistant', text)
    }
  }
  const timer = setInterval(() => { watch().catch(() => {}) }, TICK_MS)
  timer.unref?.()

  return { start, tool, info: () => agents.assistantState() }
}
