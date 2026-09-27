#!/usr/bin/env bash
# Prints 'reins <tier> $<remaining>' for the Claude Code status line.
#
# Add to ~/.claude/settings.json:
#   "statusLine": { "type": "command", "command": "~/.claude/plugins/.../statusline.sh" }
#
# Claude Code writes session JSON on stdin. It is read and discarded so the
# pipe closes cleanly, then the reins CLI is asked for the budget state.

cat >/dev/null 2>&1 || true

if ! command -v reins >/dev/null 2>&1; then
  echo 'reins: not installed'
  exit 0
fi

out="$(reins status --json 2>/dev/null)" || { echo 'reins: unavailable'; exit 0; }

printf '%s' "$out" | node -e '
let data = "";
process.stdin.on("data", (c) => { data += c; }).on("end", () => {
  try {
    const s = JSON.parse(data);
    const r = Number(s.remainingUsd);
    console.log(`reins ${s.tier} $${(Number.isFinite(r) ? r : 0).toFixed(2)}`);
  } catch {
    console.log("reins: unavailable");
  }
});
'
