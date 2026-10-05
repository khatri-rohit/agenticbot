import type { ToolRegistry } from '../tools';

const today = () => new Date().toISOString().slice(0, 10);

function formatList(items: string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

function buildToolGuardrails(registry: ToolRegistry): string {
  const sections: string[] = [];

  for (const tool of registry.byName.values()) {
    if (tool.definition.type !== 'function') {
      continue;
    }

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
 * Single source of truth for agent behavior: role, tool protocol, per-tool guardrails,
 * and task completion. Keep API tool schemas in tools.ts; keep policy here.
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
Answer clearly and honestly. Respond in the same language as the user.

# Tool calling protocol

You have access to external tools only through the host's native tool-calling mechanism.

Rules:
- Call a tool only when its guardrails below say it is appropriate for the user's request.
- If you can answer from stable general knowledge or simple reasoning, respond directly with no tool call. For greetings and chat, reply naturally (for example to "Hi, how are you?" answer as a person would).
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

When you are ready to finish:
- Answer the user's question directly. Your reply must be only what the user should read—never mention tools, tool calls, guardrails, or whether you used or skipped them unless the user explicitly asked how you work.
- Bad: "I won't call any tool for this question." Good: "I'm doing well, thanks for asking! How are you?"
- If you used tools, synthesize their results into a concise answer. Cite uncertainty where results were weak or conflicting.
- If the user asked multiple things, address each part.
`.trim();
}
