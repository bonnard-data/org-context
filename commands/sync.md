---
description: Force re-sync skills and rules from plugin config
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/oc":*)
---

Run the sync command and report what changed:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/oc" sync
```

After reporting the results, tell the user:

> Run `/reload-skills` to pick up any new or removed skills in autocomplete.
