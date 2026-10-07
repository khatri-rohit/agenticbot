import type { Message } from '@org/agent-models';

export type MessageTurn = {
  userMessage: Message;
  replies: Message[];
};

/** Split flat messages into user-initiated turns (user → following assistant/tool). */
export function groupMessageTurns(messages: Message[]): MessageTurn[] {
  const turns: MessageTurn[] = [];

  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({ userMessage: message, replies: [] });
      continue;
    }

    if (turns.length === 0) continue;

    turns[turns.length - 1].replies.push(message);
  }

  return turns;
}
