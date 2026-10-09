import { Queue, Worker } from 'bullmq';
import { client } from '@org/agent-core';
import { clampChatTitle } from '@org/agent-models';
import { redis } from './redis';

/**
 * Title generation queue.
 *
 * When the user sends the first message in a thread, we enqueue a job
 * to summarize that message into a short title using gemma4:31b via
 * the cloud Ollama endpoint. The result is polled by the client and
 * written to IndexedDB (the server stays stateless for thread data).
 */

export const TITLE_QUEUE_NAME = 'title-generation';

export type TitleJobData = {
  threadId: string;
  firstMessage: string;
};

export const titleQueue = new Queue<TitleJobData>(TITLE_QUEUE_NAME, {
  connection: redis,
});

const TITLE_MODEL = process.env.TITLE_MODEL ?? 'gemma4:31b';

const TITLE_PROMPT = `You are a title generator. Summarize the user's message into a concise, meaningful title of exactly 5 to 7 words. Reply with ONLY the title, no quotes, no punctuation at the end.

User message: """{MESSAGE}"""`;

/**
 * Call the model to generate a title from the first user message.
 * Uses a non-streaming completion — it's a one-shot summarization.
 */
async function generateTitle(firstMessage: string): Promise<string> {
  const prompt = TITLE_PROMPT.replace('{MESSAGE}', firstMessage.slice(0, 1000));

  const response = await client.chat.completions.create({
    model: TITLE_MODEL,
    stream: false,
    max_tokens: 50,
    temperature: 0.5,
    messages: [
      {
        role: 'system',
        content:
          'You generate concise chat titles of 5 to 7 words. Output only the title.',
      },
      { role: 'user', content: prompt },
    ],
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? 'New Chat';
  const cleaned = raw.replace(/^["']|["']$/g, '');
  return clampChatTitle(cleaned);
}

/**
 * BullMQ worker — runs in the same Express process.
 * Processes title generation jobs asynchronously.
 */
export const titleWorker = new Worker<TitleJobData>(
  TITLE_QUEUE_NAME,
  async (job) => {
    const { firstMessage } = job.data;
    const title = await generateTitle(firstMessage);
    return { title };
  },
  {
    connection: redis,
    concurrency: 2,
  },
);

titleWorker.on('failed', (job, err) => {
  console.error(`[title-queue] job ${job?.id} failed:`, err.message);
});
