'use client';

import { useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { createUserSkill, type SkillCatalogs } from '@/api/skills-client';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

const DEFAULT_NAME = 'my-custom-skill';

/** Real starter content, not a placeholder: users edit it in place. */
function skillTemplate(name: string): string {
  return `---
name: ${name}
description: Use when the user asks to … (one sentence: when the agent should load this skill).
---

# ${name}

## When to use
- The situations where this skill applies.
- What the user usually says when they need it.

## Steps
1. First thing the agent should do.
2. Next step, with the commands or files to prefer.
3. How to check the result before reporting back.

## Example
User: "…"
Agent: what it does and what it reports.

## Notes
- Constraints, gotchas, things to never do.
`;
}

/** Folder-safe slug; mirrors the API's folder-name rule. */
function toSkillName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 80);
}

/** Keep the frontmatter and title in step with the name field. */
function renameInContent(content: string, from: string, to: string): string {
  return content
    .replace(/^name:.*$/m, `name: ${to}`)
    .replace(new RegExp(`^# ${escapeRegExp(from)}$`, 'm'), `# ${to}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * "Create your own" skill: a name plus a SKILL.md editor seeded with a
 * working example. Saves to the home skills folder via the API.
 */
export function SkillCreateForm({
  onCreated,
  onCancel,
}: {
  onCreated: (catalogs: SkillCatalogs) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(DEFAULT_NAME);
  const [content, setContent] = useState(() => skillTemplate(DEFAULT_NAME));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const lineCount = content.split('\n').length;

  async function handleCreate() {
    setSaving(true);
    setError(null);
    try {
      onCreated(await createUserSkill({ name, content }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="shrink-0 space-y-1.5">
        <Label htmlFor="skill-create-name">Skill name</Label>
        <input
          id="skill-create-name"
          value={name}
          onChange={(event) => {
            const next = toSkillName(event.target.value);
            setContent((current) => renameInContent(current, name, next));
            setName(next);
            setError(null);
          }}
          spellCheck={false}
          className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <p className="type-caption text-subtle-foreground">
          Saved as{' '}
          <span className="font-mono">skills/{name || '…'}/SKILL.md</span>. The
          description tells the agent when to load it.
        </p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5">
        <Label htmlFor="skill-create-body">SKILL.md</Label>
        {/* One scroll box for gutter and text: the textarea grows to its
            content, so line numbers stay aligned without scroll syncing. */}
        <div
          className="min-h-0 flex-1 overflow-auto rounded-lg border border-input bg-[var(--terminal-bg)] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
          onClick={() => editorRef.current?.focus()}
        >
          <div className="flex min-h-full font-mono text-[0.8125rem] leading-[1.6]">
            <ol
              aria-hidden
              className="m-0 shrink-0 list-none select-none py-2.5 pr-3 pl-3 text-right text-subtle-foreground tabular-nums"
            >
              {Array.from({ length: lineCount }, (_, i) => (
                <li key={i}>{i + 1}</li>
              ))}
            </ol>
            <textarea
              id="skill-create-body"
              ref={editorRef}
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Tab' && !event.shiftKey) {
                  event.preventDefault();
                  const el = event.currentTarget;
                  const { selectionStart: start, selectionEnd: end } = el;
                  const next = `${content.slice(0, start)}  ${content.slice(end)}`;
                  setContent(next);
                  requestAnimationFrame(() => {
                    el.selectionStart = el.selectionEnd = start + 2;
                  });
                }
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void handleCreate();
                }
              }}
              rows={lineCount}
              spellCheck={false}
              wrap="off"
              className="min-w-0 flex-1 resize-none overflow-hidden bg-transparent py-2.5 pr-3 text-[var(--terminal-fg)] outline-none"
            />
          </div>
        </div>
      </div>

      {error ? (
        <p role="alert" className="type-caption shrink-0 text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex shrink-0 items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setContent(skillTemplate(name || DEFAULT_NAME));
            setError(null);
          }}
        >
          Reset to example
        </Button>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={saving || !name || !content.trim()}
            onClick={() => void handleCreate()}
            title="Create skill (Ctrl+Enter)"
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Create skill
          </Button>
        </div>
      </div>
    </div>
  );
}
