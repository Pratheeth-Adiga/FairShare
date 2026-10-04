import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { JoinGroup } from '@/pages/JoinGroup';

const acceptOffer = vi.hoisted(() => vi.fn());
const reset = vi.hoisted(() => vi.fn());
const subscribeToGroup = vi.hoisted(() => vi.fn());
const scannerPayload = vi.hoisted(() => ({ value: '' }));
const connectionError = vi.hoisted(() => ({ value: null as string | null }));

vi.mock('@/components/p2p/QRScanner', () => ({
  QRScanner: ({ onScan }: { onScan: (data: string) => void }) => (
    <button onClick={() => onScan(scannerPayload.value)}>Scan test code</button>
  ),
}));

vi.mock('@/stores/identity.store', () => ({
  useIdentityStore: (selector: (state: unknown) => unknown) => selector({ identity: { peerId: 'peer-me', displayName: 'Me' } }),
}));

vi.mock('@/stores/groups.store', () => ({
  useGroupsStore: (selector?: (state: unknown) => unknown) => {
    const state = { documents: {} };
    return selector ? selector(state) : state;
  },
}));

vi.mock('@/stores/sync.store', () => ({
  useSyncStore: (selector?: (state: unknown) => unknown) => {
    const state = { subscribeToGroup };
    return selector ? selector(state) : state;
  },
}));

vi.mock('@/stores/connections.store', () => {
  const useConnectionsStore = Object.assign(
    (selector?: (state: unknown) => unknown) => {
      const state = {
        acceptOffer,
        answerBlob: null,
        isAcceptingOffer: false,
        error: connectionError.value,
        reset,
      };
      return selector ? selector(state) : state;
    },
    { getState: () => ({ error: connectionError.value }) },
  );
  return { useConnectionsStore };
});

function renderJoinGroup() {
  return render(
    <MemoryRouter initialEntries={['/join?topic=group-1&name=Test']}>
      <Routes>
        <Route path="/join" element={<JoinGroup />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('JoinGroup connection offer scanning', () => {
  beforeEach(() => {
    acceptOffer.mockReset();
    reset.mockReset();
    subscribeToGroup.mockReset();
    connectionError.value = null;
  });

  it('rejects an identity QR code before passing it to WebRTC', () => {
    scannerPayload.value = 'FSID1:identity-payload';
    renderJoinGroup();

    fireEvent.click(screen.getByRole('button', { name: /scan creator's qr code/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Scan test code' }));

    expect(acceptOffer).not.toHaveBeenCalled();
    expect(screen.getByText(/invalid qr code.*fs2: or fs3:/i)).toBeInTheDocument();
  });

  it('shows the actual processing error for a valid-format offer', async () => {
    scannerPayload.value = 'FS3:valid-format-payload';
    connectionError.value = 'Failed to accept offer: SDP fingerprint mismatch';
    acceptOffer.mockResolvedValue(null);
    renderJoinGroup();

    fireEvent.click(screen.getByRole('button', { name: /scan creator's qr code/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Scan test code' }));

    expect(await screen.findByText('Failed to accept offer: SDP fingerprint mismatch')).toBeInTheDocument();
    expect(screen.queryByText(/code may be expired or corrupted/i)).toBeNull();
  });
});