'use client';

import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import {
  deleteUserSkill,
  fetchSkillCatalogs,
  installSkills,
  previewSkills,
  type FoundSkill,
  type SkillCatalogs,
  type SkillPreview,
} from '@/features/agent/api/skills-client';
import { toastError } from '@/hooks/use-toast';
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

function SkillRow({
  name,
  description,
  onRemove,
  badge,
}: {
  name: string;
  description: string;
  onRemove?: () => void;
  badge?: string;
}) {
  return (
    <div className="flex items-start gap-2 border-b border-border/40 py-1.5 last:border-0">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {name}
          {badge ? (
            <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
              {badge}
            </span>
          ) : null}
        </p>
        <p className="line-clamp-1 text-xs text-muted-foreground">
          {description}
        </p>
      </div>
      {onRemove ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="shrink-0"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          <X className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

export function SkillsPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [catalogs, setCatalogs] = useState<SkillCatalogs>({
    global: [],
    user: [],
  });
  const [repoUrl, setRepoUrl] = useState('');
  const [preview, setPreview] = useState<SkillPreview | null>(null);
  const [selected, setSelected] = useState<FoundSkill[]>([]);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    void fetchSkillCatalogs()
      .then(setCatalogs)
      .catch((error: unknown) => {
        toastError(
          error instanceof Error ? error.message : 'Could not load skills',
        );
      });
  }, [open]);

  function resetPreview() {
    setPreview(null);
    setSelected([]);
  }

  async function handleCheck() {
    const url = repoUrl.trim();
    if (!url) return;
    setChecking(true);
    resetPreview();
    try {
      const next = await previewSkills(url);
      setPreview(next);
      setSelected(next.skills);
    } catch (error) {
      toastError(
        error instanceof Error ? error.message : 'Could not check repository',
      );
    } finally {
      setChecking(false);
    }
  }

  async function handleSave() {
    if (!preview || selected.length === 0) return;
    setSaving(true);
    try {
      const next = await installSkills({
        repoUrl,
        commit: preview.commit,
        skills: selected.map((skill) => ({
          pathInRepo: skill.pathInRepo,
          folderName: skill.folderName,
        })),
      });
      setCatalogs(next);
      resetPreview();
      setRepoUrl('');
    } catch (error) {
      toastError(
        error instanceof Error ? error.message : 'Could not save skills',
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(folder: string) {
    try {
      setCatalogs(await deleteUserSkill(folder));
    } catch (error) {
      toastError(
        error instanceof Error ? error.message : 'Could not remove skill',
      );
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          resetPreview();
          setRepoUrl('');
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton>
        <DialogHeader>
          <DialogTitle>Skills</DialogTitle>
          <DialogDescription>
            Built-in skills are always in the catalog. Import adds packs to your
            user home. Nothing is saved until you click Save.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-48 overflow-y-auto">
          {catalogs.global.map((skill) => (
            <SkillRow
              key={`global:${skill.folder}`}
              name={skill.name}
              description={skill.description}
              badge="built-in"
            />
          ))}
          {catalogs.user.map((skill) => (
            <SkillRow
              key={`user:${skill.folder}`}
              name={skill.name}
              description={skill.description}
              onRemove={() => void handleDelete(skill.folder)}
            />
          ))}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="skill-repo-url">GitHub repository</Label>
          <input
            id="skill-repo-url"
            value={repoUrl}
            onChange={(event) => {
              setRepoUrl(event.target.value);
              if (preview) resetPreview();
            }}
            placeholder="https://github.com/owner/repo"
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={checking || !repoUrl.trim()}
            onClick={() => void handleCheck()}
          >
            {checking ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Check
          </Button>
        </div>

        {preview ? (
          <div>
            <p className="mb-1 text-xs text-muted-foreground">
              {selected.length === 0
                ? `No skills selected from ${preview.owner}/${preview.repo}`
                : `${selected.length} skill${selected.length === 1 ? '' : 's'} from ${preview.owner}/${preview.repo}`}
            </p>
            {preview.skills.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No SKILL.md files found in this repository.
              </p>
            ) : (
              <div className="max-h-40 overflow-y-auto">
                {selected.map((skill) => (
                  <SkillRow
                    key={skill.pathInRepo}
                    name={skill.name}
                    description={skill.description}
                    onRemove={() =>
                      setSelected((current) =>
                        current.filter(
                          (item) => item.pathInRepo !== skill.pathInRepo,
                        ),
                      )
                    }
                  />
                ))}
              </div>
            )}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!preview || selected.length === 0 || saving}
            onClick={() => void handleSave()}
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
