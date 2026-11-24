You are doing visual QA on screenshots of a feature, comparing them against its design. Do not modify any files.

## The design
{{DESIGN}}

## Screenshots
{{SCREENSHOT_REFS}}
(Each listed as @path/to/file.png — description of the screen/state.)

## Check
- Does each screen match the design (layout, hierarchy, components, states)?
- Copy: typos, truncation, text that differs from the design.
- Layout bugs: overflow, overlap, misalignment, cut-off content, broken spacing, poor contrast.
- Missing states the design calls for.

## Format
A numbered list: **Severity** (blocker / should-fix / nit) — **Screenshot** — **What's wrong** — **What it should be**. If everything looks right, say so plainly.
