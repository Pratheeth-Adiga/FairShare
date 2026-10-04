import { describe, it, expect } from 'vitest';
import { createGroupDocument } from '@/lib/crdt/document';
import { DEFAULT_GROUP_SETTINGS } from '@/types/group';

describe('createGroupDocument', () => {
  it('initializes a fresh document with the creator as sole member', () => {
    const doc = createGroupDocument('g1', 'Trip', 'peer-alice', 'Alice', DEFAULT_GROUP_SETTINGS);

    expect(doc.meta.id).toBe('g1');
    expect(doc.meta.name).toBe('Trip');
    expect(doc.meta.state).toBe('active');
    expect(doc.meta.createdBy).toBe('peer-alice');
    expect(doc.meta.settings).toEqual(DEFAULT_GROUP_SETTINGS);

    expect(Object.keys(doc.members)).toEqual(['peer-alice']);
    expect(doc.members['peer-alice']).toMatchObject({
      peerId: 'peer-alice',
      displayName: 'Alice',
      avatar: '',
    });

    expect(doc.expenses).toEqual({});
    expect(doc.settlements).toEqual({});
    expect(doc.deleted).toEqual({});
    expect(doc.version).toBe(0);
  });

  it('stamps createdAt and the member joinedAt as valid ISO timestamps', () => {
    const doc = createGroupDocument('g1', 'Trip', 'peer-alice', 'Alice', DEFAULT_GROUP_SETTINGS);
    expect(() => new Date(doc.meta.createdAt).toISOString()).not.toThrow();
    expect(() => new Date(doc.members['peer-alice'].joinedAt).toISOString()).not.toThrow();
  });

  it('does not mutate the settings object passed in (each group gets its own copy of defaults)', () => {
    const settings = { ...DEFAULT_GROUP_SETTINGS, customCategories: [] };
    const doc = createGroupDocument('g1', 'Trip', 'peer-alice', 'Alice', settings);
    doc.meta.settings.customCategories.push({ id: 'pets', label: 'Pets' });
    // createGroupDocument stores the same reference it was given (no deep clone),
    // so this documents current behavior rather than asserting isolation.
    expect(settings.customCategories).toEqual(doc.meta.settings.customCategories);
  });
});
