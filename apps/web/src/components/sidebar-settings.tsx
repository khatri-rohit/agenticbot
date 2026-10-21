'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Bell,
  Palette,
  RefreshCw,
  RotateCcw,
  Settings,
  Trash2,
  UserRound,
  Volume2,
} from 'lucide-react';
import { DEFAULT_MEMORY_CAPS, type MemoryOp } from '@org/agent-models';
import { useTheme } from '@/components/theme-provider';
import {
  fetchMemory,
  revertMemoryOp,
  saveUserMemory,
} from '@/features/agent/api/agent-client';
import { toastError, toastSuccess } from '@/hooks/use-toast';
import { formatRelativeTime } from '@/lib/format-relative-time';
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
  DropdownMenuCheckboxItem,
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { ThemeId } from '@/lib/theme-presets';
import { cn } from '@/lib/utils';
import {
  enableBrowserNotifications,
  previewAlertSound,
  readNotifyPref,
  readSoundPref,
  writeNotifyPref,
  writeSoundPref,
} from '@/features/agent/lib/run-alerts';

/** agent-client throws plain Error objects; normalize once for catch blocks. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SidebarSettings({
  collapsed = false,
}: {
  collapsed?: boolean;
}) {
  const { themeId, setThemeId, presets } = useTheme();
  const [profileOpen, setProfileOpen] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [notifyOn, setNotifyOn] = useState(false);

  useEffect(() => {
    setSoundOn(readSoundPref());
    const notify = readNotifyPref();
    if (
      notify &&
      typeof Notification !== 'undefined' &&
      Notification.permission !== 'granted'
    ) {
      writeNotifyPref(false);
      setNotifyOn(false);
      return;
    }
    setNotifyOn(notify);
  }, []);

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
          className="w-64"
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
                Appearance
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={themeId}
                onValueChange={(value) => setThemeId(value as ThemeId)}
              >
                {presets.map((preset) => (
                  <DropdownMenuRadioItem
                    key={preset.id}
                    value={preset.id}
                    className="items-start gap-2.5 py-2"
                  >
                    <span
                      className="mt-0.5 flex size-4 shrink-0 overflow-hidden rounded-[3px] ring-1 ring-border/70"
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
                      <span className="flex items-center gap-1.5 leading-none">
                        {preset.label}
                        <span className="rounded px-1 py-px text-[9px] font-medium tracking-wide text-muted-foreground uppercase ring-1 ring-border/50">
                          {preset.scheme}
                        </span>
                      </span>
                      <span className="text-[11px] leading-snug text-muted-foreground">
                        {preset.description}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={soundOn}
            className="items-start gap-2 py-2 whitespace-normal"
            onCheckedChange={(checked) => {
              const on = checked === true;
              writeSoundPref(on);
              setSoundOn(on);
              if (on) previewAlertSound();
            }}
          >
            <Volume2 className="mt-0.5 size-4 shrink-0 opacity-80" />
            <span className="leading-snug">
              Play sound when agent needs you or finishes
            </span>
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={notifyOn}
            className="items-start gap-2 py-2 whitespace-normal"
            onCheckedChange={(checked) => {
              if (checked !== true) {
                writeNotifyPref(false);
                setNotifyOn(false);
                return;
              }
              void enableBrowserNotifications().then((granted) => {
                setNotifyOn(granted);
                if (!granted) {
                  toastError(
                    'Enable notifications for this site in the browser settings.',
                    'Notifications blocked',
                  );
                }
              });
            }}
          >
            <Bell className="mt-0.5 size-4 shrink-0 opacity-80" />
            <span className="leading-snug">
              Browser notifications when tab is in background
            </span>
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
    </>
  );
}

type Tab = 'profile' | 'notes' | 'history';

function ProfileDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [tab, setTab] = useState<Tab>('profile');
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [loadedUser, setLoadedUser] = useState('');
  const [notes, setNotes] = useState('');
  const [ops, setOps] = useState<MemoryOp[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmRevertId, setConfirmRevertId] = useState<string | null>(null);
  const [revertingId, setRevertingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadAll = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    try {
      const memory = await fetchMemory();
      setDraft(memory.files.user);
      setLoadedUser(memory.files.user);
      setNotes(memory.files.notes);
      setOps(
        memory.ops
          .filter((op) => op.status === 'applied')
          .slice(-12)
          .reverse(),
      );
    } catch (error) {
      toastError(describeError(error), 'Could not load profile');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadAll();
    setConfirmDiscard(false);
    setTab('profile');
  }, [open, loadAll]);

  // USER.md is the contract: free-form text the agent reads every run.
  // Editing is a plain textarea — no structure imposed, nothing lost.
  const isDirty = draft !== loadedUser;
  const cap = DEFAULT_MEMORY_CAPS.userChars;
  const overBy = draft.length - cap;
  const overCap = overBy > 0;
  const canSave = !saving && isDirty && !overCap;

  const handleOpenChange = (next: boolean) => {
    if (!next && isDirty && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    setConfirmDiscard(false);
    onOpenChange(next);
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await saveUserMemory(draft);
      setLoadedUser(draft);
      toastSuccess('Profile saved. It applies on the next run.');
      void loadAll(true);
    } catch (error) {
      toastError(describeError(error), 'Could not save profile');
    } finally {
      setSaving(false);
    }
  };

  const handleRevert = async (opId: string) => {
    setRevertingId(opId);
    try {
      await revertMemoryOp(opId);
      toastSuccess('Reverted. It applies on the next run.');
      await loadAll(true);
    } catch (error) {
      toastError(describeError(error), 'Revert failed');
    } finally {
      setRevertingId(null);
    }
  };

  const tabs: ReadonlyArray<{ id: Tab; label: string }> = [
    { id: 'profile', label: 'Profile' },
    { id: 'notes', label: 'Agent notes' },
    { id: 'history', label: 'History' },
  ];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>User profile</DialogTitle>
          <DialogDescription>
            Durable <code className="text-xs">USER.md</code> facts included in
            every run. The agent can also write{' '}
            <code className="text-xs">MEMORY.md</code> notes; revert a change
            from History if it got it wrong.
          </DialogDescription>
        </DialogHeader>

        <div
          role="tablist"
          aria-label="Memory sections"
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

        {loading ? (
          <ProfileSkeleton />
        ) : tab === 'profile' ? (
          <ProfileTab
            draft={draft}
            onDraft={setDraft}
            cap={cap}
            overBy={overBy}
            overCap={overCap}
            isDirty={isDirty}
          />
        ) : tab === 'notes' ? (
          <NotesTab notes={notes} />
        ) : (
          <HistoryTab
            ops={ops}
            revertingId={revertingId}
            confirmRevertId={confirmRevertId}
            onRevert={handleRevert}
            onConfirmRevert={setConfirmRevertId}
            onRefresh={() => void loadAll(true)}
            refreshing={refreshing}
          />
        )}

        <DialogFooter className="mt-2">
          {confirmDiscard ? (
            <div className="flex w-full items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                Discard unsaved changes?
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmDiscard(false)}
                >
                  Keep editing
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    setConfirmDiscard(false);
                    onOpenChange(false);
                  }}
                >
                  Discard
                </Button>
              </div>
            </div>
          ) : tab === 'profile' ? (
            <div className="flex w-full items-center justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setDraft('')}
                disabled={draft === '' || saving}
                className="text-muted-foreground"
              >
                <Trash2 className="size-3.5" />
                Clear
              </Button>
              <div className="flex gap-2">
                <DialogClose asChild>
                  <Button type="button" variant="outline" disabled={saving}>
                    Close
                  </Button>
                </DialogClose>
                <Button
                  type="button"
                  disabled={!canSave}
                  onClick={() => void handleSave()}
                >
                  {saving ? 'Saving…' : isDirty ? 'Save profile' : 'Saved'}
                </Button>
              </div>
            </div>
          ) : (
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Close
              </Button>
            </DialogClose>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProfileTab({
  draft,
  onDraft,
  cap,
  overBy,
  overCap,
  isDirty,
}: {
  draft: string;
  onDraft: (value: string) => void;
  cap: number;
  overBy: number;
  overCap: boolean;
  isDirty: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      {draft.trim() === '' ? (
        <p className="rounded-md border border-dashed border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Nothing saved yet — the agent will not invent a biography. Write what
          you want it to remember across threads.
        </p>
      ) : null}

      <Label htmlFor="about-user" className="text-[11px] text-muted-foreground">
        About you
      </Label>
      <Textarea
        id="about-user"
        value={draft}
        rows={10}
        placeholder={
          'Name: Alex\nRole: staff engineer\nTimezone: IST (UTC+5:30)\nPrefs: concise BLUF answers, show trade-offs\nStack: TypeScript, Nx, Next.js'
        }
        onChange={(event) => onDraft(event.target.value)}
        className="min-h-40 resize-y"
      />

      <CharBudgetBar used={draft.length} cap={cap} />

      {overCap ? (
        <p className="text-[11px] text-destructive">
          Over cap by {overBy} chars — consolidate first.
        </p>
      ) : isDirty ? (
        <p className="text-[11px] text-muted-foreground">
          Unsaved changes — Save to persist to{' '}
          <code className="text-[11px]">USER.md</code>.
        </p>
      ) : null}
    </div>
  );
}

function CharBudgetBar({ used, cap }: { used: number; cap: number }) {
  const ratio = Math.min(used / Math.max(cap, 1), 1);
  const barColor =
    used > cap ? 'bg-destructive' : ratio > 0.8 ? 'bg-amber-500' : 'bg-primary';
  return (
    <div className="flex flex-col gap-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full transition-all', barColor)}
          style={{ width: `${ratio * 100}%` }}
          aria-hidden
        />
      </div>
      <p className="text-[11px] text-muted-foreground" aria-live="polite">
        {used}/{cap} chars · ~{Math.ceil(used / 4)} tokens
      </p>
    </div>
  );
}

function NotesTab({ notes }: { notes: string }) {
  const trimmed = notes.trim();
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        Agent-managed <code className="text-xs">MEMORY.md</code> notes —
        environment, conventions, lessons learned. Saved when you say
        “remember…” in a chat.
      </p>
      {trimmed ? (
        <ScrollArea className="h-56 rounded-md border border-border bg-muted/30">
          <pre className="whitespace-pre-wrap px-3 py-2 text-xs leading-relaxed text-foreground">
            {trimmed}
          </pre>
        </ScrollArea>
      ) : (
        <p className="rounded-md border border-dashed border-border bg-muted/40 px-3 py-3 text-xs text-muted-foreground">
          No agent notes yet.
        </p>
      )}
    </div>
  );
}

function HistoryTab({
  ops,
  revertingId,
  confirmRevertId,
  onRevert,
  onConfirmRevert,
  onRefresh,
  refreshing,
}: {
  ops: MemoryOp[];
  revertingId: string | null;
  confirmRevertId: string | null;
  onRevert: (opId: string) => void;
  onConfirmRevert: (opId: string | null) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">Recent memory writes</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCw className={cn('size-3', refreshing && 'animate-spin')} />
          Refresh
        </Button>
      </div>
      {ops.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-muted/40 px-3 py-3 text-xs text-muted-foreground">
          No memory writes yet. Say “remember…” in a chat to create one.
        </p>
      ) : (
        <ScrollArea className="h-64 rounded-md border border-border">
          <ul role="list" className="flex flex-col divide-y divide-border">
            {ops.map((op) => {
              const target = typeof op.target === 'string' ? op.target : 'file';
              const isReverting = revertingId === op.id;
              return (
                <li key={op.id} className="flex flex-col gap-1.5 px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'inline-flex h-4 items-center rounded px-1.5 text-[10px] font-medium uppercase tracking-wide',
                        op.action === 'add' && 'bg-primary/10 text-primary',
                        op.action === 'patch' &&
                          'bg-amber-500/15 text-amber-600',
                        op.action === 'remove' &&
                          'bg-destructive/10 text-destructive',
                      )}
                    >
                      {op.action}
                    </span>
                    <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      {target}
                    </span>
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {formatRelativeTime(op.ts)}
                    </span>
                  </div>
                  <p className="text-xs text-foreground">{op.reason}</p>
                  {op.content ? (
                    <p className="line-clamp-2 whitespace-pre-wrap text-[11px] text-muted-foreground">
                      {op.content}
                    </p>
                  ) : null}
                  <div className="flex justify-end">
                    {confirmRevertId === op.id ? (
                      <div
                        className="flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1"
                        role="status"
                      >
                        <span className="text-[11px] text-muted-foreground">
                          Revert?
                        </span>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          className="h-6 px-2 text-[11px]"
                          disabled={isReverting}
                          onClick={() => onRevert(op.id)}
                        >
                          {isReverting ? 'Reverting…' : 'Yes, revert'}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[11px]"
                          onClick={() => onConfirmRevert(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px] text-muted-foreground"
                        disabled={isReverting}
                        aria-label={`Revert: ${op.reason}`}
                        onClick={() => onConfirmRevert(op.id)}
                      >
                        <RotateCcw className="size-3" />
                        {isReverting ? 'Reverting…' : 'Revert'}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-live="polite">
      <div className="h-3 w-24 animate-pulse rounded bg-muted" />
      <div className="h-40 w-full animate-pulse rounded-md bg-muted" />
      <div className="h-1.5 w-full animate-pulse rounded-full bg-muted" />
      <div className="h-3 w-48 animate-pulse rounded bg-muted" />
    </div>
  );
}
