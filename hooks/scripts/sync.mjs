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

    // Write wrapper script that runs user's command + appends alert badge
    const wrapperPath = join(PLUGIN_DATA, 'statusline-wrapper.sh')
    const wrapperScript = `#!/bin/bash
# Org Context statusLine wrapper — runs user's statusLine + appends alert count
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

# Append alert count (second line)
TOKEN="${SYNC_TOKEN}"
API="${API_URL}"
if [ -n "$TOKEN" ]; then
  count=$(curl -sf -m 2 -H "Authorization: Bearer $TOKEN" "$API/alerts/count" 2>/dev/null | jq -r '.count // 0')
  if [ "$count" -gt 0 ] 2>/dev/null; then
    printf "\\n\\033[33m🔔 %s alert%s\\033[0m" "$count" "$([ "$count" -gt 1 ] && echo 's' || echo '')"
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
