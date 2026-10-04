import { useState } from 'react';
import { Dialog, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useGroupsStore } from '@/stores/groups.store';
import { MAX_LENGTHS } from '@/lib/utils/validation';
import { v4 as uuidv4 } from 'uuid';

interface AddMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupId: string;
}

export function AddMemberDialog({ open, onOpenChange, groupId }: AddMemberDialogProps) {
  const [name, setName] = useState('');
  const [duplicateWarning, setDuplicateWarning] = useState(false);
  const addMember = useGroupsStore(s => s.addMember);
  const doc = useGroupsStore(s => s.getDocument(groupId));

  const handleAdd = () => {
    if (!name.trim()) return;
    // check for duplicate display names
    if (doc && !duplicateWarning) {
      const exists = Object.values(doc.members).some(
        m => m.displayName.toLowerCase() === name.trim().toLowerCase()
      );
      if (exists) {
        setDuplicateWarning(true);
        return;
      }
    }
    // legacy 16-hex-char peer id (dashes stripped) — isPlaceholderMember relies on this format
    const peerId = `peer-${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    addMember(groupId, {
      peerId,
      displayName: name.trim(),
      avatar: '',
      joinedAt: new Date().toISOString(),
      isManualPlaceholder: true,
    });
    setName('');
    setDuplicateWarning(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogHeader>
        <DialogTitle>Add Member</DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="member-name">Member name</Label>
          <Input
            id="member-name"
            placeholder="Enter name"
            value={name}
            onChange={e => { setName(e.target.value); setDuplicateWarning(false); }}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            maxLength={MAX_LENGTHS.displayName}
            autoFocus
          />
          {duplicateWarning && (
            <p className="text-xs text-amber-600">
              A member with this name already exists. Click "Add" again to add anyway.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            In a full P2P setup, members join via QR code or invite link.
            For now, you can add them manually.
          </p>
        </div>
        <Button className="w-full" onClick={handleAdd} disabled={!name.trim()}>
          Add Member
        </Button>
      </div>
    </Dialog>
  );
}
