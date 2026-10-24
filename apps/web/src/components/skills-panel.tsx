'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Loader2, Search } from 'lucide-react';
import {
  deleteUserSkill,
  fetchSkillCatalogs,
  installSkills,
  previewSkills,
  type FoundSkill,
  type SkillCatalogItem,
  type SkillCatalogs,
  type SkillPreview,
} from '@/features/agent/api/skills-client';
import { toastError } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

type Tab = 'catalog' | 'import';

function matchesQuery(
  skill: { name: string; description: string },
  query: string,
) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    skill.name.toLowerCase().includes(q) ||
    skill.description.toLowerCase().includes(q)
  );
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function CatalogSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-live="polite">
      <div className="h-8 w-full animate-pulse rounded-md bg-muted" />
      <div className="h-12 w-full animate-pulse rounded-md bg-muted" />
      <div className="h-12 w-full animate-pulse rounded-md bg-muted" />
      <div className="h-12 w-2/3 animate-pulse rounded-md bg-muted" />
    </div>
  );
}

function OriginBadge({ source }: { source: SkillCatalogItem['source'] }) {
  return source === 'global' ? (
    <Badge variant="secondary" className="font-normal">
      Built-in
    </Badge>
  ) : (
    <Badge variant="outline" className="font-normal">
      Yours
    </Badge>
  );
}

function CatalogRow({
  skill,
  overrides,
  expanded,
  onToggleExpand,
  action,
}: {
  skill: SkillCatalogItem;
  overrides: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  action?: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-foreground">
            {skill.name}
          </p>
          <OriginBadge source={skill.source} />
        </div>
        <button
          type="button"
          onClick={onToggleExpand}
          className="mt-0.5 block w-full text-left"
          aria-expanded={expanded}
        >
          <p
            className={cn(
              'text-[13px] leading-5 text-muted-foreground',
              expanded ? 'whitespace-pre-wrap' : 'line-clamp-2',
            )}
          >
            {skill.description}
          </p>
        </button>
        {overrides ? (
          <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
            Overrides the built-in skill with this name
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0 pt-0.5">{action}</div> : null}
    </li>
  );
}

function ImportRow({
  skill,
  checked,
  onToggle,
}: {
  skill: FoundSkill;
  checked: boolean;
  onToggle: () => void;
}) {
  const id = `import-skill-${skill.pathInRepo}`;
  return (
    <li className="flex items-start gap-3 py-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-1 size-4 shrink-0 rounded border-input accent-foreground"
      />
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
        <p className="truncate text-sm font-medium text-foreground">
          {skill.name}
        </p>
        <p className="mt-0.5 line-clamp-2 text-[13px] leading-5 text-muted-foreground">
          {skill.description}
        </p>
        <p className="mt-1 truncate font-mono text-xs text-muted-foreground/80">
          {skill.pathInRepo}
          {skill.folderName !== skill.pathInRepo
            ? ` → ${skill.folderName}`
            : ''}
        </p>
        {skill.folderCollision ? (
          <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
            Folder name {skill.folderName} collides with another pack in this
            repo. Uncheck one before installing.
          </p>
        ) : null}
      </label>
    </li>
  );
}

export function SkillsPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [tab, setTab] = useState<Tab>('catalog');
  const [catalogs, setCatalogs] = useState<SkillCatalogs>({
    global: [],
    user: [],
  });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [preview, setPreview] = useState<SkillPreview | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmFolder, setConfirmFolder] = useState<string | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const loadCatalogs = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setCatalogs(await fetchSkillCatalogs());
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Could not load skills';
      setLoadError(message);
      toastError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setTab('catalog');
    setQuery('');
    setConfirmFolder(null);
    setExpanded(new Set());
    void loadCatalogs();
  }, [open, loadCatalogs]);

  const globalNames = useMemo(
    () => new Set(catalogs.global.map((skill) => skill.name)),
    [catalogs.global],
  );

  const filteredGlobal = catalogs.global.filter((skill) =>
    matchesQuery(skill, query),
  );
  const filteredUser = catalogs.user.filter((skill) =>
    matchesQuery(skill, query),
  );
  const catalogCount = catalogs.global.length + catalogs.user.length;
  const selectedCount = preview
    ? preview.skills.filter((skill) => selectedPaths.has(skill.pathInRepo))
        .length
    : 0;
  const selectedCollisions = useMemo(() => {
    if (!preview) return [];
    const counts = new Map<string, number>();
    for (const skill of preview.skills) {
      if (!selectedPaths.has(skill.pathInRepo)) continue;
      counts.set(skill.folderName, (counts.get(skill.folderName) ?? 0) + 1);
    }
    return [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([name]) => name);
  }, [preview, selectedPaths]);

  function resetPreview() {
    setPreview(null);
    setSelectedPaths(new Set());
  }

  async function handleCheck() {
    const url = repoUrl.trim();
    if (!url) return;
    setChecking(true);
    resetPreview();
    try {
      const next = await previewSkills(url);
      setPreview(next);
      setSelectedPaths(new Set(next.skills.map((skill) => skill.pathInRepo)));
    } catch (error) {
      toastError(
        error instanceof Error ? error.message : 'Could not check repository',
      );
    } finally {
      setChecking(false);
    }
  }

  async function handleSave() {
    if (!preview || selectedCount === 0) return;
    setSaving(true);
    try {
      const next = await installSkills({
        repoUrl,
        commit: preview.commit,
        skills: preview.skills
          .filter((skill) => selectedPaths.has(skill.pathInRepo))
          .map((skill) => ({
            pathInRepo: skill.pathInRepo,
            folderName: skill.folderName,
          })),
      });
      setCatalogs(next);
      resetPreview();
      setRepoUrl('');
      setTab('catalog');
    } catch (error) {
      toastError(
        error instanceof Error ? error.message : 'Could not save skills',
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(folder: string) {
    setDeletingFolder(folder);
    try {
      setCatalogs(await deleteUserSkill(folder));
      setConfirmFolder(null);
    } catch (error) {
      toastError(
        error instanceof Error ? error.message : 'Could not remove skill',
      );
    } finally {
      setDeletingFolder(null);
    }
  }

  function toggleSelected(pathInRepo: string) {
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (next.has(pathInRepo)) next.delete(pathInRepo);
      else next.add(pathInRepo);
      return next;
    });
  }

  function toggleExpand(key: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const tabs: ReadonlyArray<{ id: Tab; label: string }> = [
    {
      id: 'catalog',
      label: loading ? 'Catalog' : `Catalog · ${catalogCount}`,
    },
    { id: 'import', label: 'Import' },
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          resetPreview();
          setRepoUrl('');
          setQuery('');
          setConfirmFolder(null);
          setExpanded(new Set());
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="gap-3 sm:max-w-lg" showCloseButton>
        <DialogHeader className="pr-8">
          <DialogTitle className="flex items-center gap-2">
            Skills
            {!loading && !loadError ? (
              <Badge variant="secondary" className="font-normal">
                {catalogCount}
              </Badge>
            ) : null}
          </DialogTitle>
          <DialogDescription>
            Packs the agent can load on a run. Built-in stay with the product;
            imports live in your agent home.
          </DialogDescription>
        </DialogHeader>

        <div
          role="tablist"
          aria-label="Skill sections"
          className="flex items-center gap-1 rounded-lg bg-muted/60 p-1 text-xs"
        >
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              onClick={() => setTab(entry.id)}
              className={cn(
                'flex-1 rounded-md px-2 py-1.5 font-medium transition-colors',
                tab === entry.id
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {tab === 'catalog' ? (
          loading ? (
            <CatalogSkeleton />
          ) : loadError ? (
            <div className="rounded-md border border-border px-3 py-4 text-sm">
              <p className="text-foreground">Could not load the catalog.</p>
              <p className="mt-1 text-muted-foreground">{loadError}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => void loadCatalogs()}
              >
                Retry
              </Button>
            </div>
          ) : (
            <div className="flex min-h-0 flex-col gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search skills"
                  aria-label="Search skills"
                  className="h-8 w-full rounded-lg border border-input bg-transparent py-1 pr-2.5 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
              </div>
              <ScrollArea className="h-[min(52vh,22rem)] pr-2">
                <div className="pb-2">
                  {filteredGlobal.length === 0 && filteredUser.length === 0 ? (
                    <p className="px-0.5 py-6 text-sm text-muted-foreground">
                      {query
                        ? 'No skills match that search.'
                        : 'No skills in the catalog yet.'}
                    </p>
                  ) : (
                    <div className="divide-y divide-border">
                      {filteredGlobal.length > 0 ? (
                        <section>
                          <h3 className="pt-1 pb-1 text-xs text-muted-foreground">
                            Built-in · {filteredGlobal.length}
                          </h3>
                          <ul>
                            {filteredGlobal.map((skill) => (
                              <CatalogRow
                                key={`global:${skill.folder}`}
                                skill={skill}
                                overrides={false}
                                expanded={expanded.has(`global:${skill.folder}`)}
                                onToggleExpand={() =>
                                  toggleExpand(`global:${skill.folder}`)
                                }
                              />
                            ))}
                          </ul>
                        </section>
                      ) : null}
                      <section>
                        <h3 className="pt-3 pb-1 text-xs text-muted-foreground">
                          Yours · {filteredUser.length}
                        </h3>
                        {filteredUser.length === 0 ? (
                          <p className="pb-3 text-sm text-muted-foreground">
                            {query
                              ? 'No imported skills match that search.'
                              : 'Nothing imported yet — switch to Import to add a GitHub pack.'}
                          </p>
                        ) : (
                          <ul>
                            {filteredUser.map((skill) => (
                              <CatalogRow
                                key={`user:${skill.folder}`}
                                skill={skill}
                                overrides={globalNames.has(skill.name)}
                                expanded={expanded.has(`user:${skill.folder}`)}
                                onToggleExpand={() =>
                                  toggleExpand(`user:${skill.folder}`)
                                }
                                action={
                                  confirmFolder === skill.folder ? (
                                    <div className="flex items-center gap-1">
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        className="h-7 px-2 text-muted-foreground"
                                        onClick={() => setConfirmFolder(null)}
                                      >
                                        Keep
                                      </Button>
                                      <Button
                                        type="button"
                                        variant="destructive"
                                        size="sm"
                                        className="h-7 px-2"
                                        disabled={
                                          deletingFolder === skill.folder
                                        }
                                        onClick={() =>
                                          void handleDelete(skill.folder)
                                        }
                                      >
                                        {deletingFolder === skill.folder
                                          ? 'Removing…'
                                          : 'Remove'}
                                      </Button>
                                    </div>
                                  ) : (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 px-2 text-muted-foreground"
                                      onClick={() =>
                                        setConfirmFolder(skill.folder)
                                      }
                                    >
                                      Remove
                                    </Button>
                                  )
                                }
                              />
                            ))}
                          </ul>
                        )}
                      </section>
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>
          )
        ) : (
          <div className="flex min-h-0 flex-col gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="skill-repo-url">GitHub repository</Label>
              <div className="flex gap-2">
                <input
                  id="skill-repo-url"
                  value={repoUrl}
                  onChange={(event) => {
                    setRepoUrl(event.target.value);
                    if (preview) resetPreview();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void handleCheck();
                    }
                  }}
                  placeholder="https://github.com/owner/repo"
                  className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0"
                  disabled={checking || !repoUrl.trim()}
                  onClick={() => void handleCheck()}
                >
                  {checking ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : null}
                  Check
                </Button>
              </div>
            </div>

            {checking ? (
              <CatalogSkeleton />
            ) : preview ? (
              <div className="min-h-0">
                <p className="mb-1 text-xs text-muted-foreground">
                  {preview.owner}/{preview.repo} @ {shortSha(preview.commit)}
                  {preview.skills.length === 0
                    ? ' — no SKILL.md files'
                    : ` · ${selectedCount} of ${preview.skills.length} selected`}
                </p>
                {preview.skills.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                    This repository has no skill packs the agent can import.
                  </p>
                ) : (
                  <ScrollArea className="h-[min(40vh,16rem)] pr-2">
                    <ul className="divide-y divide-border">
                      {preview.skills.map((skill) => (
                        <ImportRow
                          key={skill.pathInRepo}
                          skill={skill}
                          checked={selectedPaths.has(skill.pathInRepo)}
                          onToggle={() => toggleSelected(skill.pathInRepo)}
                        />
                      ))}
                    </ul>
                  </ScrollArea>
                )}
              </div>
            ) : (
              <p className="rounded-md border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
                Paste a public GitHub URL, then Check to preview skill packs.
                Nothing is written until you install.{' '}
                <span className="font-mono text-xs">
                  e.g. github.com/owner/repo
                </span>
              </p>
            )}
          </div>
        )}

        <DialogFooter className="mt-1">
          {tab === 'import' ? (
            <div className="flex w-full flex-col items-stretch gap-2">
              {selectedCollisions.length > 0 ? (
                <p className="text-xs text-amber-600 dark:text-amber-500">
                  Two packs flatten to {selectedCollisions.join(', ')}. Uncheck
                  one before installing.
                </p>
              ) : null}
              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenChange(false)}
                >
                  Close
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={
                    !preview ||
                    selectedCount === 0 ||
                    saving ||
                    selectedCollisions.length > 0
                  }
                  onClick={() => void handleSave()}
                >
                  {saving ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : null}
                  {selectedCount > 0 ? `Install ${selectedCount}` : 'Install'}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
