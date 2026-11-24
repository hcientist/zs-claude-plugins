#!/usr/bin/env bun
/**
 * matrix-rooms proxy: ONE Matrix bot account fanned out to many Claude sessions,
 * one per Matrix room. The Matrix counterpart of plugins/telegram/proxy.
 *
 * It owns the access token and the single /sync loop, gates every event on an
 * allowlist of Matrix IDs, queues inbound messages per room, and exposes the
 * same small HTTP surface the telegram-topics MCP uses (topic == room id):
 *
 *   GET  /poll?topic=ROOM     long-poll ~25s: 204 idle / 200 {content, meta}
 *   POST /send /react /edit /download   (carry topic = room id)
 *   POST /room/create         {name}  -> new unencrypted room in the Space
 *   GET  /rooms               rooms the bot is in (+ queued counts)
 *   GET  /health
 *
 * Lobby commands (from an allowed user, in any room the bot is in):
 *   !new <name>    create a room for a new context, invite the sender
 *   !rooms         list rooms
 *   !ping          liveness check
 *
 * Not yet: spawning a tmux Claude per room (step 3), encryption (rooms are
 * created unencrypted; encrypted events are answered with a notice).
 *
 * Env (from ~/.config/matrix-claude/.env or the real environment):
 *   MATRIX_HOMESERVER, MATRIX_USER_ID, MATRIX_ACCESS_TOKEN,
 *   MATRIX_ALLOWED_USERS (comma-separated MXIDs), MATRIX_PROXY_PORT (8791),
 *   MATRIX_INBOX_DIR (downloads; default ~/.config/matrix-claude/inbox)
 */

import { marked } from 'marked'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'

const CONF_DIR = join(homedir(), '.config/matrix-claude')
loadEnvFile(join(CONF_DIR, '.env'))

const HS = must('MATRIX_HOMESERVER').replace(/\/+$/, '')
const ME = must('MATRIX_USER_ID')
const TOKEN = must('MATRIX_ACCESS_TOKEN')
const ALLOWED = new Set(must('MATRIX_ALLOWED_USERS').split(',').map(s => s.trim()).filter(Boolean))
const PORT = Number(process.env.MATRIX_PROXY_PORT ?? 8791)
const INBOX = process.env.MATRIX_INBOX_DIR ?? join(CONF_DIR, 'inbox')
const STATE_FILE = join(CONF_DIR, 'state.json')
const SPACE_NAME = process.env.MATRIX_SPACE_NAME ?? 'Claude'
mkdirSync(INBOX, { recursive: true })

function must(k: string): string {
  const v = process.env[k]
  if (!v) {
    console.error(`matrix-proxy: missing ${k}`)
    process.exit(1)
  }
  return v
}

function loadEnvFile(path: string) {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
}

const log = (...a: unknown[]) => console.error(new Date().toISOString(), 'matrix-proxy:', ...a)

// ---------- persistent state ----------
type RoomState = { session: string; claude_session_id: string; spawned?: boolean; last_active?: number }
type State = { since?: string; space_id?: string; rooms?: Record<string, RoomState> }
let state: State = {}
try {
  state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
} catch {}
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 })

// ---------- Matrix client-server API ----------
let txn = Date.now()
async function mx(method: string, path: string, body?: unknown, raw?: { type: string; data: BodyInit }): Promise<any> {
  const res = await fetch(`${HS}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(raw ? { 'content-type': raw.type } : body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: raw ? raw.data : body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data: any
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text }
  }
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} -> ${res.status} ${data.errcode ?? ''} ${data.error ?? text}`)
  return data
}
const enc = encodeURIComponent

async function sendEvent(room: string, type: string, content: unknown): Promise<string> {
  const r = await mx('PUT', `/_matrix/client/v3/rooms/${enc(room)}/send/${enc(type)}/${txn++}`, content)
  return r.event_id
}

function textContent(text: string, format?: string): Record<string, unknown> {
  if (format === 'text') return { msgtype: 'm.text', body: text }
  // default: markdown -> HTML (Element renders formatted_body)
  const html = (marked.parse(text, { async: false, gfm: true, breaks: true }) as string).trim()
  return { msgtype: 'm.text', body: text, format: 'org.matrix.custom.html', formatted_body: html }
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
  html: 'text/html', csv: 'text/csv', mp4: 'video/mp4', mp3: 'audio/mpeg', zip: 'application/zip',
}

async function uploadFile(room: string, path: string, replyTo?: string): Promise<string> {
  const f = Bun.file(path)
  if (!(await f.exists())) throw new Error(`no such file: ${path}`)
  if (f.size > 50 * 1024 * 1024) throw new Error(`file too large (>50MB): ${path}`)
  const name = basename(path)
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const type = MIME[ext] ?? f.type ?? 'application/octet-stream'
  const up = await mx('POST', `/_matrix/media/v3/upload?filename=${enc(name)}`, undefined, { type, data: f })
  const msgtype = type.startsWith('image/') ? 'm.image' : type.startsWith('video/') ? 'm.video' : type.startsWith('audio/') ? 'm.audio' : 'm.file'
  return sendEvent(room, 'm.room.message', {
    msgtype, body: name, filename: name, url: up.content_uri, info: { mimetype: type, size: f.size },
    ...(replyTo ? { 'm.relates_to': { 'm.in_reply_to': { event_id: replyTo } } } : {}),
  })
}

async function createRoom(name: string, inviter: string): Promise<string> {
  const space = await ensureSpace(inviter)
  const r = await mx('POST', '/_matrix/client/v3/createRoom', {
    name,
    preset: 'private_chat',
    invite: [...new Set([inviter, ...ALLOWED])],
    // no m.room.encryption in initial_state -> unencrypted (can be added later; never removed)
    power_level_content_override: { users: { [ME]: 100, [inviter]: 100 } },
  })
  const room = r.room_id
  const via = [ME.split(':')[1]]
  await mx('PUT', `/_matrix/client/v3/rooms/${enc(space)}/state/m.space.child/${enc(room)}`, { via, suggested: false })
  await mx('PUT', `/_matrix/client/v3/rooms/${enc(room)}/state/m.space.parent/${enc(space)}`, { via, canonical: true })
  return room
}

async function ensureSpace(inviter: string): Promise<string> {
  if (state.space_id) return state.space_id
  const r = await mx('POST', '/_matrix/client/v3/createRoom', {
    name: SPACE_NAME,
    topic: 'Claude sessions: one room per context',
    preset: 'private_chat',
    creation_content: { type: 'm.space' },
    invite: [...new Set([inviter, ...ALLOWED])],
    power_level_content_override: { users: { [ME]: 100, [inviter]: 100 }, events_default: 100 },
  })
  state.space_id = r.room_id
  saveState()
  log('created space', r.room_id)
  return r.room_id
}

// ---------- per-room queues + long-poll waiters ----------
type Inbound = { content: string; meta: Record<string, string> }
const queues = new Map<string, Inbound[]>()
const waiters = new Map<string, (m: Inbound | null) => void>()
const roomNames = new Map<string, string>()

function enqueue(room: string, msg: Inbound) {
  const w = waiters.get(room)
  if (w) {
    waiters.delete(room)
    w(msg)
    return
  }
  const q = queues.get(room) ?? []
  q.push(msg)
  queues.set(room, q)
}

function waitFor(room: string, ms: number): Promise<Inbound | null> {
  const q = queues.get(room)
  if (q?.length) return Promise.resolve(q.shift()!)
  waiters.get(room)?.(null) // newer poller wins
  return new Promise(resolve => {
    const t = setTimeout(() => {
      if (waiters.get(room) === done) waiters.delete(room)
      resolve(null)
    }, ms)
    const done = (m: Inbound | null) => {
      clearTimeout(t)
      resolve(m)
    }
    waiters.set(room, done)
  })
}

// ---------- per-room Claude sessions (tmux) ----------
const PLUGIN_DIR = join(import.meta.dir, '..')
const LAUNCHER = join(PLUGIN_DIR, 'scripts/launch-room.sh')
const SPAWN_DIR = process.env.MATRIX_SPAWN_DIR ?? homedir()
const IDLE_REAP_HOURS = Number(process.env.MATRIX_IDLE_REAP_HOURS ?? 6)
const MODEL = process.env.MATRIX_MODEL ?? ''
const spawning = new Set<string>()

function roomState(room: string): RoomState {
  state.rooms ??= {}
  let r = state.rooms[room]
  if (!r) {
    const slug = (roomNames.get(room) || 'room').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'room'
    const tag = room.slice(1, 5).toLowerCase().replace(/[^a-z0-9]/g, 'x')
    r = state.rooms[room] = { session: `mx-${slug}-${tag}`, claude_session_id: crypto.randomUUID() }
    saveState()
  }
  return r
}

async function tmuxHas(session: string): Promise<boolean> {
  const p = Bun.spawn(['tmux', 'has-session', '-t', `=${session}`], { stdout: 'ignore', stderr: 'ignore' })
  return (await p.exited) === 0
}

function kickoff(room: string): string {
  const name = roomNames.get(room) || room
  return (
    `SYSTEM STARTUP NOTICE (not a user message): you are the Claude for the "${name}" Matrix room (${room}). ` +
    `Do NOT greet or send anything yet. Wait for the first real user message - it arrives as a <channel> turn - ` +
    `and respond to THAT via the matrix reply tool. Your working dir is ${SPAWN_DIR}. IMPORTANT: other Claudes ` +
    `may be running concurrently on this same machine, un-sandboxed and possibly in overlapping dirs, so be careful ` +
    `with destructive or global actions and with shared state, and do not assume you are alone.`
  )
}

async function ensureSession(room: string): Promise<void> {
  const r = roomState(room)
  r.last_active = Date.now()
  saveState()
  if (spawning.has(room) || (await tmuxHas(r.session))) return
  spawning.add(room)
  try {
    const resume = r.spawned ? '1' : ''
    log(`spawning ${r.session} for ${room}${resume ? ' (resume)' : ''}`)
    const p = Bun.spawn(['bash', LAUNCHER], {
      env: {
        ...process.env,
        MX_SESSION: r.session, MX_SPAWN_DIR: SPAWN_DIR, MATRIX_ROOM_ID: room,
        MATRIX_PROXY_URL: `http://localhost:${PORT}`, MX_PLUGIN_DIR: PLUGIN_DIR,
        MX_KICKOFF: kickoff(room), MX_CLAUDE_SESSION_ID: r.claude_session_id, MX_RESUME: resume, MX_MODEL: MODEL,
      },
      stdout: 'inherit', stderr: 'inherit',
    })
    if ((await p.exited) !== 0) throw new Error('launcher failed')
    r.spawned = true
    saveState()
  } catch (e) {
    log('spawn failed', room, e)
  } finally {
    spawning.delete(room)
  }
}

async function killSession(room: string): Promise<boolean> {
  const r = state.rooms?.[room]
  if (!r || !(await tmuxHas(r.session))) return false
  await Bun.spawn(['tmux', 'kill-session', '-t', `=${r.session}`]).exited
  log(`stopped ${r.session}`)
  return true
}

setInterval(async () => {
  if (!(IDLE_REAP_HOURS > 0)) return
  for (const [room, r] of Object.entries(state.rooms ?? {})) {
    if (r.last_active && Date.now() - r.last_active > IDLE_REAP_HOURS * 3600_000 && !queues.get(room)?.length)
      if (await killSession(room)) log(`reaped idle ${r.session}`)
  }
}, 5 * 60_000)

// mxc id handed to Claude as attachment_file_id
const attachments = new Map<string, { mxc: string; name: string }>()

// ---------- inbound ----------
async function handleEvent(room: string, ev: any) {
  if (ev.sender === ME) return
  if (!ALLOWED.has(ev.sender)) return // silent: kids and everyone else on the server
  if (ev.type === 'm.room.encrypted') {
    await sendEvent(room, 'm.room.message', { msgtype: 'm.notice', body: "This room is encrypted and I can't read it yet. Use !new <name> to make an unencrypted room." }).catch(() => {})
    return
  }
  if (ev.type !== 'm.room.message') return
  const c = ev.content ?? {}
  const rel = c['m.relates_to'] ?? {}
  const edited = rel.rel_type === 'm.replace'
  const body: string = (edited ? c['m.new_content']?.body : c.body) ?? ''

  const cmd = body.trim().match(/^!(\w+)\s*(.*)$/s)
  if (cmd && !edited) {
    const [, name, arg] = cmd
    if (name === 'ping') return void sendEvent(room, 'm.room.message', { msgtype: 'm.notice', body: 'pong' })
    if (name === 'new') {
      if (!arg.trim()) return void sendEvent(room, 'm.room.message', { msgtype: 'm.notice', body: 'usage: !new <room name>' })
      try {
        const id = await createRoom(arg.trim(), ev.sender)
        await sendEvent(room, 'm.room.message', { msgtype: 'm.notice', body: `created "${arg.trim()}" (${id}); check your invites` })
      } catch (e) {
        await sendEvent(room, 'm.room.message', { msgtype: 'm.notice', body: `!new failed: ${e}` })
      }
      return
    }
    if (name === 'sleep') {
      const stopped = await killSession(room)
      return void sendEvent(room, 'm.room.message', { msgtype: 'm.notice', body: stopped ? 'Claude for this room stopped; your next message wakes it (with its history).' : 'no Claude running for this room' })
    }
    if (name === 'status') {
      const r = state.rooms?.[room]
      const live = r ? await tmuxHas(r.session) : false
      return void sendEvent(room, 'm.room.message', { msgtype: 'm.notice', body: r ? `session ${r.session}: ${live ? 'running' : 'asleep'}; claude session ${r.claude_session_id}` : 'no Claude yet for this room; say something to start one' })
    }
    if (name === 'rooms') {
      const lines = [...roomNames].map(([id, n]) => `• ${n || '(unnamed)'}: ${id}${queues.get(id)?.length ? ` (${queues.get(id)!.length} queued)` : ''}`)
      return void sendEvent(room, 'm.room.message', { msgtype: 'm.notice', body: lines.join('\n') || 'no rooms' })
    }
  }

  const meta: Record<string, string> = {
    chat_id: room,
    message_id: ev.event_id,
    user: ev.sender,
    user_id: ev.sender,
    ts: new Date(ev.origin_server_ts).toISOString(),
  }
  if (roomNames.get(room)) meta.room_name = roomNames.get(room)!
  if (edited) meta.edits = rel.event_id
  if (rel['m.in_reply_to']?.event_id) meta.in_reply_to = rel['m.in_reply_to'].event_id
  let content = body
  if (['m.image', 'm.file', 'm.video', 'm.audio'].includes(c.msgtype) && c.url) {
    const fid = ev.event_id
    attachments.set(fid, { mxc: c.url, name: c.filename ?? c.body ?? 'file' })
    meta.attachment_file_id = fid
    meta.attachment_name = c.filename ?? c.body ?? ''
    if (c.info?.mimetype) meta.attachment_mime = c.info.mimetype
    content = c.filename && c.body !== c.filename ? c.body : `(${c.msgtype.slice(2)} attached)`
  }
  // strip reply fallback quote lines
  content = content.replace(/^(> .*\n)+\n/, '')
  enqueue(room, { content, meta })
  log(`queued ${ev.event_id} for ${room}`)
  if (room !== state.space_id) void ensureSession(room)
}

async function syncLoop() {
  const filter = enc(JSON.stringify({
    room: {
      timeline: { limit: 50, types: ['m.room.message', 'm.room.encrypted', 'm.room.name', 'm.room.member'] },
      state: { types: ['m.room.name', 'm.room.member'], lazy_load_members: true },
      ephemeral: { not_types: ['*'] },
      account_data: { not_types: ['*'] },
    },
    presence: { not_types: ['*'] },
  }))
  let backoff = 1000
  if (!state.since) {
    // first run: skip history, just learn where "now" is
    const r = await mx('GET', `/_matrix/client/v3/sync?filter=${filter}&timeout=0`)
    state.since = r.next_batch
    for (const [id, j] of Object.entries<any>(r.rooms?.join ?? {})) noteName(id, j)
    saveState()
  }
  while (true) {
    try {
      const r = await mx('GET', `/_matrix/client/v3/sync?filter=${filter}&timeout=30000&since=${enc(state.since!)}`)
      for (const [room, inv] of Object.entries<any>(r.rooms?.invite ?? {})) {
        const inviter = inv.invite_state?.events?.find((e: any) => e.type === 'm.room.member' && e.state_key === ME)?.sender
        if (inviter && ALLOWED.has(inviter)) {
          await mx('POST', `/_matrix/client/v3/join/${enc(room)}`, {}).catch(e => log('join failed', e))
          log('joined', room, 'invited by', inviter)
        } else {
          await mx('POST', `/_matrix/client/v3/rooms/${enc(room)}/leave`, {}).catch(() => {})
          log('declined invite to', room, 'from', inviter)
        }
      }
      for (const [room, j] of Object.entries<any>(r.rooms?.join ?? {})) {
        noteName(room, j)
        for (const ev of j.timeline?.events ?? []) await handleEvent(room, ev).catch(e => log('event error', e))
      }
      for (const room of Object.keys(r.rooms?.leave ?? {})) roomNames.delete(room)
      state.since = r.next_batch
      saveState()
      backoff = 1000
    } catch (e) {
      log('sync error', e, `retry in ${backoff}ms`)
      await Bun.sleep(backoff)
      backoff = Math.min(backoff * 2, 60000)
    }
  }
}

function noteName(room: string, j: any) {
  const evs = [...(j.state?.events ?? []), ...(j.timeline?.events ?? [])]
  const n = evs.filter((e: any) => e.type === 'm.room.name').pop()
  if (n) roomNames.set(room, n.content?.name ?? '')
  else if (!roomNames.has(room)) roomNames.set(room, '')
}

async function loadRoomNames() {
  const r = await mx('GET', '/_matrix/client/v3/joined_rooms')
  for (const id of r.joined_rooms ?? []) {
    const n = await mx('GET', `/_matrix/client/v3/rooms/${enc(id)}/state/m.room.name/`).catch(() => ({}))
    roomNames.set(id, n.name ?? '')
  }
}

// ---------- HTTP surface ----------
const json = (d: unknown, status = 200) => Response.json(d, { status })

Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url)
    try {
      if (req.method === 'GET' && url.pathname === '/health')
        return json({ ok: true, user: ME, rooms: roomNames.size, space: state.space_id ?? null, port: PORT })
      if (req.method === 'GET' && url.pathname === '/rooms')
        return json([...roomNames].map(([id, name]) => ({ id, name, queued: queues.get(id)?.length ?? 0 })))
      if (req.method === 'GET' && url.pathname === '/poll') {
        const room = url.searchParams.get('topic') ?? ''
        if (!room) return json({ error: 'topic required' }, 400)
        const m = await waitFor(room, 25000)
        if (!m) return new Response(null, { status: 204 })
        mx('POST', `/_matrix/client/v3/rooms/${enc(room)}/receipt/m.read/${enc(m.meta.message_id)}`, {}).catch(() => {})
        return json(m)
      }
      if (req.method !== 'POST') return json({ error: 'not found' }, 404)
      const b: any = await req.json()
      const room = String(b.chat_id ?? b.topic ?? '')
      switch (url.pathname) {
        case '/send': {
          if (b.topic && b.chat_id && b.topic !== b.chat_id) return json({ error: `this session serves ${b.topic}, not ${b.chat_id}` }, 403)
          const ids: string[] = []
          if (b.text) {
            const content = textContent(String(b.text), b.format)
            if (b.reply_to) content['m.relates_to'] = { 'm.in_reply_to': { event_id: b.reply_to } }
            ids.push(await sendEvent(room, 'm.room.message', content))
          }
          for (const f of b.files ?? []) ids.push(await uploadFile(room, f, b.text ? undefined : b.reply_to))
          return json({ message_ids: ids })
        }
        case '/react': {
          await sendEvent(room, 'm.reaction', { 'm.relates_to': { rel_type: 'm.annotation', event_id: b.message_id, key: b.emoji } })
          return json({ ok: true })
        }
        case '/edit': {
          const nc = textContent(String(b.text), b.format)
          const id = await sendEvent(room, 'm.room.message', {
            ...nc, body: `* ${nc.body}`,
            ...(nc.formatted_body ? { formatted_body: `* ${nc.formatted_body}` } : {}),
            'm.new_content': nc,
            'm.relates_to': { rel_type: 'm.replace', event_id: b.message_id },
          })
          return json({ message_id: b.message_id, edit_event_id: id })
        }
        case '/download': {
          const a = attachments.get(String(b.file_id))
          if (!a) return json({ error: 'unknown file_id (attachments are only remembered since the proxy started)' }, 404)
          const [, server, mid] = a.mxc.match(/^mxc:\/\/([^/]+)\/(.+)$/) ?? []
          const res = await fetch(`${HS}/_matrix/client/v1/media/download/${enc(server)}/${enc(mid)}`, { headers: { authorization: `Bearer ${TOKEN}` } })
          if (!res.ok) throw new Error(`media download ${res.status}`)
          const safe = a.name.replace(/[^\w.\-]+/g, '_').slice(-80) || 'file'
          const path = join(INBOX, `${Date.now()}-${safe}`)
          await Bun.write(path, res)
          return json({ path })
        }
        case '/room/create': {
          const id = await createRoom(String(b.name), [...ALLOWED][0])
          roomNames.set(id, String(b.name))
          return json({ room_id: id, name: b.name })
        }
      }
      return json({ error: 'not found' }, 404)
    } catch (e) {
      log(url.pathname, 'error', e)
      return json({ error: String(e instanceof Error ? e.message : e) }, 500)
    }
  },
})

const who = await mx('GET', '/_matrix/client/v3/account/whoami')
if (who.user_id !== ME) {
  log(`token belongs to ${who.user_id}, expected ${ME}`)
  process.exit(1)
}
await loadRoomNames().catch(e => log('room names', e))
log(`up as ${ME} on 127.0.0.1:${PORT}; allowed: ${[...ALLOWED].join(', ')}; ${roomNames.size} rooms`)
void syncLoop()
