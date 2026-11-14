/**
 * Done gates (P6): what an answer needs before the run may end, per evidence
 * type. A change needs a check after its last edit; open plan todos need to
 * be finished or updated. Each gate sends the run back once, with a reason,
 * and never blocks a second time (progress beats perfection): after that the
 * answer stands, or the run ends on its plan limit.
 *
 * Research has no gate: "every requested topic covered" needs topics the
 * harness cannot know without asking the model to declare them.
 */

const CLAIMS_SUCCESS = /\b(works|working now|passes|passing|fixed|verified|succeeds|all tests pass)\b/i;
const ADMITS_UNVERIFIED =
  /\b(not verified|unverified|could not verify|couldn't verify|did not verify|didn't verify|not tested|untested)\b/i;

/**
 * Change gate: an Agent run with edits not followed by a check, that claims
 * success without saying it is unverified, goes back once to verify.
 */
export function changeGate(input: {
  enabled: boolean;
  alreadySent: boolean;
  posture: string;
  unchecked: boolean;
  canRunChecks: boolean;
  answer: string;
}): boolean {
  return (
    input.enabled &&
    !input.alreadySent &&
    input.posture === 'agent' &&
    input.unchecked &&
    input.canRunChecks &&
    CLAIMS_SUCCESS.test(input.answer) &&
    !ADMITS_UNVERIFIED.test(input.answer)
  );
}

/**
 * Plan gate: open todos on the plan send an Agent run back once, then end
 * it on its plan limit. A read-only run (Plan, Ask) passes: it cannot work
 * on the todos, so they never hold its answer back.
 */
export function planGate(input: { openPlanWork: boolean; nudges: number; posture: string }): 'pass' | 'nudge' | 'stop' {
  if (input.posture !== 'agent' || !input.openPlanWork) return 'pass';
  return input.nudges < 1 ? 'nudge' : 'stop';
}
