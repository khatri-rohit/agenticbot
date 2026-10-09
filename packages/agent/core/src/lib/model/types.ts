/**
 * Model layer types — one completed LLM turn and streaming callbacks.
 *
 * ModelTurn is defined in @org/agent-models (domain shape); re-exported here
 * so model/loop code imports from the runtime module tree, not mixed with impl.
 */
export type { ModelTurn } from '@org/agent-models';

/** Called for each streamed text fragment from chat.completions (stream: true). */
export type OnTextDelta = (delta: string) => void;

export type { ModelCallOptions } from './call-options';
