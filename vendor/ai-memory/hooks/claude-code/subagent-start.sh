#!/bin/sh
# Claude Code subagent-start hook — forwards the event so the server can seed
# the subagent's session id for drop_subagent_captures (so the whole nested
# session, incl. the unmarked tail, is dropped). Mirrors stop.sh.
#
# A repository that opts into `[briefing] inject_on_subagent_start` also hands
# the subagent its project brief, as the native hook does. It comes from the
# read-only `/brief`, never `/handoff`, whose fetch would claim the parent
# session's baton. Cursor also runs these hook settings, and its handling of
# the envelope is unverified, so a Cursor payload gets no brief.
_lib_dir="$(dirname "$0")"
[ -f "$_lib_dir/_lib.sh" ] || _lib_dir="$_lib_dir/.."
. "$_lib_dir/_lib.sh"

SERVER="${AI_MEMORY_HOOK_URL:-http://127.0.0.1:49374}"
PAYLOAD=$(cat)
CWD=$(ai_memory_extract_cwd "$PAYLOAD")
QS=$(ai_memory_marker_qs "$CWD")
BRIEF_QS=$(ai_memory_subagent_briefing_qs "$CWD")
case "$PAYLOAD" in
    *'"cursor_version"'*) BRIEF_QS="" ;;
esac

printf '%s' "$PAYLOAD" \
    | ai_memory_post_hook "$SERVER/hook?event=subagent-start&agent=claude-code${QS}" >/dev/null 2>&1 || true

BRIEF=""
[ -n "$BRIEF_QS" ] && BRIEF=$(ai_memory_get_brief "$SERVER/brief?agent=claude-code${QS}${BRIEF_QS}" 2>/dev/null || true)
if [ -n "$BRIEF" ]; then
    printf '{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":%s}}\n' \
        "$(printf '%s' "$BRIEF" | ai_memory_json_string)"
else
    printf '{}\n'
fi
exit 0
