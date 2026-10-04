import type { GroupDocument } from '@/lib/crdt/document';
import type { UserIdentity } from '@/types';
import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { parseGroupDocument, userIdentitySchema, formatZodError } from '@/lib/validation/schemas';

export interface GroupExportFile {
  fileFormat: 'fairshare-group-export';
  version: 1;
  exportedAt: string;
  document: GroupDocument;
}

export function exportGroupToJSON(doc: GroupDocument): string {
  const file: GroupExportFile = {
    fileFormat: 'fairshare-group-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    document: doc,
  };
  return JSON.stringify(file, null, 2);
}

// Accepts either a wrapped GroupExportFile or a bare GroupDocument (for
// forward/backward compatibility with future export format changes), and
// normalizes older document shapes so imports never crash on a missing field.
export function importGroupFromJSON(json: string): GroupDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('That file is not valid JSON.');
  }

  const maybeExport = parsed as { document?: unknown } | GroupDocument;
  const doc = (maybeExport && typeof maybeExport === 'object' && 'document' in maybeExport
    ? (maybeExport as { document: unknown }).document
    : maybeExport) as Partial<GroupDocument> | null;

  // Guard the legacy-shape normalisation behind `meta.settings`: it dereferences
  // `doc.meta.settings.customCategories`, and a file without it used to blow up
  // with a raw TypeError instead of a user-facing validation error.
  if (!doc || typeof doc !== 'object' || !doc.meta?.id || !doc.meta?.settings
      || typeof doc.meta.settings !== 'object' || !doc.members || !doc.expenses) {
    throw new Error('This file does not contain a valid FairShare group export.');
  }

  if (Array.isArray(doc.deleted)) {
    const record: Record<string, string> = {};
    for (const id of doc.deleted as unknown as string[]) {
      record[id] = doc.meta.createdAt || new Date().toISOString();
    }
    doc.deleted = record;
  } else if (!doc.deleted) {
    doc.deleted = {};
  }

  if (!doc.meta.settings.customCategories) doc.meta.settings.customCategories = [];
  if (!doc.meta.settings.disabledCategories) doc.meta.settings.disabledCategories = [];
  if (!doc.formerMembers) doc.formerMembers = {};
  if (!doc.settlements) doc.settlements = {};
  if (typeof doc.version !== 'number') doc.version = 0;

  // after normalizing legacy shapes above, validate the result at this
  // user-facing boundary (a file the user picked off their filesystem) so a
  // clear, specific error is shown instead of a downstream crash.
  const result = parseGroupDocument(doc);
  if (!result.success) {
    throw new Error(`This file does not contain a valid FairShare group export (${formatZodError(result.error)}).`);
  }

  return result.data as GroupDocument;
}

// any member controls these strings, and a spreadsheet runs a cell that starts
// with = + - @ (or their full-width forms) as a formula even when it's quoted
const FORMULA_START = /^[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/;

// Also quote bare carriage returns: rows join with CRLF, and a stray CR splits
// a description into two CSV cells for Excel and most parsers.
function csvEscape(value: string | number): string {
  let s = String(value);
  if (typeof value === 'string' && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// the group name ends up as a file path on native, so no slashes or dot-dot
export function safeFileName(name: string, fallback = 'fairshare'): string {
  const cleaned = name.replace(/[^\p{L}\p{N} ._-]/gu, '').replace(/\.{2,}/g, '.').replace(/^[ .]+|[ .]+$/g, '').slice(0, 80);
  return cleaned || fallback;
}

export function exportExpensesToCSV(doc: GroupDocument): string {
  // Include removed participants so split amounts remain visible in the export.
  const extraIds = new Set<string>();
  for (const e of Object.values(doc.expenses)) {
    if (e.id in doc.deleted) continue;
    for (const s of e.splits) {
      if (!doc.members[s.userId]) extraIds.add(s.userId);
    }
  }
  const memberIds = [...Object.keys(doc.members), ...[...extraIds].sort()];
  const header = [
    'Date', 'Description', 'Category', 'Currency', 'Total Amount', 'Paid By',
    ...memberIds.map(id => `${doc.members[id]?.displayName || doc.formerMembers?.[id]?.displayName || id + ' (removed)'} owes`),
    'Notes',
  ];

  const expenses = Object.values(doc.expenses)
    .filter(e => !(e.id in doc.deleted))
    .sort((a, b) => a.date.localeCompare(b.date));

  const rows = expenses.map(e => {
    const paidBy = e.payers
      .map(p => `${doc.members[p.userId]?.displayName || p.userId}: ${(p.amount / 100).toFixed(2)}`)
      .join('; ');
    const splitByMember: Record<string, number> = {};
    for (const s of e.splits) splitByMember[s.userId] = s.amount;

    return [
      e.date.split('T')[0],
      e.description,
      e.category,
      e.currency,
      (e.totalAmount / 100).toFixed(2),
      paidBy,
      ...memberIds.map(id => splitByMember[id] !== undefined ? (splitByMember[id] / 100).toFixed(2) : ''),
      e.notes || '',
    ];
  });

  return [header, ...rows].map(row => row.map(csvEscape).join(',')).join('\r\n');
}

// Identity backup: lets a user carry their peerId + keypair to a second device
// (see docs/USER_GUIDE.md "Multi-device use"). Contains the private key -
// callers must warn the user to store it somewhere safe and never share it.
export interface IdentityExportFile {
  fileFormat: 'fairshare-identity-export';
  version: 1;
  exportedAt: string;
  identity: UserIdentity;
}

export function exportIdentityToJSON(identity: UserIdentity): string {
  const file: IdentityExportFile = {
    fileFormat: 'fairshare-identity-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    identity,
  };
  return JSON.stringify(file, null, 2);
}

export function importIdentityFromJSON(json: string): UserIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  const candidate = parsed as { identity?: UserIdentity } | UserIdentity;
  const identity = (candidate && typeof candidate === 'object' && 'identity' in candidate
    ? (candidate as { identity: UserIdentity }).identity
    : candidate) as UserIdentity | null;

  // validate at the boundary instead of only checking 3 fields are truthy
  const result = userIdentitySchema.safeParse(identity);
  if (!result.success) {
    throw new Error(`This file does not contain a valid FairShare identity export (${formatZodError(result.error)}).`);
  }
  return result.data;
}

export async function downloadTextFile(filename: string, content: string, mimeType: string): Promise<string> {
  filename = safeFileName(filename, 'fairshare-export');
  if (Capacitor.isNativePlatform()) {
    const { Directory, Encoding, Filesystem } = await import('@capacitor/filesystem');
    const file = await Filesystem.writeFile({
      path: filename,
      data: content,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
      recursive: true,
    });
    await Share.share({
      title: filename,
      url: file.uri,
      dialogTitle: 'Export FairShare file',
    });
    return `Export ready: ${filename}`;
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Safari can drop the download if the URL is revoked straight away
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return `Downloaded ${filename}`;
}
