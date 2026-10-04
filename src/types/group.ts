import type { PeerId, GroupId } from './expense';

export type GroupState = 'active' | 'settling' | 'archived' | 'closed';
export type InvitePermission = 'any_member' | 'creator_only' | 'majority';

export interface CustomCategory {
  id: string;
  label: string;
}

export interface GroupSettings {
  defaultCurrency: string;
  defaultSplitType: string;
  simplifyDebts: boolean;
  settleThreshold: number;
  roundingAssignee: 'payer' | 'first_member';
  requireApproval: boolean;
  invitePermission: InvitePermission;
  // Category customization: members can add their own tags and hide defaults they don't use.
  customCategories: CustomCategory[];
  disabledCategories: string[];
}

export interface Group {
  id: GroupId;
  name: string;
  members: PeerId[];
  createdBy: PeerId;
  createdAt: string;
  settings: GroupSettings;
  state: GroupState;
}

export interface MemberProfile {
  peerId: PeerId;
  displayName: string;
  avatar: string;
  joinedAt: string;
  updatedAt?: string;
  // optional public key for signature verification and legacy compatibility
  publicKey?: string;
  // True only for an entry created through Add Member. It may be claimed by a
  // joining device after the user explicitly confirms the name suggestion.
  isManualPlaceholder?: boolean;
}

export const DEFAULT_GROUP_SETTINGS: GroupSettings = {
  defaultCurrency: 'INR',
  defaultSplitType: 'equal',
  simplifyDebts: true,
  settleThreshold: 100,
  roundingAssignee: 'payer',
  requireApproval: false,
  invitePermission: 'any_member',
  customCategories: [],
  disabledCategories: [],
};
