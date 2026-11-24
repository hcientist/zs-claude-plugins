#!/usr/bin/env bash
# matrix-rooms: spawn ONE detached tmux session running a foreground Claude
# bound to a single Matrix room. Invoked by proxy/proxy.ts with the room's
# parameters in the environment. A trimmed, tmux-only port of
# plugins/telegram/scripts/launch-topic.sh; see that file for the long history
# behind each trick used here (=form flags, -e env passing, dialog watcher).
set -u
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

: "${MX_SESSION:?}" "${MX_SPAWN_DIR:?}" "${MATRIX_ROOM_ID:?}" "${MATRIX_PROXY_URL:?}"
: "${MX_PLUGIN_DIR:?}" "${MX_KICKOFF:?}" "${MX_CLAUDE_SESSION_ID:?}"
: "${MX_RESUME:=}" "${MX_MODEL:=}" "${MCP_TIMEOUT:=180000}"

MX_SETTINGS="$MX_PLUGIN_DIR/override-settings.json"
MX_HOOK="$MX_PLUGIN_DIR/hooks/stop-reply-guard.py"
MX_CLAUDE_BIN=$(command -v claude) || { echo "matrix-rooms: claude not on PATH" >&2; exit 1; }

# A pruned transcript makes --resume fail; start fresh instead.
if [ -n "$MX_RESUME" ]; then
  pdir="$HOME/.claude/projects/$(printf '%s' "$MX_SPAWN_DIR" | sed 's/[^a-zA-Z0-9]/-/g')"
  if [ -d "$pdir" ] && [ ! -e "$pdir/$MX_CLAUDE_SESSION_ID.jsonl" ]; then
    echo "matrix-rooms: transcript $MX_CLAUDE_SESSION_ID gone; fresh start" >&2
    MX_RESUME=''
  fi
fi

if tmux has-session -t "=$MX_SESSION" 2>/dev/null; then
  echo "matrix-rooms: $MX_SESSION already exists" >&2
  exit 0
fi

PANE_CMD='set -- --plugin-dir "$MX_PLUGIN_DIR" \
       --dangerously-load-development-channels=plugin:matrix@inline \
       --settings "$MX_SETTINGS" --permission-mode auto \
       --disallowedTools=AskUserQuestion; \
 [ -n "$MX_MODEL" ] && set -- "$@" --model "$MX_MODEL"; \
 if [ -n "$MX_RESUME" ]; then exec "$MX_CLAUDE_BIN" "$@" --resume "$MX_CLAUDE_SESSION_ID"; \
 else exec "$MX_CLAUDE_BIN" "$@" --session-id "$MX_CLAUDE_SESSION_ID" "$MX_KICKOFF"; fi'

tmux new-session -d -s "$MX_SESSION" -c "$MX_SPAWN_DIR" \
  -e PATH="$PATH" -e MCP_TIMEOUT="$MCP_TIMEOUT" \
  -e MX_PLUGIN_DIR="$MX_PLUGIN_DIR" -e MX_SETTINGS="$MX_SETTINGS" -e MX_HOOK="$MX_HOOK" \
  -e MX_CLAUDE_BIN="$MX_CLAUDE_BIN" -e MX_MODEL="$MX_MODEL" -e MX_KICKOFF="$MX_KICKOFF" \
  -e MX_CLAUDE_SESSION_ID="$MX_CLAUDE_SESSION_ID" -e MX_RESUME="$MX_RESUME" \
  -e MATRIX_ROOM_ID="$MATRIX_ROOM_ID" -e MATRIX_PROXY_URL="$MATRIX_PROXY_URL" \
  "$PANE_CMD"

# Answer the two startup dialogs: folder trust ("No, exit" is pre-selected, so
# Down until "Yes" is highlighted, then Enter) and the dev-channels warning.
(
  for _ in $(seq 1 240); do
    tmux has-session -t "=$MX_SESSION" 2>/dev/null || break
    t=$(tmux capture-pane -t "$MX_SESSION" -p 2>/dev/null | tr -d ' \t\n')
    if printf '%s' "$t" | grep -q 'Isthisaprojectyoucreatedoroneyoutrust'; then
      if printf '%s' "$t" | grep -qF '❯Yes,Itrustthisfolder'; then tmux send-keys -t "$MX_SESSION" Enter; sleep 1.5
      else tmux send-keys -t "$MX_SESSION" Down; sleep 0.5; fi
      continue
    fi
    if printf '%s' "$t" | grep -q 'Iamusingthisforlocaldevelopment'; then
      tmux send-keys -t "$MX_SESSION" 1 Enter; sleep 1.5; continue
    fi
    sleep 0.25
  done
) </dev/null >/dev/null 2>&1 &
disown
