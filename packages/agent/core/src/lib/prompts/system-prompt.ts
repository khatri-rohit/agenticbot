import type { ModeName, RunPosture } from '@org/agent-models';

import { listSkills } from '../tools/skills';
import type { ToolRegistry } from '../tools/type';
import {
  ANTI_SLOP_CODE_LAW,
  SOFTWARE_ENGINEER_CONSTITUTION,
} from './coding-law';
import { loadAgentIdentity } from './load-agent-identity';

const today = () => new Date().toISOString().slice(0, 10);

function formatList(items: string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

function buildToolGuardrails(
  registry: ToolRegistry,
  compact: boolean,
): string {
  if (compact) {
    return Array.from(registry.byName.values())
      .map((tool) => {
        const name = tool.definition.function.name;
        const use = tool.guidance.whenToUse[0] ?? '';
        const avoid = tool.guidance.whenNotToUse[0];
        return avoid
          ? `- ${name}: ${use} Do not: ${avoid}`
          : `- ${name}: ${use}`;
      })
      .join('\n');
  }

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
 * Assembles the frozen system prompt: identity + protocol + always-on law.
 * USER.md / MEMORY.md belong in the memory layer (assembleContext), not here.
 * Workspace Ask uses read-only behavior; posture is a run policy, not a ModeName.
 */
export function buildSystemPrompt(
  registry: ToolRegistry,
  mode?: ModeName,
  posture: RunPosture = 'agent',
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

  const hasWebSearch = registry.byName.has('web_search');
  const isWorkspace = mode === 'workspace';
  const isAsk = isWorkspace && posture === 'ask';
  const skillsSection = hasLoadSkill
    ? `
# Skills

Available skills:
${catalog || '- (none)'}

Skills are optional procedure packs. Names and descriptions above are pointers.
Call load_skill with skill_name to load a body when that workflow applies.
Built-in tools work without a skill. Loading a skill does not approve its steps.
Additional user, workspace, and MCP skills are not in this catalog yet.
`
    : '';

  const webSearchRule = hasWebSearch
    ? isWorkspace
      ? `- web_search is on this run. Use the open folder first. If files, AGENTS.md, and attached threads do not contain the current API, version, or docs you need, call web_search (then web_fetch if the page is required). Cite URLs. Do not invent live library shape from memory.`
      : `- When web_search is listed below, it is a built-in host tool. If you lack reliable current knowledge, call web_search once with a specific query, then answer from Detailed Sources with URL citations.`
    : isWorkspace
      ? `- web_search is not on this run. Work from the open folder, project files, and attached AGENTS.md / rules.`
      : `- web_search is not enabled for this run. Do not invent live web facts; answer from knowledge or ask the user to enable web search.`;

  const modeBehavior = !isWorkspace
    ? HOME_BEHAVIOR
    : isAsk
      ? workspaceAskBehavior(hasWebSearch)
      : workspaceAgentBehavior(hasWebSearch);

  const lawBand = isWorkspace
    ? isAsk
      ? ANTI_SLOP_CODE_LAW
      : `${SOFTWARE_ENGINEER_CONSTITUTION}\n\n${ANTI_SLOP_CODE_LAW}`
    : ANTI_SLOP_CODE_LAW;

  return `
${loadAgentIdentity(mode)}

Today's date is ${today()}.

# Tool calling protocol

Tools below are the host's built-in native tools (function calls).

Rules:
- Call a tool only when its guardrails below say it is appropriate.
- If you can answer from stable general knowledge or simple reasoning, respond with no tool call.
${webSearchRule}
- Never invent tool names. Only use: ${toolNames.join(', ') || 'none'}.
- Never print tool calls as JSON or prose in your reply to the user. Use the tool channel only.
- After a tool returns, read the result, then either call another tool or give the final answer.
- Do not repeat the same tool with the same arguments if it already failed or did not help.
- Do not search in loops when results are not improving; answer with what you have and state uncertainty.
- One purpose per tool call.

Available tools:
${availableTools}
${skillsSection}
# Per-tool guardrails

${buildToolGuardrails(registry, isWorkspace)}

${modeBehavior}

${lawBand}

# Task completion

When you finish:
- Write in the identity's design language. Clean prose is the example the user will copy.
- Match the turn: full BLUF only for a new non-trivial question; follow-ups are the delta.
- Lead with the verdict (or the delta), then support it. Never open with restating the question.
- If you used tools, synthesize into one coherent answer, not a list of separate summaries.
- If the user asked multiple things, address each part.
- Do not mention tools, searching, or skipping tools unless the user explicitly asked how you work.
- If a loop limit stopped you, say what you did and what is unfinished. Do not claim verify passed.
`.trim();
}

const HOME_BEHAVIOR = `
# Home behavior

This chat is not bound to a project folder. You cannot edit files or run a terminal.

Think clearly. Answer as a peer. Use web_search and web_fetch when current facts matter.
Cite source URLs inline when you used the web. Do not invent live facts.
If the user wants you to change a repo, tell them to open a folder (start a workspace chat).
`.trim();

function workspaceAgentBehavior(hasWebSearch: boolean): string {
  const docsStep = hasWebSearch
    ? `
5. Docs — if the folder and rules lack current library or API docs, web_search (then web_fetch if needed). Prefer project files first.`
    : '';
  return `
# Workspace behavior

You are bound to one opened project folder. File tools and the terminal cannot leave that folder.

Act loop:
1. Retrieve — glob / grep / read_file until the working files are known. Do not invent paths.
   Never use run_terminal to read or search files.
2. Patch — edit_file with a unique oldText span. Read the change report in the tool result.
3. Verify — run_terminal with that project's real compile/test/build command (cwd is the folder).
4. Repair — use command errors; edit again. Repeat until the check passes or you are stuck.${docsStep}

edit_file results tell you what changed (path, created or patched, line/byte delta, hunk). Do not assume the file matches your intent without that report. Re-read if the report is truncated.

AGENTS.md and attached rules in the memory layer are project law for this folder only.
Do not mention tools unless the user asks how you work.
`.trim();
}

function workspaceAskBehavior(hasWebSearch: boolean): string {
  const docs = hasWebSearch
    ? ' If the folder lacks current library docs, web_search rather than guessing.'
    : '';
  return `
# Workspace Ask behavior

You are bound to one opened project folder in read-only Ask posture.
You can glob, grep, and read_file. You cannot edit files or run the terminal.

Explain, locate, and reason from the open folder.${docs} If the user wants edits, tests, or
commands, tell them to switch the composer to Agent.
Do not claim you changed files. Do not invent tool names for write or exec.
AGENTS.md and attached rules in the memory layer are project law for this folder only.
Do not mention tools unless the user asks how you work.
`.trim();
}
