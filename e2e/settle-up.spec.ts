import { test, expect } from '@playwright/test';

// Regression coverage for the settle-up quick-settle flow.
// After a suggested settlement is applied, the pair balance must be zero and
// the group card on Dashboard should read "settled".

test('quick-settle clears the pair balance', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: /get started/i }).click();
  await page.getByPlaceholder(/enter your name/i).fill('Tester');
  await page.getByRole('button', { name: /^continue$/i }).click();

  await page.getByTitle('Create group', { exact: true }).click();
  await page.getByLabel(/group name/i).fill('Trip');
  await page.getByLabel(/group name/i).press('Enter');

  await page.getByRole('button', { name: /^add$/i }).click();
  await page.getByLabel(/member name/i).fill('Alice');
  await page.getByRole('button', { name: /^add member$/i }).click();

  // Create ₹40 expense so Alice owes Tester ₹20.
  await page.getByRole('button', { name: /add first expense/i }).click();
  await page.getByLabel(/^description$/i).fill('Lunch');
  await page.getByLabel(/^amount/i).fill('40');
  await page.getByRole('button', { name: /^add .* expense$/i }).click();

  // Open the settle-up page and apply the first suggested settlement.
  await expect(page).toHaveURL(/\/group\/[^/]+$/);
  await page.getByRole('button', { name: /settle up/i }).click();
  await expect(page).toHaveURL(/\/settle$/);
  await expect(page.getByRole('heading', { name: /suggested settlements/i })).toBeVisible();

  // The "Suggested Settlements" section has a Settle button per debt; the first
  // one clears our only debt.
  await page.getByRole('button', { name: /^settle$/i }).first().click();

  // Back on GroupDetail, then confirm Dashboard shows this group as settled.
  await expect(page).toHaveURL(/\/group\/[^/]+$/);
  await page.goto('/dashboard');
  await expect(page.getByText(/^settled$/i)).toBeVisible();
});
