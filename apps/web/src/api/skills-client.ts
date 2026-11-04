const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3333';

export type SkillCatalogItem = {
  name: string;
  description: string;
  folder: string;
  source: 'global' | 'user';
};

export type SkillCatalogs = {
  global: SkillCatalogItem[];
  user: SkillCatalogItem[];
};

export type FoundSkill = {
  name: string;
  description: string;
  folderName: string;
  pathInRepo: string;
  folderCollision?: boolean;
};

export type SkillPreview = {
  owner: string;
  repo: string;
  commit: string;
  skills: FoundSkill[];
};

async function readJson<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return body;
}

export async function fetchSkillCatalogs(): Promise<SkillCatalogs> {
  const res = await fetch(`${API_BASE}/api/agent/skills`);
  return readJson<SkillCatalogs>(res);
}

export async function previewSkills(repoUrl: string): Promise<SkillPreview> {
  const res = await fetch(`${API_BASE}/api/agent/skills/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoUrl }),
  });
  return readJson<SkillPreview>(res);
}

export async function installSkills(input: {
  repoUrl: string;
  commit: string;
  skills: { pathInRepo: string; folderName: string }[];
}): Promise<SkillCatalogs> {
  const res = await fetch(`${API_BASE}/api/agent/skills/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return readJson<SkillCatalogs>(res);
}

export async function deleteUserSkill(
  folder: string,
): Promise<SkillCatalogs> {
  const res = await fetch(
    `${API_BASE}/api/agent/skills/${encodeURIComponent(folder)}`,
    { method: 'DELETE' },
  );
  return readJson<SkillCatalogs>(res);
}
