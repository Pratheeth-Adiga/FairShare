import { useEffect, useRef, useState } from 'react';
import type { Html5Qrcode } from 'html5-qrcode';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Camera, Clipboard } from 'lucide-react';

interface QRScannerProps {
  onScan: (data: string) => void;
  onError?: (error: string) => void;
  className?: string;
}

export function QRScanner({ onScan, onError, className }: QRScannerProps) {
  const [useCamera, setUseCamera] = useState(true);
  const [pasteValue, setPasteValue] = useState('');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const containerIdRef = useRef(`qr-scanner-${Math.random().toString(36).slice(2, 8)}`);

  useEffect(() => {
    if (!useCamera) return;

    let cancelled = false;
    let scanner: Html5Qrcode | null = null;
    let startPromise: Promise<void> | null = null;

    async function startScanner() {
      try {
        // Ensure the DOM element exists before initializing Html5Qrcode
        const element = document.getElementById(containerIdRef.current);
        if (!element || cancelled) return;

        const { Html5Qrcode } = await import('html5-qrcode');
        // The dialog may have closed while the dynamic import was resolving.
        // Html5Qrcode looks up this id itself, so confirm this exact mounted
        // element still owns it immediately before construction.
        if (cancelled || !containerRef.current?.isConnected || document.getElementById(containerIdRef.current) !== containerRef.current) return;

        scanner = new Html5Qrcode(containerIdRef.current);
        const activeScanner = scanner;
        scannerRef.current = activeScanner;

        // Try rear camera first, fall back to any available camera
        const startConfig = { fps: 10, qrbox: { width: 250, height: 250 } };
        const doStart = async () => {
          try {
            await activeScanner.start({ facingMode: 'environment' }, startConfig,
              (decodedText: string) => {
                if (cancelled) return;
                if (scannerRef.current === activeScanner) scannerRef.current = null;
                activeScanner.stop().catch(() => {});
                onScan(decodedText);
              }, () => {}
            );
          } catch {
            if (cancelled) return;
            // Rear camera failed: try user-facing camera
            await activeScanner.start({ facingMode: 'user' }, startConfig,
              (decodedText: string) => {
                if (cancelled) return;
                if (scannerRef.current === activeScanner) scannerRef.current = null;
                activeScanner.stop().catch(() => {});
                onScan(decodedText);
              }, () => {}
            );
          }
        };
        // keep this effect's start promise local - a later camera toggle starts
        // another scanner, whose promise must not replace the one this cleanup waits for
        startPromise = doStart();
        await startPromise;

        // stop a camera that finishes starting after unmount
        if (cancelled) {
          if (scannerRef.current === scanner) scannerRef.current = null;
          try { await scanner.stop(); } catch { /* ignore */ }
          try { scanner.clear(); } catch { /* ignore */ }
        }
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error && err.message.includes('Permission')
          ? 'Camera permission denied. Use "Paste code instead" below.'
          : `Camera unavailable: ${err instanceof Error ? err.message : String(err)}`;
        setCameraError(msg);
        setUseCamera(false);
        onError?.(msg);
      }
    }

    startScanner();

    return () => {
      cancelled = true;
      const ownedScanner = scanner;
      if (scannerRef.current === ownedScanner) scannerRef.current = null;
      if (ownedScanner) {
        // Html5Qrcode rejects stop() before its async start completes. Try it
        // now for an active scanner; the cancelled branch after startPromise
        // above performs the second cleanup attempt for a pending one.
        try { void ownedScanner.stop().catch(() => {}); } catch { /* ignore */ }
        try { ownedScanner.clear(); } catch { /* ignore */ }
      }
    };
  }, [useCamera]);

  const handlePaste = () => {
    const trimmed = pasteValue.trim();
    if (trimmed) {
      onScan(trimmed);
    }
  };

  const handleClipboardPaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        onScan(text.trim());
      }
    } catch {
      onError?.('Could not read clipboard');
    }
  };

  return (
    <div className={className}>
      {useCamera && !cameraError && (
        <div className="space-y-2">
          <div
            id={containerIdRef.current}
            ref={containerRef}
            className="w-full aspect-square max-w-[300px] mx-auto rounded-lg overflow-hidden bg-black"
          />
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={() => setUseCamera(false)}
          >
            Paste code instead
          </Button>
        </div>
      )}

      {(!useCamera || cameraError) && (
        <div className="space-y-3">
          {cameraError && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground text-center">{cameraError}</p>
              <Button variant="outline" size="sm" className="w-full" onClick={() => {
                setCameraError(null);
                setUseCamera(true);
              }}>
                <Camera className="h-4 w-4 mr-2" />
                Retry Camera
              </Button>
            </div>
          )}
          <div className="flex gap-2">
            <Input
              placeholder="Paste connection code here..."
              value={pasteValue}
              onChange={e => setPasteValue(e.target.value)}
              className="text-xs font-mono"
            />
            <Button variant="outline" size="icon" onClick={handleClipboardPaste} title="Paste from clipboard">
              <Clipboard className="h-4 w-4" />
            </Button>
          </div>
          <Button className="w-full" onClick={handlePaste} disabled={!pasteValue.trim()}>
            Connect
          </Button>
          {!cameraError && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => setUseCamera(true)}
            >
              <Camera className="h-4 w-4 mr-2" />
              Use camera instead
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
