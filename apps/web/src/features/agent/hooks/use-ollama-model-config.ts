import { useEffect, useState } from 'react';
import type { OllamaEndpoint, OllamaModelConfig } from '@org/agent-models';
import { fetchOllamaModelConfig } from '../api/agent-client';

const cache = new Map<string, OllamaModelConfig>();

function cacheKey(endpoint: OllamaEndpoint, model: string): string {
  return `${endpoint}:${model}`;
}

/** Load /api/show snapshot for the selected model (cached in memory). */
export function useOllamaModelConfig(model: string, local = false) {
  const endpoint: OllamaEndpoint = local ? 'local' : 'cloud';
  const key = cacheKey(endpoint, model);
  const [config, setConfig] = useState<OllamaModelConfig | null>(
    () => cache.get(key) ?? null,
  );

  useEffect(() => {
    if (!model.trim()) {
      setConfig(null);
      return;
    }

    const hit = cache.get(key);
    if (hit) {
      setConfig(hit);
      return;
    }

    let cancelled = false;
    setConfig(null);
    void fetchOllamaModelConfig(model, endpoint)
      .then((next) => {
        if (cancelled) return;
        cache.set(key, next);
        setConfig(next);
      })
      .catch(() => {
        if (!cancelled) setConfig(null);
      });

    return () => {
      cancelled = true;
    };
  }, [endpoint, key, model]);

  return config;
}
