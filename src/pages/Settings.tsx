import { Capacitor } from '@capacitor/core';
import { Header } from '@/components/layout/Header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { QRDisplay } from '@/components/identity/QRDisplay';
import { QRScanner } from '@/components/p2p/QRScanner';
import { KeyEncryptionCard } from '@/components/identity/KeyEncryptionCard';
import { useIdentityStore } from '@/stores/identity.store';
import { useSettingsStore } from '@/stores/settings.store';
import { useState, useRef } from 'react';
import { Shield, User, Database, Smartphone, Wifi, Download, Upload, QrCode, ScanLine, Monitor, Moon, Sun } from 'lucide-react';
import { exportIdentityToJSON, importIdentityFromJSON, downloadTextFile } from '@/lib/io/backup';
import { encodeIdentityForQR, decodeIdentityFromQR } from '@/lib/crypto/identity-qr';
import { estimateBlobSize } from '@/lib/p2p/signaling-codec';
import type { UserIdentity } from '@/types';
import { keysMatch } from '@/lib/crypto/identity';
import { formatExpenseDate } from '@/lib/utils/date';
import { MAX_LENGTHS } from '@/lib/utils/validation';

export function SettingsPage() {
  const identity = useIdentityStore(s => s.identity);
  const { updateProfile, restoreIdentity } = useIdentityStore.getState();
  // see identity.store.ts for why this reads the store instead of a local flag
  const isEncryptedOnDisk = useIdentityStore(s => s.isEncryptedOnDisk);
  const { keepAliveEnabled, keepAliveError, setKeepAliveEnabled, theme, setTheme } = useSettingsStore();
  const [displayName, setDisplayName] = useState(identity?.displayName || '');
  const [saved, setSaved] = useState(false);
  const [identityError, setIdentityError] = useState('');
  const [identityExportMessage, setIdentityExportMessage] = useState('');
  const importIdentityRef = useRef<HTMLInputElement>(null);

  // QR identity transfer - shown/scanned data contains a private key, so each
  // path gets its own explicit warning before anything sensitive is displayed
  // or applied.
  const [qrExportWarningOpen, setQrExportWarningOpen] = useState(false);
  const [qrExportOpen, setQrExportOpen] = useState(false);
  const [qrScanWarningOpen, setQrScanWarningOpen] = useState(false);
  const [qrScanOpen, setQrScanOpen] = useState(false);
  const [qrScanError, setQrScanError] = useState('');
  const [scannedIdentity, setScannedIdentity] = useState<UserIdentity | null>(null);
  // passphrase-encrypted identities still export as plaintext, so ask first
  const [identityExportWarningOpen, setIdentityExportWarningOpen] = useState(false);

  const handleSave = async () => {
    if (!displayName.trim()) return;
    await updateProfile({ displayName: displayName.trim() });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleExportIdentity = async () => {
    if (!identity) return;
    if (isEncryptedOnDisk) {
      setIdentityExportWarningOpen(true);
      return;
    }
    await runExportIdentity();
  };

  const runExportIdentity = async () => {
    if (!identity) return;
    setIdentityError('');
    try {
      setIdentityExportMessage(await downloadTextFile(`fairshare-identity-${identity.peerId}.json`, exportIdentityToJSON(identity), 'application/json'));
    } catch (err) {
      setIdentityExportMessage('');
      setIdentityError(err instanceof Error ? `Could not export identity: ${err.message}` : 'Could not export identity.');
    }
  };

  const handleImportIdentity = async (file: File) => {
    setIdentityError('');
    try {
      const text = await file.text();
      const imported = importIdentityFromJSON(text);
      if (!(await keysMatch(imported))) {
        setIdentityError('The keys in this file do not belong together. It may be damaged or edited.');
        return;
      }
      // stage file imports through the same confirmation flow as QR imports
      setScannedIdentity(imported);
    } catch (err) {
      setIdentityError(err instanceof Error ? err.message : 'Import failed');
    }
  };

  // only build the QR (it holds the private key) while the dialog is open, and
  // don't let an over-long name crash the whole page
  const identityQR = (() => {
    if (!identity || !qrExportOpen) return null;
    try {
      const blob = encodeIdentityForQR(identity);
      return { blob, fitsQR: estimateBlobSize(blob).fitsQR };
    } catch {
      return { blob: '', fitsQR: false };
    }
  })();

  const handleScanIdentityQR = async (data: string) => {
    setQrScanError('');
    try {
      const decoded = decodeIdentityFromQR(data);
      if (!(await keysMatch(decoded))) {
        setQrScanError('The keys in this code do not belong together.');
        return;
      }
      setQrScanOpen(false);
      setScannedIdentity(decoded);
    } catch (err) {
      setQrScanError(err instanceof Error ? err.message : 'Could not read this QR code.');
    }
  };

  const handleConfirmScannedIdentity = async () => {
    if (!scannedIdentity) return;
    // mandatory backup of the current identity before overwriting so an
    // accidental replace can be reverted. Skipped only if there's no current
    // identity to back up (fresh install).
    if (identity) {
      try {
        await downloadTextFile(
          `fairshare-identity-backup-${identity.peerId}.json`,
          exportIdentityToJSON(identity),
          'application/json'
        );
      } catch (err) {
        setIdentityError(err instanceof Error ? `Could not back up current identity: ${err.message}` : 'Could not back up current identity.');
        return;
      }
    }
    await restoreIdentity(scannedIdentity);
    setScannedIdentity(null);
  };

  return (
    <div className="flex flex-col">
      <Header title="Settings" />

      <div className="p-4 space-y-4">
        {/* Profile */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <User className="w-4 h-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">Profile</h3>
            </div>
            <div className="space-y-2">
              <Label htmlFor="display-name">Display Name</Label>
              <div className="flex gap-2">
                <Input
                  id="display-name"
                  value={displayName}
                  maxLength={MAX_LENGTHS.displayName}
                  onChange={e => setDisplayName(e.target.value)}
                />
                <Button variant="outline" onClick={handleSave}>
                  {saved ? 'Saved!' : 'Save'}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Identity info */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">Identity</h3>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Peer ID</p>
              <p className="text-xs font-mono break-all bg-muted p-2 rounded">
                {identity?.peerId}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Public Key</p>
              <p className="text-xs font-mono break-all bg-muted p-2 rounded">
                {identity?.publicKey.slice(0, 64)}...
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Created</p>
              <p className="text-xs">{identity?.createdAt ? formatExpenseDate(identity.createdAt) : 'N/A'}</p>
            </div>
            <div className="space-y-2 pt-2 border-t">
              <p className="text-xs text-muted-foreground">
                Back up your identity to use FairShare as the same person on another device, or restore it here.
                Keep this file private - anyone with it can act as you.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={handleExportIdentity}>
                  <Download className="h-4 w-4 mr-2" />
                  Export Identity
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => importIdentityRef.current?.click()}>
                  <Upload className="h-4 w-4 mr-2" />
                  Restore Identity
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={!identity} onClick={() => setQrExportWarningOpen(true)}>
                  <QrCode className="h-4 w-4 mr-2" />
                  Show QR Code
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setQrScanWarningOpen(true)}>
                  <ScanLine className="h-4 w-4 mr-2" />
                  Scan Identity QR
                </Button>
                <input
                  ref={importIdentityRef}
                  type="file"
                  accept="application/json"
                  className="hidden"
                  onChange={e => {
                    const file = e.target.files?.[0];
                    if (file) handleImportIdentity(file);
                    e.target.value = '';
                  }}
                />
              </div>
              {identityError && <p className="text-xs text-destructive">{identityError}</p>}
              {identityExportMessage && <p className="text-xs text-success">{identityExportMessage}</p>}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Moon className="w-4 h-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">Appearance</h3>
            </div>
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm">Theme</p>
                <p className="text-xs text-muted-foreground">Match your device or choose a fixed appearance.</p>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-1 rounded-md bg-muted p-1" role="group" aria-label="Theme">
              <Button
                type="button"
                size="sm"
                variant={theme === 'system' ? 'default' : 'ghost'}
                className="gap-1 px-2"
                onClick={() => setTheme('system')}
              >
                <Monitor className="h-4 w-4" />
                System
              </Button>
              <Button
                type="button"
                size="sm"
                variant={theme === 'light' ? 'default' : 'ghost'}
                className="gap-1 px-2"
                onClick={() => setTheme('light')}
              >
                <Sun className="h-4 w-4" />
                Light
              </Button>
              <Button
                type="button"
                size="sm"
                variant={theme === 'dark' ? 'default' : 'ghost'}
                className="gap-1 px-2"
                onClick={() => setTheme('dark')}
              >
                <Moon className="h-4 w-4" />
                Dark
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Persistent connection */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Wifi className="w-4 h-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">Persistent Connection</h3>
            </div>
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm">Keep syncing in the background</p>
                <p className="text-xs text-muted-foreground">
                  {Capacitor.getPlatform() === 'android' &&
                    'Shows an ongoing notification and keeps FairShare connected to peers even when the app is backgrounded or the phone is locked.'}
                  {Capacitor.getPlatform() === 'ios' &&
                    "iOS restricts background networking for all apps, so FairShare can't stay continuously connected once backgrounded or locked - only Android can do that. Enabling this just gives an in-progress sync a few extra seconds to finish before iOS suspends the connection."}
                  {Capacitor.getPlatform() === 'web' &&
                    'Only available in the installed Android or iOS app, not in a browser tab.'}
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={keepAliveEnabled}
                  disabled={!Capacitor.isNativePlatform()}
                  onChange={e => setKeepAliveEnabled(e.target.checked)}
                />
                <div className="w-10 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors" />
                <div className="absolute left-1 top-1 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-4" />
              </label>
            </div>
            {keepAliveError && <p className="text-xs text-destructive" role="alert">{keepAliveError}</p>}
          </CardContent>
        </Card>

        <KeyEncryptionCard />

        {/* Storage */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">Storage</h3>
            </div>
            <p className="text-xs text-muted-foreground">
              All data is stored locally on your device using IndexedDB. No data is sent to any server.
            </p>
          </CardContent>
        </Card>

        {/* Device / WebView info - the WebView engine actually rendering this app can
            differ from what Settings or Play Store report for "Chrome"/"WebView",
            so surface the real runtime user agent string for support/debugging. */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Smartphone className="w-4 h-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">Device</h3>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">User Agent (actual rendering engine)</p>
              <p className="text-xs font-mono break-all bg-muted p-2 rounded">
                {navigator.userAgent}
              </p>
            </div>
          </CardContent>
        </Card>

        <div className="text-center pt-4">
          <p className="text-xs text-muted-foreground">FairShare v1.0.0</p>
          <p className="text-xs text-muted-foreground">Peer-to-peer expense splitting</p>
        </div>
      </div>

      {/* exporting an encrypted-at-rest identity still writes the plaintext key to disk. */}
      <Dialog open={identityExportWarningOpen} onOpenChange={setIdentityExportWarningOpen}>
        <DialogHeader>
          <DialogTitle>Export unencrypted key?</DialogTitle>
          <DialogDescription>
            Your identity is encrypted at rest with a passphrase, but the exported file is always a plain
            private key. Anyone who gets the file can act as you in every group you're in. Keep it somewhere
            as secure as the passphrase itself.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setIdentityExportWarningOpen(false)}>Cancel</Button>
          <Button onClick={() => { setIdentityExportWarningOpen(false); runExportIdentity(); }}>
            Export anyway
          </Button>
        </div>
      </Dialog>

      {/* Warn before ever rendering a private key on-screen as a QR code. */}
      <Dialog open={qrExportWarningOpen} onOpenChange={setQrExportWarningOpen}>
        <DialogHeader>
          <DialogTitle>Show identity as a QR code?</DialogTitle>
          <DialogDescription>
            This QR code contains your private key in the open. Anyone who scans or photographs it can
            act as you in every group you're in. Only show it to a device you personally control, in a
            private place, and have them scan it right away.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setQrExportWarningOpen(false)}>Cancel</Button>
          <Button onClick={() => { setQrExportWarningOpen(false); setQrExportOpen(true); }}>
            I understand, show it
          </Button>
        </div>
      </Dialog>

      <Dialog open={qrExportOpen} onOpenChange={setQrExportOpen}>
        <DialogHeader>
          <DialogTitle>Scan this on your other device</DialogTitle>
          <DialogDescription>On the new device, open Settings and tap "Scan Identity QR".</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3">
          {identityQR?.fitsQR ? (
            <div className="p-3 bg-white rounded-lg">
              <QRDisplay data={identityQR.blob} size={240} />
            </div>
          ) : (
            <p className="text-xs text-destructive text-center">
              Your identity data is too large for a reliably scannable QR code (try a shorter display name),
              or use "Export Identity" (file) instead.
            </p>
          )}
          <Button variant="outline" onClick={() => setQrExportOpen(false)}>Done</Button>
        </div>
      </Dialog>

      {/* Warn before scanning too - this is the "am I about to hand over control
          of this device's identity to whatever the code says" checkpoint. */}
      <Dialog open={qrScanWarningOpen} onOpenChange={setQrScanWarningOpen}>
        <DialogHeader>
          <DialogTitle>Scan an identity QR code?</DialogTitle>
          <DialogDescription>
            Scanning will offer to replace this device's identity with the one in the code, including its
            private key. Only scan a code shown by a device you personally control.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setQrScanWarningOpen(false)}>Cancel</Button>
          <Button onClick={() => { setQrScanWarningOpen(false); setQrScanError(''); setQrScanOpen(true); }}>
            I understand, scan now
          </Button>
        </div>
      </Dialog>

      <Dialog open={qrScanOpen} onOpenChange={setQrScanOpen}>
        <DialogHeader>
          <DialogTitle>Scan Identity QR</DialogTitle>
        </DialogHeader>
        <QRScanner onScan={handleScanIdentityQR} onError={setQrScanError} />
        {qrScanError && <p className="text-xs text-destructive mt-2">{qrScanError}</p>}
      </Dialog>

      {/* Second, specific confirmation once we know exactly whose identity this is. */}
      <Dialog open={!!scannedIdentity} onOpenChange={(open) => { if (!open) setScannedIdentity(null); }}>
        <DialogHeader>
          <DialogTitle>Replace your identity?</DialogTitle>
          <DialogDescription>
            This device will become "{scannedIdentity?.displayName}" ({scannedIdentity?.peerId}), replacing
            your current identity. This can't be undone unless you've backed up your current identity first.
          </DialogDescription>
        </DialogHeader>
        {identity && (
          <p className="text-xs text-warning">
            {/* same warning as above - the backup is always a plain private key */}
            A backup of your current identity is saved first. That file holds your private key unencrypted
            {isEncryptedOnDisk ? ', even though it is passphrase-protected on this device' : ''}, so keep it private.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setScannedIdentity(null)}>Cancel</Button>
          <Button onClick={handleConfirmScannedIdentity}>Replace identity</Button>
        </div>
      </Dialog>
    </div>
  );
}
