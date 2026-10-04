import { useState } from 'react';
import { Trash2, Link2 } from 'lucide-react';
import { Dialog, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useGroupsStore } from '@/stores/groups.store';
import { useConnectionsStore } from '@/stores/connections.store';
import { useIdentityStore } from '@/stores/identity.store';
import { isPlaceholderMember } from '@/lib/crypto/identity';
import type { MemberProfile, PeerId } from '@/types';

interface ManageMembersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupId: string;
  members: Record<string, MemberProfile>;
}

export function ManageMembersDialog({ open, onOpenChange, groupId, members }: ManageMembersDialogProps) {
  const removeMember = useGroupsStore(s => s.removeMember);
  const reassignMember = useGroupsStore(s => s.reassignMember);
  const identity = useIdentityStore(s => s.identity);
  const activePeers = useConnectionsStore(s => s.activePeers);
  const introductions = useConnectionsStore(s => s.introductions);
  const requestIntroduction = useConnectionsStore(s => s.requestIntroduction);
  const [selected, setSelected] = useState<Set<PeerId>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [reassignTarget, setReassignTarget] = useState<PeerId | ''>('');
  const [reassignFrom, setReassignFrom] = useState<PeerId | null>(null);
  const [bridgeChoice, setBridgeChoice] = useState<Record<string, string>>({});

  const memberEntries = Object.entries(members);
  const canRemoveMembers = memberEntries.length > 1;

  // Group members we're directly connected to for this group, vs. ones we could
  // reach only by asking a connected peer to relay the signaling handshake.
  const connectedForGroup = activePeers.filter(p => p.state === 'connected' && p.groups.includes(groupId));
  const connectedIds = new Set(connectedForGroup.map(p => p.peerId));
  const bridgeCandidates = connectedForGroup.filter(p => p.peerId !== identity?.peerId);

  const handleIntroduce = (targetPeerId: string) => {
    const bridgePeerId = bridgeChoice[targetPeerId] || bridgeCandidates[0]?.peerId;
    if (!bridgePeerId || !identity) return;
    requestIntroduction(groupId, bridgePeerId, targetPeerId, identity.displayName);
  };

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        // can't select the last remaining member, removeMember throws on it
        if (next.size >= memberEntries.length - 1) return prev;
        next.add(id);
      }
      return next;
    });
  };

  const requestSingleRemove = (id: string) => {
    setSelected(new Set([id]));
    // only placeholder members can use the reassignment flow
    const member = members[id];
    if (member && isPlaceholderMember(member) && id !== identity?.peerId) {
      setReassignFrom(id);
      setReassignTarget('');
    } else {
      setReassignFrom(null);
    }
    setConfirming(true);
  };

  const handleReassignAndRemove = () => {
    if (reassignFrom && reassignTarget) {
      reassignMember(groupId, reassignFrom, reassignTarget);
    }
    // Remove other selected members (not the one being reassigned)
    selected.forEach(id => {
      if (id !== reassignFrom) {
        removeMember(groupId, id);
      }
    });
    setSelected(new Set());
    setConfirming(false);
    setReassignFrom(null);
  };

  const handleConfirmedRemove = () => {
    selected.forEach(id => removeMember(groupId, id));
    setSelected(new Set());
    setConfirming(false);
    setReassignFrom(null);
  };

  const handleClose = () => {
    setSelected(new Set());
    setConfirming(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) handleClose(); }}>
      <DialogHeader>
        <DialogTitle>Manage Members</DialogTitle>
        <DialogDescription>Check members to remove several at once, or use the trash icon to remove just one.</DialogDescription>
      </DialogHeader>

      <div className="space-y-0.5 max-h-80 overflow-y-auto">
        {memberEntries.map(([id, m]) => {
          const isSelf = id === identity?.peerId;
          const isConnected = connectedIds.has(id);
          const canIntroduce = !isSelf && !isConnected && bridgeCandidates.length > 0;
          const introStatus = introductions[id];

          return (
            <div key={id} className="border-b last:border-0">
              <div className="flex items-center gap-2 py-1.5">
                <input
                  type="checkbox"
                  className="rounded border-input"
                  checked={selected.has(id)}
                  disabled={!canRemoveMembers || (!selected.has(id) && selected.size >= memberEntries.length - 1)}
                  onChange={() => toggle(id)}
                  aria-label={`Select ${m.displayName}`}
                />
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  {m.displayName.charAt(0).toUpperCase() || '?'}
                </span>
                <span className="flex-1 truncate text-sm font-medium">{m.displayName}</span>
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${isSelf || isConnected ? 'bg-green-500' : 'bg-muted-foreground/40'}`}
                  title={isSelf || isConnected ? 'Online' : 'Offline'}
                  aria-label={isSelf || isConnected ? 'Online' : 'Offline'}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={() => requestSingleRemove(id)}
                  disabled={!canRemoveMembers}
                  title={canRemoveMembers ? 'Remove member' : 'A group must have at least one member'}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              {canIntroduce && (
                <div className="flex items-center gap-2 pb-2 pl-8 pr-1">
                  {bridgeCandidates.length > 1 && (
                    <select
                      className="h-7 flex-1 rounded border border-input bg-background text-xs"
                      value={bridgeChoice[id] || bridgeCandidates[0].peerId}
                      onChange={(e) => setBridgeChoice(prev => ({ ...prev, [id]: e.target.value }))}
                    >
                      {bridgeCandidates.map(b => (
                        <option key={b.peerId} value={b.peerId}>via {members[b.peerId]?.displayName || b.peerId.slice(0, 8)}</option>
                      ))}
                    </select>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={introStatus === 'pending'}
                    onClick={() => handleIntroduce(id)}
                  >
                    <Link2 className="h-3.5 w-3.5 mr-1" />
                    {introStatus === 'pending' ? 'Connecting…' : introStatus === 'failed' ? 'Retry connect' : 'Connect via existing peer'}
                  </Button>
                  {/* the button label alone changes silently */}
                  <span className="sr-only" role="status">
                    {introStatus === 'pending' ? `Connecting to ${m.displayName}` : introStatus === 'failed' ? `${m.displayName} is not reachable` : ''}
                  </span>
                  {introStatus === 'failed' && (
                    <span className="text-xs text-destructive" aria-hidden="true">Not reachable</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {memberEntries.length === 0 && (
          <p className="py-4 text-center text-sm text-muted-foreground">No members yet</p>
        )}
      </div>

      <div className="pt-3 border-t">
        {!confirming ? (
          <Button
            variant="destructive"
            className="w-full"
            disabled={selected.size === 0 || !canRemoveMembers}
            onClick={() => setConfirming(true)}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Remove Selected ({selected.size})
          </Button>
        ) : (
          <div className="space-y-2">
            <p className="text-center text-sm font-medium text-destructive">
              Remove {selected.size} member{selected.size !== 1 ? 's' : ''}? Their past expenses and outstanding balances will remain recorded.
            </p>
            {/* bulk removal has no per-member reassignment picker - warn
                instead of silently skipping the option single-removal offers. */}
            {!reassignFrom && selected.size > 1 && Array.from(selected).some(id => isPlaceholderMember(members[id]) && id !== identity?.peerId) && (
              <p className="text-center text-xs text-muted-foreground">
                One or more of these are unclaimed members. To reassign their expenses instead of just
                removing them, remove them one at a time with the trash icon.
              </p>
            )}
            {reassignFrom && (
              <div className="space-y-1 border rounded-md p-2">
                <p className="text-xs text-muted-foreground">Reassign their expenses/settlements to:</p>
                <select
                  className="w-full h-8 rounded border border-input bg-background text-sm px-2"
                  value={reassignTarget}
                  onChange={e => setReassignTarget(e.target.value)}
                >
                  <option value="">Don't reassign (just remove)</option>
                  {memberEntries
                    // never reassign to a member being removed
                    .filter(([id]) => id !== reassignFrom && !selected.has(id))
                    .map(([id, m]) => (
                      <option key={id} value={id}>{m.displayName}</option>
                    ))}
                </select>
              </div>
            )}
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => { setConfirming(false); setReassignFrom(null); }}>
                Cancel
              </Button>
              <Button variant="destructive" className="flex-1" onClick={reassignFrom && reassignTarget ? handleReassignAndRemove : handleConfirmedRemove}>
                {reassignFrom && reassignTarget ? 'Reassign & Remove' : 'Confirm'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
