import { mkdir, writeFile, cp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { invalidateSkillCatalog, parseSkillMarkdown } from '@agent/agent-core';
import * as tar from 'tar';

const IGNORE = new Set([
  '.cursor',
  '.vscode',
  '.idea',
  '.git',
  '.github',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  '.turbo',
  '.nx',
  '__pycache__',
  '.venv',
  'venv',
]);

const GITHUB_API = 'https://api.github.com';
const MAX_ARCHIVE_BYTES = 40 * 1024 * 1024;
const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

export type FoundSkill = {
  name: string;
  description: string;
  folderName: string;
  pathInRepo: string;
};

export class SkillImportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SkillImportError';
  }
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'personal-assistant',
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function parseGitHubRepoUrl(raw: string): {
  owner: string;
  repo: string;
  ref?: string;
} {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SkillImportError('Enter a GitHub repository URL.', 400);
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    (url.hostname !== 'github.com' && url.hostname !== 'www.github.com')
  ) {
    throw new SkillImportError(
      'Only github.com repository URLs are supported.',
      400,
    );
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const owner = parts[0];
  const repo = parts[1]?.replace(/\.git$/i, '');
  if (!owner || !repo) {
    throw new SkillImportError('URL must be github.com/owner/repo.', 400);
  }
  const ref =
    parts.length >= 4 &&
    (parts[2] === 'tree' || parts[2] === 'commit' || parts[2] === 'blob')
      ? decodeURIComponent(parts[3])
      : undefined;
  return { owner, repo, ref };
}

function ignored(posixPath: string): boolean {
  return posixPath
    .replace(/\\/g, '/')
    .split('/')
    .some((part) => IGNORE.has(part.toLowerCase()));
}

function relPath(entryPath: string): string {
  const posix = entryPath.replace(/\\/g, '/');
  const slash = posix.indexOf('/');
  return slash < 0 ? '' : posix.slice(slash + 1);
}

function folderName(pathInRepo: string, repo: string): string {
  const name =
    pathInRepo === '.' || pathInRepo === ''
      ? repo
      : path.posix.basename(pathInRepo);
  if (!FOLDER_NAME.test(name)) {
    throw new SkillImportError(`Invalid skill folder name: ${name}`, 400);
  }
  return name;
}

async function githubFetch(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: githubHeaders(),
    redirect: 'follow',
  });
  if (res.status === 403 || res.status === 429) {
    throw new SkillImportError(
      'GitHub rate limit reached. Try again later.',
      429,
    );
  }
  if (res.status === 404) {
    throw new SkillImportError(
      'Repository not found. It may be private or the URL is wrong.',
      404,
    );
  }
  if (!res.ok) {
    throw new SkillImportError(`GitHub request failed (${res.status}).`, 502);
  }
  return res;
}

function cacheFile(sha: string): string {
  return path.join(os.tmpdir(), 'personal-assistant-skills', `${sha}.tar.gz`);
}

async function downloadTarball(
  owner: string,
  repo: string,
  sha: string,
): Promise<string> {
  const dest = cacheFile(sha);
  try {
    if ((await stat(dest)).size > 0) return dest;
  } catch {
    /* download */
  }
  const res = await githubFetch(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball/${encodeURIComponent(sha)}`,
  );
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_ARCHIVE_BYTES) {
    throw new SkillImportError(
      'Repository archive is too large to import.',
      413,
    );
  }
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return dest;
}

async function skillsInArchive(
  archivePath: string,
  repo: string,
): Promise<FoundSkill[]> {
  const found: FoundSkill[] = [];
  const pending: Promise<void>[] = [];

  await tar.list({
    file: archivePath,
    gzip: true,
    onReadEntry(entry) {
      const posix = relPath(entry.path).replace(/\\/g, '/');
      const isSkill = posix === 'SKILL.md' || posix.endsWith('/SKILL.md');
      if (!posix || ignored(posix) || !isSkill) {
        entry.resume();
        return;
      }
      pending.push(
        new Promise((resolve, reject) => {
          const chunks: Buffer[] = [];
          entry.on('data', (chunk: Buffer) => chunks.push(chunk));
          entry.on('error', reject);
          entry.on('end', () => {
            const pathInRepo =
              posix === 'SKILL.md' ? '.' : path.posix.dirname(posix);
            const dir = folderName(pathInRepo, repo);
            const parsed = parseSkillMarkdown(
              Buffer.concat(chunks).toString('utf8'),
              dir,
            );
            found.push({
              name: parsed.name,
              description: parsed.description,
              folderName: dir,
              pathInRepo,
            });
            resolve();
          });
        }),
      );
    },
  });

  await Promise.all(pending);
  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

export async function previewGitHubSkills(repoUrl: string): Promise<{
  owner: string;
  repo: string;
  commit: string;
  skills: FoundSkill[];
}> {
  const parsed = parseGitHubRepoUrl(repoUrl);
  const repo = await githubFetch(
    `${GITHUB_API}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
  ).then(
    (res) => res.json() as Promise<{ default_branch?: string; size?: number }>,
  );
  if (typeof repo.size === 'number' && repo.size > 80 * 1024) {
    throw new SkillImportError('Repository is too large to import.', 413);
  }
  const ref = parsed.ref ?? repo.default_branch ?? 'HEAD';
  const commit = await githubFetch(
    `${GITHUB_API}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/commits/${encodeURIComponent(ref)}`,
  ).then((res) => res.json() as Promise<{ sha: string }>);
  const skills = await skillsInArchive(
    await downloadTarball(parsed.owner, parsed.repo, commit.sha),
    parsed.repo,
  );
  return {
    owner: parsed.owner,
    repo: parsed.repo,
    commit: commit.sha,
    skills,
  };
}

export async function installGitHubSkills(input: {
  agentHome: string;
  repoUrl: string;
  commit: string;
  skills: { pathInRepo: string; folderName: string }[];
}): Promise<{ installed: string[] }> {
  if (input.skills.length === 0) {
    throw new SkillImportError('Select at least one skill to save.', 400);
  }
  const parsed = parseGitHubRepoUrl(input.repoUrl);
  const commit = input.commit.trim();
  if (!/^[a-f0-9]{7,40}$/i.test(commit)) {
    throw new SkillImportError('Invalid commit.', 400);
  }
  const selected = input.skills.map((skill) => ({
    pathInRepo: skill.pathInRepo.replace(/\\/g, '/'),
    folderName: folderName(skill.folderName, parsed.repo),
  }));

  const archive = await downloadTarball(parsed.owner, parsed.repo, commit);
  const staging = path.join(
    os.tmpdir(),
    'personal-assistant-skills',
    `extract-${commit.slice(0, 12)}`,
  );
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    await tar.extract({
      file: archive,
      gzip: true,
      cwd: staging,
      strip: 1,
      filter(p) {
        // Archive paths are `repo-sha/...`; match the same relative paths as Check.
        const rel = relPath(p);
        if (!rel || ignored(rel)) return false;
        return selected.some((skill) =>
          skill.pathInRepo === '.'
            ? !rel.includes('/') && rel.toLowerCase().endsWith('.md')
            : rel === skill.pathInRepo ||
              rel.startsWith(`${skill.pathInRepo}/`),
        );
      },
    });

    const destRoot = path.join(input.agentHome, 'skills');
    await mkdir(destRoot, { recursive: true });
    const installed: string[] = [];
    for (const skill of selected) {
      const from =
        skill.pathInRepo === '.'
          ? staging
          : path.join(staging, ...skill.pathInRepo.split('/'));
      const to = path.join(destRoot, skill.folderName);
      await rm(to, { recursive: true, force: true });
      if (skill.pathInRepo === '.') {
        await mkdir(to, { recursive: true });
        for (const name of await readdir(from)) {
          if (!name.toLowerCase().endsWith('.md')) continue;
          await cp(path.join(from, name), path.join(to, name));
        }
      } else {
        await cp(from, to, { recursive: true });
      }
      installed.push(skill.folderName);
    }
    invalidateSkillCatalog();
    return { installed };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function deleteUserSkill(
  agentHome: string,
  folderName: string,
): Promise<void> {
  if (!FOLDER_NAME.test(folderName)) {
    throw new SkillImportError('Invalid skill folder.', 400);
  }
  await rm(path.join(agentHome, 'skills', folderName), {
    recursive: true,
    force: true,
  });
  invalidateSkillCatalog();
}
