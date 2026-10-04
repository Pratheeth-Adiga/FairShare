// Test-only bridge for Playwright document shuttling.
// dev/test-only; production bundles tree-shake it away

import { useGroupsStore } from '@/stores/groups.store';
import { useIdentityStore } from '@/stores/identity.store';
import type { MemberProfile } from '@/types';

// Keep this in sync with e2e/global.d.ts for the Playwright tsconfig.
export interface FairShareTestBridge {
  getGroupDoc: (groupId: string) => unknown | undefined;
  getIdentityPeerId: () => string | undefined;
  getGroupIdByName: (name: string) => string | undefined;
  mergeRemoteDocument: (groupId: string, doc: unknown) => void;
  addMember: (groupId: string, member: MemberProfile) => void;
}

declare global {
  interface Window {
    __fairshare?: FairShareTestBridge;
  }
}

export function installTestBridge(): void {
  if (typeof window === 'undefined') return;
  if (!import.meta.env.DEV) return;
  const params = new URLSearchParams(window.location.search);
  if (params.get('e2eHook') !== '1') return;

  window.__fairshare = {
    getGroupDoc: (groupId) => useGroupsStore.getState().documents[groupId],
    getIdentityPeerId: () => useIdentityStore.getState().identity?.peerId,
    getGroupIdByName: (name) => {
      const list = useGroupsStore.getState().groupList;
      return list.find(g => g.name === name)?.id;
    },
    mergeRemoteDocument: (groupId, doc) => {
      useGroupsStore.getState().mergeRemoteDocument(groupId, doc as never);
    },
    addMember: (groupId, member) => {
      useGroupsStore.getState().addMember(groupId, member);
    },
  };
}
