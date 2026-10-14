import { listSkills } from '../tools/skills';
import type { ToolRegistry } from '../tools/type';
import { loadAgentIdentity } from './load-agent-identity';

const today = () => new Date().toISOString().slice(0, 10);

function formatList(items: string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

function buildToolGuardrails(registry: ToolRegistry): string {
  const sections: string[] = [];

  for (const tool of registry.byName.values()) {
    const name = tool.definition.function.name;
    const { guidance } = tool;

    sections.push(
      [
        `### ${name}`,
        (tool.definition.function.description ?? '').trim(),
        '',
        '**Use when:**',
        formatList(guidance.whenToUse),
        '',
        '**Do not use when:**',
        formatList(guidance.whenNotToUse),
        '',
        '**How to use:**',
        formatList(guidance.usage),
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}

/** Format frozen profile text for the system prompt. Empty → no invented biography. */
export function buildUserPersonaPrompt(userPersona?: string): string {
  const trimmed = userPersona?.trim() ?? '';
  if (!trimmed) {
    return [
      'No frozen user profile was provided for this session.',
      'Do not invent a biography, job title, or preferences.',
      'Infer only from the current conversation; adapt once the user shows a clear preference.',
    ].join('\n');
  }

  return [
    'Frozen facts from the user profile settings. Treat as durable for this session.',
    'Use them to adapt tone, depth, examples, jargon level, and working style.',
    'Do not contradict them unless the user explicitly overrides in this chat.',
    'Do not recite this block back unless they ask what you know about them.',
    '',
    trimmed,
  ].join('\n');
}

/**
 * Assembles the frozen system prompt: agent.md identity, user persona, then
 * tool protocol. Identity/tone lives in agent.md; keep API schemas in tools/.
 */
export function buildSystemPrompt(
  registry: ToolRegistry,
  userPersona?: string,
): string {
  const toolNames = Array.from(registry.byName.keys());
  const hasLoadSkill = registry.byName.has('load_skill');
  const catalog = hasLoadSkill
    ? listSkills()
        .map((skill) => `- ${skill.name}: ${skill.description}`)
        .join('\n')
    : '';

  const availableTools =
    toolNames.length > 0
      ? toolNames.map((name) => `- ${name}`).join('\n')
      : '- (none)';

  const skillsSection = hasLoadSkill
    ? `
# Skills

Available skills:
${catalog}

These are instruction sets you can load on demand.
When a skill covers the kind of work you are about to do, call load_skill
with its name BEFORE starting that work, then follow its instructions.
Loading instructions does not approve any action they recommend.
Example: load_skill with web_search_skill
Then follow the instructions of the skill.
`
    : '';

  return `
${loadAgentIdentity()}

Today's date is ${today()}.

# User Persona

${buildUserPersonaPrompt(userPersona)}

# Tool calling protocol

You have access to external tools only through the host's native tool-calling mechanism.

Rules:
- Call a tool only when its guardrails below say it is appropriate for the user's request.
- If you can answer from stable general knowledge or simple reasoning, respond directly with no tool call. Do not call web_search for general knowledge, definitions, math, or coding help.
- Never invent tool names. Only use: ${toolNames.join(', ') || 'none'}.
- Never print tool calls as JSON or prose in your reply to the user. Use the tool channel only.
- After a tool returns, read the result, decide if it is enough, then either call another tool or give the final answer.
- Do not repeat the same tool with the same arguments if it already failed or did not help.
- Do not search in loops when results are not improving; answer with what you have and state uncertainty.

Available tools:
${availableTools}
${skillsSection}
# Per-tool guardrails

${buildToolGuardrails(registry)}

# Research behavior

When you use web_search or web_fetch, your goal is a complete, well-reasoned answer in a single response. The user should not need to ask follow-up questions for more detail.

Synthesizing results:
- web_search returns "Detailed Sources" (full page content for top results) and "Further Reading" (snippets with links). Synthesize the detailed sources first.
- If a Further Reading link is critical for a complete answer, use web_fetch on that URL before responding. Do not leave gaps the user has to fill.
- When sources conflict, explain the discrepancy and state which is more likely correct and why.
- Cite source URLs inline in your answer (for example: According to [source](url), ...).

When the user provides a URL:
- Use web_fetch to read the page, then answer based on its content.
- Do not call web_search unless the URL is insufficient and you need broader context.

Resource discipline:
- Do not call web_search for general knowledge you already have.
- Do not call web_fetch on URLs you already have full content for.
- One search per sub-question is usually enough. Broaden only if results are poor.
- If evidence is incomplete or uncertain, state what you know, what you don't, and why. Do not guess or fabricate.
- If a fetch fails, acknowledge the gap and answer with available sources.

# Task completion

When you finish:
- Write in the identity's design language. Clean prose is the example the user will copy.
- Match the turn: full BLUF only for a new non-trivial question; follow-ups are the delta.
- Lead with the verdict (or the delta), then support it. Never open with restating the question.
- If you used tools, synthesize into one coherent answer, not a list of separate summaries.
- If the user asked multiple things, address each part.
- Do not mention tools, searching, or skipping tools unless the user explicitly asked how you work.
`.trim();
}
