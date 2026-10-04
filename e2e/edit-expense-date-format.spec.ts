import { test, expect } from '@playwright/test';

// verify edited dates remain plain YYYY-MM-DD values in persisted data

async function setup(page: import('@playwright/test').Page) {
  await page.goto('/?e2eHook=1');
  await page.getByRole('button', { name: /get started/i }).click();
  await page.getByPlaceholder(/enter your name/i).fill('Tester');
  await page.getByRole('button', { name: /^continue$/i }).click();

  await page.getByTitle('Create group', { exact: true }).click();
  await page.getByLabel(/group name/i).fill('Trip');
  await page.getByLabel(/group name/i).press('Enter');

  await page.getByRole('button', { name: /^add$/i }).click();
  await page.getByLabel(/member name/i).fill('Alice');
  await page.getByRole('button', { name: /^add member$/i }).click();

  await page.getByRole('button', { name: /add first expense/i }).click();
  await page.getByLabel(/^description$/i).fill('Lunch');
  await page.getByLabel(/^amount/i).fill('40');
  await page.getByLabel(/^date$/i).fill('2026-01-01');
  await page.getByRole('button', { name: /^add .* expense$/i }).click();
  await expect(page).toHaveURL(/\/group\/[^/]+$/);
}

async function storedDates(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const gid = window.__fairshare!.getGroupIdByName('Trip')!;
    const doc = window.__fairshare!.getGroupDoc(gid) as {
      expenses: Record<string, { date: string }>;
    };
    return Object.values(doc.expenses).map(e => e.date);
  });
}

async function openEditor(page: import('@playwright/test').Page) {
  await page.getByText('Lunch').click();
  await page.locator('button:has(svg.lucide-pencil)').click();
  await expect(page).toHaveURL(/\/edit$/);
}

test('an edit leaves the date as a bare YYYY-MM-DD string', async ({ page }) => {
  await setup(page);
  expect(await storedDates(page)).toEqual(['2026-01-01']);

  await openEditor(page);
  await page.getByLabel(/^description$/i).fill('Lunch v2');
  await page.getByRole('button', { name: /save changes/i }).click();
  await expect(page).toHaveURL(/\/expense\/[^/]+$/);

  // Previously this became "2026-01-01T12:00:00.000Z".
  expect(await storedDates(page)).toEqual(['2026-01-01']);
});

test('changing the date stores the newly picked calendar day verbatim', async ({ page }) => {
  await setup(page);
  await openEditor(page);
  await page.getByLabel(/^date$/i).fill('2026-02-14');
  await page.getByRole('button', { name: /save changes/i }).click();
  await expect(page).toHaveURL(/\/expense\/[^/]+$/);

  expect(await storedDates(page)).toEqual(['2026-02-14']);
});

test('editing twice is idempotent - the format never drifts', async ({ page }) => {
  await setup(page);
  for (const suffix of ['v2', 'v3']) {
    await page.goto('/?e2eHook=1');
    await page.getByText('Trip').click();
    await openEditor(page);
    await page.getByLabel(/^description$/i).fill('Lunch ' + suffix);
    await page.getByRole('button', { name: /save changes/i }).click();
    await expect(page).toHaveURL(/\/expense\/[^/]+$/);
  }
  expect(await storedDates(page)).toEqual(['2026-01-01']);
});
