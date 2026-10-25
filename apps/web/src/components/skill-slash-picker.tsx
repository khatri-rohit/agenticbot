'use client';

import { useEffect, useMemo, useRef } from 'react';
import type { SkillCatalogItem } from '@/features/agent/api/skills-client';
import { cn } from '@/lib/utils';

export function skillQueryAtCaret(
  value: string,
  caret: number,
): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const match = /(?:^|\s)(\/[a-zA-Z0-9_-]*)$/.exec(before);
  if (!match) return null;
  const token = match[1];
  return { start: before.length - token.length, query: token.slice(1) };
}

export function filterSkillCatalog(
  skills: SkillCatalogItem[],
  query: string,
): SkillCatalogItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return skills;
  return skills.filter(
    (skill) =>
      skill.name.toLowerCase().includes(needle) ||
      skill.description.toLowerCase().includes(needle),
  );
}

export function SkillSlashPicker({
  skills,
  query,
  activeIndex,
  onActiveIndexChange,
  selectedNames,
  onPick,
}: {
  skills: SkillCatalogItem[];
  query: string;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  selectedNames: Set<string>;
  onPick: (skill: SkillCatalogItem) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const filtered = useMemo(
    () => filterSkillCatalog(skills, query),
    [skills, query],
  );

  useEffect(() => {
    const node = listRef.current?.querySelector('[data-active="true"]');
    node?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, filtered.length]);

  return (
    <div
      className="mb-1.5 w-full overflow-hidden rounded-xl bg-popover ring-1 ring-border/50"
      role="listbox"
      aria-label="Load a skill"
    >
      <div ref={listRef} className="max-h-[16.25rem] overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            No matching skills
          </p>
        ) : (
          filtered.map((skill, index) => {
            const active = index === activeIndex;
            const already = selectedNames.has(skill.name);
            return (
              <button
                key={`${skill.source}:${skill.folder}`}
                type="button"
                role="option"
                aria-selected={active}
                data-active={active ? 'true' : 'false'}
                disabled={already}
                className={cn(
                  'flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm',
                  active && 'bg-accent/80',
                  already && 'opacity-50',
                )}
                onMouseEnter={() => onActiveIndexChange(index)}
                onClick={() => {
                  if (!already) onPick(skill);
                }}
              >
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {skill.name}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {already
                      ? 'Added'
                      : skill.source === 'user'
                        ? 'Yours'
                        : 'Built-in'}
                  </span>
                </span>
                <span className="line-clamp-2 text-[12px] leading-4 text-muted-foreground">
                  {skill.description}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
