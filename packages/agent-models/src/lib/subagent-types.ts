import type { RunPosture } from './run.js';

/** What the model asks for via the `delegate` tool. */
export type SubagentSpec = {
  task: string;
  profile: string;
  tools?: string[];
  posture?: RunPosture;
  focusFiles?: string[];
  mentionedThreads?: string[];
  forkContext?: boolean;
};

/** Bounded digest returned to the parent loop as the tool result. */
export type SubagentResult = {
  subRunId: string;
  status: 'completed' | 'incomplete' | 'error' | 'cancelled';
  summary: string;
  iterations: number;
  toolCalls: number;
  limitReason?: string;
};