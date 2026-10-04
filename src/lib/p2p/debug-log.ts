// Debug-only on-screen P2P log; release builds keep it disabled.
export const P2P_DEBUG_ENABLED = import.meta.env.VITE_P2P_DEBUG === 'true';

type Listener = (lines: string[]) => void;

// use a ring buffer so full-buffer writes stay O(1)
const MAX_LOG_LINES = 300;
const buffer: string[] = new Array(MAX_LOG_LINES);
let head = 0; // index of the oldest entry
let count = 0; // number of valid entries currently stored (<= MAX_LOG_LINES)
const listeners = new Set<Listener>();

function toOrderedArray(): string[] {
  const result: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    result[i] = buffer[(head + i) % MAX_LOG_LINES];
  }
  return result;
}

export function p2pLog(msg: string): void {
  if (!P2P_DEBUG_ENABLED) return;
  console.log(msg);
  const line = `${new Date().toLocaleTimeString()}  ${msg}`;
  if (count < MAX_LOG_LINES) {
    buffer[(head + count) % MAX_LOG_LINES] = line;
    count++;
  } else {
    buffer[head] = line;
    head = (head + 1) % MAX_LOG_LINES;
  }
  const ordered = toOrderedArray();
  listeners.forEach(l => l(ordered));
}

export function getP2PLogs(): string[] {
  return P2P_DEBUG_ENABLED ? toOrderedArray() : [];
}

export function subscribeP2PLogs(listener: Listener): () => void {
  if (!P2P_DEBUG_ENABLED) return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearP2PLogs(): void {
  head = 0;
  count = 0;
  listeners.forEach(l => l([]));
}
