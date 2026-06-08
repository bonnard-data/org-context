---
description: Show sync status — skills, rules, teams, and MCPs for current user
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/oc":*)
---

Run the sync command and report the results:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/oc" sync
```

After reporting the results, tell the user:

> Run `/reload-plugins` to pick up any new or removed skills in autocomplete.
