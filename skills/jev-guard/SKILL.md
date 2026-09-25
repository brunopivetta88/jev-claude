---
name: jev-guard
description: How to react when a jev-guard hook warns, asks, or blocks an action. Use when a tool call was denied or annotated with a "jev-guard" reason, or when the user asks why an action was blocked or how to tune the thresholds.
---

# Reacting to jev-guard

jev-guard is a hook layer that scores every risky action with TypeSafe's Jev model
and a set of deterministic rules, then maps the result to allow / warn / ask / block.

## When a message tagged `jev-guard` appears

**`warn`** — the action ran. Take the note seriously in your next step, but do not
re-litigate it with the user unless it changes your plan.

**`ask`** — stop and put the decision to the user. Quote the signal and its
probability (`secret_exposure=0.62`), say what you were about to do, and let them
choose. Do not retry the same call hoping for a different verdict.

**`block`** — the action did not run. Explain to the user what was blocked and why.

## What not to do

- Never work around a block by rephrasing the same action (splitting one `rm -rf`
  into three, base64-ing a payload, moving a command into a script file). The
  deterministic floor exists precisely because that pattern is how incidents happen.
- Never edit `jev-guard.config.json`, thresholds, or `mode` to get past a block
  unless the user explicitly asks for that change.
- Never disable the hooks to finish a task faster.

## Tuning, when the user asks for it

Thresholds live in `jev-guard.config.json` under `thresholds.<signal>.<block|ask|warn>`,
and each one is a probability between 0 and 1. Raising a `block` threshold makes the
guard more permissive for that signal; lowering it makes it stricter. `mode: "shadow"`
evaluates and logs without enforcing — the right place to start when a project's
thresholds are still unproven.
