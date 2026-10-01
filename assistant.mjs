// The monitor's assistant: one fixed monitor agent, behind the floating chat button, that looks after all the
// others for the person. It works only through the tools in hooks/assistant-mcp.mjs (answered here) and is told
// about what matters as it happens: a request waiting too long, an agent that looks stuck, the plan running out.
// Nothing here is stored beyond what the agent list already keeps; events are held in memory until passed on.
import path from 'node:path'

const SYSTEM = `You are the assistant of ELOP Crew (the AI Agent Monitor) on this PC: a dashboard of every Claude Code session here — the agents
the monitor runs itself and the sessions open in VS Code — grouped by project. The person talks to you in a chat
window on that dashboard. Your job is to look after the agents for them: know what each is doing, notice problems,
keep work moving, and tell the person only what needs them.

Your tools (mcp__assistant__*):
- status: every project and agent, what it is doing, stuck or erroring ones, the requests waiting for an answer, and
  the plan's usage. Look before you act or report; never guess at state.
- send_message: tell an agent something (a reminder, a question, to carry on, to report).
- answer_request: allow or deny a waiting permission request.
- nudge: stop a stuck monitor agent and ask it to carry on.
- notify_user: get the person's attention (desktop notification and a badge).

Rules for answering requests on the person's behalf:
- Allow only routine, reversible work inside the agent's own project: reading, searching, building, running tests,
  editing files the task is about.
- Never allow, and leave to the person: deleting or overwriting outside the task, git push --force, history rewrites,
  deploys or releases, anything touching credentials, tokens, keys, .env files or money, network calls to unknown
  hosts, installs of global software, anything outside the project folder, anything you are not sure about.
- Questions an agent asks the person (AskUserQuestion) and plans to approve are for the person, not for you.
- Every answer you give is shown to the person with your reason; keep the reason short and concrete.

Messages that start with "[Monitor events]" come from the monitor, not the person. For each, decide whether the
person needs to know or act. Fix what you safely can (nudge, a message, a routine approval), and use notify_user only
when they must do something or would want to know now. If nothing needs them, reply with one short line.

Write to the person in the language the monitor tells you they use, briefly, with agent names as the page shows them.
You have no project of your own: do not edit files or run commands unless the person asks you to.`

const WAIT_TELL_MS = 2 * 60 * 1000   // a request unanswered this long is passed on
const TICK_MS = 15 * 1000

export function createAssistant({ agents, dataDir, state, decide, sendTo, requestSession, notifyPages }) {
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
  const allSessions = (data) => (data.projects || []).flatMap((p) => p.sessions.map((s) => ({ ...s, project: p.key })))
  function findAgent(data, name) {
    const n = String(name || '').trim().toLowerCase()
    return allSessions(data).find((s) => [s.nickKo, s.nick, s.name, s.short].some((x) => x && String(x).toLowerCase() === n))
  }

  function statusText(data) {
    const now = Date.now(), lines = []
    for (const p of data.projects || []) {
      lines.push(`Project ${p.key}${p.label ? ' (' + p.label + ')' : ''}:`)
      for (const s of p.sessions) {
        const act = s.activity ? [s.activity.key, s.activity.arg].filter(Boolean).join(' ') : ''
        lines.push(`- ${who(s)}${s.isLeader ? ' [leader]' : ''} · ${s.managed ? 'monitor agent' : 'VS Code session'} · ${s.state}` +
          (s.role ? ` · role: ${s.role}` : '') + (act ? ` · ${act}` : '') +
          (s.stalledFor ? ` · LOOKS STUCK for ${Math.round((now - s.stalledFor) / 60000)} min` : '') +
          (s.errors ? ` · ${s.errors}/${s.results} recent tool results failed` : '') + (s.mode ? ` · mode ${s.mode}` : ''))
      }
    }
    const asks = data.approvals || []
    lines.push('', asks.length ? 'Waiting for an answer:' : 'No requests waiting.')
    for (const a of asks) {
      const kind = a.questions ? 'question for the person' : a.plan ? 'plan to approve (for the person)' : 'permission'
      lines.push(`- id ${a.id} · ${a.nickKo || a.nick || a.session} (${a.project || '?'}) · ${kind} · ${a.tool}${a.what ? ': ' + a.what : ''}${a.code ? ' · ' + String(a.code).slice(0, 300) : ''} · waiting ${Math.round((now - a.at) / 1000)} s`)
    }
    for (const x of data.usage?.limits || []) lines.push(`Usage ${x.kind}${x.model ? ' ' + x.model : ''}: ${Math.round(x.percent)}%`)
    return lines.join('\n')
  }

  // a tool call from the assistant's MCP server
  async function tool(body) {
    if (String(body.agent || '') !== 'assistant') return 'Only the monitor\'s assistant has these tools.'
    const args = body.args || {}
    const data = await state()
    switch (String(body.tool || '')) {
      case 'status': return statusText(data)
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
  const told = { asks: new Set(), stuck: new Set(), usage: new Map() }
  let queue = []
  async function watch() {
    if (!on) return
    let data
    try { data = await state() } catch { return }
    const now = Date.now()
    const asks = data.approvals || []
    for (const a of asks) {
      if (told.asks.has(a.id) || now - a.at < WAIT_TELL_MS) continue
      if (ownRequest(a.id)) continue
      told.asks.add(a.id)
      queue.push(`${a.nickKo || a.nick || a.session} (${a.project}) has waited ${Math.round((now - a.at) / 60000)} min for an answer: ${a.questions ? 'a question for the person' : a.plan ? 'a plan to approve' : a.tool + (a.what ? ' — ' + a.what : '')} (id ${a.id})`)
    }
    for (const id of told.asks) if (!asks.some((a) => a.id === id)) told.asks.delete(id)
    const sessions = allSessions(data)
    for (const s of sessions) {
      if (s.stalledFor && !told.stuck.has(s.name)) { told.stuck.add(s.name); queue.push(`${who(s)} (${s.project}, ${s.managed ? 'monitor agent' : 'VS Code session'}) is working but has shown no sign of activity for ${Math.round((now - s.stalledFor) / 60000)} min`) }
      if (!s.stalledFor) told.stuck.delete(s.name)
    }
    for (const x of data.usage?.limits || []) {
      const level = x.percent >= 95 ? 95 : x.percent >= 80 ? 80 : 0, k = x.kind + (x.model || '')
      if (level > (told.usage.get(k) || 0)) queue.push(`The plan's ${x.kind}${x.model ? ' ' + x.model : ''} usage is at ${Math.round(x.percent)}%`)
      told.usage.set(k, level)
    }
    // one message for all of it, when the assistant is free
    const st = agents.assistantState()
    if (queue.length && st && st.state !== 'working') {
      const text = '[Monitor events]\n' + queue.map((q) => '- ' + q).join('\n')
      queue = []
      agents.sendText('assistant', text)
    }
  }
  const timer = setInterval(() => { watch().catch(() => {}) }, TICK_MS)
  timer.unref?.()

  return { start, tool, info: () => agents.assistantState() }
}
