'use client';

import * as React from 'react';
import type { ToastActionElement, ToastProps } from '@/components/ui/toast';

const TOAST_LIMIT = 3;
const TOAST_REMOVE_DELAY_MS = 4_000;

type ToasterToast = ToastProps & {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: ToastActionElement;
};

const actionTypes = {
  ADD_TOAST: 'ADD_TOAST',
  UPDATE_TOAST: 'UPDATE_TOAST',
  DISMISS_TOAST: 'DISMISS_TOAST',
  REMOVE_TOAST: 'REMOVE_TOAST',
} as const;

let toastCount = 0;

function nextToastId() {
  toastCount = (toastCount + 1) % Number.MAX_SAFE_INTEGER;
  return toastCount.toString();
}

type Action =
  | { type: typeof actionTypes.ADD_TOAST; toast: ToasterToast }
  | { type: typeof actionTypes.UPDATE_TOAST; toast: Partial<ToasterToast> }
  | { type: typeof actionTypes.DISMISS_TOAST; toastId?: string }
  | { type: typeof actionTypes.REMOVE_TOAST; toastId?: string };

interface State {
  toasts: ToasterToast[];
}

const toastTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

function queueToastRemoval(toastId: string) {
  if (toastTimeouts.has(toastId)) return;

  const timeout = setTimeout(() => {
    toastTimeouts.delete(toastId);
    dispatch({ type: actionTypes.REMOVE_TOAST, toastId });
  }, TOAST_REMOVE_DELAY_MS);

  toastTimeouts.set(toastId, timeout);
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case actionTypes.ADD_TOAST:
      return {
        ...state,
        toasts: [action.toast, ...state.toasts].slice(0, TOAST_LIMIT),
      };
    case actionTypes.UPDATE_TOAST:
      return {
        ...state,
        toasts: state.toasts.map((toastItem) =>
          toastItem.id === action.toast.id
            ? { ...toastItem, ...action.toast }
            : toastItem,
        ),
      };
    case actionTypes.DISMISS_TOAST: {
      const { toastId } = action;
      if (toastId) queueToastRemoval(toastId);
      else state.toasts.forEach((toastItem) => queueToastRemoval(toastItem.id));

      return {
        ...state,
        toasts: state.toasts.map((toastItem) =>
          toastItem.id === toastId || toastId === undefined
            ? { ...toastItem, open: false }
            : toastItem,
        ),
      };
    }
    case actionTypes.REMOVE_TOAST:
      if (action.toastId === undefined) return { ...state, toasts: [] };
      return {
        ...state,
        toasts: state.toasts.filter(
          (toastItem) => toastItem.id !== action.toastId,
        ),
      };
  }
}

const listeners: Array<(state: State) => void> = [];
let memoryState: State = { toasts: [] };

function dispatch(action: Action) {
  memoryState = reducer(memoryState, action);
  listeners.forEach((listener) => listener(memoryState));
}

type ToastInput = Omit<ToasterToast, 'id'>;

/** Imperative toast API used across the web app (errors, warnings, info). */
function toast({ ...props }: ToastInput) {
  const id = nextToastId();

  const update = (next: ToasterToast) =>
    dispatch({ type: actionTypes.UPDATE_TOAST, toast: { ...next, id } });
  const dismiss = () =>
    dispatch({ type: actionTypes.DISMISS_TOAST, toastId: id });

  dispatch({
    type: actionTypes.ADD_TOAST,
    toast: {
      ...props,
      id,
      open: true,
      onOpenChange: (open) => {
        if (!open) dismiss();
      },
    },
  });

  return { id, dismiss, update };
}

function toastError(description: string, title = 'Something went wrong') {
  return toast({
    variant: 'destructive',
    title,
    description,
  });
}

function toastSuccess(description: string, title = 'Saved') {
  return toast({ title, description });
}

/** Subscribe to the in-memory toast store from React trees. */
function useToast() {
  const [state, setState] = React.useState<State>(memoryState);

  React.useEffect(() => {
    listeners.push(setState);
    setState(memoryState);
    return () => {
      const index = listeners.indexOf(setState);
      if (index > -1) listeners.splice(index, 1);
    };
  }, []);

  return {
    ...state,
    toast,
    dismiss: (toastId?: string) =>
      dispatch({ type: actionTypes.DISMISS_TOAST, toastId }),
  };
}

export { useToast, toast, toastError, toastSuccess };
