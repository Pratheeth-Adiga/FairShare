import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Dashboard } from '@/pages/Dashboard';
import type { GroupDocument } from '@/lib/crdt/document';
import type { StoredGroup } from '@/lib/storage/database';
import { DEFAULT_GROUP_SETTINGS } from '@/types/group';

// Dashboard consumes the whole store via destructuring, so the mock must be
// tolerant of both selector-style and no-selector calls.
function makeStoreHook<State>(state: State) {
  return (selector?: (s: State) => unknown) => (selector ? selector(state) : state);
}

function makeDoc(id: string, memberIds: string[]): GroupDocument {
  const now = new Date().toISOString();
  return {
    meta: { id, name: `Group ${id}`, settings: DEFAULT_GROUP_SETTINGS, state: 'active', createdBy: memberIds[0], createdAt: now },
    members: Object.fromEntries(memberIds.map(m => [m, { peerId: m, displayName: m, avatar: '', joinedAt: now }])),
    expenses: {},
    settlements: {},
    deleted: {},
  };
}

function renderDashboard(state: {
  groupList: StoredGroup[];
  documents: Record<string, GroupDocument>;
  balances: Record<string, Record<string, number>>;
  identity: { peerId: string; displayName: string } | null;
}) {
  vi.doMock('@/stores/groups.store', () => ({
    useGroupsStore: makeStoreHook({
      groupList: state.groupList,
      documents: state.documents,
      getBalances: (gid: string) => state.balances[gid] || {},
    }),
  }));
  vi.doMock('@/stores/identity.store', () => ({
    useIdentityStore: makeStoreHook({ identity: state.identity }),
  }));
  return import('@/pages/Dashboard').then(({ Dashboard: D }) =>
    render(
      <MemoryRouter>
        <D />
      </MemoryRouter>
    )
  );
}

describe('Dashboard', () => {
  it('renders the empty-state prompt when there are no groups', () => {
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );
    expect(screen.getByText(/no groups yet/i)).toBeInTheDocument();
  });

  it('shows the derived member count and per-group balance', async () => {
    vi.resetModules();
    const doc = makeDoc('g1', ['peer-me', 'peer-a', 'peer-b']);
    await renderDashboard({
      groupList: [{ id: 'g1', name: 'Trip', topic: 'g1', createdAt: '', state: 'active', memberCount: 999, currency: 'INR' }],
      documents: { g1: doc },
      balances: { g1: { 'peer-me': 5000 } }, // owed ₹50
      identity: { peerId: 'peer-me', displayName: 'Me' },
    });

    // Derived from doc.members regardless of the stale memberCount mirror.
    expect(screen.getByText(/3 members/i)).toBeInTheDocument();
    expect(screen.getByText(/\+₹50\.00/)).toBeInTheDocument();
    expect(screen.getByText(/you are owed ₹50\.00/i)).toBeInTheDocument();
    vi.resetModules();
  });

  it('shows "settled" when the balance is zero', async () => {
    vi.resetModules();
    const doc = makeDoc('g1', ['peer-me', 'peer-a']);
    await renderDashboard({
      groupList: [{ id: 'g1', name: 'Trip', topic: 'g1', createdAt: '', state: 'active', memberCount: 2, currency: 'INR' }],
      documents: { g1: doc },
      balances: { g1: { 'peer-me': 0 } },
      identity: { peerId: 'peer-me', displayName: 'Me' },
    });
    expect(screen.getByText(/^settled$/i)).toBeInTheDocument();
    vi.resetModules();
  });
});
