// Keep the e2e-only bridge type available to the Node/Playwright project.

interface FairShareTestBridge {
  getGroupDoc: (groupId: string) => unknown | undefined;
  getIdentityPeerId: () => string | undefined;
  getGroupIdByName: (name: string) => string | undefined;
  mergeRemoteDocument: (groupId: string, doc: unknown) => void;
  addMember: (
    groupId: string,
    member: {
      peerId: string;
      displayName: string;
      avatar: string;
      joinedAt: string;
      updatedAt?: string;
      publicKey?: string;
    },
  ) => void;
}

declare global {
  interface Window {
    __fairshare?: FairShareTestBridge;
  }
}

export {};
