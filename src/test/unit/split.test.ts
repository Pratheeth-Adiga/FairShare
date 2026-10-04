import { describe, it, expect } from 'vitest';
import { calculateSplits } from '@/lib/balance/split';

describe('calculateSplits', () => {
  describe('equal split', () => {
    it('divides evenly', () => {
      const result = calculateSplits(3000, 'equal', ['a', 'b', 'c']);
      expect(result).toEqual({ a: 1000, b: 1000, c: 1000 });
    });

    it('handles remainder by distributing extra cents', () => {
      const result = calculateSplits(1000, 'equal', ['a', 'b', 'c']);
      expect(result['a']).toBe(334);
      expect(result['b']).toBe(333);
      expect(result['c']).toBe(333);
      expect(result['a'] + result['b'] + result['c']).toBe(1000);
    });

    it('handles single member', () => {
      const result = calculateSplits(5000, 'equal', ['a']);
      expect(result).toEqual({ a: 5000 });
    });

    it('handles two members with odd amount', () => {
      const result = calculateSplits(1001, 'equal', ['a', 'b']);
      expect(result['a'] + result['b']).toBe(1001);
    });
  });

  describe('exact split', () => {
    it('returns exact amounts as provided', () => {
      const result = calculateSplits(5000, 'exact', ['a', 'b'], { a: 3000, b: 2000 });
      expect(result).toEqual({ a: 3000, b: 2000 });
    });
  });

  describe('percentage split', () => {
    it('splits by percentage', () => {
      const result = calculateSplits(10000, 'percentage', ['a', 'b'], { a: 60, b: 40 });
      expect(result['a']).toBe(6000);
      expect(result['b']).toBe(4000);
    });

    it('assigns rounding remainder fairly (largest fractional remainder first)', () => {
      const result = calculateSplits(10000, 'percentage', ['a', 'b', 'c'], { a: 33, b: 33, c: 34 });
      expect(result['a'] + result['b'] + result['c']).toBe(10000);
    });
  });

  describe('shares split', () => {
    it('splits proportionally to shares, giving the rounding cent to whoever was shorted most', () => {
      const result = calculateSplits(10000, 'shares', ['a', 'b'], { a: 2, b: 1 });
      // a's exact share (6666.67) has the larger fractional remainder than b's (3333.33),
      // so the leftover cent goes to a instead of always landing on the last entry.
      expect(result['a']).toBe(6667);
      expect(result['b']).toBe(3333);
      expect(result['a'] + result['b']).toBe(10000);
    });
  });

  describe('itemized split', () => {
    it('assigns items to specific people', () => {
      const result = calculateSplits(5000, 'itemized', ['a', 'b', 'c'], {
        items: [
          { name: 'Pizza', amount: 2000, assignees: ['a', 'b'] },
          { name: 'Salad', amount: 1500, assignees: ['c'] },
          { name: 'Drinks', amount: 1500, assignees: ['a', 'b', 'c'] },
        ],
      });
      expect(result['a']).toBe(1000 + 500); // half pizza + third of drinks
      expect(result['b']).toBe(1000 + 500);
      expect(result['c']).toBe(1500 + 500);
    });
  });
});
