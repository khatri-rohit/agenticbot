/**
 * Module slot for the active chat composer.
 * ChatInput registers on mount; ChatShell type-to-focus reads it.
 * No React context — one composer per shell is enough.
 */

export type ComposerFocusHandle = {
  focus: () => void;
  insertText: (text: string) => void;
  isLocked: () => boolean;
};

let handle: ComposerFocusHandle | null = null;

export function registerComposerFocus(
  next: ComposerFocusHandle | null,
): void {
  handle = next;
}

export function getComposerFocus(): ComposerFocusHandle | null {
  return handle;
}
