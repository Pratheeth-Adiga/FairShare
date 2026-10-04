import { useState } from 'react';
import { Lock } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useIdentityStore } from '@/stores/identity.store';
import { MIN_PASSPHRASE_LENGTH } from '@/lib/crypto/key-encryption';
import { estimatePassphraseStrength } from '@/lib/crypto/passphrase-strength';

// key-encryption toggle plus its passphrase dialog, pulled out of Settings which
// had six dialog flows in one component. Shown on native too - there's no keystore
// code behind a native toggle.
export function KeyEncryptionCard() {
  // see identity.store.ts for why this reads the store instead of a local flag.
  const keyEncryptionEnabled = useIdentityStore(s => s.isEncryptedOnDisk);
  const { enableEncryption, disableEncryption } = useIdentityStore.getState();
  const [open, setOpen] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'enable' | 'disable'>('enable');

  // the hard floor is enforced inside encryptPrivateKey(); these two derived values
  // let the dialog tell the user before they submit rather than after a thrown
  // error, and nudge past merely-legal toward actually-strong.
  const strength = estimatePassphraseStrength(passphrase);
  const tooShort = passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE_LENGTH;

  const submit = async () => {
    setError('');
    try {
      if (mode === 'enable') {
        await enableEncryption(passphrase);
      } else {
        await disableEncryption(passphrase);
      }
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  return (
    <>
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Key Encryption</h3>
          </div>
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-sm">Encrypt private key at rest</p>
              <p className="text-xs text-muted-foreground">
                {keyEncryptionEnabled
                  ? 'Your private key is encrypted. You\'ll need your passphrase each time you open the app.'
                  : 'Your private key is stored unencrypted. Anyone with access to this app\'s storage can impersonate you.'}
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer shrink-0">
              <input
                type="checkbox"
                aria-label="Encrypt private key at rest"
                className="sr-only peer"
                checked={keyEncryptionEnabled}
                onChange={e => {
                  setMode(e.target.checked ? 'enable' : 'disable');
                  setPassphrase('');
                  setConfirm('');
                  setError('');
                  setOpen(true);
                }}
              />
              <div className="w-10 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors" />
              <div className="absolute left-1 top-1 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-4" />
            </label>
          </div>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogHeader>
          <DialogTitle>{mode === 'enable' ? 'Set Encryption Passphrase' : 'Disable Encryption'}</DialogTitle>
          <DialogDescription>
            {mode === 'enable'
              ? 'Choose a passphrase to encrypt your private key. You\'ll need it every time you open FairShare. If you forget it, you can restore from a backup file or start over with a new identity.'
              : 'Enter your current passphrase to decrypt and store your key unencrypted.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <input
            type="password"
            aria-label={mode === 'enable' ? 'New passphrase' : 'Current passphrase'}
            className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
            placeholder={mode === 'enable' ? 'New passphrase' : 'Current passphrase'}
            value={passphrase}
            onChange={e => setPassphrase(e.target.value)}
            autoFocus
          />
          {mode === 'enable' && (
            <input
              type="password"
              aria-label="Confirm passphrase"
              className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
              placeholder="Confirm passphrase"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
            />
          )}
          {mode === 'enable' && passphrase.length > 0 && (
            <div className="space-y-1">
              <div className="flex gap-1" aria-hidden="true">
                {[0, 1, 2, 3].map(i => (
                  <div
                    key={i}
                    className={`h-1 flex-1 rounded-full ${
                      i < strength.score
                        ? strength.score <= 1
                          ? 'bg-destructive'
                          : strength.score === 2
                            ? 'bg-warning'
                            : 'bg-success'
                        : 'bg-muted'
                    }`}
                  />
                ))}
              </div>
              <p className="text-xs text-muted-foreground">Strength: {strength.label}</p>
            </div>
          )}
          {tooShort && mode === 'enable' && (
            <p className="text-xs text-destructive">
              Passphrase must be at least {MIN_PASSPHRASE_LENGTH} characters.
            </p>
          )}
          {mode === 'enable' && confirm.length > 0 && passphrase !== confirm && (
            <p className="text-xs text-destructive">Passphrases do not match.</p>
          )}
          {mode === 'enable' && !keyEncryptionEnabled && (
            <p className="text-xs text-warning">
              Without encryption, anyone with access to this app's storage can read your private key and impersonate you in all your groups.
            </p>
          )}
          {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              className="flex-1"
              disabled={!passphrase || (mode === 'enable' && (passphrase !== confirm || passphrase.length < MIN_PASSPHRASE_LENGTH))}
              onClick={submit}
            >
              {mode === 'enable' ? 'Encrypt' : 'Decrypt'}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
