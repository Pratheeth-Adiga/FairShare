import { describe, it, expect, vi } from 'vitest';
import { createP2PNode, getP2PNode } from '@/lib/p2p/node';
import { generateIdentity } from '@/lib/crypto/identity';
import { createMessage, signP2PMessage } from '@/lib/p2p/message-protocol';

describe('createP2PNode singleton', () => {
  it('returns the same instance for repeated calls with the same peerId', () => {
    const a = createP2PNode('peer-node-test-a');
    const b = createP2PNode('peer-node-test-a');
    expect(a).toBe(b);
    expect(getP2PNode()).toBe(a);
  });

  it('creates a fresh instance and stops the previous one when peerId changes', () => {
    // Replacing an identity must replace and stop the cached node.
    const first = createP2PNode('peer-node-test-b');
    const stopSpy = vi.spyOn(first, 'stop');

    const second = createP2PNode('peer-node-test-c');

    expect(second).not.toBe(first);
    expect(second.peerId).toBe('peer-node-test-c');
    expect(getP2PNode()).toBe(second);
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('does not carry connection state over from the previous instance', () => {
    const first = createP2PNode('peer-node-test-e');
    first.connectedPeers.add('peer-someone');

    const second = createP2PNode('peer-node-test-f');

    expect(second.connectedPeers.size).toBe(0);
    expect(second.isStarted).toBe(false);
  });
});

// invalid or unverifiable messages must not reach group handlers
describe('P2P dispatch with fail-closed signature verification', () => {
  interface NodeWithDispatch {
    handleP2PMessage: (msg: unknown, viaPeerId: string) => Promise<void>;
  }

  async function runOne(scenario: {
    receiverPeerId: string;
    receiverPrivateKey?: string;
    senderIdentity: Awaited<ReturnType<typeof generateIdentity>>;
    tamper?: 'drop-signature' | 'wrong-signature' | 'wrong-from';
    registerSender?: boolean;
  }): Promise<{ handlerCalled: boolean; payload: string | undefined }> {
    const groupId = `g-${Math.random().toString(36).slice(2, 10)}`;
    const node = createP2PNode(scenario.receiverPeerId);
    await node.start(scenario.receiverPrivateKey);

    if (scenario.registerSender) {
      node.registerPeerKey(scenario.senderIdentity.peerId, scenario.senderIdentity.publicKey);
    }

    let handlerCalled = false;
    let receivedPayload: string | undefined;
    node.setupGroupSync(groupId, {
      onRemote: (data) => {
        handlerCalled = true;
        receivedPayload = data;
      },
      getLocal: () => null,
    });

    let msg = createMessage('document', groupId, scenario.senderIdentity.peerId, 'DOC-BODY');
    msg = await signP2PMessage(msg, scenario.senderIdentity.privateKey);
    if (scenario.tamper === 'drop-signature') {
      // Remove the key rather than setting it to undefined: that is what an
      // unsigned message from a peer actually looks like on the wire, and under
      // exactOptionalPropertyTypes the two are not interchangeable.
      const { signature: _dropped, ...unsigned } = msg;
      msg = unsigned;
    } else if (scenario.tamper === 'wrong-signature') {
      msg = { ...msg, signature: '00'.repeat(64) };
    } else if (scenario.tamper === 'wrong-from') {
      // Same signature, but claim a different sender: the derived pubkey will
      // no longer match the key that signed the message.
      const other = await generateIdentity('Impostor');
      msg = { ...msg, from: other.peerId };
    }

    // Reach directly into private dispatch (matches ConnectionManager onMessage).
    await (node as unknown as NodeWithDispatch).handleP2PMessage(msg, 'via-peer');
    await node.stop();

    return { handlerCalled, payload: receivedPayload };
  }

  it('accepts a properly signed document from a peer whose key can be derived from their peerId', async () => {
    const receiver = await generateIdentity('Receiver');
    const sender = await generateIdentity('Sender');
    const result = await runOne({
      receiverPeerId: receiver.peerId,
      receiverPrivateKey: receiver.privateKey,
      senderIdentity: sender,
    });
    expect(result.handlerCalled).toBe(true);
    expect(result.payload).toBe('DOC-BODY');
  });

  it('drops an unsigned document even when the sender is a resolvable peer', async () => {
    const receiver = await generateIdentity('Receiver');
    const sender = await generateIdentity('Sender');
    const result = await runOne({
      receiverPeerId: receiver.peerId,
      receiverPrivateKey: receiver.privateKey,
      senderIdentity: sender,
      tamper: 'drop-signature',
    });
    expect(result.handlerCalled).toBe(false);
  });

  it('drops a document with a forged signature (wrong bytes)', async () => {
    const receiver = await generateIdentity('Receiver');
    const sender = await generateIdentity('Sender');
    const result = await runOne({
      receiverPeerId: receiver.peerId,
      receiverPrivateKey: receiver.privateKey,
      senderIdentity: sender,
      tamper: 'wrong-signature',
    });
    expect(result.handlerCalled).toBe(false);
  });

  it('drops a document when the claimed `from` peerId does not match the signing key', async () => {
    const receiver = await generateIdentity('Receiver');
    const sender = await generateIdentity('Sender');
    const result = await runOne({
      receiverPeerId: receiver.peerId,
      receiverPrivateKey: receiver.privateKey,
      senderIdentity: sender,
      tamper: 'wrong-from',
    });
    expect(result.handlerCalled).toBe(false);
  });

  it('drops a signed document from a legacy 16-hex peerId whose key is not registered', async () => {
    const receiver = await generateIdentity('Receiver');
    const legacySender = await generateIdentity('LegacyPeer');
    // Force a legacy-style peerId that resolveSenderKey cannot derive.
    (legacySender as { peerId: string }).peerId = 'peer-a1b2c3d4e5f6a7b8';
    const result = await runOne({
      receiverPeerId: receiver.peerId,
      receiverPrivateKey: receiver.privateKey,
      senderIdentity: legacySender,
      // registerSender=false: sender is unregistered and legacy ID cannot be derived.
    });
    expect(result.handlerCalled).toBe(false);
  });

  it('accepts the same legacy-peerId document once the sender key is registered', async () => {
    const receiver = await generateIdentity('Receiver');
    const legacySender = await generateIdentity('LegacyPeer');
    (legacySender as { peerId: string }).peerId = 'peer-a1b2c3d4e5f6a7b8';
    const result = await runOne({
      receiverPeerId: receiver.peerId,
      receiverPrivateKey: receiver.privateKey,
      senderIdentity: legacySender,
      registerSender: true,
    });
    expect(result.handlerCalled).toBe(true);
  });

  // a keyless sender used to get through as a "direct bootstrap". Every session
  // now proves its id in the hello handshake, so nothing keyless is accepted at all.
  it('drops a signed document from an unregistered legacy peerId even from the direct peer', async () => {
    const receiver = await generateIdentity('Receiver');
    const legacySender = await generateIdentity('LegacyPeer');
    (legacySender as { peerId: string }).peerId = 'peer-a1b2c3d4e5f6a7b8';
    const groupId = `g-${Math.random().toString(36).slice(2, 10)}`;
    const node = createP2PNode(receiver.peerId);
    await node.start(receiver.privateKey);

    let called = false;
    node.setupGroupSync(groupId, { onRemote: () => { called = true; }, getLocal: () => null });
    let msg = createMessage('document', groupId, legacySender.peerId, 'DOC-BODY');
    msg = await signP2PMessage(msg, legacySender.privateKey);

    await (node as unknown as NodeWithDispatch).handleP2PMessage(msg, legacySender.peerId);
    await node.stop();

    expect(called).toBe(false);
  });
});

describe('P2P dispatch authorization', () => {
  interface NodeInternals {
    handleP2PMessage: (msg: unknown, viaPeerId: string) => Promise<void>;
  }

  // a sync-request is answered to the requester only
  it('answers a sync-request from a member with a document addressed to them', async () => {
    const receiver = await generateIdentity('Receiver');
    const member = await generateIdentity('Member');
    const groupId = `g-${Math.random().toString(36).slice(2, 10)}`;
    const node = createP2PNode(receiver.peerId);
    await node.start(receiver.privateKey);
    node.setupGroupSync(groupId, { onRemote: () => {}, getLocal: () => 'LOCAL-DOC' });
    const sendTo = vi.spyOn(node.connectionManager!, 'sendTo');

    const msg = await signP2PMessage({ ...createMessage('sync-request', groupId, member.peerId), to: receiver.peerId }, member.privateKey);
    await (node as unknown as NodeInternals).handleP2PMessage(msg, member.peerId);
    await vi.waitFor(() => expect(sendTo).toHaveBeenCalledTimes(1));

    const [via, reply] = sendTo.mock.calls[0];
    expect(via).toBe(member.peerId);
    expect(reply).toMatchObject({ type: 'document', to: member.peerId, payload: 'LOCAL-DOC' });
    await node.stop();
  });

  // a non-member can't make us gather ICE and hand over our addresses
  it('ignores an introduce-request from a non-member', async () => {
    const receiver = await generateIdentity('Receiver');
    const stranger = await generateIdentity('Stranger');
    const groupId = `g-${Math.random().toString(36).slice(2, 10)}`;
    const node = createP2PNode(receiver.peerId);
    await node.start(receiver.privateKey);
    node.setupGroupSync(groupId, { onRemote: () => {}, getLocal: () => null });
    node.setMembershipVerifier((peerId) => peerId !== stranger.peerId);
    const createOffer = vi.spyOn(node.connectionManager!, 'createOffer');

    const msg = await signP2PMessage({ ...createMessage('introduce-request', groupId, stranger.peerId), to: receiver.peerId }, stranger.privateKey);
    await (node as unknown as NodeInternals).handleP2PMessage(msg, stranger.peerId);

    expect(createOffer).not.toHaveBeenCalled();
    await node.stop();
  });

  // an unsolicited offer (e.g. one claiming to be a placeholder) is dropped
  it('ignores an introduce-offer nobody asked for', async () => {
    const receiver = await generateIdentity('Receiver');
    const member = await generateIdentity('Member');
    const groupId = `g-${Math.random().toString(36).slice(2, 10)}`;
    const node = createP2PNode(receiver.peerId);
    await node.start(receiver.privateKey);
    node.setupGroupSync(groupId, { onRemote: () => {}, getLocal: () => null });
    const acceptOffer = vi.spyOn(node.connectionManager!, 'acceptOffer');

    const msg = await signP2PMessage({ ...createMessage('introduce-offer', groupId, member.peerId, 'FS3:whatever'), to: receiver.peerId }, member.privateKey);
    await (node as unknown as NodeInternals).handleP2PMessage(msg, member.peerId);

    expect(acceptOffer).not.toHaveBeenCalled();
    await node.stop();
  });

  it('remembers an admitted joiner for a while', async () => {
    const node = createP2PNode('peer-admission-test');
    node.admitPeer('peer-joiner', 'g1');
    expect(node.isAdmitted('peer-joiner', 'g1')).toBe(true);
    expect(node.isAdmitted('peer-joiner', 'g2')).toBe(false);
    expect(node.isAdmitted('peer-other', 'g1')).toBe(false);
  });
});
