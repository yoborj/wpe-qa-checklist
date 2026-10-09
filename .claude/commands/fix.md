---
description: Apply the approved fixes for a site and checklist, with a backup first
argument-hint: <site> <tab>
---
Apply the approved fixes for: $ARGUMENTS

Follow CLAUDE.md steps 5–7: show me the plan (`node bin/wpeqa.mjs plan …`), wait for my explicit
yes, then run the fix with --yes, report the backup and what was verified, and fix any remaining
fix-request items yourself under `node bin/wpeqa.mjs rules <site>`, verifying afterwards.
