import { useEffect, useState, useRef, lazy, Suspense, Component, type ComponentType, type ReactNode, type ErrorInfo } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';

// Keep the app usable after an unexpected render crash.
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[FairShare] Unhandled error:', error, info.componentStack);
  }

  override render() {
    const error = this.state.error as Error | null;
    if (error) {
      return (
        <div className="flex flex-col items-center justify-center min-h-dvh p-6 text-center gap-4">
          <div className="w-14 h-14 bg-destructive/10 rounded-full flex items-center justify-center text-destructive text-2xl">✕</div>
          <h2 className="text-lg font-semibold">Something went wrong</h2>
          <p className="text-sm text-muted-foreground bg-muted rounded p-3 font-mono text-left break-all max-w-sm">
            {error.message || String(error)}
          </p>
          <div className="flex gap-3">
            <button
              className="px-4 py-2 rounded-md border text-sm"
              onClick={() => this.setState({ error: null })}
            >
              Try Again
            </button>
            <button
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm"
              onClick={() => { this.setState({ error: null }); window.location.href = '/dashboard'; }}
            >
              Go to Dashboard
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { closeTopDialog } from '@/components/ui/dialog';
import { getP2PNode } from '@/lib/p2p/node';
import { useConnectionsStore } from '@/stores/connections.store';
import { p2pLog } from '@/lib/p2p/debug-log';
import { importIdentityFromJSON } from '@/lib/io/backup';
import { keysMatch } from '@/lib/crypto/identity';
import { AppShell } from '@/components/layout/AppShell';
import { Dashboard } from '@/pages/Dashboard';
import { GroupDetail } from '@/pages/GroupDetail';
import { useIdentityStore } from '@/stores/identity.store';
import { useGroupsStore } from '@/stores/groups.store';
import { useSyncStore } from '@/stores/sync.store';
import { useSettingsStore } from '@/stores/settings.store';

// only Dashboard and GroupDetail load up front, the rest (and the QR scanner they pull in) on demand
const named = <K extends string>(load: () => Promise<Record<K, ComponentType>>, key: K) =>
  lazy(() => load().then(m => ({ default: m[key] })));
const Onboarding = named(() => import('@/pages/Onboarding'), 'Onboarding');
const GroupStats = named(() => import('@/pages/GroupStats'), 'GroupStats');
const AddExpense = named(() => import('@/pages/AddExpense'), 'AddExpense');
const EditExpense = named(() => import('@/pages/EditExpense'), 'EditExpense');
const ExpenseDetail = named(() => import('@/pages/ExpenseDetail'), 'ExpenseDetail');
const SettleUp = named(() => import('@/pages/SettleUp'), 'SettleUp');
const Stats = named(() => import('@/pages/Stats'), 'Stats');
const HistoryPage = named(() => import('@/pages/History'), 'HistoryPage');
const SettingsPage = named(() => import('@/pages/Settings'), 'SettingsPage');
const JoinGroup = named(() => import('@/pages/JoinGroup'), 'JoinGroup');

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center min-h-dvh">
      <div className="text-center">
        <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <p className="text-sm text-muted-foreground" role="status">{label}</p>
      </div>
    </div>
  );
}

// fairshare://join?topic=... puts "join" in the host, not the path
function deepLinkPath(raw: string): string | null {
  try {
    const url = new URL(raw);
    const path = url.protocol === 'fairshare:' ? `/${url.host}${url.pathname}`.replace(/\/+$/, '') : url.pathname;
    if (path !== '/join') return null;
    const topic = url.searchParams.get('topic') || '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(topic)) return null;
    return `/join?topic=${encodeURIComponent(topic)}`;
  } catch {
    return null;
  }
}

function AppLoader() {
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState('');
  const [bootAttempt, setBootAttempt] = useState(0);
  const { initialize: initIdentity, identity, needsPassphrase, unlockWithPassphrase, loadError, resetIdentity, restoreIdentity } = useIdentityStore();
  const { initialize: initGroups } = useGroupsStore();
  const { initializeP2P } = useSyncStore();
  const navigate = useNavigate();
  const [passphrase, setPassphrase] = useState('');
  const [unlockError, setUnlockError] = useState('');
  const [forgotOpen, setForgotOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const restoreFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Surfaces the WebView/browser engine actually rendering the app in the P2P
    // debug panel, since Settings screens or Play Store can report a different
    // ("installed") version than what's really active for this WebView instance.
    p2pLog(`User agent: ${navigator.userAgent}`);
  }, []);

  useEffect(() => {
    async function boot() {
      setBootError('');
      // any of these can throw (IndexedDB VersionError, disk full, blocked storage).
      // Without a catch the spinner just stayed up forever.
      try {
        await initIdentity();
        await initGroups();
        await useSettingsStore.getState().initialize();
        // groups are loaded now, so an interrupted rename can reach them
        void useIdentityStore.getState().resumePendingProfileUpdate()
          .catch(err => console.error('[boot] rename retry failed', err));
        if (navigator.storage?.persist) {
          await navigator.storage.persist().catch(() => false);
        }
        setReady(true);
      } catch (err) {
        console.error('[boot] failed', err);
        setBootError(err instanceof Error ? err.message : String(err));
      }
    }
    boot();
  }, [bootAttempt]);

  // key on the id and key, not the identity object, which changes on every profile save
  const peerId = identity?.peerId;
  const privateKey = identity?.privateKey;
  useEffect(() => {
    if (peerId && ready) {
      initializeP2P(peerId, privateKey).then(() => {
        // Re-subscribe every known group, not just the one being viewed, so a
        // previously paired peer can resume syncing as soon as it reconnects.
        const { groupList } = useGroupsStore.getState();
        const { subscribeToGroup } = useSyncStore.getState();
        groupList.forEach(g => subscribeToGroup(g.id));
      });
    }
  }, [peerId, privateKey, ready]);

  // the PWA has no appStateChange, so check the channels when the tab comes back
  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      getP2PNode()?.notifyForegroundResume();
      useConnectionsStore.getState().refreshPeers();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    const urlListener = CapApp.addListener('appUrlOpen', (event) => {
      const path = deepLinkPath(event.url);
      if (path) navigate(path);
    });

    const backListener = CapApp.addListener('backButton', ({ canGoBack }) => {
      // Close open dialogs first; they are local component state, not router entries.
      if (closeTopDialog()) return;
      if (canGoBack) {
        window.history.back();
      } else {
        CapApp.exitApp();
      }
    });

    const stateListener = CapApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) {
        // A backgrounded WebView can freeze the ping keepalive timer; clear any
        // stale missed-ping count instead of letting it immediately trip a
        // disconnect, then refresh the UI's view of connection state.
        getP2PNode()?.notifyForegroundResume();
        useConnectionsStore.getState().refreshPeers();
      }
    });

    return () => {
      urlListener.then(l => l.remove());
      backListener.then(l => l.remove());
      stateListener.then(l => l.remove());
    };
  }, [navigate]);

  if (bootError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh p-6 text-center gap-4">
        <h2 className="text-lg font-semibold">FairShare couldn't open its storage</h2>
        <p className="text-sm text-muted-foreground max-w-sm">
          Your data hasn't been touched. This can happen if the device is out of space or site storage is blocked.
        </p>
        <p className="text-xs font-mono bg-muted rounded p-2 break-all max-w-sm">{bootError}</p>
        <button className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm" onClick={() => setBootAttempt(n => n + 1)}>
          Retry
        </button>
      </div>
    );
  }

  if (!ready) {
    return <Spinner label="Loading FairShare..." />;
  }

  if (needsPassphrase) {
    const handleUnlock = async () => {
      setUnlockError('');
      try {
        await unlockWithPassphrase(passphrase);
      } catch (err) {
        setUnlockError(err instanceof Error ? err.message : 'Unlock failed');
      }
    };
    // a forgotten passphrase used to mean clearing site data and losing every group
    const handleRestoreFile = async (file: File) => {
      setUnlockError('');
      try {
        const restored = importIdentityFromJSON(await file.text());
        if (!(await keysMatch(restored))) throw new Error('The keys in this file do not belong together.');
        await restoreIdentity(restored);
      } catch (err) {
        setUnlockError(err instanceof Error ? err.message : 'Restore failed');
      }
    };
    return (
      <div className="flex items-center justify-center min-h-dvh p-6">
        <div className="w-full max-w-sm space-y-4 text-center">
          <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mx-auto text-2xl">🔒</div>
          <h2 className="text-lg font-semibold">Unlock FairShare</h2>
          <p className="text-sm text-muted-foreground">Your private key is encrypted. Enter your passphrase to continue.</p>
          <input
            type="password"
            className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
            placeholder="Enter passphrase"
            aria-label="Passphrase"
            value={passphrase}
            onChange={e => setPassphrase(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleUnlock()}
            autoFocus
          />
          {unlockError && <p className="text-xs text-destructive" role="alert">{unlockError}</p>}
          <button
            className="w-full h-10 rounded-md bg-primary text-primary-foreground text-sm font-medium"
            onClick={handleUnlock}
            disabled={!passphrase}
          >
            Unlock
          </button>
          {!forgotOpen ? (
            <button className="text-xs text-muted-foreground underline" onClick={() => setForgotOpen(true)}>
              Forgot passphrase?
            </button>
          ) : (
            <div className="space-y-3 border-t pt-4 text-left">
              <p className="text-xs text-muted-foreground">
                Your groups are stored separately and stay on this device either way.
              </p>
              <button
                className="w-full h-10 rounded-md border text-sm"
                onClick={() => restoreFileRef.current?.click()}
              >
                Restore identity from a backup file
              </button>
              <input
                ref={restoreFileRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) handleRestoreFile(file);
                  e.target.value = '';
                }}
              />
              {!confirmReset ? (
                <button className="w-full h-10 rounded-md border border-destructive text-destructive text-sm" onClick={() => setConfirmReset(true)}>
                  Start over with a new identity
                </button>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-destructive">
                    Your old identity can't be recovered. Other members will see you as a new person until
                    someone reassigns your old records to you.
                  </p>
                  <div className="flex gap-2">
                    <button className="flex-1 h-9 rounded-md border text-sm" onClick={() => setConfirmReset(false)}>Cancel</button>
                    <button
                      className="flex-1 h-9 rounded-md bg-destructive text-destructive-foreground text-sm"
                      onClick={() => resetIdentity().catch(err => setUnlockError(String(err)))}
                    >
                      Confirm
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // a failed identity read is not "no identity", Onboarding would replace the real one
  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh p-6 text-center gap-4">
        <h2 className="text-lg font-semibold">Couldn't load your identity</h2>
        <p className="text-sm text-muted-foreground max-w-sm">Nothing was changed. Try again, or restart the app.</p>
        <p className="text-xs font-mono bg-muted rounded p-2 break-all max-w-sm">{loadError}</p>
        <button className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm" onClick={() => setBootAttempt(n => n + 1)}>
          Retry
        </button>
      </div>
    );
  }

  if (!identity) {
    return (
      <Suspense fallback={<Spinner label="Loading..." />}>
        <Onboarding />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<Spinner label="Loading..." />}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/stats" element={<Stats />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="/group/:groupId" element={<GroupDetail />} />
        <Route path="/group/:groupId/stats" element={<GroupStats />} />
        <Route path="/group/:groupId/expense/new" element={<AddExpense />} />
        <Route path="/group/:groupId/expense/:expenseId" element={<ExpenseDetail />} />
        <Route path="/group/:groupId/expense/:expenseId/edit" element={<EditExpense />} />
        <Route path="/group/:groupId/settle" element={<SettleUp />} />
        <Route path="/join" element={<JoinGroup />} />
        {/* with an identity, a link to /onboarding must never offer "Create" again */}
        <Route path="/onboarding" element={<Navigate to="/dashboard" replace />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Suspense>
  );
}

function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <AppLoader />
      </ErrorBoundary>
    </BrowserRouter>
  );
}

export default App;
