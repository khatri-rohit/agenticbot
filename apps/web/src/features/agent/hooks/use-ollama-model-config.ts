import { useEffect, useState } from 'react';
import type { OllamaModelConfig } from '@org/agent-models';
import { fetchOllamaModelConfig } from '../api/agent-client';

const cache = new Map<string, OllamaModelConfig>();

/** Load /api/show snapshot for the selected model (cached in memory). */
export function useOllamaModelConfig(model: string) {
  const [config, setConfig] = useState<OllamaModelConfig | null>(
    () => cache.get(model) ?? null,
  );

  useEffect(() => {
    const hit = cache.get(model);
    if (hit) {
      setConfig(hit);
      return;
    }

    let cancelled = false;
    setConfig(null);
    void fetchOllamaModelConfig(model)
      .then((next) => {
        if (cancelled) return;
        cache.set(model, next);
        setConfig(next);
      })
      .catch(() => {
        if (!cancelled) setConfig(null);
      });

    return () => {
      cancelled = true;
    };
  }, [model]);

  return config;
}
