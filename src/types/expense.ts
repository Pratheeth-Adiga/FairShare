export type PeerId = string;
export type ExpenseId = string;
export type GroupId = string;
export type SettlementId = string;

export type SplitType = 'equal' | 'exact' | 'percentage' | 'shares' | 'by_weight' | 'itemized';

// Category is an open string so groups can define their own in addition to the
// built-in defaults (see lib/utils/categories.ts for the default set).
export type Category = string;

export interface Payer {
  userId: PeerId;
  amount: number;
}

export interface Split {
  userId: PeerId;
  amount: number;
}

export interface ExpenseItem {
  name: string;
  amount: number;
  assignees: PeerId[];
}

export interface ExpenseComment {
  id: string;
  authorId: PeerId;
  text: string;
  createdAt: string;
}

// Snapshot of the fields a single edit changed, keyed by field name, so the
// full history of an expense can be reconstructed and displayed.
export interface ExpenseEditRecord {
  editedAt: string;
  editedBy: PeerId;
  changes: Partial<Record<keyof Expense, { from: unknown; to: unknown }>>;
}

export interface Expense {
  id: ExpenseId;
  groupId: GroupId | null;
  friendId: PeerId | null;
  description: string;
  totalAmount: number;
  currency: string;
  payers: Payer[];
  splitType: SplitType;
  splits: Split[];
  items: ExpenseItem[];
  category: Category;
  // Optional additional tags; when present, category is treated as categories[0].
  categories?: Category[];
  date: string;
  createdAt: string;
  createdBy: PeerId;
  notes: string;
  updatedAt?: string;
  comments?: ExpenseComment[];
  editHistory?: ExpenseEditRecord[];
  // preserve raw weights because computed cents are not invertible
  splitInputs?: Record<PeerId, number>;
}
