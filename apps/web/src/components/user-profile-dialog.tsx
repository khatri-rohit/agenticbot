'use client';

import { useEffect, useState } from 'react';
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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  USER_PERSONA_MAX_CHARS,
  getUserPersona,
  setUserPersona,
} from '@/lib/user-persona';

export function UserProfileDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (open) setDraft(getUserPersona());
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>User profile</DialogTitle>
          <DialogDescription>
            Frozen profile facts sent with every chat so the agent can adapt to
            you. This is not long-term memory yet; edit here to update.
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
              onOpenChange(false);
            }}
          >
            Save profile
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
