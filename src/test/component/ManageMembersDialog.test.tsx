import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ManageMembersDialog } from '@/components/group/ManageMembersDialog';
import type { MemberProfile } from '@/types';

const removeMember = vi.hoisted(() => vi.fn());
const reassignMember = vi.hoisted(() => vi.fn());
const requestIntroduction = vi.hoisted(() => vi.fn());
const identity = vi.hoisted(() => ({ peerId: 'peer-me', displayName: 'Me' }));

vi.mock('@/stores/groups.store', () => ({
  useGroupsStore: (selector: (s: { removeMember: typeof removeMember; reassignMember: typeof reassignMember }) => unknown) =>
    selector({ removeMember, reassignMember }),
}));

vi.mock('@/stores/connections.store', () => ({
  useConnectionsStore: (selector: (s: { activePeers: string[]; introductions: Record<string, never>; requestIntroduction: typeof requestIntroduction }) => unknown) =>
    selector({ activePeers: [], introductions: {}, requestIntroduction }),
}));

vi.mock('@/stores/identity.store', () => ({
  useIdentityStore: (selector: (s: { identity: typeof identity }) => unknown) => selector({ identity }),
}));

function makeMember(peerId: string, displayName: string, isManualPlaceholder = false): MemberProfile {
  return { peerId, displayName, avatar: '', joinedAt: '2026-01-01T00:00:00.000Z', ...(isManualPlaceholder ? { isManualPlaceholder: true } : {}) };
}

// real peers carry a `publicKey` and use the 64-hex peerId format, so the
// reassign flow only triggers for genuine placeholder members. These fixtures
// mirror what AddMemberDialog creates: `peer-<16-hex>` and no publicKey.
const PLACEHOLDER_ALICE = 'peer-a1b2c3d4e5f6a7b8';
const PLACEHOLDER_BOB = 'peer-b1b2c3d4e5f6a7b8';
const PLACEHOLDER_CAROL = 'peer-c1b2c3d4e5f6a7b8';

const baseMembers: Record<string, MemberProfile> = {
  'peer-me': makeMember('peer-me', 'Me'),
  [PLACEHOLDER_ALICE]: makeMember(PLACEHOLDER_ALICE, 'Alice', true),
  [PLACEHOLDER_BOB]: makeMember(PLACEHOLDER_BOB, 'Bob', true),
  [PLACEHOLDER_CAROL]: makeMember(PLACEHOLDER_CAROL, 'Carol', true),
};

function renderDialog(members = baseMembers) {
  return render(
    <ManageMembersDialog
      open={true}
      onOpenChange={() => {}}
      groupId="group-1"
      members={members}
    />
  );
}

describe('ManageMembersDialog', () => {
  beforeEach(() => {
    removeMember.mockReset();
    reassignMember.mockReset();
    requestIntroduction.mockReset();
  });

  it('removes each selected member when multi-select confirmed', () => {
    renderDialog();

    fireEvent.click(screen.getByLabelText('Select Alice'));
    fireEvent.click(screen.getByLabelText('Select Bob'));

    fireEvent.click(screen.getByRole('button', { name: /remove selected \(2\)/i }));
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));

    expect(removeMember).toHaveBeenCalledTimes(2);
    expect(removeMember).toHaveBeenCalledWith('group-1', PLACEHOLDER_ALICE);
    expect(removeMember).toHaveBeenCalledWith('group-1', PLACEHOLDER_BOB);
    expect(reassignMember).not.toHaveBeenCalled();
  });

  it('reassigns a placeholder member without removing the reassign target', () => {
    renderDialog();

    // Trash-icon on Alice (a placeholder: 16-hex peerId, no publicKey) triggers the reassign flow.
    const aliceRow = screen.getByLabelText('Select Alice').closest('div')!;
    fireEvent.click(within(aliceRow).getByTitle('Remove member'));

    fireEvent.change(screen.getByRole('combobox'), { target: { value: PLACEHOLDER_BOB } });
    fireEvent.click(screen.getByRole('button', { name: /reassign & remove/i }));

    expect(reassignMember).toHaveBeenCalledTimes(1);
    expect(reassignMember).toHaveBeenCalledWith('group-1', PLACEHOLDER_ALICE, PLACEHOLDER_BOB);
    // The reassign target itself must NOT be removed.
    expect(removeMember).not.toHaveBeenCalledWith('group-1', PLACEHOLDER_BOB);
  });

  it('does not call reassignMember when no target is chosen', () => {
    renderDialog();

    const aliceRow = screen.getByLabelText('Select Alice').closest('div')!;
    fireEvent.click(within(aliceRow).getByTitle('Remove member'));

    // Leave the reassign target as the default "Don't reassign" option.
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));

    expect(reassignMember).not.toHaveBeenCalled();
    expect(removeMember).toHaveBeenCalledTimes(1);
    expect(removeMember).toHaveBeenCalledWith('group-1', PLACEHOLDER_ALICE);
  });

  it('reassign target dropdown excludes the reassign source itself', () => {
    renderDialog();

    // Trash-icon on Alice triggers the reassign flow (placeholder, not self).
    const aliceRow = screen.getByLabelText('Select Alice').closest('div')!;
    fireEvent.click(within(aliceRow).getByTitle('Remove member'));

    const options = within(screen.getByRole('combobox')).getAllByRole('option').map(o => o.textContent);
    // Alice must not be pickable as her own reassign target.
    expect(options).not.toContain('Alice');
    // Every other member (including self) is a valid reassign target.
    expect(options).toContain('Me');
    expect(options).toContain('Bob');
    expect(options).toContain('Carol');
  });

  it('reassigning to the source (if it were selected) would be blocked by the filter', () => {
    // Render with only the source and one target to verify source cannot be picked.
    renderDialog({
      'peer-me': makeMember('peer-me', 'Me'),
      [PLACEHOLDER_ALICE]: makeMember(PLACEHOLDER_ALICE, 'Alice', true),
    });
    const aliceRow = screen.getByLabelText('Select Alice').closest('div')!;
    fireEvent.click(within(aliceRow).getByTitle('Remove member'));

    const options = within(screen.getByRole('combobox')).getAllByRole('option').map(o => o.textContent);
    expect(options).not.toContain('Alice');
    expect(options).toContain('Me');
  });

  it('real (non-placeholder) members do NOT trigger the reassign flow', () => {
    const REAL_ALICE = 'peer-' + 'a'.repeat(64);
    const withReal: Record<string, MemberProfile> = {
      'peer-me': makeMember('peer-me', 'Me'),
      [REAL_ALICE]: { ...makeMember(REAL_ALICE, 'Alice'), publicKey: 'a'.repeat(64) },
    };
    renderDialog(withReal);

    const aliceRow = screen.getByLabelText('Select Alice').closest('div')!;
    fireEvent.click(within(aliceRow).getByTitle('Remove member'));

    // No reassign combobox should appear; confirm removes member directly.
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));
    expect(removeMember).toHaveBeenCalledWith('group-1', REAL_ALICE);
    expect(reassignMember).not.toHaveBeenCalled();
  });

  it('does not allow the sole member to be removed', () => {
    renderDialog({ 'peer-me': makeMember('peer-me', 'Me') });

    expect(screen.getByLabelText('Select Me')).toBeDisabled();
    expect(screen.getByTitle('A group must have at least one member')).toBeDisabled();
    expect(screen.getByRole('button', { name: /remove selected/i })).toBeDisabled();
  });

  it('F-152: blocks selecting all members of a 3-member group (leaving none)', () => {
    renderDialog({
      'peer-me': makeMember('peer-me', 'Me'),
      [PLACEHOLDER_ALICE]: makeMember(PLACEHOLDER_ALICE, 'Alice', true),
      [PLACEHOLDER_BOB]: makeMember(PLACEHOLDER_BOB, 'Bob', true),
    });

    fireEvent.click(screen.getByLabelText('Select Me'));
    fireEvent.click(screen.getByLabelText('Select Alice'));
    // Two of three already selected - the last remaining member's checkbox must be disabled.
    expect(screen.getByLabelText('Select Bob')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /remove selected \(2\)/i }));
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));

    expect(removeMember).toHaveBeenCalledTimes(2);
    expect(removeMember).not.toHaveBeenCalledWith('group-1', PLACEHOLDER_BOB);
  });

  it('warns that outstanding balances remain when removing a member', () => {
    renderDialog();

    fireEvent.click(screen.getByLabelText('Select Alice'));
    fireEvent.click(screen.getByRole('button', { name: /remove selected/i }));

    expect(screen.getByText(/outstanding balances will remain recorded/i)).toBeInTheDocument();
  });
});
