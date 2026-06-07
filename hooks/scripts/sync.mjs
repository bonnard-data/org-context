#!/usr/bin/env node
import { mkdirSync, writeFileSync, readdirSync, rmSync, readFileSync, chmodSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(__dirname, '..', '..')
const PLUGIN_DATA = process.env.CLAUDE_PLUGIN_DATA || join(HOME, '.claude', 'plugins', 'data', 'org-context')
const API_URL = process.env.ORG_CONTEXT_API || 'http://localhost:3000/api'
const HOME = process.env.HOME || homedir()
const SYNC_TOKEN = process.env.CLAUDE_PLUGIN_OPTION_SYNCTOKEN || ''
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR

function safeName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100)
}

if (!SYNC_TOKEN) {
  process.stderr.write('No sync token configured. Set your sync token in the plugin settings.\n')
  const output = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: '[Org Context] No sync token configured. Run: curl -X POST -H "Authorization: Bearer <session>" http://localhost:3000/api/sync-token to generate one, then set it in plugin settings.'
    }
  }
  process.stdout.write(JSON.stringify(output))
  process.exit(0)
}

try {
  const res = await fetch(`${API_URL}/sync`, {
    headers: { 'Authorization': `Bearer ${SYNC_TOKEN}` },
    signal: AbortSignal.timeout(5000),
  })

  if (!res.ok) throw new Error(`API returned ${res.status}`)

  const data = await res.json()

  // Write skills
  const skillsDir = join(PLUGIN_ROOT, 'skills')
  mkdirSync(skillsDir, { recursive: true })
  try {
    for (const d of readdirSync(skillsDir, { withFileTypes: true })) {
      if (d.isDirectory()) rmSync(join(skillsDir, d.name), { recursive: true, force: true })
    }
  } catch {}

  for (const skill of data.skills || []) {
    const name = safeName(skill.name)
    const dir = join(skillsDir, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), skill.content)
  }

  // Write rules to project scope if available, otherwise global
  const rulesDir = PROJECT_DIR
    ? join(PROJECT_DIR, '.claude', 'rules')
    : join(HOME, '.claude', 'rules')
  mkdirSync(rulesDir, { recursive: true })
  try {
    for (const f of readdirSync(rulesDir)) {
      if (f.startsWith('oc-') && f.endsWith('.md')) rmSync(join(rulesDir, f), { force: true })
    }
  } catch {}
  for (const rule of data.rules || []) {
    writeFileSync(join(rulesDir, `oc-${safeName(rule.name)}.md`), rule.content)
  }

  // Write CLI tools to bin/
  const binDir = join(PLUGIN_ROOT, 'bin')
  mkdirSync(binDir, { recursive: true })
  try {
    for (const f of readdirSync(binDir)) {
      if (f.startsWith('oc-') && f !== 'oc-statusline') rmSync(join(binDir, f), { force: true })
    }
  } catch {}
  for (const tool of data.cliTools || []) {
    const toolPath = join(binDir, `oc-${safeName(tool.name)}`)
    writeFileSync(toolPath, tool.content)
    chmodSync(toolPath, 0o755)
  }

  // Write MCP config
  if (data.mcpServers && Object.keys(data.mcpServers).length > 0) {
    writeFileSync(
      join(PLUGIN_ROOT, '.mcp.json'),
      JSON.stringify({ mcpServers: data.mcpServers }, null, 2)
    )
  }

  // Set up statusLine wrapper in project-local settings
  if (PROJECT_DIR) {
    setupStatusLine(PROJECT_DIR)
  }

  const cliCount = (data.cliTools || []).length
  const mcpCount = Object.keys(data.mcpServers || {}).length

  // Check alert count for additionalContext
  let alertInfo = ''
  try {
    const alertRes = await fetch(`${API_URL}/alerts/count`, {
      headers: { 'Authorization': `Bearer ${SYNC_TOKEN}` },
      signal: AbortSignal.timeout(2000),
    })
    if (alertRes.ok) {
      const { count } = await alertRes.json()
      if (count > 0) alertInfo = ` 🔔 ${count} pending alert${count > 1 ? 's' : ''} — ask me to check alerts.`
    }
  } catch {}

  const output = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      reloadSkills: true,
      additionalContext: `[Org Context] Synced for ${data.email} (teams: ${(data.teams || []).join(', ') || 'none'}). ${(data.skills || []).length} skills, ${(data.rules || []).length} rules, ${cliCount} CLI tools, ${mcpCount} MCPs.${alertInfo}`
    }
  }
  process.stdout.write(JSON.stringify(output))
} catch (err) {
  process.stderr.write(`Org Context sync failed: ${err.message}\n`)
  const output = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `[Org Context] Sync failed: ${err.message}`
    }
  }
  process.stdout.write(JSON.stringify(output))
}

function setupStatusLine(projectDir) {
  try {
    mkdirSync(PLUGIN_DATA, { recursive: true })

    // Read user's existing global statusLine command
    let userCommand = ''
    try {
      const globalSettings = JSON.parse(readFileSync(join(HOME, '.claude', 'settings.json'), 'utf-8'))
      userCommand = globalSettings?.statusLine?.command || ''
    } catch {}

    // Write wrapper script that runs user's command + appends smart alert badge
    const wrapperPath = join(PLUGIN_DATA, 'statusline-wrapper.sh')
    const watermarkPath = join(PLUGIN_DATA, 'statusline-watermark')
    const wrapperScript = `#!/bin/bash
# Org Context statusLine wrapper — user's statusLine + severity-aware alert badge
input=$(cat)

# Run user's original statusLine (if any)
${userCommand ? `echo "$input" | (${userCommand})` : `
model=$(echo "$input" | jq -r '.model.display_name // ""')
dir=$(echo "$input" | jq -r '.workspace.current_dir // ""' | xargs basename)
branch=$(echo "$input" | jq -r '.workspace.git_branch // ""')
if [ -n "$branch" ]; then
  printf "\\033[2m%s \\033[36m(%s)\\033[0m \\033[2m| %s\\033[0m" "$dir" "$branch" "$model"
else
  printf "\\033[2m%s | %s\\033[0m" "$dir" "$model"
fi`}

# Smart alert badge (second line)
TOKEN="${SYNC_TOKEN}"
API="${API_URL}"
WATERMARK="${watermarkPath}"

if [ -n "$TOKEN" ]; then
  data=$(curl -sf -m 2 -H "Authorization: Bearer $TOKEN" "$API/alerts/count" 2>/dev/null)
  if [ -n "$data" ]; then
    count=$(echo "$data" | jq -r '.count // 0')
    if [ "$count" -gt 0 ] 2>/dev/null; then
      crit=$(echo "$data" | jq -r '.severities.critical // 0')
      high=$(echo "$data" | jq -r '.severities.high // 0')
      med=$(echo "$data" | jq -r '.severities.medium // 0')
      info=$(echo "$data" | jq -r '.severities.info // 0')
      newest=$(echo "$data" | jq -r '.newest // ""')
      oldest=$(echo "$data" | jq -r '.oldest // ""')

      # Check for new alerts since last watermark
      last_seen=""
      [ -f "$WATERMARK" ] && last_seen=$(cat "$WATERMARK" 2>/dev/null)
      new_flag=""
      if [ -n "$newest" ] && [ -n "$last_seen" ]; then
        if [ "$newest" \\> "$last_seen" ]; then
          new_flag=" ⚡NEW"
        fi
      elif [ -z "$last_seen" ] && [ -n "$newest" ]; then
        new_flag=" ⚡NEW"
      fi
      # Update watermark
      [ -n "$newest" ] && echo "$newest" > "$WATERMARK"

      # Calculate age of oldest alert
      age=""
      if [ -n "$oldest" ]; then
        now=$(date +%s)
        then=$(date -j -f "%Y-%m-%dT%H:%M:%S" "$(echo "$oldest" | cut -d. -f1)" +%s 2>/dev/null || echo "")
        if [ -n "$then" ]; then
          diff=$((now - then))
          if [ $diff -lt 60 ]; then age="<1m"
          elif [ $diff -lt 3600 ]; then age="$((diff/60))m"
          elif [ $diff -lt 86400 ]; then age="$((diff/3600))h"
          else age="$((diff/86400))d"
          fi
        fi
      fi

      # Build severity segments
      parts=""
      [ "$crit" -gt 0 ] 2>/dev/null && parts="\\033[31m🚨 $crit crit\\033[0m"
      if [ "$high" -gt 0 ] 2>/dev/null; then
        [ -n "$parts" ] && parts="$parts \\033[2m·\\033[0m "
        parts="$parts\\033[33m🔶 $high high\\033[0m"
      fi
      rest=$((med + info))
      if [ "$rest" -gt 0 ] 2>/dev/null; then
        [ -n "$parts" ] && parts="$parts \\033[2m·\\033[0m "
        parts="$parts\\033[2m🔔 $rest more\\033[0m"
      fi
      # If no severity breakdown, just show count
      if [ -z "$parts" ]; then
        parts="\\033[33m🔔 $count alert$([ "$count" -gt 1 ] && echo 's')\\033[0m"
      fi

      # Add age of oldest if stale (>1h)
      age_suffix=""
      if [ -n "$age" ]; then
        case "$age" in
          *h|*d) age_suffix=" \\033[2m(oldest: $age)\\033[0m" ;;
        esac
      fi

      printf "\\n%b%b%b" "$parts" "\\033[36m$new_flag\\033[0m" "$age_suffix"
    fi
  fi
fi
`
    writeFileSync(wrapperPath, wrapperScript)
    chmodSync(wrapperPath, 0o755)

    // Write project-local settings with statusLine pointing to wrapper
    const localSettingsPath = join(projectDir, '.claude', 'settings.local.json')
    let localSettings = {}
    try {
      localSettings = JSON.parse(readFileSync(localSettingsPath, 'utf-8'))
    } catch {}

    localSettings.statusLine = {
      type: 'command',
      command: `bash "${wrapperPath}"`,
    }

    mkdirSync(join(projectDir, '.claude'), { recursive: true })
    writeFileSync(localSettingsPath, JSON.stringify(localSettings, null, 2) + '\n')
  } catch (err) {
    process.stderr.write(`[Org Context] StatusLine setup failed: ${err.message}\n`)
  }
}
