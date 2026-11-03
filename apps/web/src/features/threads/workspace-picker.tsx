'use client';

import { useState } from 'react';
import { Check, FolderOpen, FolderPlus } from 'lucide-react';
import {
  folderNameFromRoot,
  sameWorkspaceRoot,
  setWorkspaceRoot,
  useAgentSpace,
} from '@/features/agent/store/space-store';
import { pickWorkspaceFolder } from '@/features/agent/api/thread-client';
import { toastError } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export function WorkspacePicker({
  disabled = false,
  className,
}: {
  disabled?: boolean;
  className?: string;
}) {
  const { workspaceRoot, recentFolders } = useAgentSpace();
  const [picking, setPicking] = useState(false);
  const label = workspaceRoot
    ? folderNameFromRoot(workspaceRoot)
    : 'No workspace';

  const pick = async () => {
    if (picking) return;
    setPicking(true);
    try {
      const selected = await pickWorkspaceFolder(workspaceRoot);
      if (!selected) return;
      setWorkspaceRoot(selected);
    } catch (error) {
      toastError(
        error instanceof Error
          ? error.message
          : 'Could not open the folder picker.',
        'Folder picker failed',
      );
    } finally {
      setPicking(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || picking}
          title={workspaceRoot ?? 'No workspace — Home chat'}
          className={cn(
            'type-ui h-7 max-w-[11rem] justify-start gap-1.5 truncate px-2 text-xs font-medium text-muted-foreground hover:text-foreground',
            className,
          )}
        >
          <FolderOpen className="size-3.5 shrink-0 opacity-80" strokeWidth={1.75} />
          <span className="truncate">{picking ? 'Choose…' : label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Workspace</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => setWorkspaceRoot(null)}>
          {!workspaceRoot ? <Check className="size-4" /> : null}
          No workspace
        </DropdownMenuItem>
        {recentFolders.length > 0 ? <DropdownMenuSeparator /> : null}
        {recentFolders.map((root) => (
          <DropdownMenuItem
            key={root}
            title={root}
            onSelect={() => setWorkspaceRoot(root)}
          >
            {sameWorkspaceRoot(root, workspaceRoot) ? (
              <Check className="size-4" />
            ) : (
              <FolderOpen className="size-4" />
            )}
            <span className="truncate">{folderNameFromRoot(root)}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void pick()}>
          <FolderPlus className="size-4" />
          Open folder
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
