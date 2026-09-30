// Tokens a session used today, from its transcript (and its subagents' transcripts).
// Only the usage numbers of assistant replies are read; nothing else from the lines is kept.
// A file is read in full once, then only what was appended; at midnight the count starts over.

import fsp from 'node:fs/promises'

const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() }
const counts = new Map()   // file → { day, offset, size, mtimeMs, byMsg: Map(message id → usage) }

// a reply is written as one line per content block, each carrying the reply's usage so far: keep the last
function addLine(c, l, day) {
  if (!l.includes('"usage"')) return
  let o
  try { o = JSON.parse(l) } catch { return }
  const u = o.message?.usage
  if (o.type !== 'assistant' || !u) return
  const ts = o.timestamp ? Date.parse(o.timestamp) : 0
  if (ts < day) return
  c.byMsg.set(o.message.id || o.uuid || String(c.byMsg.size), {
    in: u.input_tokens || 0, out: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0,
  })
}

async function fileToday(file) {
  let st
  try { st = await fsp.stat(file) } catch { return null }
  const day = midnight()
  if (st.mtimeMs < day) { counts.delete(file); return null }   // not touched today
  let c = counts.get(file)
  if (c && c.day === day && c.size === st.size && c.mtimeMs === st.mtimeMs) return c
  if (!c || c.day !== day || st.size < c.offset) c = { day, offset: 0, size: 0, mtimeMs: 0, byMsg: new Map() }
  const fh = await fsp.open(file, 'r')
  try {
    const n = st.size - c.offset
    const buf = Buffer.alloc(n)
    if (n) await fh.read(buf, 0, n, c.offset)
    // the part after the last newline is still being written: read it next time
    const end = buf.lastIndexOf(0x0a)
    if (end >= 0) {
      for (const l of buf.subarray(0, end).toString('utf8').split('\n')) if (l) addLine(c, l, day)
      c.offset += end + 1
    }
  } finally { await fh.close() }
  c.size = st.size
  c.mtimeMs = st.mtimeMs
  counts.set(file, c)
  return c
}

// { in, out, cacheRead, cacheWrite, total } for the given transcript files, or null when none was used today
export async function tokensToday(files) {
  const sum = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }
  let any = false
  for (const f of files) {
    const c = await fileToday(f).catch(() => null)
    if (!c) continue
    for (const u of c.byMsg.values()) { any = true; sum.in += u.in; sum.out += u.out; sum.cacheRead += u.cacheRead; sum.cacheWrite += u.cacheWrite }
  }
  if (!any) return null
  sum.total = sum.in + sum.out + sum.cacheRead + sum.cacheWrite
  return sum
}
