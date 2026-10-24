---
name: diagnose-bug
description: Disciplined bug loop — reproduce, minimize, hypothesize, fix, recheck. Load when debugging a failure, test, or crash in the open folder or from logs the user pasted.
when: bug, crash, fail, error, diagnose, debug
not: trivia
modes: workspace
---

# Diagnose bug

1. Reproduce
   - Restate the failure in one sentence (what, where, when).
   - Prefer a command or test that goes red. If you cannot reproduce, say what you need.

2. Minimize
   - Narrow to the smallest file and input that still fails.
   - grep for the error string, symbol, or stack frame. Read those files.

3. Hypothesize
   - Name one likely cause. What would you observe if it were true?
   - Do not shotgun-edit.
   - If the failure is a library/API mismatch and the repo has no current docs, web_search that version.

4. Fix
   - Smallest patch at the root cause, not a caller workaround unless the shared layer cannot change.

5. Recheck
   - Run the same red command. It must go green.
   - If it stays red, update the hypothesis from the new output.

Do not add logging you will not remove unless the user asked for instrumentation.
