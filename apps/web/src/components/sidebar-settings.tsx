'use client';

import { Palette, Settings } from 'lucide-react';
import { useTheme } from '@/components/theme-provider';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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

  const menuButton = (
    <Button
      type="button"
      variant="ghost"
      aria-label={collapsed ? 'Settings' : undefined}
      className={cn(
        'type-ui font-normal text-muted-foreground hover:bg-accent/55 hover:text-foreground',
        collapsed
          ? 'mx-auto size-9 w-full max-w-9 justify-center rounded-md px-0'
          : 'h-8 w-full justify-start gap-2 rounded-md px-2.5',
      )}
    >
      <Settings className="size-4 shrink-0 opacity-80" strokeWidth={2} />
      {!collapsed ? <span>Settings</span> : null}
    </Button>
  );

  return (
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
        sideOffset={collapsed ? 8 : 4}
        className="w-56"
      >
        <DropdownMenuLabel>Preferences</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gap-2">
            <Palette className="size-4 opacity-80" />
            Theme
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-[min(70vh,24rem)] w-64 overflow-y-auto">
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
  );
}
