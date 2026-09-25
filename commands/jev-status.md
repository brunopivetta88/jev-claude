---
description: Show what jev-guard has been deciding in this project
---

Run this and report the output to the user:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs"
```

Then, in two or three sentences: say whether the plugin is in shadow or enforce
mode, which signals fired most often, and whether any threshold looks mistuned
for this project (lots of shadow blocks on actions the user clearly wanted is
the signal to loosen; real incidents slipping through is the signal to tighten).
Do not change any thresholds unless the user asks.
