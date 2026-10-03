/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { client } from './model';

export async function runAgent(
  model: string,
  messages: ChatCompletionMessageParam[],
): Promise<any> {
  // while (true) {
  try {
    const response = await client.chat.completions.create({
      model,
      messages,
    });

    const choices = response.choices[0];
    console.log(choices);
  } catch (error) {
    console.error(error);
    // break;
  }
}
// }
