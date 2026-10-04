// validate untrusted input at the edges before it reaches app state
import { z } from 'zod';
import { MAX_LENGTHS } from '@/lib/utils/validation';
import { publicKeyFromPeerId } from '@/lib/crypto/identity';

// ---------------------------------------------------------------------------
// P2P message ingestion (message-protocol.ts deserializeMessage)
// ---------------------------------------------------------------------------

// re-export the wire schema so message validation has one source of truth
export { p2pMessageSchema, p2pMessageTypeSchema } from '@/lib/p2p/message-protocol';

// ---------------------------------------------------------------------------
// GroupDocument (loaded from IndexedDB, and from group export files)
// ---------------------------------------------------------------------------

// bound peer IDs because they become object keys and persisted data
const MAX_PEER_ID_LENGTH = 128;
const peerIdSchema = z.string().max(MAX_PEER_ID_LENGTH);

// reject negative and non-finite amounts at the schema boundary, and round to whole
// cents instead of rejecting (rejecting brings back an old unloadable-doc bug).
const centsSchema = z.number().min(0).finite().transform(Math.round);
const payerSchema = z.object({ userId: peerIdSchema, amount: centsSchema });
const splitSchema = z.object({ userId: peerIdSchema, amount: centsSchema });
// bound free-text fields at the schema boundary
const expenseItemSchema = z.object({
  name: z.string().max(MAX_LENGTHS.itemName),
  amount: centsSchema,
  assignees: z.array(peerIdSchema),
});
const expenseCommentSchema = z.object({
  id: z.string(),
  authorId: peerIdSchema,
  // cap comment length; min(1) mirrors the non-empty check in addComment
  text: z.string().min(1).max(2000),
  createdAt: z.string(),
});
const expenseEditRecordSchema = z.object({
  editedAt: z.string(),
  editedBy: peerIdSchema,
  changes: z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() })),
});

const expenseSchema = z.object({
  id: z.string(),
  groupId: z.string().nullable(),
  friendId: z.string().nullable(),
  description: z.string().max(MAX_LENGTHS.expenseDescription),
  totalAmount: centsSchema,
  currency: z.string(),
  payers: z.array(payerSchema),
  splitType: z.enum(['equal', 'exact', 'percentage', 'shares', 'by_weight', 'itemized']),
  splits: z.array(splitSchema),
  items: z.array(expenseItemSchema),
  category: z.string(),
  categories: z.array(z.string()).optional(),
  date: z.string(),
  createdAt: z.string(),
  createdBy: peerIdSchema,
  notes: z.string().max(MAX_LENGTHS.notes),
  updatedAt: z.string().optional(),
  // preserve raw share/weight inputs when documents cross the schema
  splitInputs: z.record(peerIdSchema, z.number().finite()).optional(),
  comments: z.array(expenseCommentSchema).optional(),
  editHistory: z.array(expenseEditRecordSchema).optional(),
});

const settlementSchema = z.object({
  id: z.string(),
  groupId: z.string(),
  from: peerIdSchema,
  to: peerIdSchema,
  amount: z.number().positive().finite().transform(Math.round),
  date: z.string(),
  note: z.string().max(MAX_LENGTHS.notes),
  settlesExpenses: z.array(z.string()),
  updatedAt: z.string().optional(),
});

const customCategorySchema = z.object({ id: z.string(), label: z.string().max(MAX_LENGTHS.categoryLabel) });

export const groupSettingsSchema = z.object({
  defaultCurrency: z.string(),
  defaultSplitType: z.string(),
  simplifyDebts: z.boolean(),
  settleThreshold: z.number().min(0).finite(),
  roundingAssignee: z.enum(['payer', 'first_member']),
  requireApproval: z.boolean(),
  invitePermission: z.enum(['any_member', 'creator_only', 'majority']),
  customCategories: z.array(customCategorySchema),
  disabledCategories: z.array(z.string()),
});

const memberProfileSchema = z.object({
  peerId: peerIdSchema,
  displayName: z.string().max(MAX_LENGTHS.displayName),
  avatar: z.string(),
  joinedAt: z.string(),
  updatedAt: z.string().optional(),
  // keep member public keys so joiners can verify signatures
  publicKey: z.string().max(512).optional(),
  isManualPlaceholder: z.boolean().optional(),
});

export const groupDocumentSchema = z.object({
  meta: z.object({
    id: z.string(),
    name: z.string().max(MAX_LENGTHS.groupName),
    settings: groupSettingsSchema,
    state: z.enum(['active', 'settling', 'archived', 'closed']),
    createdBy: peerIdSchema,
    createdAt: z.string(),
    settingsUpdatedAt: z.string().optional(),
    nameUpdatedAt: z.string().optional(),
    stateUpdatedAt: z.string().optional(),
  }),
  // the map key is that same peerId, so it needs the same bound - an
  // oversized key paired with a short peerId field would otherwise slip through.
  members: z.record(peerIdSchema, memberProfileSchema),
  formerMembers: z.record(peerIdSchema, memberProfileSchema).optional(),
  expenses: z.record(z.string(), expenseSchema),
  settlements: z.record(z.string(), settlementSchema),
  deleted: z.record(z.string(), z.string()),
  version: z.number().optional(),
});

// ---------------------------------------------------------------------------
// User-supplied import files (Settings/GroupDetail "Import" buttons)
// ---------------------------------------------------------------------------

export const groupExportFileSchema = z.object({
  fileFormat: z.literal('fairshare-group-export'),
  version: z.literal(1),
  exportedAt: z.string(),
  document: groupDocumentSchema,
});

function truncateAt(root: unknown, path: PropertyKey[], max: number): void {
  let node: unknown = root;
  for (const key of path.slice(0, -1)) {
    if (!node || typeof node !== 'object') return;
    node = (node as Record<PropertyKey, unknown>)[key];
  }
  const last = path[path.length - 1];
  if (!node || typeof node !== 'object' || last === undefined) return;
  const holder = node as Record<PropertyKey, unknown>;
  const value = holder[last];
  if (typeof value === 'string') holder[last] = value.slice(0, max);
}

// one over-long string used to make a whole group unloadable (and kill its
// sync). Cut those strings to their cap and parse again instead of dropping the doc.
export function parseGroupDocument(raw: unknown):
  | { success: true; data: z.infer<typeof groupDocumentSchema>; repaired: boolean }
  | { success: false; error: z.ZodError } {
  let value = raw;
  let repaired = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = groupDocumentSchema.safeParse(value);
    if (result.success) return { success: true, data: result.data, repaired };
    const tooLong = result.error.issues.filter(issue => issue.code === 'too_big' && issue.origin === 'string');
    if (tooLong.length === 0) return { success: false, error: result.error };
    if (!repaired) {
      value = structuredClone(value);
      repaired = true;
    }
    for (const issue of tooLong) {
      if (issue.code === 'too_big') truncateAt(value, issue.path, Number(issue.maximum));
    }
  }
  return { success: false, error: groupDocumentSchema.safeParse(value).error! };
}

// old 16-hex-char ids or new 64-hex-char ids, e.g. peer-a1b2c3...
const PEER_ID_FORMAT = /^peer-(?:[0-9a-f]{16}|[0-9a-f]{64})$/i;

// shape alone let a mismatched key pair, an enc1: key or a path-like peerId through
export const userIdentitySchema = z.object({
  peerId: z.string().regex(PEER_ID_FORMAT, 'not a FairShare peer id'),
  publicKey: z.string().regex(/^[0-9a-f]{64}$/i, 'must be a 64-character hex Ed25519 key'),
  // PKCS#8 hex. An encrypted (enc1:) key has no business in a restore file.
  privateKey: z.string().regex(/^[0-9a-f]+$/i, 'must be an unencrypted hex private key').max(512),
  // older exports can carry longer names, trim instead of refusing the restore
  displayName: z.string().transform(name => name.slice(0, MAX_LENGTHS.displayName)),
  avatar: z.string().max(10_000),
  createdAt: z.string(),
}).refine(identity => {
  const derived = publicKeyFromPeerId(identity.peerId);
  return !derived || derived === identity.publicKey.toLowerCase();
}, { message: 'peerId does not match the public key', path: ['peerId'] });

export const identityExportFileSchema = z.object({
  fileFormat: z.literal('fairshare-identity-export'),
  version: z.literal(1),
  exportedAt: z.string(),
  identity: userIdentitySchema,
});

// Formats a ZodError into a short user-facing message (first issue only).
export function formatZodError(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return 'Invalid data.';
  const path = first.path.join('.');
  return path ? `${path}: ${first.message}` : first.message;
}
