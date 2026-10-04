import { describe, it, expect } from 'vitest';
import {
  createMessage,
  serializeMessage,
  deserializeMessage,
  shouldRelay,
  incrementHop,
  getSignableContent,
  signP2PMessage,
  verifyP2PMessage,
  PROTOCOL_VERSION,
} from '@/lib/p2p/message-protocol';
import { generateIdentity } from '@/lib/crypto/identity';

describe('createMessage', () => {
  it('stamps hopCount 0 and the current protocol version', () => {
    const msg = createMessage('ping', 'group-1', 'peer-alice');
    expect(msg.hopCount).toBe(0);
    expect(msg.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(msg.groupId).toBe('group-1');
    expect(msg.from).toBe('peer-alice');
    expect(msg.type).toBe('ping');
    expect(typeof msg.id).toBe('string');
    expect(msg.id.length).toBeGreaterThan(0);
  });
});

describe('serializeMessage / deserializeMessage', () => {
  it('round-trips a valid message', () => {
    const msg = createMessage('document', 'group-1', 'peer-alice', 'payload-data');
    const deserialized = deserializeMessage(serializeMessage(msg));
    expect(deserialized).toEqual(msg);
  });

  it('returns null for invalid JSON', () => {
    expect(deserializeMessage('not json {{{')).toBeNull();
  });

  it('returns null for JSON that does not match the message schema', () => {
    expect(deserializeMessage(JSON.stringify({ foo: 'bar' }))).toBeNull();
    expect(deserializeMessage(JSON.stringify({ id: 1, type: 'ping', groupId: 'g', from: 'p', hopCount: 0, timestamp: 'x' }))).toBeNull();
  });

  it('rejects a message with an unsupported (newer) protocol version', () => {
    const msg = createMessage('ping', 'group-1', 'peer-alice');
    const future = { ...msg, protocolVersion: PROTOCOL_VERSION + 1 };
    expect(deserializeMessage(JSON.stringify(future))).toBeNull();
  });

  it('accepts a message with no protocolVersion field for legacy compatibility', () => {
    const msg = createMessage('ping', 'group-1', 'peer-alice');
    const legacy: Record<string, unknown> = { ...msg };
    delete legacy.protocolVersion;
    const deserialized = deserializeMessage(JSON.stringify(legacy));
    expect(deserialized).not.toBeNull();
    expect(deserialized?.id).toBe(msg.id);
  });

  it('rejects messages whose payload exceeds the 2MB cap', () => {
    const msg = createMessage('document', 'group-1', 'peer-alice');
    // Payload is 2,000,001 characters (one byte over the 2 MB limit).
    const oversized = { ...msg, payload: 'x'.repeat(2_000_001) };
    expect(deserializeMessage(JSON.stringify(oversized))).toBeNull();
  });

  it('accepts messages whose payload is exactly at the 2MB cap', () => {
    const msg = createMessage('document', 'group-1', 'peer-alice');
    const atLimit = { ...msg, payload: 'x'.repeat(2_000_000) };
    expect(deserializeMessage(JSON.stringify(atLimit))).not.toBeNull();
  });
});

describe('shouldRelay / incrementHop', () => {
  it('allows relaying under the max hop count and stops at the limit', () => {
    let msg = createMessage('ping', 'group-1', 'peer-alice');
    expect(shouldRelay(msg)).toBe(true);
    msg = incrementHop(msg);
    msg = incrementHop(msg);
    msg = incrementHop(msg);
    expect(msg.hopCount).toBe(3);
    expect(shouldRelay(msg)).toBe(false);
  });
});

describe('signP2PMessage / verifyP2PMessage', () => {
  it('signs a message such that it verifies against the signer public key', async () => {
    const identity = await generateIdentity('Alice');
    const msg = createMessage('document', 'group-1', identity.peerId, 'payload');
    const signed = await signP2PMessage(msg, identity.privateKey);
    expect(signed.signature).toBeTruthy();
    const ok = await verifyP2PMessage(signed, identity.publicKey);
    expect(ok).toBe(true);
  });

  it('fails verification if the message is tampered with after signing', async () => {
    const identity = await generateIdentity('Alice');
    const msg = createMessage('document', 'group-1', identity.peerId, 'payload');
    const signed = await signP2PMessage(msg, identity.privateKey);
    const tampered = { ...signed, payload: 'tampered-payload' };
    const ok = await verifyP2PMessage(tampered, identity.publicKey);
    expect(ok).toBe(false);
  });

  it('fails verification against the wrong public key', async () => {
    const alice = await generateIdentity('Alice');
    const bob = await generateIdentity('Bob');
    const msg = createMessage('document', 'group-1', alice.peerId, 'payload');
    const signed = await signP2PMessage(msg, alice.privateKey);
    const ok = await verifyP2PMessage(signed, bob.publicKey);
    expect(ok).toBe(false);
  });

  it('returns false for an unsigned message', async () => {
    const identity = await generateIdentity('Alice');
    const msg = createMessage('document', 'group-1', identity.peerId, 'payload');
    const ok = await verifyP2PMessage(msg, identity.publicKey);
    expect(ok).toBe(false);
  });

  it('getSignableContent changes when any signable field changes', () => {
    const msg = createMessage('document', 'group-1', 'peer-alice', 'payload');
    const base = getSignableContent(msg);
    expect(getSignableContent({ ...msg, payload: 'other' })).not.toBe(base);
    expect(getSignableContent({ ...msg, from: 'peer-bob' })).not.toBe(base);
    expect(getSignableContent({ ...msg, groupId: 'group-2' })).not.toBe(base);
  });

  it('getSignableContent excludes hopCount so relayed messages still verify', () => {
    const msg = createMessage('document', 'group-1', 'peer-alice', 'payload');
    const base = getSignableContent(msg);
    // hopCount is mutated by every relay hop; if it were in the signed content,
    // any relayed message would fail verification on the receiving side.
    expect(getSignableContent(incrementHop(msg))).toBe(base);
    expect(getSignableContent({ ...msg, hopCount: 5 })).toBe(base);
  });

  it('a signature on a message still verifies after the hopCount is bumped by relays', async () => {
    const identity = await generateIdentity('Alice');
    const msg = createMessage('document', 'group-1', identity.peerId, 'payload');
    const signed = await signP2PMessage(msg, identity.privateKey);
    const relayed = incrementHop(incrementHop(signed));
    const ok = await verifyP2PMessage(relayed, identity.publicKey);
    expect(ok).toBe(true);
  });
});
