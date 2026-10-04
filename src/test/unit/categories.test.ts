import { describe, it, expect } from 'vitest';
import { DEFAULT_CATEGORIES, getCategoryOptions, categoryLabel, slugifyCategoryLabel } from '@/lib/utils/categories';

describe('getCategoryOptions', () => {
  it('returns all default categories when nothing is customized', () => {
    const options = getCategoryOptions({ customCategories: [], disabledCategories: [] });
    expect(options).toEqual(DEFAULT_CATEGORIES);
  });

  it('excludes disabled default categories', () => {
    const options = getCategoryOptions({ customCategories: [], disabledCategories: ['rent', 'health'] });
    expect(options.map(c => c.value)).not.toContain('rent');
    expect(options.map(c => c.value)).not.toContain('health');
    expect(options).toHaveLength(DEFAULT_CATEGORIES.length - 2);
  });

  it('appends custom categories after the defaults', () => {
    const options = getCategoryOptions({
      customCategories: [{ id: 'pet-care', label: 'Pet Care' }],
      disabledCategories: [],
    });
    expect(options[options.length - 1]).toEqual({ value: 'pet-care', label: 'Pet Care' });
    expect(options).toHaveLength(DEFAULT_CATEGORIES.length + 1);
  });
});

describe('categoryLabel', () => {
  it('resolves a known value to its label', () => {
    const label = categoryLabel({ customCategories: [], disabledCategories: [] }, 'food');
    expect(label).toBe('Food & Drink');
  });

  it('resolves a custom category label', () => {
    const label = categoryLabel({ customCategories: [{ id: 'pet-care', label: 'Pet Care' }], disabledCategories: [] }, 'pet-care');
    expect(label).toBe('Pet Care');
  });

  it('falls back to the raw value when unknown (e.g. legacy/disabled category on old expenses)', () => {
    const label = categoryLabel({ customCategories: [], disabledCategories: ['food'] }, 'food');
    expect(label).toBe('food');
  });
});

describe('slugifyCategoryLabel', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifyCategoryLabel('Pet Care')).toBe('pet-care');
  });

  it('strips non-alphanumeric characters', () => {
    expect(slugifyCategoryLabel('Kids & School!')).toBe('kids-school');
  });

  it('trims leading/trailing hyphens', () => {
    expect(slugifyCategoryLabel('  -Weird Input-  ')).toBe('weird-input');
  });

  it('falls back to "custom" for an empty/symbol-only input', () => {
    expect(slugifyCategoryLabel('   ')).toBe('custom');
    expect(slugifyCategoryLabel('!!!')).toBe('custom');
  });
});
