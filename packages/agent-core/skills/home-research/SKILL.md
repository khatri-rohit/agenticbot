---
name: home-research
description: Multi-source web answer discipline for Home chats. Load for current-events, product, or version questions that need search. Not required before calling web_search.
---

# Home research

web_search and web_fetch are built-in. You do not need this skill to call them.

When the question needs live sources:

- One specific query per sub-question. Include product, version, and year when freshness matters.
- Prefer Detailed Sources over Further Reading. web_fetch a listed URL only if you still cannot finish.
- Synthesize one complete answer with inline URL citations.
- When sources conflict, say so and pick the more reliable one with a reason.
- Do not run near-duplicate searches. Do not invent facts missing from the tool results.

If you already know a stable fact (math, language syntax that has not changed), answer without search.
