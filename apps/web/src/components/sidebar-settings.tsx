'use client';

import { useEffect, useState } from 'react';
import { Palette, Settings, UserRound } from 'lucide-react';
import { DEFAULT_MEMORY_CAPS, type MemoryOp } from '@org/agent-models';
import { useTheme } from '@/components/theme-provider';
import {
  fetchMemory,
  revertMemoryOp,
  saveUserMemory,
} from '@/features/agent/api/agent-client';
import { toastError } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { ThemeId } from '@/lib/theme-presets';
import { cn } from '@/lib/utils';

export function SidebarSettings({
  collapsed = false,
}: {
  collapsed?: boolean;
}) {
  const { themeId, setThemeId, presets } = useTheme();
  const [profileOpen, setProfileOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [notes, setNotes] = useState('');
  const [ops, setOps] = useState<MemoryOp[]>([]);
  const [cap, setCap] = useState(DEFAULT_MEMORY_CAPS.userChars);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!profileOpen) return;
    let cancelled = false;
    void fetchMemory()
      .then((memory) => {
        if (cancelled) return;
        setDraft(memory.files.user);
        setNotes(memory.files.notes);
        setOps(memory.ops.filter((op) => op.status === 'applied').slice(-8).reverse());
        setCap(memory.caps.userChars);
      })
      .catch((error) => {
        if (!cancelled) {
          toastError(
            error instanceof Error ? error.message : String(error),
            'Could not load profile',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [profileOpen]);

  const menuButton = (
    <Button
      type="button"
      variant="ghost"
      aria-label={collapsed ? 'Settings' : undefined}
      className={cn(
        'type-ui font-normal text-muted-foreground hover:bg-accent/55 hover:text-foreground',
        collapsed
          ? 'size-9 shrink-0 justify-center rounded-md px-0'
          : 'h-8 w-full justify-start gap-2 rounded-md px-2.5',
      )}
    >
      <Settings className="size-4 shrink-0 opacity-80" strokeWidth={2} />
      {!collapsed ? <span>Settings</span> : null}
    </Button>
  );

  return (
    <>
      <DropdownMenu>
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>{menuButton}</DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="right">Settings</TooltipContent>
          </Tooltip>
        ) : (
          <DropdownMenuTrigger asChild>{menuButton}</DropdownMenuTrigger>
        )}
        <DropdownMenuContent
          align="start"
          side={collapsed ? 'right' : 'top'}
          sideOffset={collapsed ? 8 : 6}
          collisionPadding={12}
          className="w-56"
        >
          <DropdownMenuLabel>Preferences</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="gap-2"
            onSelect={() => {
              setTimeout(() => setProfileOpen(true), 0);
            }}
          >
            <UserRound className="size-4 opacity-80" />
            Profile
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2">
              <Palette className="size-4 opacity-80" />
              Theme
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              sideOffset={8}
              className="max-h-[min(70vh,24rem)] w-64 overflow-y-auto"
            >
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Color scheme
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={themeId}
                onValueChange={(value) => setThemeId(value as ThemeId)}
              >
                {presets.map((preset) => (
                  <DropdownMenuRadioItem
                    key={preset.id}
                    value={preset.id}
                    className="items-start gap-2 py-2"
                  >
                    <span
                      className="mt-0.5 flex size-4 shrink-0 overflow-hidden rounded-sm ring-1 ring-border/60"
                      aria-hidden
                    >
                      <span
                        className="h-full w-1/2"
                        style={{ background: preset.swatch.bg }}
                      />
                      <span
                        className="h-full w-1/2"
                        style={{ background: preset.swatch.accent }}
                      />
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="leading-none">{preset.label}</span>
                      <span className="text-[11px] leading-snug text-muted-foreground">
                        {preset.description}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={profileOpen} onOpenChange={setProfileOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>User profile</DialogTitle>
            <DialogDescription>
              Durable USER.md facts included in every run. The agent can also
              write MEMORY.md notes; revert a change below if it got it wrong.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label htmlFor="about-user">About you</Label>
            <Textarea
              id="about-user"
              value={draft}
              maxLength={cap}
              rows={10}
              autoFocus
              placeholder={
                'Name: Rohit\nRole: senior engineer / tech lead\nPrefs: concise BLUF answers, show trade-offs\nStack: TypeScript, Nx, NestJS, Next.js'
              }
              className="min-h-40 resize-y"
              onChange={(event) => setDraft(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Saved on the host. {draft.length}/{cap}
            </p>
          </div>

          {notes.trim() ? (
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium text-muted-foreground">
                Agent notes
              </p>
              <p className="max-h-24 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
                {notes}
              </p>
            </div>
          ) : null}

          {ops.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                Recent memory writes
              </p>
              {ops.map((op) => (
                <div
                  key={op.id}
                  className="flex items-start justify-between gap-2 text-xs"
                >
                  <span className="min-w-0 truncate text-muted-foreground">
                    {op.action} {typeof op.target === 'string' ? op.target : 'file'}
                    {op.reason ? ` — ${op.reason}` : ''}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 shrink-0 px-2"
                    onClick={() => {
                      void revertMemoryOp(op.id)
                        .then(() => fetchMemory())
                        .then((memory) => {
                          setDraft(memory.files.user);
                          setNotes(memory.files.notes);
                          setOps(
                            memory.ops
                              .filter((item) => item.status === 'applied')
                              .slice(-8)
                              .reverse(),
                          );
                        })
                        .catch((error) => {
                          toastError(
                            error instanceof Error
                              ? error.message
                              : String(error),
                            'Revert failed',
                          );
                        });
                    }}
                  >
                    Revert
                  </Button>
                </div>
              ))}
            </div>
          ) : null}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              disabled={saving}
              onClick={() => {
                setSaving(true);
                void saveUserMemory(draft)
                  .then(() => setProfileOpen(false))
                  .catch((error) => {
                    toastError(
                      error instanceof Error ? error.message : String(error),
                      'Could not save profile',
                    );
                  })
                  .finally(() => setSaving(false));
              }}
            >
              {saving ? 'Saving…' : 'Save profile'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
