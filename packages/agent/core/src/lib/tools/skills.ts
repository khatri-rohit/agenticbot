import type { Skill, SkillMetadata, Tool } from './type';

const skills: Skill[] = [
  {
    name: 'web_search_skill',
    description:
      'Optional research checklist for multi-source web answers. Not required before calling web_search.',
    instructions: `web_search is already a built-in tool — call it directly; you do not need this skill to search.

When you load this skill for a harder research turn:
- One specific query per sub-question; include product/version and year when freshness matters.
- Prefer Detailed Sources over Further Reading; web_fetch a listed URL only if needed to finish.
- Synthesize a single complete answer with inline URL citations.
- Do not run near-duplicate searches or invent facts missing from the tool results.`,
  },
];

export function listSkills(): SkillMetadata[] {
  return skills.map(({ name, description }) => ({ name, description }));
}

function getSkill(name: string): Skill | undefined {
  return skills.find((skill) => skill.name === name);
}

export const load_skill: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'load_skill',
      description: 'Use this skill to get the body of a skill',
      parameters: {
        type: 'object',
        properties: {
          skill_name: {
            type: 'string',
            description: 'this is the name of the skill to get the body of',
          },
        },
        required: ['skill_name'],
        additionalProperties: false,
      },
    },
  },
  guidance: {
    whenToUse: [
      'When you need to use a skill to improve the quality of the response',
    ],
    whenNotToUse: [
      'Do not use for general conversation or questions',
      'Do not use for questions that are not related to skills',
    ],
    usage: [
      'Call load_skill with skill_name only when you want optional procedure text. Built-in tools (web_search, web_fetch) do not require a skill first.',
    ],
  },
  execute: async (args) => {
    const skill = String(args.skill_name ?? '');
    const skillBody = getSkill(skill);
    if (skillBody) return skillBody.instructions;
    const available = listSkills()
      .map((s) => s.name)
      .join(', ');
    return `Skill not found. Available skills: ${available || '(none)'}`;
  },
};
