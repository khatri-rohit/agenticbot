import { Skill, SkillMetadata, Tool } from './type';

const skills: Skill[] = [
  {
    name: 'web_search_skill',
    description:
      'Use this skill before using the web_search tool, this will provide better instructions for the web_search tool.',
    instructions: `Use the web_search skill whenever you need up-to-date or specific information that may not be in your internal knowledge base. To use it effectively:
- Clearly state the topic, question, or keywords you want to search for.
- Be as specific as possible to get the most relevant results.`,
  },
];

export function listSkills(): SkillMetadata[] {
  return skills.map(({ name, description }) => ({ name, description }));
}

export function getSkill(name: string): Skill | undefined {
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
      'Use the skills tool to get the body of a skill, which will provide better context and help is thinking and responding better. Example: "load_skill: web_search_skill"',
    ],
  },
  execute: async (args) => {
    const skill = String(args.skill_name ?? '');
    const skillBody = getSkill(skill);
    return skillBody?.instructions ?? 'Skill not found';
  },
};
