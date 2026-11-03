'use client';

import { useEffect, useState } from 'react';
import type { OllamaBalance } from '@agent/agent-models';
import { fetchOllamaBalance } from '@/features/agent/api/agent-client';

const POLL_MS = 60_000;

export type OllamaBalanceState = {
  balance: OllamaBalance | null;
  loading: boolean;
};

/**
 * Polls the Ollama Cloud balance proxy every 60s (matching the API's
 * 10 req/min rate limit). Returns null balance when local mode is active —
 * local Ollama has no balance concept.
 */
export function useOllamaBalance(options: {
  local?: boolean;
}): OllamaBalanceState {
  const { local } = options;
  const [state, setState] = useState<OllamaBalanceState>({
    balance: null,
    loading: !local,
  });

  useEffect(() => {
    if (local) {
      setState({ balance: null, loading: false });
      return;
    }

    let cancelled = false;

    const poll = () => {
      void fetchOllamaBalance()
        .then((balance) => {
          if (cancelled) return;
          setState({ balance, loading: false });
        })
        .catch(() => {
          if (cancelled) return;
          setState((prev) => ({ balance: prev.balance, loading: false }));
        });
    };

    poll();
    const timer = window.setInterval(poll, POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [local]);

  return state;
}