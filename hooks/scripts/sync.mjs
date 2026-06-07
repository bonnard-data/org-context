#!/usr/bin/env node
import { mkdirSync, writeFileSync, readdirSync, rmSync, readFileSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(__dirname, '..', '..')
const API_URL = process.env.ORG_CONTEXT_API || 'http://localhost:3000/api'
const HOME = process.env.HOME || homedir()
const SYNC_TOKEN = process.env.CLAUDE_PLUGIN_OPTION_SYNCTOKEN || ''

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
  const projectDir = process.env.CLAUDE_PROJECT_DIR
  const rulesDir = projectDir
    ? join(projectDir, '.claude', 'rules')
    : join(HOME, '.claude', 'rules')
  mkdirSync(rulesDir, { recursive: true })
  for (const rule of data.rules || []) {
    writeFileSync(join(rulesDir, `${safeName(rule.name)}.md`), rule.content)
  }

  // Write CLI tools to bin/
  const binDir = join(PLUGIN_ROOT, 'bin')
  mkdirSync(binDir, { recursive: true })
  try {
    for (const f of readdirSync(binDir)) {
      if (f.startsWith('oc-')) rmSync(join(binDir, f), { force: true })
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

  const cliCount = (data.cliTools || []).length
  const mcpCount = Object.keys(data.mcpServers || {}).length
  const output = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      reloadSkills: true,
      additionalContext: `[Org Context] Synced for ${data.email} (teams: ${(data.teams || []).join(', ') || 'none'}). ${(data.skills || []).length} skills, ${(data.rules || []).length} rules, ${cliCount} CLI tools, ${mcpCount} MCPs.`
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
