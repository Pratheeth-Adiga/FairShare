import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useIdentityStore } from '@/stores/identity.store';
import { MAX_LENGTHS } from '@/lib/utils/validation';
import { Users, Shield, Zap } from 'lucide-react';

export function Onboarding() {
  const [step, setStep] = useState(0);
  const [displayName, setDisplayName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createIdentity = useIdentityStore(s => s.createIdentity);
  const navigate = useNavigate();

  const handleCreate = async () => {
    if (!displayName.trim()) return;
    setIsCreating(true);
    setCreateError(null);
    try {
      await createIdentity(displayName.trim());
      navigate('/dashboard', { replace: true });
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
      setIsCreating(false);
    }
  };

  if (step === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh p-6 text-center">
        <div className="mb-8">
          <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <Users className="w-10 h-10 text-primary" />
          </div>
          <h1 className="text-3xl font-bold mb-3">FairShare</h1>
          <p className="text-muted-foreground text-lg max-w-xs">
            Split expenses with friends (no accounts, no servers, your data stays yours).
          </p>
        </div>

        <div className="space-y-4 w-full max-w-xs mb-8">
          <div className="flex items-center gap-3 text-left">
            <Shield className="w-5 h-5 text-primary shrink-0" />
            <span className="text-sm">Peer-to-peer (no cloud needed)</span>
          </div>
          <div className="flex items-center gap-3 text-left">
            <Zap className="w-5 h-5 text-primary shrink-0" />
            <span className="text-sm">Works offline, syncs when connected</span>
          </div>
        </div>

        <Button size="lg" className="w-full max-w-xs" onClick={() => setStep(1)}>
          Get Started
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-dvh p-6">
      <div className="w-full max-w-xs space-y-6">
        <div className="text-center">
          <h2 className="text-2xl font-bold mb-2">What's your name?</h2>
          <p className="text-sm text-muted-foreground">
            This is how others will see you in groups.
          </p>
        </div>

        <Input
          placeholder="Enter your name"
          value={displayName}
          onChange={e => setDisplayName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleCreate()}
          autoFocus
          maxLength={MAX_LENGTHS.displayName}
        />

        {createError && (
          <p className="text-sm text-destructive text-center">{createError}</p>
        )}

        <Button
          size="lg"
          className="w-full"
          onClick={handleCreate}
          disabled={!displayName.trim() || isCreating}
        >
          {isCreating ? 'Creating identity...' : 'Continue'}
        </Button>
      </div>
    </div>
  );
}
