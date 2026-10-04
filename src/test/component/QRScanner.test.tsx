import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QRScanner } from '@/components/p2p/QRScanner';

// Track instances so we can assert lifecycle and simulate a scan.
const instances = vi.hoisted(() => [] as Array<{ id: string; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; onDecoded?: (t: string) => void }>);

vi.mock('html5-qrcode', () => ({
  Html5Qrcode: class {
    id: string;
    start = vi.fn(async (_config: unknown, _startConfig: unknown, onDecoded: (t: string) => void) => {
      const entry = instances.find(i => i.id === this.id);
      if (entry) entry.onDecoded = onDecoded;
    });
    stop = vi.fn(async () => {});
    clear = vi.fn();
    constructor(id: string) {
      this.id = id;
      instances.push({ id, start: this.start, stop: this.stop, clear: this.clear });
    }
  },
}));

async function flushMicrotasks() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('QRScanner', () => {
  beforeEach(() => {
    instances.length = 0;
  });

  it('starts the scanner only after its container DOM node is attached', async () => {
    render(<QRScanner onScan={() => {}} />);
    await flushMicrotasks();

    // Exactly one Html5Qrcode instance, tied to the mounted div's id.
    expect(instances).toHaveLength(1);
    const containerId = instances[0].id;
    expect(document.getElementById(containerId)).not.toBeNull();
    expect(instances[0].start).toHaveBeenCalled();
  });

  it('forwards decoded text to onScan and stops the scanner', async () => {
    const onScan = vi.fn();
    render(<QRScanner onScan={onScan} />);
    await flushMicrotasks();

    // Simulate the html5-qrcode library detecting a QR payload.
    instances[0].onDecoded?.('FS2:hello');
    expect(onScan).toHaveBeenCalledWith('FS2:hello');
    expect(instances[0].stop).toHaveBeenCalled();
  });

  it('tears down the scanner when the camera container unmounts', async () => {
    const { unmount } = render(<QRScanner onScan={() => {}} />);
    await flushMicrotasks();

    unmount();
    await flushMicrotasks();

    expect(instances[0].stop).toHaveBeenCalled();
  });

  it('ignores a stale scan callback after the scanner unmounts', async () => {
    const onScan = vi.fn();
    const { unmount } = render(<QRScanner onScan={onScan} />);
    await flushMicrotasks();

    unmount();
    instances[0].onDecoded?.('FS2:stale');

    expect(onScan).not.toHaveBeenCalled();
  });

  it('tears down when the user switches away from the camera', async () => {
    render(<QRScanner onScan={() => {}} />);
    await flushMicrotasks();

    fireEvent.click(screen.getByRole('button', { name: /paste code instead/i }));
    await flushMicrotasks();

    expect(instances[0].stop).toHaveBeenCalled();
    // Paste UI must be visible after teardown.
    expect(screen.getByPlaceholderText(/paste connection code/i)).toBeInTheDocument();
  });

  it('paste flow calls onScan with the trimmed value', async () => {
    const onScan = vi.fn();
    render(<QRScanner onScan={onScan} />);
    await flushMicrotasks();

    fireEvent.click(screen.getByRole('button', { name: /paste code instead/i }));
    fireEvent.change(screen.getByPlaceholderText(/paste connection code/i), {
      target: { value: '  FS2:xyz  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    expect(onScan).toHaveBeenCalledWith('FS2:xyz');
  });
});
