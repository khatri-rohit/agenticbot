/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { client } from './model';
import { ToolRegistry } from './tools';

export async function runAgent(
  model: string,
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry,
): Promise<any> {
  try {
    while (true) {
      const response = await client.chat.completions.create({
        model,
        messages,
        tools: tools.definitions,
      });

      const choices = response.choices[0];
      console.log('Choices: ', choices);
      if (choices.finish_reason === 'stop') {
        console.log('Stop reason: ', choices.finish_reason);
        return choices.message.content;
      } else {
        console.log('Finish reason: ', choices.finish_reason);
        console.log('Message: ', choices.message);
        console.log('Logprobs: ', choices.logprobs);
        console.log('Index: ', choices.index);
      }

      if (
        choices.message.tool_calls &&
        choices.finish_reason === 'tool_calls'
      ) {
        console.log('Tool calls: ', choices.message.tool_calls);
        const toolCalls = choices.message.tool_calls;
        for (const toolCall of toolCalls ?? []) {
          if (toolCall.type === 'function') {
            const toolName = toolCall.function.name;
            const tool = tools.byName.get(toolName);
            if (tool) {
              const toolArgs = toolCall.function.arguments;
              const toolResult = await tool.execute(JSON.parse(toolArgs));
              // console.log('Tool result: ', toolResult);
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: toolResult,
              });
            }
          }
        }
      } else {
        console.log('Finish reason: ', choices.finish_reason);
        console.log('Message: ', choices.message);
        console.log('Logprobs: ', choices.logprobs);
        console.log('Index: ', choices.index);
        console.log('--------------------------------');
        console.log('Breaking the loop');
        console.log('--------------------------------');
        break;
      }
    }
  } catch (error) {
    return `Error running agent: ${error}`;
  }
}
