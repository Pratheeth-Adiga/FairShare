import { test, expect } from '@playwright/test';
import { copyDocument, seedIdentity } from './helpers.js';

async function addMember(page: import('@playwright/test').Page, name: string) {
  await page.getByRole('button', { name: /^add$/i }).click();
  await page.getByLabel(/member name/i).fill(name);
  await page.getByRole('button', { name: /^add member$/i }).click();
}

async function addExpense(page: import('@playwright/test').Page, description: string, amount: string) {
  const addButton = page.getByRole('button', { name: /add first expense/i });
  if (await addButton.isVisible()) {
    await addButton.click();
  } else {
    await page.getByTitle('Add expense').click();
  }
  await page.getByLabel(/^description$/i).fill(description);
  await page.getByLabel(/^amount/i).fill(amount);
  await page.getByRole('button', { name: /^add .* expense$/i }).click();
}

test('two peers converge after joining and each adding an expense', async ({ browser }) => {
  const creatorContext = await browser.newContext();
  const joinerContext = await browser.newContext();
  const creator = await creatorContext.newPage();
  const joiner = await joinerContext.newPage();

  await seedIdentity(creator, 'Creator');
  await seedIdentity(joiner, 'Alan');

  await creator.getByTitle('Create group', { exact: true }).click();
  await creator.getByLabel(/group name/i).fill('Convergence');
  await creator.getByLabel(/group name/i).press('Enter');
  await addMember(creator, 'Alan');
  await addExpense(creator, 'Creator expense', '100');

  const groupId = await creator.evaluate(() => window.__fairshare!.getGroupIdByName('Convergence'));
  expect(groupId).toBeTruthy();
  await copyDocument(creator, joiner, groupId!);

  const joinerPeerId = await joiner.evaluate(() => window.__fairshare!.getIdentityPeerId());
  expect(joinerPeerId).toBeTruthy();
  await joiner.evaluate(([group, peerId]) => window.__fairshare!.addMember(group as string, {
    peerId: peerId as string,
    displayName: 'Alan',
    avatar: '',
    joinedAt: new Date().toISOString(),
    publicKey: (peerId as string).replace(/^peer-/, ''),
  }), [groupId, joinerPeerId] as const);
  await copyDocument(joiner, creator, groupId!);

  await joiner.goto(`/group/${groupId}?e2eHook=1`);
  await expect(joiner.getByRole('heading', { name: /members \(3\)/i })).toBeVisible();
  await expect(joiner.getByRole('button', { name: /claim member/i })).toBeVisible();
  await addExpense(joiner, 'Joiner expense', '60');

  await copyDocument(joiner, creator, groupId!);
  await copyDocument(creator, joiner, groupId!);

  for (const page of [creator, joiner]) {
    await page.goto(`/group/${groupId}?e2eHook=1`);
    await expect(page.getByRole('heading', { name: /members \(3\)/i })).toBeVisible();
    await expect(page.getByText('Creator expense')).toBeVisible();
    await expect(page.getByText('Joiner expense')).toBeVisible();
  }

  const participantSummary = await Promise.all([creator, joiner].map(page => page.evaluate(group => {
    const doc = window.__fairshare!.getGroupDoc(group) as { members: Record<string, unknown>; expenses: Record<string, unknown> };
    return { members: Object.keys(doc.members).sort(), expenses: Object.keys(doc.expenses).sort() };
  }, groupId!)));
  expect(participantSummary[0]).toEqual(participantSummary[1]);

  await creatorContext.close();
  await joinerContext.close();
});

test('a differently named joiner can explicitly claim or preserve a manual placeholder', async ({ browser }) => {
  const creatorContext = await browser.newContext();
  const joinerContext = await browser.newContext();
  const creator = await creatorContext.newPage();
  const joiner = await joinerContext.newPage();

  await seedIdentity(creator, 'Creator');
  await seedIdentity(joiner, 'Alan W');
  await creator.getByTitle('Create group', { exact: true }).click();
  await creator.getByLabel(/group name/i).fill('Claims');
  await creator.getByLabel(/group name/i).press('Enter');
  await addMember(creator, 'Alan');
  await addExpense(creator, 'Alan balance', '40');

  const groupId = await creator.evaluate(() => window.__fairshare!.getGroupIdByName('Claims'));
  await copyDocument(creator, joiner, groupId!);
  const joinerPeerId = await joiner.evaluate(() => window.__fairshare!.getIdentityPeerId());
  await joiner.evaluate(([group, peerId]) => window.__fairshare!.addMember(group as string, {
    peerId: peerId as string,
    displayName: 'Alan W',
    avatar: '',
    joinedAt: new Date().toISOString(),
    publicKey: (peerId as string).replace(/^peer-/, ''),
  }), [groupId, joinerPeerId] as const);

  await joiner.goto(`/group/${groupId}?e2eHook=1`);
  await joiner.getByRole('button', { name: /claim member/i }).click();
  await expect(joiner.getByRole('heading', { name: /claim existing member/i })).toBeVisible();
  await joiner.getByRole('button', { name: /yes, claim record/i }).click();

  const result = await joiner.evaluate(group => {
    const doc = window.__fairshare!.getGroupDoc(group) as {
      members: Record<string, { displayName: string }>;
      expenses: Record<string, { splits: { userId: string }[] }>;
    };
    return {
      names: Object.values(doc.members).map(member => member.displayName),
      splitIds: Object.values(doc.expenses)[0].splits.map(split => split.userId),
    };
  }, groupId!);
  expect(result.names).toContain('Alan W');
  expect(result.names).not.toContain('Alan');
  expect(result.splitIds).toContain(joinerPeerId);

  await creatorContext.close();
  await joinerContext.close();
});