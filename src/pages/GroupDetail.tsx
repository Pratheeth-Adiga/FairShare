import { useParams, useNavigate } from 'react-router-dom';
import { Plus, UserPlus, ArrowRightLeft, Wifi, Settings, Trash2, Users, BarChart3, Download, Upload, X, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Header } from '@/components/layout/Header';
import { Dialog, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useGroupsStore } from '@/stores/groups.store';
import { useSyncStore } from '@/stores/sync.store';
import { useConnectionsStore } from '@/stores/connections.store';
import { useIdentityStore } from '@/stores/identity.store';
import { formatCents, SUPPORTED_CURRENCIES } from '@/lib/utils/currency';
import { formatExpenseDate } from '@/lib/utils/date';
import { getCategoryOptions } from '@/lib/utils/categories';
import { MAX_LENGTHS } from '@/lib/utils/validation';
import { getMemberNames, getSettlements } from '@/lib/crdt/queries';
import type { GroupDocument } from '@/lib/crdt/document';
import { isPlaceholderMember } from '@/lib/crypto/identity';
import { exportGroupToJSON, exportExpensesToCSV, importGroupFromJSON, downloadTextFile } from '@/lib/io/backup';
import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { AddMemberDialog } from '@/components/group/AddMemberDialog';
import { ManageMembersDialog } from '@/components/group/ManageMembersDialog';
import { ConnectPeerDialog } from '@/components/p2p/ConnectPeerDialog';
import { JoinPeerDialog } from '@/components/p2p/JoinPeerDialog';
import { PeerStatusBar } from '@/components/p2p/PeerStatusBar';

export function GroupDetail() {
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();
  // subscribe to this group's document only; actions are stable so read them once
  const doc = useGroupsStore(s => (groupId ? s.documents[groupId] : undefined));
  const hasStoredGroup = useGroupsStore(s => s.groupList.some(g => g.id === groupId));
  const {
    getDocument, getExpenses, getSimplifiedDebts, updateSettings, deleteGroup, addCustomCategory, removeCategory,
    importDocument, reassignMember, renameGroup, changeState, deleteSettlement,
  } = useGroupsStore.getState();
  const persistError = useGroupsStore(s => groupId ? s.persistErrors[groupId] : undefined);
  const clearPersistError = useGroupsStore(s => s.clearPersistError);
  const sendError = useSyncStore(s => s.lastSendError);
  const clearSendError = useSyncStore(s => s.clearSendError);
  const [showAddMember, setShowAddMember] = useState(false);
  const [showManageMembers, setShowManageMembers] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [showReconnectChoice, setShowReconnectChoice] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showClaimDialog, setShowClaimDialog] = useState(false);
  const [selectedClaimId, setSelectedClaimId] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newCategoryLabel, setNewCategoryLabel] = useState('');
  const [importError, setImportError] = useState('');
  const [exportMessage, setExportMessage] = useState('');
  // guards Export/Import/Delete Group against rapid double-clicks
  const [isBusy, setIsBusy] = useState(false);
  // an import file for a different group waits here for confirmation
  const [pendingImport, setPendingImport] = useState<GroupDocument | null>(null);
  const [confirmSettlementDelete, setConfirmSettlementDelete] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);
  const expenseListRef = useRef<HTMLDivElement>(null);
  const subscribeToGroup = useSyncStore(s => s.subscribeToGroup);
  const identity = useIdentityStore(s => s.identity);
  const activePeers = useConnectionsStore(s => s.activePeers);
  const introductions = useConnectionsStore(s => s.introductions);
  const requestIntroduction = useConnectionsStore(s => s.requestIntroduction);
  const lastAutoIntroduceAttempt = useRef<Record<string, number>>({});

  useEffect(() => {
    if (groupId) subscribeToGroup(groupId);
  }, [groupId]);

  // Opportunistically ask an already-connected peer to relay a connection to any
  // group member we're not directly reachable to yet, instead of requiring the
  // user to manually pick "Connect via existing peer" for every missing member.
  useEffect(() => {
    if (!groupId || !identity) return;
    const doc = getDocument(groupId);
    if (!doc) return;

    const connectedForGroup = activePeers.filter(p => p.state === 'connected' && p.groups.includes(groupId));
    const bridgeCandidates = connectedForGroup.filter(p => p.peerId !== identity.peerId);
    if (bridgeCandidates.length === 0) return;
    const connectedIds = new Set(connectedForGroup.map(p => p.peerId));

    const AUTO_INTRODUCE_COOLDOWN = 20000;
    const now = Date.now();
    for (const id of Object.keys(doc.members)) {
      if (id === identity.peerId || connectedIds.has(id)) continue;
      // only the lower peerId asks, so two devices never introduce each other at once
      if (identity.peerId > id) continue;
      if (introductions[id] === 'pending') continue;
      const last = lastAutoIntroduceAttempt.current[id] || 0;
      if (now - last < AUTO_INTRODUCE_COOLDOWN) continue;
      lastAutoIntroduceAttempt.current[id] = now;
      requestIntroduction(groupId, bridgeCandidates[0].peerId, id, identity.displayName);
    }
  }, [groupId, identity, activePeers, introductions, requestIntroduction, getDocument]);

  const expenses = groupId && doc ? getExpenses(groupId) : [];
  const [listOffset, setListOffset] = useState(0);
  useLayoutEffect(() => {
    const top = expenseListRef.current?.offsetTop ?? 0;
    if (top !== listOffset) setListOffset(top);
  });
  // a long-running group can have hundreds of expenses, same reason as History
  const expenseVirtualizer = useWindowVirtualizer({
    count: expenses.length,
    estimateSize: () => 76,
    overscan: 8,
    scrollMargin: listOffset,
  });

  if (!groupId) return null;

  if (!doc) {
    return (
      <div className="flex flex-col">
        <Header title="Group" showBack />
        <div className="p-4 space-y-3">
          <p>Group not found.</p>
          {/* a group whose data won't load still has to be removable */}
          {hasStoredGroup && (
            <>
              <p className="text-sm text-muted-foreground">This group's saved data couldn't be read on this device.</p>
              <Button
                variant="destructive"
                disabled={isBusy}
                onClick={async () => {
                  setIsBusy(true);
                  await deleteGroup(groupId);
                  navigate('/dashboard');
                }}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Remove from this device
              </Button>
            </>
          )}
        </div>
      </div>
    );
  }

  const handleExportJSON = async () => {
    setImportError('');
    setIsBusy(true);
    try {
      setExportMessage(await downloadTextFile(`${doc.meta.name}-export.json`, exportGroupToJSON(doc), 'application/json'));
    } catch (err) {
      setExportMessage('');
      setImportError(err instanceof Error ? `Could not export JSON: ${err.message}` : 'Could not export JSON.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleExportCSV = async () => {
    setImportError('');
    setIsBusy(true);
    try {
      setExportMessage(await downloadTextFile(`${doc.meta.name}-expenses.csv`, exportExpensesToCSV(doc), 'text/csv'));
    } catch (err) {
      setExportMessage('');
      setImportError(err instanceof Error ? `Could not export CSV: ${err.message}` : 'Could not export CSV.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleImportFile = async (file: File) => {
    setImportError('');
    setExportMessage('');
    setIsBusy(true);
    try {
      const text = await file.text();
      const imported = importGroupFromJSON(text);
      if (imported.meta.id !== groupId) {
        setPendingImport(imported);
        return;
      }
      await importDocument(imported);
      setExportMessage('Imported and merged with this group.');
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setIsBusy(false);
    }
  };

  const debts = getSimplifiedDebts(groupId);
  const settlements = getSettlements(doc);
  const members = doc.members;
  const memberNames = getMemberNames(doc);
  const isActive = doc.meta.state === 'active';
  // our device was removed, so it no longer adds itself back
  const wasRemoved = !!identity && !members[identity.peerId]
    && (identity.peerId in doc.deleted || !!doc.formerMembers?.[identity.peerId]);
  const claimCandidates = Object.values(members).filter(isPlaceholderMember);
  const claimCandidate = claimCandidates.find(member => member.peerId === selectedClaimId) || claimCandidates[0];
  const canClaimMember = !!identity && claimCandidates.length > 0;
  const onlineMemberIds = new Set(
    activePeers.filter(p => p.state === 'connected' && p.groups.includes(groupId)).map(p => p.peerId)
  );

  return (
    <div className="flex flex-col">
      <Header
        title={doc.meta.name}
        showBack
        rightAction={
          <div className="flex gap-1">
            <Button variant="ghost" size="icon" onClick={() => navigate(`/group/${groupId}/stats`)} title="Group stats">
              <BarChart3 className="h-5 w-5" />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => setShowConnect(true)} title="Connect to peer">
              <Wifi className="h-5 w-5" />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => setShowSettings(true)} title="Group settings">
              <Settings className="h-5 w-5" />
            </Button>
          </div>
        }
      />

      <div className="p-4 space-y-4">
        {wasRemoved && (
          <Card className="border-destructive">
            <CardContent className="p-3">
              <p className="text-sm text-destructive">You were removed from this group. Ask a member to add you again, or rejoin with a new invite.</p>
            </CardContent>
          </Card>
        )}
        {!isActive && (
          <Card>
            <CardContent className="p-3 flex items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">This group is {doc.meta.state}. Expenses can't be added or changed.</p>
              <Button size="sm" variant="outline" onClick={() => changeState(groupId, 'active')}>Reopen</Button>
            </CardContent>
          </Card>
        )}
        {sendError && (
          <Card className="border-destructive">
            <CardContent className="p-3 flex items-center justify-between gap-2">
              <p className="text-sm text-destructive">Some changes didn't reach a peer: {sendError}</p>
              <button type="button" aria-label="Dismiss" className="text-muted-foreground hover:text-destructive shrink-0" onClick={clearSendError}>
                <X className="h-4 w-4" />
              </button>
            </CardContent>
          </Card>
        )}
        {persistError && (
          <Card className="border-destructive">
            <CardContent className="p-3 flex items-center justify-between gap-2">
              <p className="text-sm text-destructive">{persistError}</p>
              <button type="button" aria-label="Dismiss" className="text-muted-foreground hover:text-destructive shrink-0" onClick={() => clearPersistError(groupId)}>
                <X className="h-4 w-4" />
              </button>
            </CardContent>
          </Card>
        )}
        {/* Members & P2P Status */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
              <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                Members ({Object.keys(members).length})
              </h3>
              <div className="flex flex-wrap items-center gap-2">
                <PeerStatusBar groupId={groupId} onReconnect={() => setShowReconnectChoice(true)} />
                {canClaimMember && (
                  <Button variant="outline" size="sm" onClick={() => setShowClaimDialog(true)}>
                    Claim Member
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => setShowAddMember(true)}>
                  <UserPlus className="h-4 w-4 mr-1" />
                  Add
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(members).map(([id, m]) => {
                const isOnline = id === identity?.peerId || onlineMemberIds.has(id);
                const isPlaceholder = isPlaceholderMember(m);
                return (
                  <div
                    key={id}
                    className="flex items-center gap-1.5 rounded-full bg-muted pl-1 pr-2.5 py-1"
                    title={`${m.displayName} · ${isOnline ? 'online' : 'offline'}${isPlaceholder ? ' · not yet claimed' : ''}`}
                  >
                    <span className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {m.displayName.charAt(0).toUpperCase() || '?'}
                      <span
                        className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background ${isOnline ? 'bg-green-500' : 'bg-muted-foreground/40'}`}
                        aria-hidden="true"
                      />
                    </span>
                    <span className="text-xs font-medium max-w-[7rem] truncate">{m.displayName}</span>
                    {/* placeholder members have no real key yet - mark them until claimed */}
                    {isPlaceholder && (
                      <span className="text-[10px] font-medium text-muted-foreground bg-background rounded-full px-1.5 py-0.5">
                        unclaimed
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <Button variant="outline" size="sm" className="w-full" onClick={() => setShowManageMembers(true)}>
              <Users className="h-4 w-4 mr-1" />
              Manage Members
            </Button>
            <div className="flex gap-2 pt-1">
              <Button variant="outline" size="sm" className="flex-1" onClick={() => setShowConnect(true)}>
                <Wifi className="h-4 w-4 mr-1" />
                Connect Peer
              </Button>
              <Button variant="outline" size="sm" className="flex-1" onClick={() => setShowJoin(true)}>
                Scan to Join
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Balances */}
        {debts.length > 0 && (
          <Card>
            <CardContent className="p-4 space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Balances</h3>
              {debts.map((debt, i) => (
                <div key={i} className="flex items-center justify-between py-1">
                  <span className="text-sm">
                    <span className="font-medium">{memberNames[debt.from] || 'Unknown'}</span>
                    {' owes '}
                    <span className="font-medium">{memberNames[debt.to] || 'Unknown'}</span>
                  </span>
                  <span className="text-sm font-semibold">
                    {formatCents(debt.amount, doc.meta.settings.defaultCurrency)}
                  </span>
                </div>
              ))}
              <Button
                variant="outline"
                className="w-full mt-2"
                onClick={() => navigate(`/group/${groupId}/settle`)}
              >
                <ArrowRightLeft className="w-4 h-4 mr-2" />
                Settle Up
              </Button>
            </CardContent>
          </Card>
        )}

        {debts.length === 0 && expenses.length > 0 && (
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-sm text-muted-foreground">All settled up!</p>
            </CardContent>
          </Card>
        )}

        {/* recorded settlements, so a mistake can actually be found and undone */}
        {settlements.length > 0 && (
          <Card>
            <CardContent className="p-4 space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                Settlements ({settlements.length})
              </h3>
              {settlements.map(s => (
                <div key={s.id} className="flex items-center justify-between gap-2 py-1">
                  <div className="min-w-0">
                    <p className="text-sm">
                      <span className="font-medium">{memberNames[s.from] || 'Unknown'}</span>
                      {' paid '}
                      <span className="font-medium">{memberNames[s.to] || 'Unknown'}</span>
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {formatExpenseDate(s.date)}{s.note ? ` · ${s.note}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-sm font-semibold">{formatCents(s.amount, doc.meta.settings.defaultCurrency)}</span>
                    {confirmSettlementDelete === s.id ? (
                      <>
                        <Button size="sm" variant="outline" onClick={() => setConfirmSettlementDelete(null)}>Cancel</Button>
                        <Button size="sm" variant="destructive" onClick={() => { deleteSettlement(groupId, s.id); setConfirmSettlementDelete(null); }}>
                          Confirm Delete
                        </Button>
                      </>
                    ) : (
                      <Button variant="ghost" size="icon" title="Delete settlement" onClick={() => setConfirmSettlementDelete(s.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Expenses. Extra bottom padding keeps the last card(s) from being
            covered by the fixed floating add button below. */}
        <div className="space-y-2 pb-24">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Expenses ({expenses.length})
            </h3>
          </div>

          {expenses.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-sm text-muted-foreground mb-3">No expenses yet</p>
              <Button onClick={() => navigate(`/group/${groupId}/expense/new`, { state: { returnTo: `/group/${groupId}` } })}>
                <Plus className="w-4 h-4 mr-2" />
                Add First Expense
              </Button>
            </div>
          ) : (
            <div ref={expenseListRef} style={{ height: expenseVirtualizer.getTotalSize(), position: 'relative' }}>
              {expenseVirtualizer.getVirtualItems().map(virtualRow => {
                const expense = expenses[virtualRow.index];
                return (
                <div
                  key={expense.id}
                  data-index={virtualRow.index}
                  ref={expenseVirtualizer.measureElement}
                  className="pb-2"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${virtualRow.start - expenseVirtualizer.options.scrollMargin}px)`,
                  }}
                >
                <Card
                  className="cursor-pointer hover:bg-accent/50 transition-colors"
                  onClick={() => navigate(`/group/${groupId}/expense/${expense.id}`)}
                >
                  <CardContent className="flex items-center justify-between gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 font-medium text-sm">
                        {expense.description}
                        {(expense.editHistory?.length || 0) > 0 && (
                          <span className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground" title="This expense was edited">
                            <Pencil className="h-3 w-3" aria-hidden="true" />
                            (edited)
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Paid by {memberNames[expense.payers[0]?.userId] || 'Unknown'}
                        {' · '}
                        {formatExpenseDate(expense.date)}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-semibold text-sm">
                        {formatCents(expense.totalAmount, expense.currency)}
                      </p>
                      <Badge variant="secondary" className="text-xs">
                        {expense.category}
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
                </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Floating Add Button */}
      {isActive && (
      <Button
        className="fixed bottom-[calc(env(safe-area-inset-bottom)+1rem)] right-4 h-14 w-14 rounded-full shadow-lg"
        size="icon"
        title="Add expense"
        onClick={() => navigate(`/group/${groupId}/expense/new`, { state: { returnTo: `/group/${groupId}` } })}
      >
        <Plus className="h-6 w-6" />
      </Button>
      )}

      <AddMemberDialog
        open={showAddMember}
        onOpenChange={setShowAddMember}
        groupId={groupId}
      />

      <ManageMembersDialog
        open={showManageMembers}
        onOpenChange={setShowManageMembers}
        groupId={groupId}
        members={members}
      />

      <ConnectPeerDialog
        open={showConnect}
        onOpenChange={setShowConnect}
        groupId={groupId}
      />

      <JoinPeerDialog
        open={showJoin}
        onOpenChange={setShowJoin}
      />

      <Dialog open={showClaimDialog} onOpenChange={setShowClaimDialog}>
        <DialogHeader>
          <DialogTitle>Claim Existing Member?</DialogTitle>
          <DialogDescription>
            Choose a member previously added manually if it represents you.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Select value={claimCandidate?.peerId || ''} onChange={event => setSelectedClaimId(event.target.value)}>
            {claimCandidates.map(member => (
              <option key={member.peerId} value={member.peerId}>{member.displayName}</option>
            ))}
          </Select>
          <p className="text-sm text-muted-foreground">
            Claiming moves this member's expenses and balances to your verified device identity. Choose No to join as a separate person.
          </p>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setShowClaimDialog(false)}>
              Cancel
            </Button>
            <Button className="flex-1" onClick={() => {
              if (!claimCandidate || !identity) return;
              reassignMember(groupId, claimCandidate.peerId, identity.peerId);
              setShowClaimDialog(false);
            }}>
              Yes, Claim Record
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Reconnect chooser: known peers are offline, one tap into the right flow */}
      <Dialog open={showReconnectChoice} onOpenChange={setShowReconnectChoice}>
        <DialogHeader>
          <DialogTitle>Reconnect to Peer</DialogTitle>
          <DialogDescription>
            A known peer for this group is offline. One device shows a code, the other scans it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Button
            className="w-full justify-start"
            onClick={() => { setShowReconnectChoice(false); setShowConnect(true); }}
          >
            <Wifi className="h-4 w-4 mr-2" />
            Show my code
          </Button>
          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={() => { setShowReconnectChoice(false); setShowJoin(true); }}
          >
            Scan their code
          </Button>
        </div>
      </Dialog>

      {/* Group Settings Dialog */}
      <Dialog open={showSettings} onOpenChange={setShowSettings}>
        <DialogHeader>
          <DialogTitle>Group Settings</DialogTitle>
          <DialogDescription>Configure currency and preferences for this group.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="group-name">Group Name</Label>
            {/* rename existed in the store but had no UI */}
            <div className="flex gap-2">
              <Input
                id="group-name"
                value={nameDraft ?? doc.meta.name}
                maxLength={MAX_LENGTHS.groupName}
                onChange={e => setNameDraft(e.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                disabled={nameDraft === null || !nameDraft.trim() || nameDraft.trim() === doc.meta.name}
                onClick={() => {
                  if (nameDraft && renameGroup(groupId, nameDraft)) setNameDraft(null);
                }}
              >
                Save
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="currency">Default Currency</Label>
            <Select
              id="currency"
              value={doc.meta.settings.defaultCurrency}
              disabled={expenses.length > 0}
              onChange={e => updateSettings(groupId, { defaultCurrency: e.target.value })}
            >
              {SUPPORTED_CURRENCIES.map(c => (
                <option key={c.code} value={c.code}>
                  {c.symbol} {c.name} ({c.code})
                </option>
              ))}
            </Select>
            {/* balances add up every expense in one currency, so it can't change underneath them */}
            {expenses.length > 0 && (
              <p className="text-xs text-muted-foreground">Currency is locked once a group has expenses.</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="defaultSplit">Default Split Type</Label>
            <Select
              id="defaultSplit"
              value={doc.meta.settings.defaultSplitType}
              onChange={e => updateSettings(groupId, { defaultSplitType: e.target.value })}
            >
              <option value="equal">Equal</option>
              <option value="exact">Exact Amounts</option>
              <option value="percentage">Percentage</option>
              <option value="shares">Shares</option>
              <option value="by_weight">Weights</option>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="simplify"
              checked={doc.meta.settings.simplifyDebts}
              onChange={e => updateSettings(groupId, { simplifyDebts: e.target.checked })}
              className="rounded border-input"
            />
            <Label htmlFor="simplify">Simplify debts</Label>
          </div>

          <div className="space-y-2 pt-2 border-t">
            <Label>Categories</Label>
            <div className="flex flex-wrap gap-2">
              {getCategoryOptions(doc.meta.settings).map(c => (
                <Badge key={c.value} variant="secondary" className="flex items-center gap-1">
                  {c.label}
                  <button
                    type="button"
                    aria-label={`Remove ${c.label} category`}
                    onClick={() => removeCategory(groupId, c.value)}
                    className="hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                placeholder="Add custom category"
                value={newCategoryLabel}
                onChange={e => setNewCategoryLabel(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && newCategoryLabel.trim()) {
                    addCustomCategory(groupId, newCategoryLabel.trim());
                    setNewCategoryLabel('');
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                disabled={!newCategoryLabel.trim()}
                onClick={() => {
                  addCustomCategory(groupId, newCategoryLabel.trim());
                  setNewCategoryLabel('');
                }}
              >
                Add
              </Button>
            </div>
          </div>

          <div className="space-y-2 pt-2 border-t">
            <Label>Backup &amp; Export</Label>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" disabled={isBusy} onClick={handleExportJSON}>
                <Download className="h-4 w-4 mr-2" />
                Export JSON
              </Button>
              <Button type="button" variant="outline" disabled={isBusy} onClick={handleExportCSV}>
                <Download className="h-4 w-4 mr-2" />
                Export CSV
              </Button>
              <Button type="button" variant="outline" disabled={isBusy} onClick={() => importFileRef.current?.click()}>
                <Upload className="h-4 w-4 mr-2" />
                Import JSON
              </Button>
              <input
                ref={importFileRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) handleImportFile(file);
                  e.target.value = '';
                }}
              />
            </div>
            {importError && <p className="text-sm text-destructive">{importError}</p>}
            {exportMessage && <p className="text-sm text-success">{exportMessage}</p>}
            <p className="text-xs text-muted-foreground">
              JSON export includes all expenses, members and settings and can be re-imported here or on another
              device. CSV export includes expenses only, for use in spreadsheets.
            </p>
          </div>

          <div className="pt-4 border-t space-y-3">
            {isActive && (
              <Button variant="outline" className="w-full" onClick={() => changeState(groupId, 'archived')}>
                Archive Group
              </Button>
            )}
            {!confirmDelete ? (
              <Button
                variant="destructive"
                className="w-full"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete Group
              </Button>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-destructive font-medium text-center">
                  This will permanently delete this group and all its expenses.
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" className="flex-1" onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    className="flex-1"
                    disabled={isBusy}
                    onClick={async () => {
                      setIsBusy(true);
                      await deleteGroup(groupId);
                      navigate('/dashboard');
                    }}
                  >
                    Confirm Delete
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </Dialog>

      <Dialog open={pendingImport !== null} onOpenChange={open => { if (!open) setPendingImport(null); }}>
        <DialogHeader>
          <DialogTitle>Import a different group?</DialogTitle>
          <DialogDescription>
            This file is for "{pendingImport?.meta.name}", not "{doc.meta.name}". Importing merges it into that group
            on this device (or adds it if you don't have it).
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={() => setPendingImport(null)}>Cancel</Button>
          <Button
            className="flex-1"
            disabled={isBusy}
            onClick={async () => {
              if (!pendingImport) return;
              setIsBusy(true);
              try {
                await importDocument(pendingImport);
                setExportMessage(`Imported "${pendingImport.meta.name}".`);
              } catch (err) {
                setImportError(err instanceof Error ? err.message : 'Import failed');
              } finally {
                setIsBusy(false);
                setPendingImport(null);
              }
            }}
          >
            Import
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
