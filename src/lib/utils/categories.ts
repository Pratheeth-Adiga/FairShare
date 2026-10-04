import type { GroupSettings } from '@/types';

export interface CategoryOption {
  value: string;
  label: string;
}

export const DEFAULT_CATEGORIES: CategoryOption[] = [
  { value: 'food', label: 'Food & Drink' },
  { value: 'groceries', label: 'Groceries' },
  { value: 'transport', label: 'Transport' },
  { value: 'entertainment', label: 'Entertainment' },
  { value: 'utilities', label: 'Utilities' },
  { value: 'rent', label: 'Rent' },
  { value: 'health', label: 'Health' },
  { value: 'shopping', label: 'Shopping' },
  { value: 'travel', label: 'Travel' },
  { value: 'other', label: 'Other' },
];

// Built-ins minus disabled values, plus custom categories.
export function getCategoryOptions(settings: Pick<GroupSettings, 'customCategories' | 'disabledCategories'>): CategoryOption[] {
  const disabled = new Set(settings.disabledCategories || []);
  const defaults = DEFAULT_CATEGORIES.filter(c => !disabled.has(c.value));
  const custom = (settings.customCategories || []).map(c => ({ value: c.id, label: c.label }));
  // Custom values win collisions with built-in IDs.
  const byValue = new Map<string, CategoryOption>();
  for (const option of [...defaults, ...custom]) byValue.set(option.value, option);
  return [...byValue.values()];
}

export function categoryLabel(settings: Pick<GroupSettings, 'customCategories' | 'disabledCategories'>, value: string): string {
  return getCategoryOptions(settings).find(c => c.value === value)?.label || value;
}

// Slugifies a user-entered category name into a stable id, e.g. "Pet Care" -> "pet-care".
export function slugifyCategoryLabel(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'custom';
}
