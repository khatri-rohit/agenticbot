/**
 * Mid-turn direction picker. Separate from exec approval:
 * checkboxes + optional extra text, then Continue — or Skip to decide later
 * (the run ends with a summary of the options).
 */

export const MAX_CHOICE_OPTIONS = 8;
export const MAX_CHOICE_TEXT_CHARS = 2_000;

export type ChoiceOption = {
  id: string;
  label: string;
};

export type ChoiceRequest = {
  question: string;
  options: ChoiceOption[];
};

/** Continue payload. Skip is ChoiceSkipped, not this type. */
export type ChoiceResult = {
  optionIds: string[];
  text?: string;
};

/** User skipped to decide later: the run ends with a summary, never a picked path. */
export class ChoiceSkipped extends Error {
  override readonly name = 'ChoiceSkipped';
  constructor(message = 'User skipped this choice') {
    super(message);
  }
}
