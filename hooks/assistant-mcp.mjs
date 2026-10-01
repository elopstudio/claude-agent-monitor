#!/usr/bin/env node
// The monitor's own tools for its assistant (an MCP server over stdio, JSON-RPC), given only to the assistant agent:
//   claude -p … --mcp-config {assistant: this file} --allowedTools mcp__assistant
// Each call goes to the monitor on 127.0.0.1 (/hook/assistant), which checks that it comes from the assistant and
// does the work: what every agent is doing, a message to one, an answer to a waiting request, an alert to the person.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const RUNTIME = [process.env.MONITOR_LINK || '', path.join(os.homedir(), '.claude-agent-monitor', 'bridge.json'), path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.runtime', 'bridge.json')]
  .find((p) => p && fs.existsSync(p)) || ''
const AGENT = process.env.MONITOR_AGENT || ''

const TOOLS = [
  {
    name: 'status',
    description: 'Every project and agent on this PC right now: name, kind (monitor agent or VS Code session), state, what it is doing, whether it looks stuck, its recent tool errors; the requests waiting for an answer (with their ids); the Claude plan usage. Call it first, and again before acting on anything.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'send_message',
    description: 'Send a message to one agent, as if typed in its message box on the page. A monitor agent gets it at once; a VS Code session when it next listens (the answer says if it is not listening). Name it by the name shown in status.',
    inputSchema: { type: 'object', properties: { agent: { type: 'string' }, text: { type: 'string' } }, required: ['agent', 'text'] },
  },
  {
    name: 'answer_request',
    description: 'Allow or deny a waiting permission request by its id from status. Only for routine, reversible work inside the project the agent belongs to; leave anything destructive, outside the project, about secrets or money, or not clearly safe to the person. Always give the reason; it is shown to the person.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, decision: { type: 'string', enum: ['allow', 'deny'] }, reason: { type: 'string' } }, required: ['id', 'decision', 'reason'] },
  },
  {
    name: 'nudge',
    description: 'Stop a monitor agent that looks stuck and ask it to carry on (the same as "Stop and carry on" on the page). Not for VS Code sessions.',
    inputSchema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] },
  },
  {
    name: 'notify_user',
    description: 'Get the person\'s attention: a highlighted line in your chat, a badge on the chat button, and a desktop notification. For what needs them now (a decision, a problem, something finished they were waiting for). Do not use it for routine updates — just write those in your reply.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, level: { type: 'string', enum: ['info', 'warn'] } }, required: ['text'] },
  },
]

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })

function call(tool, args) {
  return new Promise((resolve) => {
    let conf
    try { conf = JSON.parse(fs.readFileSync(RUNTIME, 'utf8')) } catch { return resolve('The agent monitor is not running.') }
    const body = JSON.stringify({ agent: AGENT, tool, args })
    const req = http.request({
      host: '127.0.0.1', port: conf.port, path: '/hook/assistant', method: 'POST', timeout: 30000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-monitor-token': conf.token },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => { try { resolve(String(JSON.parse(Buffer.concat(chunks).toString('utf8')).text || '')) } catch { resolve('Bad answer from the agent monitor.') } })
    })
    req.on('timeout', () => { req.destroy(); resolve('The agent monitor did not answer.') })
    req.on('error', () => resolve('Could not reach the agent monitor.'))
    req.end(body)
  })
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', async (chunk) => {
  const lines = (buf + chunk).split('\n')
  buf = lines.pop()
  for (const line of lines) {
    if (!line.trim()) continue
    let m
    try { m = JSON.parse(line) } catch { continue }
    if (m.method === 'initialize') {
      reply(m.id, { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agent-monitor-assistant', version: '1.0.0' } })
    } else if (m.method === 'tools/list') {
      reply(m.id, { tools: TOOLS })
    } else if (m.method === 'tools/call') {
      const name = String(m.params?.name || '')
      const text = TOOLS.some((t) => t.name === name) ? await call(name, m.params?.arguments || {}) : 'No such tool.'
      reply(m.id, { content: [{ type: 'text', text }] })
    } else if (m.id !== undefined) {
      send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
