---
description: Switch jev-guard between shadow and enforce mode
argument-hint: shadow | enforce
---

The user wants jev-guard set to: $ARGUMENTS

Write (creating it if needed) `jev-guard.config.json` in the project root, setting
`"mode"` to the requested value and leaving every other key untouched. Then tell
the user the change takes effect on the next tool call, and remind them that
`enforce` means jev-guard can deny a tool call outright.

If `$ARGUMENTS` is neither `shadow` nor `enforce`, ask which one they meant
instead of guessing.
