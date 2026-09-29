#!/usr/bin/env node
// Claude Code Stop hook (async + asyncRewake) → waits for a message typed on the agent monitor's page.
//
// After each turn Claude Code starts this in the background. It asks the monitor on 127.0.0.1 for messages
// addressed to this session and waits. When one arrives it prints the text to stderr and exits 2, which makes
// Claude Code wake the session with that text. On anything else — no monitor, timeout, a newer waiter for the
// same session — it exits 0 quietly and nothing happens.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

// the running monitor leaves its port and token in ~/.claude-agent-monitor (the folder next to the code is the old place)
// looked up on every try: the monitor may not be running yet when this starts waiting
const linkFile = () => [path.join(os.homedir(), '.claude-agent-monitor', 'bridge.json'), path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.runtime', 'bridge.json')]
  .find((p) => fs.existsSync(p)) || ''
const WAIT_MS = 26 * 60 * 1000   // a little longer than the monitor's own wait

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
      host: '127.0.0.1', port, path: '/hook/wait', method: 'POST', timeout: WAIT_MS,
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
  // A restart of the monitor drops the connection; the session is still idle and still waiting, so keep
  // listening: reread the port and token (they change on every start) and connect again, until the deadline.
  const deadline = Date.now() + WAIT_MS
  let reply = null
  while (Date.now() < deadline) {
    let conf
    try { conf = JSON.parse(fs.readFileSync(linkFile(), 'utf8')) } catch { conf = null }
    const raw = conf ? await post(conf.port, conf.token, JSON.stringify({ session_id: input.session_id })) : null
    if (raw !== null) { try { reply = JSON.parse(raw) } catch { reply = {} } break }
    await new Promise((r) => setTimeout(r, 3000))
  }
  if (!reply || reply.superseded) return 0
  const messages = Array.isArray(reply?.messages) ? reply.messages : []
  if (!messages.length) return 0
  const lines = messages.map((m) => '- ' + String(m.text))
  process.stderr.write('Message(s) the user typed on the agent monitor page for this session:\n' + lines.join('\n') + '\n')
  return 2
}

main().then((code) => process.exit(code), () => process.exit(0))
