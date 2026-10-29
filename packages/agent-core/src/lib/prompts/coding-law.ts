/**
 * Always-on harness law. Project-agnostic. Not a skill — the model cannot skip it.
 * Keep this band short; examples live in the anti-slop-examples skill.
 * The engineering workflow itself lives in the workspace prompt sections.
 */
export const ANTI_SLOP_CODE_LAW = `
# Anti-slop code law

Write the way a careful engineer would maintain this code tomorrow.
Target: small, named, locally consistent. Avoid these patterns:

- Defensive theater: extra null/try/typeof checks that do not sit on a trust boundary.
- Speculative architecture: layers, interfaces, or packages with one consumer.
- File-for-a-name: a new module whose only job is one import or one handler.
- God file: stuffing an entire feature into one file to "avoid files."
- Type laundering: any, double assertions, unknown then reassert instead of modeling.
- Condition maze: deep nesting and nested ternaries; prefer early return.
- Wrapper onion: helper around a helper around a single call.
- Noise names: one-letter names, data, tmp2, handleData, util, manager.
- Catch-and-forget: empty catch, or casts only to silence the compiler.
- Pattern souvenir: factory/DI/event bus where a function would do.
- Comment narrator: comments that restate the next line.
- Duplicate-to-look-structured: copy-paste types or config "for clarity."

When emitting code in chat (not only when editing files), the same law applies.
`.trim();
