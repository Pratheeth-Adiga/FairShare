import { test, expect } from '@playwright/test';

// Cover the add-expense flow and the resulting dashboard balance.

test('add expense splits equally and shows Dashboard balance', async ({ page }) => {
  await page.goto('/');

  // Onboarding
  await page.getByRole('button', { name: /get started/i }).click();
  await page.getByPlaceholder(/enter your name/i).fill('Tester');
  await page.getByRole('button', { name: /^continue$/i }).click();

  // Create group (default currency is INR)
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByTitle('Create group', { exact: true }).click();
  await page.getByLabel(/group name/i).fill('Trip');
  await page.getByLabel(/group name/i).press('Enter');

  // Add a second member so an equal-split has someone to owe us.
  await expect(page).toHaveURL(/\/group\//);
  await page.getByRole('button', { name: /^add$/i }).click();
  await page.getByLabel(/member name/i).fill('Alice');
  await page.getByRole('button', { name: /^add member$/i }).click();

  // Create the expense: ₹40 paid by Tester, split equally between both members.
  await page.getByRole('button', { name: /add first expense/i }).click();
  await expect(page).toHaveURL(/\/expense\/new$/);
  await page.getByLabel(/^description$/i).fill('Lunch');
  await page.getByLabel(/^amount/i).fill('40');
  await page.getByRole('button', { name: /^add .* expense$/i }).click();

  // Back on GroupDetail: expense should be visible.
  await expect(page).toHaveURL(/\/group\/[^/]+$/);
  await expect(page.getByText('Lunch')).toBeVisible();

  // Adding repeatedly must not leave stale Add Expense / Group entries in
  // browser history. One Back after two submissions should reach Dashboard.
  await page.locator('button:has(svg.lucide-plus)').last().click();
  await expect(page).toHaveURL(/\/expense\/new$/);
  await page.getByLabel(/^description$/i).fill('Coffee');
  await page.getByLabel(/^amount/i).fill('10');
  await page.getByRole('button', { name: /^add .* expense$/i }).click();
  await expect(page).toHaveURL(/\/group\/[^/]+$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard$/);

  // Dashboard should show Tester is owed ₹25.00: ₹20 from lunch plus ₹5
  // from coffee, both paid by Tester and split equally.
  // The value renders in two places (overall banner + per-group card).
  await page.goto('/dashboard');
  await expect(page.getByText(/you are owed ₹25\.00/i)).toBeVisible();
  await expect(page.getByText(/\+₹25\.00/)).toBeVisible();
});
