import { useEffect, useState } from 'react';
import { getP2PLogs, subscribeP2PLogs, P2P_DEBUG_ENABLED } from '@/lib/p2p/debug-log';

// Temporary diagnostic panel: shows live P2P connection logs on-screen so we
// can see what's happening on a real device without USB debugging access.
// Renders nothing in normal/release builds (see debug-log.ts).
export function P2PDebugPanel() {
  const [lines, setLines] = useState<string[]>(() => getP2PLogs());

  useEffect(() => subscribeP2PLogs(setLines), []);

  if (!P2P_DEBUG_ENABLED || lines.length === 0) return null;

  return (
    <div className="mt-2 max-h-48 overflow-y-auto rounded border bg-muted p-2 text-left">
      <p className="text-[10px] font-semibold text-muted-foreground mb-1">Debug log (temporary)</p>
      <pre className="text-[10px] font-mono whitespace-pre-wrap break-all leading-tight">
        {lines.join('\n')}
      </pre>
    </div>
  );
}
