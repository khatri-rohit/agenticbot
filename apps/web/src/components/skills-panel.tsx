'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Loader2, Search, Trash2 } from 'lucide-react';
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
    <div className="flex flex-col gap-2.5" aria-busy="true" aria-live="polite">
      <div className="h-9 w-full animate-pulse rounded-lg bg-muted" />
      <div className="h-14 w-full animate-pulse rounded-lg bg-muted" />
      <div className="h-14 w-full animate-pulse rounded-lg bg-muted" />
      <div className="h-14 w-4/5 animate-pulse rounded-lg bg-muted" />
    </div>
  );
}

function OriginBadge({ source }: { source: SkillCatalogItem['source'] }) {
  return source === 'global' ? (
    <Badge variant="secondary" className="shrink-0 font-normal">
      Built-in
    </Badge>
  ) : (
    <Badge variant="outline" className="shrink-0 font-normal">
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
    <li className="flex items-start gap-2 rounded-lg px-2 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="truncate text-sm font-medium text-foreground">
            {skill.name}
          </p>
          <OriginBadge source={skill.source} />
        </div>
        <button
          type="button"
          onClick={onToggleExpand}
          className="mt-1 block w-full text-left"
          aria-expanded={expanded}
        >
          <p
            className={cn(
              'type-ui leading-5 text-muted-foreground',
              expanded ? 'whitespace-pre-wrap' : 'line-clamp-2',
            )}
          >
            {skill.description}
          </p>
        </button>
        {overrides ? (
          <p className="mt-1 text-xs text-[var(--warning-fg)]">
            Overrides the built-in skill with this name
          </p>
        ) : null}
      </div>
      {action ? (
        <div className="flex shrink-0 items-start gap-0.5 pt-0.5">{action}</div>
      ) : null}
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
    <li className="flex items-start gap-3 rounded-lg px-2 py-2.5">
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
        <p className="type-ui mt-0.5 line-clamp-2 leading-5 text-muted-foreground">
          {skill.description}
        </p>
        <p className="mt-1 truncate font-mono text-xs text-muted-foreground/80">
          {skill.pathInRepo}
          {skill.folderName !== skill.pathInRepo
            ? ` → ${skill.folderName}`
            : ''}
        </p>
        {skill.folderCollision ? (
          <p className="mt-1 text-xs text-[var(--warning-fg)]">
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
      <DialogContent
        className="grid max-h-[min(90dvh,40rem)] w-full grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-xl"
        showCloseButton
      >
        <DialogHeader className="shrink-0 gap-1.5 border-b border-border/60 px-4 py-3.5 pr-12">
          <DialogTitle>Skills</DialogTitle>
          <DialogDescription>
            Catalog of procedure packs. Import from GitHub into your home skills
            folder. Type / in the composer to attach a pack to this send. The
            agent always sees this catalog and loads a body with{' '}
            <span className="font-mono text-xs">load_skill</span> when intent
            fits.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-3 overflow-hidden px-4 pt-3 pb-3 [grid-row:2]">
          <div
            role="tablist"
            aria-label="Skill sections"
            className="flex shrink-0 items-center gap-1 rounded-lg bg-muted/60 p-1 text-xs"
          >
            <button
              type="button"
              role="tab"
              id="skills-tab-catalog"
              aria-controls="skills-panel-catalog"
              aria-selected={tab === 'catalog'}
              onClick={() => setTab('catalog')}
              className={cn(
                'flex-1 rounded-md px-2 py-1.5 font-medium transition-colors',
                tab === 'catalog'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              Catalog
              {!loading && !loadError ? (
                <span className="ml-1 text-muted-foreground">
                  · {catalogCount}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              role="tab"
              id="skills-tab-import"
              aria-controls="skills-panel-import"
              aria-selected={tab === 'import'}
              onClick={() => setTab('import')}
              className={cn(
                'flex-1 rounded-md px-2 py-1.5 font-medium transition-colors',
                tab === 'import'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              Import
            </button>
          </div>

          {tab === 'catalog' ? (
            <div
              id="skills-panel-catalog"
              role="tabpanel"
              aria-labelledby="skills-tab-catalog"
              className="flex min-h-0 flex-1 flex-col gap-2"
            >
              {loading ? (
                <CatalogSkeleton />
              ) : loadError ? (
                <div className="rounded-lg border border-border px-3 py-4 text-sm">
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
                <>
                  <div className="relative shrink-0">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search by name or description"
                      aria-label="Search skills"
                      className="h-9 w-full rounded-lg border border-input bg-transparent py-1 pr-2.5 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    />
                  </div>
                  <ScrollArea className="h-[min(48vh,22rem)] pr-2">
                    <div className="pb-1">
                      {filteredGlobal.length === 0 &&
                      filteredUser.length === 0 ? (
                        <div className="px-0.5 py-8 text-center">
                          <p className="text-sm text-muted-foreground">
                            {query
                              ? 'No skills match that search.'
                              : 'No skills in the catalog yet.'}
                          </p>
                          {!query ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="mt-3"
                              onClick={() => setTab('import')}
                            >
                              Import from GitHub
                            </Button>
                          ) : null}
                        </div>
                      ) : (
                        <div className="space-y-1">
                          {filteredGlobal.length > 0 ? (
                            <section>
                              <h3 className="sticky top-0 z-10 bg-popover px-2 pt-1 pb-1 text-xs font-medium text-muted-foreground">
                                Built-in · {filteredGlobal.length}
                              </h3>
                              <ul className="space-y-0.5">
                                {filteredGlobal.map((skill) => (
                                    <CatalogRow
                                      key={`global:${skill.folder}`}
                                      skill={skill}
                                      overrides={false}
                                      expanded={expanded.has(
                                        `global:${skill.folder}`,
                                      )}
                                      onToggleExpand={() =>
                                        toggleExpand(`global:${skill.folder}`)
                                      }
                                    />
                                  ))}
                              </ul>
                            </section>
                          ) : null}
                          <section>
                            <h3 className="sticky top-0 z-10 bg-popover px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                              Yours · {filteredUser.length}
                            </h3>
                            {filteredUser.length === 0 ? (
                              <div className="px-2 pb-3">
                                <p className="text-sm text-muted-foreground">
                                  {query
                                    ? 'No imported skills match that search.'
                                    : 'Nothing imported yet.'}
                                </p>
                                {!query ? (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="mt-2"
                                    onClick={() => setTab('import')}
                                  >
                                    Import from GitHub
                                  </Button>
                                ) : null}
                              </div>
                            ) : (
                              <ul className="space-y-0.5">
                                {filteredUser.map((skill) => {
                                  const confirming =
                                    confirmFolder === skill.folder;
                                  return (
                                    <CatalogRow
                                      key={`user:${skill.folder}`}
                                      skill={skill}
                                      overrides={globalNames.has(skill.name)}
                                      expanded={expanded.has(
                                        `user:${skill.folder}`,
                                      )}
                                      onToggleExpand={() =>
                                        toggleExpand(`user:${skill.folder}`)
                                      }
                                      action={
                                        confirming ? (
                                          <div className="flex flex-col items-stretch gap-1 sm:flex-row">
                                            <Button
                                              type="button"
                                              variant="ghost"
                                              size="sm"
                                              className="h-7 px-2 text-muted-foreground"
                                              onClick={() =>
                                                setConfirmFolder(null)
                                              }
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
                                            size="icon-sm"
                                            className="size-7 text-muted-foreground hover:text-destructive"
                                            aria-label={`Remove ${skill.name}`}
                                            onClick={() =>
                                              setConfirmFolder(skill.folder)
                                            }
                                          >
                                            <Trash2 className="size-3.5" />
                                          </Button>
                                        )
                                      }
                                    />
                                  );
                                })}
                              </ul>
                            )}
                          </section>
                        </div>
                      )}
                    </div>
                  </ScrollArea>
                  <p className="type-caption shrink-0 leading-4 text-muted-foreground">
                    Type / in the composer to attach a pack to this send. The
                    agent can also load any catalog skill with load_skill.
                  </p>
                </>
              )}
            </div>
          ) : (
            <div
              id="skills-panel-import"
              role="tabpanel"
              aria-labelledby="skills-tab-import"
              className="flex min-h-0 flex-1 flex-col gap-3"
            >
              <div className="shrink-0 space-y-1.5">
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
                    className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 shrink-0"
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
                <div className="flex min-h-0 flex-1 flex-col">
                  <p className="mb-1.5 shrink-0 text-xs text-muted-foreground">
                    {preview.owner}/{preview.repo} @ {shortSha(preview.commit)}
                    {preview.skills.length === 0
                      ? ' — no SKILL.md files'
                      : ` · ${selectedCount} of ${preview.skills.length} selected`}
                  </p>
                  {preview.skills.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
                      This repository has no skill packs the agent can import.
                    </p>
                  ) : (
                    <ScrollArea className="h-[min(40vh,18rem)] pr-2">
                      <ul className="space-y-0.5 pb-1">
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
                <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border px-4 py-8">
                  <p className="max-w-sm text-center text-sm text-muted-foreground">
                    Paste a public GitHub URL, then Check to preview skill
                    packs. Nothing is written until you install.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {tab === 'import' ? (
          <DialogFooter className="mt-0 shrink-0">
            <div className="flex w-full flex-col items-stretch gap-2">
              {selectedCollisions.length > 0 ? (
                <p className="text-xs text-[var(--warning-fg)]">
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
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
