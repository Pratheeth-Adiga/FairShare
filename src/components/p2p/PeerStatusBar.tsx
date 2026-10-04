import { useEffect } from 'react';
import { Wifi, WifiOff } from 'lucide-react';
import { Badge, badgeVariants } from '@/components/ui/badge';
import { useConnectionsStore } from '@/stores/connections.store';

interface PeerStatusBarProps {
  groupId?: string;
  onReconnect?: () => void;
}

export function PeerStatusBar({ groupId, onReconnect }: PeerStatusBarProps) {
  const activePeers = useConnectionsStore(s => s.activePeers);
  const knownPeers = useConnectionsStore(s => s.knownPeers);
  const { refreshPeers, loadKnownPeers } = useConnectionsStore.getState();

  useEffect(() => {
    refreshPeers();
    const interval = setInterval(refreshPeers, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (groupId) loadKnownPeers(groupId);
  }, [groupId]);

  // Scope to peers actually associated with this group so a device connected to
  // other groups' peers doesn't inflate this group's count.
  const groupPeers = groupId
    ? activePeers.filter(p => p.groups.includes(groupId))
    : activePeers;
  const connectedPeers = groupPeers.filter(p => p.state === 'connected');
  const connectedCount = connectedPeers.length;
  const connectedIds = new Set(connectedPeers.map(p => p.peerId));
  const offlineKnown = knownPeers.filter(p => !connectedIds.has(p.peerId));

  if (connectedCount === 0) {
    const hasKnown = offlineKnown.length > 0;

    if (hasKnown && onReconnect) {
      const names = offlineKnown.map(p => p.displayName || 'Unknown').join(', ');
      return (
        <button
          type="button"
          onClick={onReconnect}
          className={badgeVariants({ variant: 'secondary' }) + ' gap-1 cursor-pointer hover:bg-secondary/80'}
          title={`Offline: ${names} (tap to reconnect)`}
        >
          <WifiOff className="h-3 w-3" />
          {offlineKnown.length === 1 ? `${names} offline` : `${offlineKnown.length} known, offline`}
        </button>
      );
    }

    return (
      <Badge variant="secondary" className="text-xs gap-1">
        <WifiOff className="h-3 w-3" />
        No peers
      </Badge>
    );
  }

  const offlineNames = offlineKnown.map(p => p.displayName || 'Unknown').join(', ');
  const offlineLabel = offlineKnown.length <= 2
    ? offlineNames
    : `${offlineKnown.slice(0, 2).map(p => p.displayName || 'Unknown').join(', ')} +${offlineKnown.length - 2} more`;

  return (
    <Badge
      variant="secondary"
      className="text-xs gap-1 bg-green-100 text-green-700"
      title={offlineKnown.length > 0 ? `Offline: ${offlineNames}` : undefined}
    >
      <Wifi className="h-3 w-3" />
      {connectedCount} peer{connectedCount !== 1 ? 's' : ''}
      {offlineKnown.length > 0 ? ` · ${offlineLabel} offline` : ''}
    </Badge>
  );
}
