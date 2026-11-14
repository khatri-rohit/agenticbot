import { useEffect, useState } from 'react';

import {
  fetchCloudOllamaModels,
  fetchLocalOllamaModels,
} from '../../api/agent-client';
import {
  CLOUD_OLLAMA_MODELS,
  listedModelToPickerModel,
  mergeCloudModels,
  type OllamaModel,
} from './ollama-models';

/**
 * The model list for pickers: live Ollama Cloud models (static catalog
 * fallback) plus installed local models when `includeLocal` is on. The
 * composer uses it for its picker; Settings → Models reuses it for role rows.
 */
export function useOllamaModels(includeLocal: boolean): {
  cloudModels: OllamaModel[];
  localModels: OllamaModel[];
  localModelsLoading: boolean;
  localModelsError: string | null;
} {
  const [cloudModels, setCloudModels] =
    useState<OllamaModel[]>(CLOUD_OLLAMA_MODELS);
  const [localModels, setLocalModels] = useState<OllamaModel[]>([]);
  const [localModelsLoading, setLocalModelsLoading] = useState(false);
  const [localModelsError, setLocalModelsError] = useState<string | null>(null);

  // Discover cloud models from Ollama Cloud on mount; fall back to the
  // static catalog on error so cloud chat still works with known models.
  useEffect(() => {
    let cancelled = false;
    void fetchCloudOllamaModels()
      .then((res) => {
        if (cancelled) return;
        const merged = mergeCloudModels(
          res.models.map((m) => ({ id: m.id, family: m.family, size: m.size })),
        );
        if (merged.length > 0) setCloudModels(merged);
      })
      .catch((err) => {
        // Keep the static catalog — cloud chat still works with known models.
        console.warn(
          '[use-ollama-models] live cloud models fetch failed, using catalog fallback',
          err,
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Discover installed models from the API host's Ollama when Local is on.
  useEffect(() => {
    if (!includeLocal) {
      setLocalModels([]);
      setLocalModelsError(null);
      setLocalModelsLoading(false);
      return;
    }

    let cancelled = false;
    setLocalModelsLoading(true);
    setLocalModelsError(null);
    void fetchLocalOllamaModels()
      .then((res) => {
        if (cancelled) return;
        setLocalModels(res.models.map(listedModelToPickerModel));
        setLocalModelsLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLocalModels([]);
        setLocalModelsLoading(false);
        setLocalModelsError(
          err instanceof Error
            ? err.message
            : 'Could not reach Ollama on the API host (127.0.0.1:11434). Start `ollama serve` there, or set OLLAMA_LOCAL_BASE_URL.',
        );
      });

    return () => {
      cancelled = true;
    };
  }, [includeLocal]);

  return { cloudModels, localModels, localModelsLoading, localModelsError };
}