import type { PeerId, GroupId } from './expense';

export type SettlementId = string;

export interface Settlement {
  id: SettlementId;
  groupId: GroupId;
  from: PeerId;
  to: PeerId;
  amount: number;
  date: string;
  note: string;
  settlesExpenses: string[];
  updatedAt?: string;
}
