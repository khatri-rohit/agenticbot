---
name: patch-and-verify
description: Retrieve, unique-span edit, then run that project's own check and repair from errors. Load before multi-file implementation in a workspace.
when: patch, edit, implement, fix, refactor
not: trivia, explain
modes: workspace
---

# Patch and verify

Use this when the user asked you to change code in the open folder.

1. Retrieve
   - glob / grep for symbols and filenames in the request.
   - read_file the hits. Quote a unique oldText span from the real file.
   - If nothing matches, stop and say so. Do not invent paths.
   - If the folder lacks current library/API docs, web_search (then web_fetch). Prefer project files first.

2. Patch
   - edit_file with path + unique oldText + newText.
   - For a new file, omit oldText and pass full contents.
   - Read the tool's change report (created vs patched, line/byte delta, hunk).
   - Prefer one logical change per patch. Match local style. Follow anti-slop law.

3. Verify
   - run_terminal with that project's real command (from AGENTS.md, package.json scripts, Makefile, cargo, pytest, go test, …).
   - cwd is the workspace root. Do not cd to a parent.

4. Repair
   - If the command fails, use the error text. Read the cited file. Patch again.
   - Stop when the check passes or you hit the loop limit. Then report what passed and what did not.

Do not claim the work is done while the check is red.
