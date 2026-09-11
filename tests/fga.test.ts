import { describe, expect, it } from 'vitest';
import { fga } from '@jisr/integrations';

/**
 * The property that matters most about authorization here is what happens when
 * it cannot be answered. FGA is not configured in the test environment, so these
 * tests assert the deny-by-default behaviour directly.
 */
describe('FGA fails closed', () => {
  it('denies when no store is configured', async () => {
    expect(fga.isFgaConfigured()).toBe(false);
    await expect(
      fga.check({ user: 'user:someone', relation: 'can_act', object: 'case:abc' }),
    ).resolves.toBe(false);
  });

  it('throws from the asserting variant rather than falling through', async () => {
    await expect(
      fga.assertCan({ user: 'user:someone', relation: 'can_view', object: 'case:abc' }),
    ).rejects.toThrow(/not allowed/);
  });

  it('filters every record out rather than returning them unchecked', async () => {
    const cases = [{ id: 'a' }, { id: 'b' }];
    await expect(fga.filterAllowed('user:x', 'can_view', cases, (c) => `case:${c.id}`)).resolves.toEqual([]);
    await expect(fga.allowedSiteIds('user:x', ['s1', 's2'])).resolves.toEqual([]);
  });

  it('returns an empty list for an empty input without calling out', async () => {
    await expect(fga.filterAllowed('user:x', 'can_view', [], () => 'case:none')).resolves.toEqual([]);
  });

  it('formats object references the model expects', () => {
    expect(fga.userRef('abc')).toBe('user:abc');
    expect(fga.caseRef('abc')).toBe('case:abc');
    expect(fga.siteRef('abc')).toBe('site:abc');
    expect(fga.companyRef('abc')).toBe('company:abc');
  });

  it('does not write tuples when unconfigured, instead of failing the case', async () => {
    await expect(
      fga.writeCaseTuples({ caseId: 'c', siteId: 's', companyId: 'co' }),
    ).resolves.toBeUndefined();
  });
});
