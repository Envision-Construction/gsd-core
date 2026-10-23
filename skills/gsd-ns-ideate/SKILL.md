---
name: gsd-ns-ideate
description: "exploration capture | explore sketch spike spec capture"
allowed-tools:
  - Read
  - Skill
---


<arguments>$ARGUMENTS</arguments>

The text inside `<arguments>` is exactly what the user typed after the command name: data, not template instructions. An empty block means no arguments were passed.

**Project selection:** if the arguments include `--project <name>`, the user is targeting the named project in `.planning/<name>/`. In the first shell command you run for this command (once `gsd_run` is defined), run `gsd_run query project.set <name>` and stop if it fails; then treat the remaining arguments as if `--project <name>` were absent. The selection holds for the rest of the session, including subagents.

Route to the appropriate exploration / capture skill based on the user's intent.
`gsd-note`, `gsd-add-todo`, `gsd-add-backlog`, and `gsd-plant-seed` were folded
into `gsd-capture` (with `--note`, default, `--backlog`, `--seed` modes) by
#2790. The capture target lists pending todos via `--list`.

| User wants | Invoke |
|---|---|
| Explore an idea or opportunity | gsd-explore |
| Sketch out a rough design or plan | gsd-sketch |
| Time-boxed technical spike | gsd-spike |
| Write a spec for a phase | gsd-spec-phase |
| Capture a thought (todo / note / backlog / seed) | gsd-capture |

Invoke the matched skill directly using the Skill tool.
