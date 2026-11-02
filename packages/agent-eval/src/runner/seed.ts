import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * What makes the eval agent "the agent you use": skills, user sub-agents and
 * the user-level memory files. Per-workspace memory is keyed by folder, so it
 * never applies to eval checkouts and is not copied.
 */
const SEED_DIRS = ['skills', 'agents'];
const SEED_FILES = [path.join('memory', 'USER.md'), path.join('memory', 'MEMORY.md')];

export type SeedInfo = { seedHash: string; seededAt: string; from: string; files: number };

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(root: string, rel = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(root, child)));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

/** Hash of the seeded content (paths + bytes), stable across machines. */
export async function seedHashOf(evalHome: string): Promise<{ hash: string; files: number }> {
  const files: string[] = [];
  for (const dir of SEED_DIRS) files.push(...(await listFiles(evalHome, dir)));
  for (const file of SEED_FILES) if (await exists(path.join(evalHome, file))) files.push(file);
  files.sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.split(path.sep).join('/'));
    hash.update('\0');
    hash.update(await readFile(path.join(evalHome, file)));
    hash.update('\0');
  }
  return { hash: hash.digest('hex'), files: files.length };
}

/**
 * Copy the personal home's skills, agents and user memory into the eval home
 * (replacing what was there) and write `seed.json` with the content hash.
 * Sessions, catalog and usage are never copied: evals start empty.
 */
export async function seedEvalHome(personalHome: string, evalHome: string): Promise<SeedInfo> {
  await mkdir(evalHome, { recursive: true });
  for (const dir of SEED_DIRS) {
    await rm(path.join(evalHome, dir), { recursive: true, force: true });
    if (await exists(path.join(personalHome, dir))) {
      await cp(path.join(personalHome, dir), path.join(evalHome, dir), { recursive: true });
    }
  }
  for (const file of SEED_FILES) {
    await rm(path.join(evalHome, file), { force: true });
    if (await exists(path.join(personalHome, file))) {
      await mkdir(path.dirname(path.join(evalHome, file)), { recursive: true });
      await cp(path.join(personalHome, file), path.join(evalHome, file));
    }
  }
  const { hash, files } = await seedHashOf(evalHome);
  const info: SeedInfo = { seedHash: hash, seededAt: new Date().toISOString(), from: personalHome, files };
  await writeFile(path.join(evalHome, 'seed.json'), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

/** The recorded seed, re-hashed so an edited seed is caught. Null when never seeded. */
export async function readSeed(evalHome: string): Promise<(SeedInfo & { drifted: boolean }) | null> {
  try {
    const info = JSON.parse(await readFile(path.join(evalHome, 'seed.json'), 'utf8')) as SeedInfo;
    const current = await seedHashOf(evalHome);
    return { ...info, drifted: current.hash !== info.seedHash };
  } catch {
    return null;
  }
}
