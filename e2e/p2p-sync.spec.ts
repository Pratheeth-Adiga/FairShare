import { test, expect } from '@playwright/test';
import { copyDocument, seedIdentity } from './helpers.js';

test('two peers converge on group + expense after doc exchange', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await seedIdentity(pageA, 'Alice');
  await seedIdentity(pageB, 'Bob');

  // Alice creates a group and adds Charlie as a placeholder member.
  await pageA.getByTitle('Create group', { exact: true }).click();
  await pageA.getByLabel(/group name/i).fill('SharedTrip');
  await pageA.getByLabel(/group name/i).press('Enter');
  await expect(pageA).toHaveURL(/\/group\/[^/]+/);
  await pageA.getByRole('button', { name: /^add$/i }).click();
  await pageA.getByLabel(/member name/i).fill('Charlie');
  await pageA.getByRole('button', { name: /^add member$/i }).click();

  await pageA.getByRole('button', { name: /add first expense/i }).click();
  await pageA.getByLabel(/^description$/i).fill('AliceLunch');
  await pageA.getByLabel(/^amount/i).fill('30');
  await pageA.getByRole('button', { name: /^add .* expense$/i }).click();

  const groupId = await pageA.evaluate(() => window.__fairshare!.getGroupIdByName('SharedTrip'));
  expect(groupId).toBeTruthy();

  await copyDocument(pageA, pageB, groupId!);

  // Bob should now see Alice's group with 2 members (Alice + Charlie) and the expense.
  await pageB.goto(`/group/${groupId}?e2eHook=1`);
  await expect(pageB.getByRole('heading', { name: /members \(2\)/i })).toBeVisible();
  await expect(pageB.getByText('AliceLunch')).toBeVisible();

  await ctxA.close();
  await ctxB.close();
});

test('expense deletion tombstone propagates via doc merge', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await seedIdentity(pageA, 'Alice');
  await seedIdentity(pageB, 'Bob');

  await pageA.getByTitle('Create group', { exact: true }).click();
  await pageA.getByLabel(/group name/i).fill('SharedTrip');
  await pageA.getByLabel(/group name/i).press('Enter');
  await pageA.getByRole('button', { name: /^add$/i }).click();
  await pageA.getByLabel(/member name/i).fill('Charlie');
  await pageA.getByRole('button', { name: /^add member$/i }).click();
  await pageA.getByRole('button', { name: /add first expense/i }).click();
  await pageA.getByLabel(/^description$/i).fill('Kept');
  await pageA.getByLabel(/^amount/i).fill('20');
  await pageA.getByRole('button', { name: /^add .* expense$/i }).click();

  // Add a second expense that we'll delete.
  await pageA.getByTitle('Add expense').click();
  await pageA.getByLabel(/^description$/i).fill('Doomed');
  await pageA.getByLabel(/^amount/i).fill('50');
  await pageA.getByRole('button', { name: /^add .* expense$/i }).click();

  const groupId = await pageA.evaluate(() => window.__fairshare!.getGroupIdByName('SharedTrip'));
  await copyDocument(pageA, pageB, groupId!);

  await pageB.goto(`/group/${groupId}?e2eHook=1`);
  await expect(pageB.getByText('Doomed')).toBeVisible();

  // Alice deletes the Doomed expense.
  await pageA.getByText('Doomed').click();
  await pageA.locator('button:has(svg.lucide-trash-2)').first().click();
  await pageA.getByRole('button', { name: /confirm delete/i }).click();
  await expect(pageA).toHaveURL(/\/group\/[^/]+$/);

  await copyDocument(pageA, pageB, groupId!);

  // Bob refreshes their view; Doomed should be gone, Kept should stay.
  await pageB.reload();
  await expect(pageB.getByText('Kept')).toBeVisible();
  await expect(pageB.getByText('Doomed')).not.toBeVisible();

  await ctxA.close();
  await ctxB.close();
});

test('member removal tombstone propagates via doc merge', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await seedIdentity(pageA, 'Alice');
  await seedIdentity(pageB, 'Bob');

  // Alice sets up a group with two placeholder members.
  await pageA.getByTitle('Create group', { exact: true }).click();
  await pageA.getByLabel(/group name/i).fill('SharedTrip');
  await pageA.getByLabel(/group name/i).press('Enter');
  for (const name of ['Charlie', 'Dave']) {
    await pageA.getByRole('button', { name: /^add$/i }).click();
    await pageA.getByLabel(/member name/i).fill(name);
    await pageA.getByRole('button', { name: /^add member$/i }).click();
  }

  const groupId = await pageA.evaluate(() => window.__fairshare!.getGroupIdByName('SharedTrip'));
  await copyDocument(pageA, pageB, groupId!);
  await pageB.goto(`/group/${groupId}?e2eHook=1`);
  await expect(pageB.getByText('Charlie')).toBeVisible();
  await expect(pageB.getByText('Dave')).toBeVisible();

  // Alice removes Charlie via ManageMembers.
  await pageA.getByRole('button', { name: /manage members/i }).click();
  await pageA.getByLabel('Select Charlie').check();
  await pageA.getByRole('button', { name: /remove selected \(1\)/i }).click();
  await pageA.getByRole('button', { name: /^confirm$/i }).click();

  // Merge the tombstoned doc into Bob and reload his view.
  await copyDocument(pageA, pageB, groupId!);
  await pageB.reload();

  // Charlie must be gone on Bob; Dave remains.
  await expect(pageB.getByText('Dave')).toBeVisible();
  await expect(pageB.getByText('Charlie')).not.toBeVisible();

  await ctxA.close();
  await ctxB.close();
});

test('re-adding a removed member after tombstone propagates', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await seedIdentity(pageA, 'Alice');
  await seedIdentity(pageB, 'Bob');

  // Alice sets up a group with Charlie.
  await pageA.getByTitle('Create group', { exact: true }).click();
  await pageA.getByLabel(/group name/i).fill('SharedTrip');
  await pageA.getByLabel(/group name/i).press('Enter');
  await pageA.getByRole('button', { name: /^add$/i }).click();
  await pageA.getByLabel(/member name/i).fill('Charlie');
  await pageA.getByRole('button', { name: /^add member$/i }).click();

  const groupId = await pageA.evaluate(() => window.__fairshare!.getGroupIdByName('SharedTrip'));
  await copyDocument(pageA, pageB, groupId!);

  // Capture Charlie's peerId so both peers can address the same member.
  const charlieId = await pageA.evaluate((gid) => {
    const doc = window.__fairshare!.getGroupDoc(gid) as { members: Record<string, { displayName: string; peerId: string }> };
    return Object.values(doc.members).find(m => m.displayName === 'Charlie')?.peerId;
  }, groupId!);
  expect(charlieId).toBeTruthy();

  // Alice removes Charlie and syncs the tombstone to Bob.
  await pageA.getByRole('button', { name: /manage members/i }).click();
  await pageA.getByLabel('Select Charlie').check();
  await pageA.getByRole('button', { name: /remove selected \(1\)/i }).click();
  await pageA.getByRole('button', { name: /^confirm$/i }).click();
  await copyDocument(pageA, pageB, groupId!);

  await pageB.goto(`/group/${groupId}?e2eHook=1`);
  await expect(pageB.getByText('Charlie')).not.toBeVisible();

  // Alice re-adds Charlie by the same peerId (not reachable through the UI,
  // but simulates a merge-time scenario where a re-added record is newer than the tombstone).
  await pageA.evaluate(([gid, cid]) => {
    window.__fairshare!.addMember(gid as string, {
      peerId: cid as string,
      displayName: 'Charlie',
      avatar: '',
      joinedAt: new Date().toISOString(),
      // updatedAt is auto-stamped by addMember → strictly newer than the tombstone.
    });
  }, [groupId, charlieId] as const);

  // Sync the re-add to Bob. Add-wins: Charlie must reappear.
  await copyDocument(pageA, pageB, groupId!);
  await pageB.reload();
  await expect(pageB.getByText('Charlie')).toBeVisible();

  await ctxA.close();
  await ctxB.close();
});
