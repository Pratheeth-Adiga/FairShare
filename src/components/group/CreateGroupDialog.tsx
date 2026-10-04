import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useGroupsStore } from '@/stores/groups.store';
import { useIdentityStore } from '@/stores/identity.store';
import { SUPPORTED_CURRENCIES } from '@/lib/utils/currency';
import { MAX_LENGTHS } from '@/lib/utils/validation';

interface CreateGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateGroupDialog({ open, onOpenChange }: CreateGroupDialogProps) {
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('INR');
  // a double tap (or Enter then click) used to create two groups
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const identity = useIdentityStore(s => s.identity);
  const createGroup = useGroupsStore(s => s.createGroup);
  const navigate = useNavigate();

  const handleCreate = async () => {
    if (isCreating || !name.trim() || !identity) return;
    setIsCreating(true);
    setCreateError('');
    try {
      const groupId = await createGroup(name.trim(), currency, identity.peerId, identity.displayName, identity.publicKey);
      onOpenChange(false);
      setName('');
      navigate(`/group/${groupId}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Could not create the group.');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogHeader>
        <DialogTitle>Create Group</DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="group-name">Group name</Label>
          <Input
            id="group-name"
            placeholder="e.g., Apartment, Trip to Paris"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            maxLength={MAX_LENGTHS.groupName}
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="currency">Currency</Label>
          <Select
            id="currency"
            value={currency}
            onChange={e => setCurrency(e.target.value)}
          >
            {SUPPORTED_CURRENCIES.map(c => (
              <option key={c.code} value={c.code}>
                {c.symbol} {c.name} ({c.code})
              </option>
            ))}
          </Select>
        </div>
        {createError && <p className="text-sm text-destructive" role="alert">{createError}</p>}
        <Button className="w-full" onClick={handleCreate} disabled={isCreating || !name.trim()}>
          Create Group
        </Button>
      </div>
    </Dialog>
  );
}
