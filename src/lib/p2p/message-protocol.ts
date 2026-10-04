import { z } from 'zod';

// v2: hello handshake and the JSON signable encoding. v1 peers can't verify v2 messages.
export const PROTOCOL_VERSION = 2;

export type P2PMessageType =
  | 'sync-request'
  | 'document'
  | 'ping'
  | 'pong'
  | 'hello'
  | 'hello-proof'
  | 'peer-announce'
  | 'introduce-request'
  | 'introduce-offer'
  | 'introduce-answer';

export interface P2PMessage {
  id: string;
  type: P2PMessageType;
  groupId: string;
  from: string;
  hopCount: number;
  timestamp: string;
  payload?: string;
  signature?: string;
  // Final destination peerId for messages that must be relayed through an
  // intermediate peer (peer introduction). Absent for normal broadcast messages.
  to?: string;
  protocolVersion?: number;
}

export const p2pMessageTypeSchema = z.enum([
  'sync-request', 'document', 'ping', 'pong', 'hello', 'hello-proof',
  'peer-announce', 'introduce-request', 'introduce-offer', 'introduce-answer',
]);

// connection-level messages, they may omit groupId.
export const CONTROL_MESSAGE_TYPES: ReadonlySet<P2PMessageType> = new Set<P2PMessageType>(['ping', 'pong', 'hello', 'hello-proof', 'peer-announce']);

// caps payload to 2 MB to prevent memory exhaustion from oversized peer messages.
// this is the single authoritative wire schema. lib/validation/schemas.ts
// re-exports it rather than declaring a second, subtly different copy.
export const p2pMessageSchema = z.object({
  // ids sit in the seen-set for minutes, so keep them short
  id: z.string().min(1).max(64),
  type: p2pMessageTypeSchema,
  groupId: z.string().max(256),
  from: z.string().min(1).max(256),
  hopCount: z.number().int().min(0),
  timestamp: z.string().min(1),
  payload: z.string().max(2_000_000).optional(), // cap payload to 2 MB to prevent memory exhaustion from oversized peer messages
  signature: z.string().max(256).optional(),
  to: z.string().max(256).optional(),
  protocolVersion: z.number().int().optional(),
}).superRefine((msg, ctx) => {
  if (!CONTROL_MESSAGE_TYPES.has(msg.type) && msg.groupId.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['groupId'],
      message: `groupId is required for message type "${msg.type}"`,
    });
  }
});

export function createMessage(
  type: P2PMessageType,
  groupId: string,
  from: string,
  payload?: string
): P2PMessage {
  return {
    id: crypto.randomUUID(),
    type,
    groupId,
    from,
    hopCount: 0,
    timestamp: new Date().toISOString(),
    // omit undefined payloads so local and wire objects match.
    ...(payload !== undefined ? { payload } : {}),
    protocolVersion: PROTOCOL_VERSION,
  };
}

export function serializeMessage(msg: P2PMessage): string {
  return JSON.stringify(msg);
}

export function deserializeMessage(data: string): P2PMessage | null {
  try {
    const parsed = JSON.parse(data);
    const result = p2pMessageSchema.safeParse(parsed);
    if (!result.success) return null;
    const msg = result.data as P2PMessage;
    // Reject messages from peers running a newer, incompatible protocol version
    if (msg.protocolVersion !== undefined && msg.protocolVersion > PROTOCOL_VERSION) return null;
    return msg;
  } catch {
    return null;
  }
}

// true only when deserializeMessage dropped this exact payload for being a newer
// protocol version, so callers can tell that apart from plain garbage/corruption
export function isNewerProtocolMessage(data: string): boolean {
  try {
    const result = p2pMessageSchema.safeParse(JSON.parse(data));
    return result.success && result.data.protocolVersion !== undefined && result.data.protocolVersion > PROTOCOL_VERSION;
  } catch {
    return false;
  }
}

const MAX_HOP_COUNT = 3;

export function shouldRelay(msg: P2PMessage): boolean {
  return msg.hopCount < MAX_HOP_COUNT;
}

export function incrementHop(msg: P2PMessage): P2PMessage {
  return { ...msg, hopCount: msg.hopCount + 1 };
}

// a JSON array has no ambiguous field boundaries, unlike joining on ':'
export function getSignableContent(msg: P2PMessage): string {
  return JSON.stringify([msg.id, msg.type, msg.groupId, msg.from, msg.timestamp, msg.payload ?? '', msg.to ?? '']);
}

export async function signP2PMessage(msg: P2PMessage, privateKeyHex: string): Promise<P2PMessage> {
  const { signMessage } = await import('@/lib/crypto/identity');
  const content = getSignableContent(msg);
  const signature = await signMessage(privateKeyHex, content);
  return { ...msg, signature };
}

export async function verifyP2PMessage(msg: P2PMessage, publicKeyHex: string): Promise<boolean> {
  if (!msg.signature) return false;
  const { verifySignature } = await import('@/lib/crypto/identity');
  const content = getSignableContent(msg);
  return verifySignature(publicKeyHex, content, msg.signature);
}
