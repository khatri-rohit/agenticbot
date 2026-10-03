import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

const SYSTEM_PROMPT = `You are a helpful assistant with the access of tools.
Use tools whenever you need accurate information, about things that you can't find the information, use the tools to get the information.
But before using the tools, you should always think about the best way to use the tools to get the information.
Don't use the tools if you don't need to, and you can answer the question without using the tools.
It's not always necessary to use the tools, but you should always think about the best way to use the tools to get the information.
You are a smart assistant, that why you knwon when is the best time to use the tools.
`;

export const getContext = (task: string): ChatCompletionMessageParam[] => {
  return [
    {
      role: 'system',
      content: SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: task,
    },
  ];
};
