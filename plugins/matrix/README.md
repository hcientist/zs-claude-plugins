# matrix-rooms

A Matrix channel for Claude Code: one bot account multiplexed across many
Claude sessions, one per Matrix room. The Matrix counterpart of `../telegram`,
built so the operator can talk to their Claudes on their own (non-federated)
homeserver, where strangers can't reach the bot.

```
Element ── Matrix homeserver ── proxy/proxy.ts (one /sync loop, allowlist, 127.0.0.1:8791)
                                   ├─ per-room queue + GET /poll?topic=<room>
                                   ├─ POST /send /react /edit /download /room/create
                                   └─ ensureSession(): scripts/launch-room.sh -> tmux mx-<slug>-<tag>
                                                         claude --plugin-dir <this> \
                                                           --dangerously-load-development-channels=plugin:matrix@inline
server.ts (MCP, one per session) ── long-polls the proxy, injects <channel source="plugin:matrix:matrix"> turns
```

- **Access**: `MATRIX_ALLOWED_USERS` (comma-separated MXIDs). Everyone else is
  ignored silently, and room invites from them are declined.
- **Rooms**: `!new <name>` creates an unencrypted room inside a private Space
  ("Claude") and invites the allowed users. Encrypted rooms aren't supported yet.
- **Commands**: `!ping`, `!rooms`, `!status`, `!sleep`.
- **Sessions**: spawned on a room's first message, resumed by Claude session id
  afterwards, reaped after `MATRIX_IDLE_REAP_HOURS` (default 6) idle.
- **Reply guard**: `hooks/stop-reply-guard.py` (Stop hook via
  `override-settings.json`) nudges a turn that never called `reply`.

## Setup

1. Make a bot account and an access token. On ESS/MAS:
   `mas-cli manage register-user claude` then
   `mas-cli manage issue-compatibility-token claude CLAUDEBOT`.
2. `~/.config/matrix-claude/.env` (mode 600):
   ```
   MATRIX_HOMESERVER=https://matrix.example.org
   MATRIX_USER_ID=@claude:example.org
   MATRIX_ACCESS_TOKEN=mct_...
   MATRIX_ALLOWED_USERS=@you:example.org
   ```
   Optional: `MATRIX_PROXY_PORT`, `MATRIX_SPAWN_DIR`, `MATRIX_IDLE_REAP_HOURS`,
   `MATRIX_MODEL`, `MATRIX_SPACE_NAME`.
3. Run `bun proxy.ts` in `proxy/` (a systemd user unit with `KillMode=process`
   so a restart never kills the room sessions), then invite the bot to a room
   or send `!new <name>` to it.
