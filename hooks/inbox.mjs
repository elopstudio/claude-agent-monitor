#!/usr/bin/env node
// Claude Code Stop hook (async + asyncRewake) → waits for a message typed on the agent monitor's page.
//
// After each turn Claude Code starts this in the background. It asks the monitor on 127.0.0.1 for messages
// addressed to this session and waits. When one arrives it prints the text to stderr and exits 2, which makes
// Claude Code wake the session with that text. On anything else — a newer waiter for the same session, the session
// gone, the day over — it exits 0 quietly and nothing happens.
//
// It waits for most of a week, so a session that has been resting for days can still be woken from the page:
// the monitor answers empty after 25 minutes and it simply asks again. The hook's own timeout is 7 days
// (installs from before gave it 24 hours; it gives up at whichever comes first).
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

// the running monitor leaves its port and token in ~/.claude-agent-monitor (the folder next to the code is the old place)
// looked up on every try: the monitor may not be running yet when this starts waiting
const linkFile = () => [path.join(os.homedir(), '.claude-agent-monitor', 'bridge.json'), path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.runtime', 'bridge.json')]
  .find((p) => fs.existsSync(p)) || ''
const WAIT_MS = (7 * 24 * 60 - 10) * 60 * 1000   // just under the hook's 7-day timeout
const POLL_MS = 26 * 60 * 1000               // one wait at the monitor, a little longer than its own 25 minutes
// the session that started this: when it is gone (VS Code closed), nobody is left to wake
function parentAlive() { try { process.kill(process.ppid, 0); return true } catch (e) { return e.code === 'EPERM' } }

function readStdin() {
  return new Promise((resolve) => {
    const chunks = []
    process.stdin.on('data', (c) => chunks.push(c))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', () => resolve(''))
  })
}

function post(port, token, body) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/hook/wait', method: 'POST', timeout: POLL_MS,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-monitor-token': token },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(res.statusCode === 200 ? Buffer.concat(chunks).toString('utf8') : null))
      res.on('error', () => resolve(null))
    })
    req.on('timeout', () => { req.destroy(); resolve('') })
    req.on('error', () => resolve(null))   // the monitor went away (restarted, stopped): try again
    req.end(body)
  })
}

async function main() {
  let input
  try { input = JSON.parse(await readStdin()) } catch { return 0 }
  if (!input.session_id) return 0
  // A restart of the monitor drops the connection, and its wait runs out after 25 minutes; either way the session
  // is still idle, so keep listening: reread the port and token (they change on every start) and ask again.
  const deadline = Date.now() + WAIT_MS
  while (Date.now() < deadline) {
    if (!parentAlive()) return 0
    let conf
    try { conf = JSON.parse(fs.readFileSync(linkFile(), 'utf8')) } catch { conf = null }
    const raw = conf ? await post(conf.port, conf.token, JSON.stringify({ session_id: input.session_id })) : null
    if (raw === null) { await new Promise((r) => setTimeout(r, 3000)); continue }   // the monitor is away: try again
    let reply
    try { reply = JSON.parse(raw) } catch { reply = {} }
    if (reply.superseded) return 0   // a newer turn's hook waits instead
    const messages = Array.isArray(reply.messages) ? reply.messages : []
    if (!messages.length) continue   // nothing yet: wait again
    const lines = messages.map((m) => '- ' + String(m.text))
    process.stderr.write('Message(s) the user typed on the agent monitor page for this session:\n' + lines.join('\n') + '\n')
    return 2
  }
  return 0
}

main().then((code) => process.exit(code), () => process.exit(0))
