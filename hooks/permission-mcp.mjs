#!/usr/bin/env node
// A tiny MCP server (stdio, JSON-RPC) with one tool, `approve`, used by agents the monitor runs itself:
//   claude -p … --mcp-config {monitor: this file} --permission-prompt-tool mcp__monitor__approve
// Claude Code calls it whenever a tool needs permission (or asks the user a question). It hands the request to
// the monitor, which shows it on the page and waits for a person; the answer goes back as the tool's result.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const RUNTIME = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.runtime', 'bridge.json')
const AGENT = process.env.MONITOR_AGENT || ''

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })

function ask(args) {
  return new Promise((resolve) => {
    let conf
    try { conf = JSON.parse(fs.readFileSync(RUNTIME, 'utf8')) } catch { return resolve({ behavior: 'deny', message: 'The agent monitor is not running' }) }
    const body = JSON.stringify({ agent: AGENT, tool_name: args.tool_name, input: args.input })
    const req = http.request({
      host: '127.0.0.1', port: conf.port, path: '/hook/prompt', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-monitor-token': conf.token },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { resolve({ behavior: 'deny', message: 'Bad answer from the agent monitor' }) } })
    })
    req.on('error', () => resolve({ behavior: 'deny', message: 'Could not reach the agent monitor' }))
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
      reply(m.id, { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agent-monitor', version: '1.0.0' } })
    } else if (m.method === 'tools/list') {
      reply(m.id, { tools: [{
        name: 'approve',
        description: 'Asks the person at the agent monitor to allow or deny a tool call, or to answer a question.',
        inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] },
      }] })
    } else if (m.method === 'tools/call') {
      const decision = await ask(m.params?.arguments || {})
      reply(m.id, { content: [{ type: 'text', text: JSON.stringify(decision) }] })
    } else if (m.id !== undefined) {
      send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
