import { limitCodeOf } from './limits.js';

/**
 * What happened to one tool call, stored on its ledger row and its
 * `tool.completed` event so the UI never guesses from the text.
 *
 * ok: ran and returned. failed: ran and threw. refused: a gate said no before
 * it ran. skipped: never attempted (the run halted or was cancelled, or the
 * user skipped a choice).
 */
export type ToolOutcome = 'ok' | 'failed' | 'refused' | 'skipped';

/**
 * Outcome of a tool row written before outcomes were stored. Knows every
 * refusal and skip text the loop has written; anything else ran.
 */
export function legacyToolOutcome(content: string): ToolOutcome {
  if (content.startsWith('Tool execution failed:')) return 'failed';
  const code = limitCodeOf(content);
  const detail = code ? content.slice(code.length + 1).trimStart() : content;
  if (
    detail.startsWith('Skipped:') ||
    detail.startsWith('User skipped this choice.')
  ) {
    return 'skipped';
  }
  if (
    code ||
    detail.startsWith('Blocked:') ||
    detail.startsWith('Invalid tool arguments.') ||
    detail.startsWith('Unsupported tool call type.') ||
    /^Tool ".*" does not exist\.$/.test(detail)
  ) {
    return 'refused';
  }
  return 'ok';
}
