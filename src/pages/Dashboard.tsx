import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Users, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Header } from '@/components/layout/Header';
import { useGroupsStore } from '@/stores/groups.store';
import { useIdentityStore } from '@/stores/identity.store';
import { formatCents } from '@/lib/utils/currency';
import { CreateGroupDialog } from '@/components/group/CreateGroupDialog';

export function Dashboard() {
  const [showCreate, setShowCreate] = useState(false);
  const identity = useIdentityStore(s => s.identity);
  const groupList = useGroupsStore(s => s.groupList);
  const documents = useGroupsStore(s => s.documents);
  const getBalances = useGroupsStore(s => s.getBalances);
  const navigate = useNavigate();

  // the document is the source of truth, the StoredGroup copy can lag behind it
  const currencyOf = (groupId: string, fallback: string) =>
    documents[groupId]?.meta.settings.defaultCurrency ?? fallback;

  // bucket the aggregate net-balance by currency instead of summing cents
  // across mixed currencies and rendering the total in whichever currency the
  // first group happened to use.
  const balanceByCurrency: Record<string, number> = {};
  if (identity) {
    for (const group of groupList) {
      const bal = getBalances(group.id)[identity.peerId] || 0;
      const currency = currencyOf(group.id, group.currency);
      balanceByCurrency[currency] = (balanceByCurrency[currency] || 0) + bal;
    }
  }
  const currencies = Object.keys(balanceByCurrency).filter(c => balanceByCurrency[c] !== 0);
  const singleCurrency = currencies.length === 1 ? currencies[0] : null;
  const singleTotal = singleCurrency ? balanceByCurrency[singleCurrency] : 0;

  return (
    <div className="flex flex-col">
      <Header
        title="FairShare"
        rightAction={
          <div className="flex gap-1">
            <Button variant="ghost" size="icon" title="Join group" onClick={() => navigate('/join')}>
              <UserPlus className="h-5 w-5" />
            </Button>
            <Button variant="ghost" size="icon" title="Create group" onClick={() => setShowCreate(true)}>
              <Plus className="h-5 w-5" />
            </Button>
          </div>
        }
      />

      <div className="p-4 space-y-4">
        {/* Net balance summary */}
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Overall balance</p>
            {currencies.length === 0 ? (
              <p className="text-2xl font-bold text-muted-foreground">Settled up</p>
            ) : singleCurrency ? (
              <p className={`text-2xl font-bold ${singleTotal >= 0 ? 'text-success' : 'text-destructive'}`}>
                {singleTotal >= 0 ? 'You are owed ' : 'You owe '}
                {formatCents(Math.abs(singleTotal), singleCurrency)}
              </p>
            ) : (
              <div className="space-y-0.5">
                {currencies.map(c => {
                  const amt = balanceByCurrency[c];
                  return (
                    <p key={c} className={`text-lg font-semibold ${amt >= 0 ? 'text-success' : 'text-destructive'}`}>
                      {amt >= 0 ? 'You are owed ' : 'You owe '}
                      {formatCents(Math.abs(amt), c)}
                    </p>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Group list */}
        {groupList.length === 0 ? (
          <div className="text-center py-12">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
              <Users className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="font-medium mb-1">No groups yet</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Create or join a group to start splitting expenses
            </p>
            <Button onClick={() => setShowCreate(true)}>Create Group</Button>
          </div>
        ) : (
          <div className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Groups</h2>
            {groupList.map(group => {
              const doc = documents[group.id];
              const memberCount = doc ? Object.keys(doc.members).length : 0;
              const balance = identity ? (getBalances(group.id)[identity.peerId] || 0) : 0;

              return (
                <Card
                  key={group.id}
                  className="cursor-pointer hover:bg-accent/50 transition-colors"
                  onClick={() => navigate(`/group/${group.id}`)}
                >
                  <CardContent className="p-4 flex items-center justify-between">
                    <div>
                      <p className="font-medium">{doc?.meta.name ?? group.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {memberCount} member{memberCount !== 1 ? 's' : ''}
                        {doc && doc.meta.state !== 'active' && ` · ${doc.meta.state}`}
                      </p>
                    </div>
                    <div className="text-right">
                      {balance !== 0 && (
                        <p className={`text-sm font-medium ${balance > 0 ? 'text-success' : 'text-destructive'}`}>
                          {balance > 0 ? '+' : ''}{formatCents(balance, currencyOf(group.id, group.currency))}
                        </p>
                      )}
                      {balance === 0 && (
                        <p className="text-sm text-muted-foreground">settled</p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <CreateGroupDialog open={showCreate} onOpenChange={setShowCreate} />
    </div>
  );
}
