import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { CreateGroupDialog } from '@/components/group/CreateGroupDialog';

const createGroup = vi.hoisted(() => vi.fn().mockResolvedValue('group-42'));
const navigate = vi.hoisted(() => vi.fn());

vi.mock('@/stores/groups.store', () => ({
  useGroupsStore: (selector: (s: { createGroup: typeof createGroup }) => unknown) => selector({ createGroup }),
}));

vi.mock('@/stores/identity.store', () => ({
  useIdentityStore: (selector: (s: { identity: { peerId: string; displayName: string; publicKey: string } }) => unknown) =>
    selector({ identity: { peerId: 'peer-me', displayName: 'Me', publicKey: 'pubkey-me' } }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

function renderDialog() {
  return render(
    <MemoryRouter>
      <CreateGroupDialog open={true} onOpenChange={() => {}} />
    </MemoryRouter>
  );
}

describe('CreateGroupDialog', () => {
  beforeEach(() => {
    createGroup.mockClear();
    navigate.mockClear();
  });

  it('disables the create button when the name is blank', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: /create group/i })).toBeDisabled();
  });

  it('calls createGroup with the trimmed name and default currency, then navigates', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(/group name/i), { target: { value: '  Trip  ' } });
    fireEvent.click(screen.getByRole('button', { name: /create group/i }));

    // Flush microtasks for async createGroup.
    await Promise.resolve();
    await Promise.resolve();

    expect(createGroup).toHaveBeenCalledWith('Trip', 'INR', 'peer-me', 'Me', 'pubkey-me');
    expect(navigate).toHaveBeenCalledWith('/group/group-42');
  });

  it('changes the currency via the select before creating', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(/group name/i), { target: { value: 'Trip' } });
    fireEvent.change(screen.getByLabelText(/currency/i), { target: { value: 'USD' } });
    fireEvent.click(screen.getByRole('button', { name: /create group/i }));

    await Promise.resolve();
    await Promise.resolve();

    expect(createGroup).toHaveBeenCalledWith('Trip', 'USD', 'peer-me', 'Me', 'pubkey-me');
  });

  it('does not create when identity is missing', async () => {
    // Override mock for this test with a fresh module scope.
    vi.doMock('@/stores/identity.store', () => ({
      useIdentityStore: (selector: (s: { identity: null }) => unknown) => selector({ identity: null }),
    }));
    vi.resetModules();
    const { CreateGroupDialog: DialogNoId } = await import('@/components/group/CreateGroupDialog');
    render(
      <MemoryRouter>
        <DialogNoId open={true} onOpenChange={() => {}} />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText(/group name/i), { target: { value: 'Trip' } });
    fireEvent.click(screen.getByRole('button', { name: /create group/i }));

    await Promise.resolve();
    expect(createGroup).not.toHaveBeenCalled();
    vi.doUnmock('@/stores/identity.store');
    vi.resetModules();
  });
});
