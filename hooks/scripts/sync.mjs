#!/usr/bin/env node
import { mkdirSync, writeFileSync, readdirSync, rmSync, readFileSync, chmodSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(__dirname, '..', '..')
const API_URL = process.env.ORG_CONTEXT_API || 'http://localhost:3000/api'
const HOME = process.env.HOME || homedir()
const API_KEY = process.env.CLAUDE_PLUGIN_OPTION_APIKEY || ''

function safeName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100)
}

if (!API_KEY) {
  process.stderr.write('No API key configured. Set your API key in the plugin settings.\n')
  const output = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: '[Org Context] No API key configured. Generate one from the Install page in the dashboard, then set it in plugin settings.'
    }
  }
  process.stdout.write(JSON.stringify(output))
  process.exit(0)
}

// Export env vars to all Bash tool calls for this session
const envFile = process.env.CLAUDE_ENV_FILE
if (envFile) {
  appendFileSync(envFile, `export CLAUDE_PLUGIN_OPTION_APIKEY="${API_KEY}"\n`)
  appendFileSync(envFile, `export ORG_CONTEXT_API="${API_URL}"\n`)
  if (process.env.CLAUDE_PROJECT_DIR) {
    appendFileSync(envFile, `export CLAUDE_PROJECT_DIR="${process.env.CLAUDE_PROJECT_DIR}"\n`)
  }
}

try {
  const res = await fetch(`${API_URL}/sync`, {
    headers: { 'x-api-key': API_KEY },
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
  // Clean old oc- prefixed rules before writing new ones
  try {
    for (const f of readdirSync(rulesDir)) {
      if (f.startsWith('oc-') && f.endsWith('.md')) rmSync(join(rulesDir, f), { force: true })
    }
  } catch {}
  for (const rule of data.rules || []) {
    writeFileSync(join(rulesDir, `oc-${safeName(rule.name)}.md`), rule.content)
  }

  // Write static agent guide rule
  const skillNames = (data.skills || []).map(s => s.name)
  writeFileSync(join(rulesDir, 'oc-agent-guide.md'), `# Org Context

You have the Org Context plugin installed. It provides your organization's knowledge, standards, and tools.

## What you have

- **Skills** (slash commands): ${skillNames.length ? skillNames.map(n => '/' + safeName(n)).join(', ') : 'none synced'}
- **Rules** (always-on context): ${(data.rules || []).length} org rules loaded — follow them
- **MCP tools**: Use \`search_docs\` to search company documentation, \`list_docs\` to browse available docs
- **CLI** (\`oc\`): Admin tool for managing org content

## CLI reference

\`\`\`
oc whoami                              # Current user info
oc sync                                # Sync status

oc skill list|get|create|update|delete # Manage skills
oc rule  list|get|create|update|delete # Manage rules
oc doc   list|get|create|update|delete|search # Manage docs

oc skill template / oc rule template / oc doc template  # Show example content

oc teams   list|get|create|delete|add-member|rm-member
oc members list|invite|set-role|remove
\`\`\`

Flags: \`--json\` for machine-readable output, \`--file <path>\` for content, \`--tags a,b\`, \`--org-wide\`, \`--description "..."\`

## Content types

**Skills** — On-demand procedures invoked via slash command. Write as step-by-step instructions the agent should follow. Markdown with headers, lists, code blocks. One focused task per skill.

**Rules** — Always-on context injected into every session. Keep short and directive: "Always...", "Never...", "Prefer...". Plain markdown, no frontmatter.

**Docs** — Searchable knowledge (architecture, schemas, runbooks). Title and description are separate fields; content is just the body in markdown. Found via \`search_docs\` MCP tool.

## When to use what

- Need company knowledge? → \`search_docs\` MCP tool
- Need to see what's available? → \`oc doc list\`, \`oc skill list\`
- Need to create/edit content? → Write content to a temp file, then \`oc <type> create "Name" --file /tmp/content.md\`
- User asks about their setup? → \`oc whoami\`, \`oc teams list\`
- Need a content example? → \`oc skill template\`, \`oc rule template\`, \`oc doc template\`
`)

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

  // Write MCP config — include org-context server with API key baked in
  const mcpServers = {
    'org-context': {
      type: 'http',
      url: API_URL.replace('/api', '/mcp'),
      headers: { 'x-api-key': API_KEY },
    },
    ...(data.mcpServers || {}),
  }
  writeFileSync(
    join(PLUGIN_ROOT, '.mcp.json'),
    JSON.stringify({ mcpServers }, null, 2)
  )

  const cliCount = (data.cliTools || []).length
  const mcpCount = Object.keys(data.mcpServers || {}).length
  const skillList = skillNames.length ? skillNames.map(n => '/' + safeName(n)).join(', ') : 'none'
  const output = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      reloadSkills: true, reloadMcpServers: true,
      additionalContext: `[Org Context] Synced for ${data.email} (teams: ${(data.teams || []).join(', ') || 'none'}). ${(data.skills || []).length} skills, ${(data.rules || []).length} rules, ${cliCount} CLI tools, ${mcpCount} MCPs.

Available skills: ${skillList}
MCP tools: search_docs, list_docs, list_alerts, acknowledge_alert
CLI (oc): whoami, sync, skill list|get|create|update|delete|template, rule list|get|create|update|delete|template, doc list|get|create|update|delete|search|template, teams list|get|create|delete|add-member|rm-member, members list|invite|set-role|remove. Use --json for structured output, --file <path> for content.`
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
