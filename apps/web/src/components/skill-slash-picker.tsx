'use client';

import { useEffect, useMemo, useRef } from 'react';
import { BookMarked, User } from 'lucide-react';
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

const SKILL_TOKEN_RE = /(?:^|\s)\/([a-zA-Z0-9_-]+)/g;

/** All `/name` tokens in the text, deduped case-insensitively, in order. */
export function skillTokensInText(value: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of value.matchAll(SKILL_TOKEN_RE)) {
    const key = match[1].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(match[1]);
  }
  return out;
}

/** Replace the `/query` span at the caret with `/name `; caret lands after the space. */
export function completeSkillToken(
  value: string,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const found = skillQueryAtCaret(value, caret);
  if (!found) return { text: value, caret };
  const token = `/${name} `;
  return {
    text: `${value.slice(0, found.start)}${token}${value.slice(caret)}`,
    caret: found.start + token.length,
  };
}

/**
 * Text flow rendered behind the composer textarea so `/name` tokens show in
 * accent color while the textarea's own text is transparent. Must keep the
 * textarea's exact box classes or highlights drift; trailing "\n" keeps the
 * last line's height in sync.
 */
export function SkillHighlightMirror({
  value,
  knownNames,
  mirrorRef,
}: {
  value: string;
  knownNames: Set<string>;
  mirrorRef: React.RefObject<HTMLDivElement | null>;
}) {
  const parts = useMemo(() => {
    const out: { text: string; known: boolean }[] = [];
    let last = 0;
    for (const match of value.matchAll(SKILL_TOKEN_RE)) {
      const start = match.index ?? 0;
      if (start > last) {
        out.push({ text: value.slice(last, start), known: false });
      }
      out.push({
        text: match[0],
        known: knownNames.has(match[1].toLowerCase()),
      });
      last = start + match[0].length;
    }
    if (last < value.length) {
      out.push({ text: value.slice(last), known: false });
    }
    return out;
  }, [value, knownNames]);

  return (
    <div
      ref={mirrorRef}
      aria-hidden
      className="type-composer pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-1 py-2 text-foreground"
    >
      {parts.map((part, index) =>
        part.known ? (
          // Color only — any weight/size change here alters glyph widths and
          // desyncs the mirror from the textarea's caret positions.
          <span key={index} className="text-[var(--link)]">
            {part.text}
          </span>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
      {'\n'}
    </div>
  );
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
      className="absolute inset-x-0 bottom-full z-40 mb-2 overflow-hidden rounded-xl bg-popover shadow-[0_8px_32px_oklch(0_0_0/0.35)] ring-1 ring-border/50"
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
            const already = selectedNames.has(skill.name.toLowerCase());
            const needle = query.trim().toLowerCase();
            const hit = needle
              ? skill.name.toLowerCase().indexOf(needle)
              : -1;
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
                  {skill.source === 'user' ? (
                    <User className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <BookMarked className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {hit >= 0 ? (
                      <>
                        {skill.name.slice(0, hit)}
                        <span className="text-primary">
                          {skill.name.slice(hit, hit + needle.length)}
                        </span>
                        {skill.name.slice(hit + needle.length)}
                      </>
                    ) : (
                      skill.name
                    )}
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
