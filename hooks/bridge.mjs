#!/usr/bin/env node
// Claude Code hook → agent monitor.
//
// Registered in ~/.claude/settings.json for PermissionRequest (and PostToolUse / Stop for the permission mode).
// Reads the hook input from stdin, hands it to the monitor on 127.0.0.1 and prints the monitor's answer.
// Whenever anything goes wrong — monitor not running, timeout, bad reply — it prints nothing and exits 0,
// so Claude Code carries on exactly as if this hook did not exist (the normal prompt appears).
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

// the running monitor leaves its port and token in ~/.claude-agent-monitor (the folder next to the code is the old place)
const RUNTIME = [path.join(os.homedir(), '.claude-agent-monitor', 'bridge.json'), path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.runtime', 'bridge.json')]
  .find((p) => fs.existsSync(p)) || ''
const WAIT_MS = 75 * 1000   // a little longer than the monitor's own 60 s wait

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
      host: '127.0.0.1', port, path: '/hook', method: 'POST', timeout: WAIT_MS,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-monitor-token': token },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(res.statusCode === 200 ? Buffer.concat(chunks).toString('utf8') : ''))
    })
    req.on('timeout', () => { req.destroy(); resolve('') })
    req.on('error', () => resolve(''))
    req.end(body)
  })
}

async function main() {
  let conf
  try { conf = JSON.parse(fs.readFileSync(RUNTIME, 'utf8')) } catch { return }   // monitor not running
  const input = await readStdin()
  if (!input) return
  const reply = await post(conf.port, conf.token, input)
  let out
  try { out = JSON.parse(reply) } catch { return }
  if (out && out.hookSpecificOutput) process.stdout.write(JSON.stringify(out))
}

main().catch(() => {}).finally(() => process.exit(0))
