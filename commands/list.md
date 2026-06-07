---
description: List all available skills, rules, docs, teams, and members
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/oc":*)
---

Show the user what content is available. Run these commands:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/oc" sync
"${CLAUDE_PLUGIN_ROOT}/bin/oc" skill list
"${CLAUDE_PLUGIN_ROOT}/bin/oc" rule list
"${CLAUDE_PLUGIN_ROOT}/bin/oc" doc list
"${CLAUDE_PLUGIN_ROOT}/bin/oc" teams list
```
