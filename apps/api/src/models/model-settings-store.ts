import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  emptyModelSettings,
  isModelSettingRole,
  isSideCallThinking,
  MODEL_SETTING_ROLES,
  type ModelRoleSetting,
  type ModelSettingRole,
  type ModelSettings,
  type ResolvedModelSettings,
  type SideCallThinking,
} from '@agent/agent-models';

import { getAgentHome } from '../platform/instances.js';

const SETTINGS_FILE = 'model-settings.json';

function settingsPath(): string {
  return path.join(getAgentHome(), SETTINGS_FILE);
}

function isRoleSetting(value: unknown): value is ModelRoleSetting {
  if (typeof value !== 'object' || value === null) return false;
  const setting = value as Record<string, unknown>;
  return (
    typeof setting.model === 'string' &&
    (setting.endpoint === 'cloud' || setting.endpoint === 'local')
  );
}

/**
 * Read the settings file. Corrupt or partially-shaped files warn once and
 * degrade to unset roles — the dialog can never brick the harness; env vars
 * still apply.
 */
export async function readModelSettings(): Promise<ModelSettings> {
  const defaults = emptyModelSettings();
  let raw: string;
  try {
    raw = await readFile(settingsPath(), 'utf8');
  } catch {
    return defaults; // No file yet — normal first-run state.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(
      `[models] ${SETTINGS_FILE} is not valid JSON; using env defaults (${error instanceof Error ? error.message : error})`,
    );
    return defaults;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    console.warn(`[models] ${SETTINGS_FILE} has an unexpected shape; using env defaults`);
    return defaults;
  }
  const file = parsed as Record<string, unknown>;
  const roles = file.roles;
  if (roles !== undefined) {
    if (typeof roles !== 'object' || roles === null) {
      console.warn(`[models] ${SETTINGS_FILE} roles is malformed; using env defaults`);
      return defaults;
    }
    for (const role of MODEL_SETTING_ROLES) {
      const setting = (roles as Record<string, unknown>)[role];
      if (setting === undefined) continue;
      if (!isRoleSetting(setting)) {
        console.warn(`[models] ${SETTINGS_FILE} roles.${role} is malformed; ignoring it`);
        continue;
      }
      defaults.roles[role] = { model: setting.model, endpoint: setting.endpoint };
    }
  }
  const thinking = file.thinking;
  if (typeof thinking === 'object' && thinking !== null) {
    const t = thinking as Record<string, unknown>;
    if (t.summary !== undefined) {
      if (isSideCallThinking(t.summary)) defaults.thinking.summary = t.summary;
      else console.warn(`[models] ${SETTINGS_FILE} thinking.summary is invalid; ignoring it`);
    }
    if (t.learningReview !== undefined) {
      if (isSideCallThinking(t.learningReview)) defaults.thinking.learningReview = t.learningReview;
      else console.warn(`[models] ${SETTINGS_FILE} thinking.learningReview is invalid; ignoring it`);
    }
  }
  return defaults;
}

/** Atomic write: readers never see a partial file; last write wins. */
export async function writeModelSettings(settings: ModelSettings): Promise<void> {
  const target = settingsPath();
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  await rename(tmp, target);
}

const ENV_ROLE_VARS: Record<ModelSettingRole, string> = {
  fast: 'AGENT_MODEL_FAST',
  strong: 'AGENT_MODEL_STRONG',
  summary: 'AGENT_MODEL_SUMMARY',
  title: 'TITLE_MODEL',
};

/**
 * Resolve every role for one run: file > env > the run's own model. The
 * endpoint travels with the pick; a cloud pick on a local run is honored only
 * when OLLAMA_API_KEY exists, else it falls back with one warn.
 */
export async function resolveModelSettings(
  runModel: string,
  runEndpoint: 'cloud' | 'local',
): Promise<ResolvedModelSettings> {
  const settings = await readModelSettings();
  const resolved: ResolvedModelSettings = {
    roles: {
      fast: { model: runModel, endpoint: runEndpoint, source: 'default' },
      strong: { model: runModel, endpoint: runEndpoint, source: 'default' },
      summary: { model: runModel, endpoint: runEndpoint, source: 'default' },
      title: { model: runModel, endpoint: runEndpoint, source: 'default' },
    },
    thinking: settings.thinking,
  };
  for (const role of MODEL_SETTING_ROLES) {
    const fileSetting = settings.roles[role];
    if (fileSetting.model !== '') {
      if (fileSetting.endpoint === 'cloud' && !process.env.OLLAMA_API_KEY) {
        console.warn(
          `[models] settings role ${role}=${fileSetting.model} needs OLLAMA_API_KEY; falling back`,
        );
      } else {
        resolved.roles[role] = {
          model: fileSetting.model,
          endpoint: fileSetting.endpoint,
          source: 'file',
        };
        continue;
      }
    }
    const envModel = process.env[ENV_ROLE_VARS[role]]?.trim();
    // Env vars hold cloud ids; on local runs they would not resolve, so the
    // run's own model applies (the pre-settings behavior).
    if (envModel && runEndpoint === 'cloud') {
      resolved.roles[role] = {
        model: envModel,
        endpoint: 'cloud',
        source: 'env',
      };
    }
  }
  return resolved;
}

/**
 * Side-call budget for a thinking preference. Thinking tokens eat max_tokens,
 * so the cap rises with the preference and the timeout scales with it.
 */
export function sideCallBudget(
  thinking: SideCallThinking,
): { maxTokens: number; timeoutMs: number } {
  switch (thinking) {
    case 'off':
      return { maxTokens: 1_500, timeoutMs: 20_000 };
    case 'low':
      return { maxTokens: 2_000, timeoutMs: 20_000 };
    case 'medium':
      return { maxTokens: 2_500, timeoutMs: 30_000 };
    case 'high':
      return { maxTokens: 3_500, timeoutMs: 45_000 };
  }
}

/** Parse + validate a PUT body into ModelSettings; returns problems for a 400. */
export function parseModelSettingsBody(
  body: unknown,
): { ok: true; settings: ModelSettings } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (typeof body !== 'object' || body === null) {
    return { ok: false, problems: ['body must be a JSON object'] };
  }
  const input = body as Record<string, unknown>;
  const allowed = new Set(['roles', 'thinking']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) problems.push(`unknown field "${key}"`);
  }
  const settings = emptyModelSettings();
  const roles = input.roles;
  if (roles !== undefined) {
    if (typeof roles !== 'object' || roles === null) {
      problems.push('roles must be an object');
    } else {
      for (const key of Object.keys(roles as Record<string, unknown>)) {
        if (!isModelSettingRole(key)) problems.push(`unknown role "${key}"`);
      }
      for (const role of MODEL_SETTING_ROLES) {
        const setting = (roles as Record<string, unknown>)[role];
        if (setting === undefined) continue;
        if (!isRoleSetting(setting)) {
          problems.push(`roles.${role} must be { model: string, endpoint: "cloud" | "local" }`);
          continue;
        }
        if (setting.model !== '' && setting.model.trim() === '') {
          problems.push(`roles.${role}.model must be non-empty or "" (unset)`);
          continue;
        }
        settings.roles[role] = { model: setting.model, endpoint: setting.endpoint };
      }
    }
  }
  const thinking = input.thinking;
  if (thinking !== undefined) {
    if (typeof thinking !== 'object' || thinking === null) {
      problems.push('thinking must be an object');
    } else {
      const t = thinking as Record<string, unknown>;
      for (const key of Object.keys(t)) {
        if (key !== 'summary' && key !== 'learningReview') {
          problems.push(`unknown thinking field "${key}"`);
        }
      }
      if (t.summary !== undefined) {
        if (isSideCallThinking(t.summary)) settings.thinking.summary = t.summary;
        else problems.push('thinking.summary must be off | low | medium | high');
      }
      if (t.learningReview !== undefined) {
        if (isSideCallThinking(t.learningReview)) settings.thinking.learningReview = t.learningReview;
        else problems.push('thinking.learningReview must be off | low | medium | high');
      }
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, settings };
}