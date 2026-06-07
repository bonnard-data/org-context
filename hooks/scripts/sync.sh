#!/bin/bash
# Org Context — SessionStart sync script
# Reads plugin.yaml, resolves user email → role, populates skills/commands/rules

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
CONFIG="$PLUGIN_ROOT/plugin.yaml"

if [ ! -f "$CONFIG" ]; then
  echo '{}' >&2
  exit 0
fi

# Read hook stdin to get user_email from Claude Code session
HOOK_INPUT=$(cat)
EMAIL=$(echo "$HOOK_INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('user_email',''))" 2>/dev/null)
# Fallback to git config if hook doesn't provide email
if [ -z "$EMAIL" ]; then
  EMAIL=$(git config user.email 2>/dev/null || echo "unknown")
fi

# Parse role from plugin.yaml users section
ROLE=$(grep "^  ${EMAIL}:" "$CONFIG" 2>/dev/null | awk '{print $2}')
if [ -z "$ROLE" ]; then
  ROLE=$(grep "^default_role:" "$CONFIG" | awk '{print $2}')
fi
ROLE="${ROLE:-engineer}"

CONTENT_DIR="$PLUGIN_ROOT/content"
SHARED_DIR="$CONTENT_DIR/shared"
ROLE_DIR="$CONTENT_DIR/$ROLE"

# --- Sync skills ---
SKILLS_DIR="$PLUGIN_ROOT/skills"
find "$SKILLS_DIR" -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} + 2>/dev/null
if [ -d "$ROLE_DIR/skills" ]; then
  cp -r "$ROLE_DIR/skills"/* "$SKILLS_DIR/" 2>/dev/null
fi
SKILL_COUNT=$(find "$SKILLS_DIR" -name "SKILL.md" 2>/dev/null | wc -l | tr -d ' ')

# Commands are static in the repo — not synced dynamically
CMD_COUNT=$(find "$PLUGIN_ROOT/commands" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')

# --- Sync rules ---
RULES_DIR="$HOME/.claude/rules"
mkdir -p "$RULES_DIR"
if [ -d "$SHARED_DIR/rules" ]; then
  cp "$SHARED_DIR/rules"/*.md "$RULES_DIR/" 2>/dev/null
fi
if [ -d "$ROLE_DIR/rules" ]; then
  cp "$ROLE_DIR/rules"/*.md "$RULES_DIR/" 2>/dev/null
fi

# --- Hook output ---
cat <<EOF
{"hookSpecificOutput":{"hookEventName":"SessionStart","reloadSkills":true,"additionalContext":"[Org Context] Synced for ${EMAIL} (role: ${ROLE}). ${SKILL_COUNT} skills, ${CMD_COUNT} commands."}}
EOF

exit 0
