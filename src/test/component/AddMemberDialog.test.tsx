import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AddMemberDialog } from '@/components/group/AddMemberDialog';
import type { MemberProfile } from '@/types';

const addMember = vi.hoisted(() => vi.fn());
const getDocument = vi.hoisted(() =>
  vi.fn((_: string) => ({
    members: {
      'peer-me': { peerId: 'peer-me', displayName: 'Me', avatar: '', joinedAt: '' } as MemberProfile,
      'peer-alice': { peerId: 'peer-alice', displayName: 'Alice', avatar: '', joinedAt: '' } as MemberProfile,
    },
  }))
);

vi.mock('@/stores/groups.store', () => ({
  useGroupsStore: (selector: (s: { addMember: typeof addMember; getDocument: typeof getDocument }) => unknown) =>
    selector({ addMember, getDocument }),
}));

function renderDialog() {
  return render(
    <AddMemberDialog open={true} onOpenChange={() => {}} groupId="group-1" />
  );
}

describe('AddMemberDialog', () => {
  beforeEach(() => {
    addMember.mockReset();
  });

  it('adds a new member with a fresh peer- id', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(/member name/i), { target: { value: 'Bob' } });
    fireEvent.click(screen.getByRole('button', { name: /^add member$/i }));

    expect(addMember).toHaveBeenCalledTimes(1);
    const [gid, member] = addMember.mock.calls[0];
    expect(gid).toBe('group-1');
    expect(member.displayName).toBe('Bob');
    expect(member.peerId).toMatch(/^peer-/);
  });

  it('warns on first click when name is a duplicate and does not add', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(/member name/i), { target: { value: 'Alice' } });
    fireEvent.click(screen.getByRole('button', { name: /^add member$/i }));

    expect(addMember).not.toHaveBeenCalled();
    expect(screen.getByText(/member with this name already exists/i)).toBeInTheDocument();
  });

  it('adds the duplicate on the second click after acknowledging the warning', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(/member name/i), { target: { value: 'Alice' } });
    fireEvent.click(screen.getByRole('button', { name: /^add member$/i }));
    // Second click should bypass the warning.
    fireEvent.click(screen.getByRole('button', { name: /^add member$/i }));

    expect(addMember).toHaveBeenCalledTimes(1);
    expect(addMember.mock.calls[0][1].displayName).toBe('Alice');
  });

  it('resets the duplicate flag when the name is edited', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(/member name/i), { target: { value: 'Alice' } });
    fireEvent.click(screen.getByRole('button', { name: /^add member$/i }));
    expect(screen.getByText(/member with this name already exists/i)).toBeInTheDocument();

    // Editing the name should hide the warning AND require a fresh duplicate check.
    fireEvent.change(screen.getByLabelText(/member name/i), { target: { value: 'AliceX' } });
    expect(screen.queryByText(/member with this name already exists/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^add member$/i }));
    expect(addMember).toHaveBeenCalledTimes(1);
    expect(addMember.mock.calls[0][1].displayName).toBe('AliceX');
  });

  it('is case-insensitive when detecting duplicates', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(/member name/i), { target: { value: 'ALICE' } });
    fireEvent.click(screen.getByRole('button', { name: /^add member$/i }));
    expect(addMember).not.toHaveBeenCalled();
    expect(screen.getByText(/member with this name already exists/i)).toBeInTheDocument();
  });

  it('does not add when the name is blank', () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /^add member$/i }));
    expect(addMember).not.toHaveBeenCalled();
  });
});
