import { describe, it, expect, beforeAll } from 'vitest';
import { generateIdentity } from '@/lib/crypto/identity';
import { createMessage, signP2PMessage } from '@/lib/p2p/message-protocol';
import { getP2PNode } from '@/lib/p2p/node';
import * as ops from '@/lib/crdt/operations';
import { useGroupsStore } from '@/stores/groups.store';
import { useSyncStore } from '@/stores/sync.store';
import { useIdentityStore } from '@/stores/identity.store';
import type { UserIdentity } from '@/types';

// the join used to be tested only through the e2e test bridge, which skips
// the real verifier. This runs the joiner's "add me" document through the actual node,
// sync store and groups store (only the WebRTC transport is left out).

interface NodeInternals {
  handleP2PMessage: (msg: unknown, viaPeerId: string) => Promise<void>;
}

async function deliver(from: UserIdentity, groupId: string, payload: string): Promise<void> {
  const msg = await signP2PMessage(createMessage('document', groupId, from.peerId, payload), from.privateKey);
  await (getP2PNode() as unknown as NodeInternals).handleP2PMessage(msg, from.peerId);
}

async function startAs(identity: UserIdentity): Promise<void> {
  useIdentityStore.setState({ identity, needsPassphrase: false, loadError: null });
  await useSyncStore.getState().initializeP2P(identity.peerId, identity.privateKey);
}

describe('QR join round trip', () => {
  let creator: UserIdentity;
  let joiner: UserIdentity;

  beforeAll(async () => {
    creator = await generateIdentity('Creator');
    joiner = await generateIdentity('Joiner');
  });

  it('adds a QR-paired joiner on the creator side, and only that joiner record', async () => {
    await startAs(creator);
    const groupId = await useGroupsStore.getState().createGroup('Trip', 'INR', creator.peerId, creator.displayName, creator.publicKey);
    useSyncStore.getState().subscribeToGroup(groupId);

    // what the joiner sends back after adding itself to its copy
    const joinerCopy = ops.renameGroup(ops.addMember(useGroupsStore.getState().documents[groupId], {
      peerId: joiner.peerId,
      displayName: joiner.displayName,
      avatar: '',
      joinedAt: new Date().toISOString(),
      publicKey: joiner.publicKey,
    }), 'Hijacked');

    // not paired yet: dropped, same as before
    await deliver(joiner, groupId, JSON.stringify(joinerCopy));
    expect(useGroupsStore.getState().documents[groupId].members[joiner.peerId]).toBeUndefined();

    // the creator scanned the joiner's answer
    getP2PNode()!.admitPeer(joiner.peerId, groupId);
    await deliver(joiner, groupId, JSON.stringify(joinerCopy));

    const doc = useGroupsStore.getState().documents[groupId];
    expect(doc.members[joiner.peerId]?.publicKey).toBe(joiner.publicKey);
    // only the member record was taken, not the rest of the joiner's document
    expect(doc.meta.name).toBe('Trip');
  });

  // a removed device used to add itself straight back after any merge
  it('does not let a removed device re-add itself on the next sync', async () => {
    await startAs(creator);
    const groupId = await useGroupsStore.getState().createGroup('Flat', 'INR', creator.peerId, creator.displayName, creator.publicKey);
    let shared = ops.addMember(useGroupsStore.getState().documents[groupId], {
      peerId: joiner.peerId, displayName: joiner.displayName, avatar: '', joinedAt: new Date().toISOString(), publicKey: joiner.publicKey,
    });
    const beforeRemoval = shared;
    shared = ops.removeMember(shared, joiner.peerId);

    // the removed device still has its old copy with itself in it
    await startAs(joiner);
    useGroupsStore.setState(state => { state.documents[groupId] = beforeRemoval; });
    useSyncStore.getState().subscribeToGroup(groupId);

    await deliver(creator, groupId, JSON.stringify(shared));

    const doc = useGroupsStore.getState().documents[groupId];
    expect(doc.members[joiner.peerId]).toBeUndefined();
    expect(doc.formerMembers?.[joiner.peerId]).toBeDefined();
  });

  it('adds the local user on the first copy of a group it is joining', async () => {
    await startAs(creator);
    const groupId = await useGroupsStore.getState().createGroup('Ski', 'INR', creator.peerId, creator.displayName, creator.publicKey);
    const creatorCopy = useGroupsStore.getState().documents[groupId];

    await startAs(joiner);
    useGroupsStore.setState(state => { delete state.documents[groupId]; });
    useSyncStore.getState().joinGroup(groupId);

    await deliver(creator, groupId, JSON.stringify(creatorCopy));

    expect(useGroupsStore.getState().documents[groupId].members[joiner.peerId]).toBeDefined();
  });

  it('drops a document whose meta.id is a different group', async () => {
    await startAs(creator);
    const groupA = await useGroupsStore.getState().createGroup('A', 'INR', creator.peerId, creator.displayName, creator.publicKey);
    const groupB = await useGroupsStore.getState().createGroup('B', 'INR', creator.peerId, creator.displayName, creator.publicKey);
    useGroupsStore.getState().addMember(groupA, {
      peerId: joiner.peerId, displayName: joiner.displayName, avatar: '', joinedAt: new Date().toISOString(), publicKey: joiner.publicKey,
    });
    useSyncStore.getState().subscribeToGroup(groupA);
    const before = useGroupsStore.getState().documents[groupA];

    await deliver(joiner, groupA, JSON.stringify(useGroupsStore.getState().documents[groupB]));

    expect(useGroupsStore.getState().documents[groupA]).toBe(before);
  });
});
