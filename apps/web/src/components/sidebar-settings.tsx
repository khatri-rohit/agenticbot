'use client';

import { useEffect, useState } from 'react';
import { Palette, Settings, UserRound } from 'lucide-react';
import { useTheme } from '@/components/theme-provider';
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
import {
  USER_PERSONA_MAX_CHARS,
  getUserPersona,
  setUserPersona,
} from '@/lib/user-persona';
import { cn } from '@/lib/utils';

export function SidebarSettings({
  collapsed = false,
}: {
  collapsed?: boolean;
}) {
  const { themeId, setThemeId, presets } = useTheme();
  const [profileOpen, setProfileOpen] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (profileOpen) setDraft(getUserPersona());
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
              Frozen profile facts sent with every chat so the agent can adapt
              to you. This is not long-term memory yet; edit here to update.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label htmlFor="about-user">About you</Label>
            <Textarea
              id="about-user"
              value={draft}
              maxLength={USER_PERSONA_MAX_CHARS}
              rows={10}
              autoFocus
              placeholder={
                'Name: Rohit\nRole: senior engineer / tech lead\nPrefs: concise BLUF answers, show trade-offs\nStack: TypeScript, Nx, NestJS, Next.js'
              }
              className="min-h-40 resize-y"
              onChange={(event) => setDraft(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Saved in this browser. {draft.length}/{USER_PERSONA_MAX_CHARS}
            </p>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              onClick={() => {
                setUserPersona(draft);
                setProfileOpen(false);
              }}
            >
              Save profile
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
