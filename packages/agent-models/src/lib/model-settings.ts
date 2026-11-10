import type { OllamaEndpoint } from './ollama-model.js';

/**
 * Settings-dialog roles. Distinct from `ModelRole` in mode.ts (main/fast/strong
 * sub-agent roles): these are the host-persisted, user-editable picks for
 * which model each background job uses. `summary` and `title` have no
 * sub-agent counterpart.
 */
export type ModelSettingRole = 'fast' | 'strong' | 'summary' | 'title';

export const MODEL_SETTING_ROLES: readonly ModelSettingRole[] = [
  'fast',
  'strong',
  'summary',
  'title',
] as const;

/** Thinking preference for a side call (summary, learning review). */
export type SideCallThinking = 'off' | 'low' | 'medium' | 'high';

export const SIDE_CALL_THINKING_LEVELS: readonly SideCallThinking[] = [
  'off',
  'low',
  'medium',
  'high',
] as const;

/** A role's stored pick. `model: ''` means unset (env/default applies). */
export type ModelRoleSetting = {
  model: string;
  endpoint: OllamaEndpoint;
};

export type ModelSettings = {
  roles: Record<ModelSettingRole, ModelRoleSetting>;
  thinking: {
    summary: SideCallThinking;
    learningReview: SideCallThinking;
  };
};

/** Where a resolved role's model came from, for run_start attribution. */
export type ModelSettingSource = 'file' | 'env' | 'default';

export type ResolvedModelSetting = {
  model: string;
  endpoint: OllamaEndpoint;
  source: ModelSettingSource;
};

export type ResolvedModelSettings = {
  roles: Record<ModelSettingRole, ResolvedModelSetting>;
  thinking: ModelSettings['thinking'];
};

/** Unset role rows and code-default thinking, before any file/env override. */
export function emptyModelSettings(): ModelSettings {
  return {
    roles: {
      fast: { model: '', endpoint: 'cloud' },
      strong: { model: '', endpoint: 'cloud' },
      summary: { model: '', endpoint: 'cloud' },
      title: { model: '', endpoint: 'cloud' },
    },
    thinking: { summary: 'medium', learningReview: 'high' },
  };
}

export function isModelSettingRole(value: unknown): value is ModelSettingRole {
  return typeof value === 'string' && (MODEL_SETTING_ROLES as readonly string[]).includes(value);
}

export function isSideCallThinking(value: unknown): value is SideCallThinking {
  return (
    typeof value === 'string' && (SIDE_CALL_THINKING_LEVELS as readonly string[]).includes(value)
  );
}