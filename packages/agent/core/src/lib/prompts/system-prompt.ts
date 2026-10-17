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

/**
 * Assembles the frozen system prompt: identity + tool protocol.
 * USER.md / MEMORY.md belong in the memory layer (assembleContext), not here.
 */
export function buildSystemPrompt(registry: ToolRegistry): string {
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

  const hasWebSearch = registry.byName.has('web_search');
  const skillsSection = hasLoadSkill
    ? `
# Skills

Available skills:
${catalog}

Skills are optional instruction packs. Built-in tools like web_search and web_fetch
work without loading a skill — call them directly when needed.
Only call load_skill when you want extra procedure text before a specialized workflow.
Loading instructions does not approve any action they recommend.
`
    : '';

  const webSearchRule = hasWebSearch
    ? `- When web_search is listed below, it is a built-in host tool (not an MCP plugin). If you lack reliable current knowledge for the question, call web_search once with a specific query, then answer from Detailed Sources with URL citations.`
    : `- web_search is not enabled for this run. Do not invent live web facts; answer from knowledge or ask the user to enable web search.`;

  return `
${loadAgentIdentity()}

Today's date is ${today()}.

# Tool calling protocol

Tools below are the host's built-in native tools (function calls). They are not third-party plugins the user must configure mid-chat.

Rules:
- Call a tool only when its guardrails below say it is appropriate for the user's request.
- If you can answer from stable general knowledge or simple reasoning, respond directly with no tool call.
${webSearchRule}
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
