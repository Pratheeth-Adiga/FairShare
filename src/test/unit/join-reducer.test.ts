import { describe, it, expect } from 'vitest';
import { joinReducer, initialJoinState, type JoinState } from '@/pages/JoinGroup';

describe('joinReducer', () => {
  it('SET_STEP updates only step', () => {
    const next = joinReducer(initialJoinState, { type: 'SET_STEP', step: 'scan' });
    expect(next).toEqual({ ...initialJoinState, step: 'scan' });
  });

  it('OFFER_ACCEPTED transitions to show-answer and clears prior error', () => {
    const state: JoinState = { ...initialJoinState, step: 'scan', localError: 'stale' };
    const next = joinReducer(state, { type: 'OFFER_ACCEPTED', groupId: 'group-42' });
    expect(next.step).toBe('show-answer');
    expect(next.pendingGroupId).toBe('group-42');
    expect(next.localError).toBeNull();
  });

  it('FAIL sets error step and message', () => {
    const next = joinReducer(initialJoinState, { type: 'FAIL', message: 'timeout' });
    expect(next.step).toBe('error');
    expect(next.localError).toBe('timeout');
  });

  it('GROUP_ARRIVED clears localError but keeps step + pendingGroupId', () => {
    // A late-arriving document must not resurrect a previously-shown timeout message.
    const state: JoinState = {
      step: 'error',
      localError: 'Connection timed out',
      pendingGroupId: 'group-1',
      copied: false,
    };
    const next = joinReducer(state, { type: 'GROUP_ARRIVED' });
    expect(next.localError).toBeNull();
    expect(next.pendingGroupId).toBe('group-1');
    expect(next.step).toBe('error');
  });

  it('RETRY resets to scan step and drops pendingGroupId', () => {
    const state: JoinState = {
      step: 'error',
      localError: 'x',
      pendingGroupId: 'g',
      copied: true,
    };
    const next = joinReducer(state, { type: 'RETRY' });
    expect(next).toEqual({ step: 'scan', localError: null, pendingGroupId: null, copied: false });
  });

  it('SET_COPIED toggles copied flag independently of step', () => {
    const state: JoinState = { ...initialJoinState, step: 'show-answer' };
    const on = joinReducer(state, { type: 'SET_COPIED', copied: true });
    expect(on.copied).toBe(true);
    expect(on.step).toBe('show-answer');
    const off = joinReducer(on, { type: 'SET_COPIED', copied: false });
    expect(off.copied).toBe(false);
  });

  it('CLEAR_ERROR only touches localError', () => {
    const state: JoinState = { ...initialJoinState, step: 'scan', localError: 'boom' };
    const next = joinReducer(state, { type: 'CLEAR_ERROR' });
    expect(next.localError).toBeNull();
    expect(next.step).toBe('scan');
  });

  it('unknown action returns the same state reference', () => {
    // @ts-expect-error deliberately invalid to guard the default branch
    const next = joinReducer(initialJoinState, { type: 'BOGUS' });
    expect(next).toBe(initialJoinState);
  });
});
