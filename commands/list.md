---
description: List all available skills, commands, and rules for current role
---

Show the user what content is available to them. Run these commands:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/oc" whoami
"${CLAUDE_PLUGIN_ROOT}/bin/oc" status
```

Then read `${CLAUDE_PLUGIN_ROOT}/plugin.yaml` and report the full content mapping for their role.
