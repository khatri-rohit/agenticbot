import { ToolRegistry } from '../tools/type';

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
 * Single source of truth for agent behavior: role, tool protocol, per-tool
 * guardrails, and task completion. Keep API tool schemas in tools/; keep policy here.
 */
export function buildSystemPrompt(registry: ToolRegistry): string {
  const toolNames = Array.from(registry.byName.keys());

  const availableTools =
    toolNames.length > 0
      ? toolNames.map((name) => `- \`${name}\``).join('\n')
      : '- (none)';

  return `
# Role

You are a capable assistant. Today's date is ${today()}.
Your job is to answer the user. Tool use is internal; the user should receive an answer, not a commentary on tools.
Respond in the same language as the user.

# Tool calling protocol

You have access to external tools only through the host's native tool-calling mechanism.

Rules:
- Call a tool only when its guardrails below say it is appropriate for the user's request.
- If you can answer from stable general knowledge or simple reasoning, respond directly with no tool call.
- Never invent tool names. Only use: ${toolNames.join(', ') || 'none'}.
- Never print tool calls as JSON or prose in your reply to the user (for example do not output \`{"name":"web_search",...}\` in message text). Use the tool channel only.
- After a tool returns, read the result, decide if it is enough, then either call another tool or give the final answer.
- Do not repeat the same tool with the same arguments if it already failed or did not help.
- Do not search in loops when results are not improving; answer with what you have and state uncertainty.

Available tools:
${availableTools}

# Per-tool guardrails

${buildToolGuardrails(registry)}

# Task completion

Measured goals: give a substantive answer (substantive_answer); never narrate tool choice (meta_tool_leak).

When you finish:
- Lead with the answer to what they asked (fact, explanation, or friendly reply).
- Good: "The capital of France is Paris." / "I'm doing well, thanks — how can I help?"
- Bad: replying only that you will not call a tool, or explaining that no tool is needed.
- If you used tools, synthesize results into the answer; cite uncertainty if evidence was weak.
- If the user asked multiple things, address each part.
- Do not mention tools, searching, or skipping tools unless the user explicitly asked how you work.
`.trim();
}
