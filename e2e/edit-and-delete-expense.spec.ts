import { test, expect } from '@playwright/test';

// Regression coverage for edit-expense and delete-expense flows.
// Wires the same expense-form logic that AddExpense uses, plus the destructive
// removeExpense path that must not leave a stale balance behind.

test('edit an expense and see the recomputed balance', async ({ page }) => {
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

  await page.getByRole('button', { name: /add first expense/i }).click();
  await page.getByLabel(/^description$/i).fill('Lunch');
  await page.getByLabel(/^amount/i).fill('40');
  await page.getByRole('button', { name: /^add .* expense$/i }).click();

  // Open the expense and edit it: bump amount to 100 (my share becomes 50, owed 50).
  await expect(page).toHaveURL(/\/group\/[^/]+$/);
  await page.getByText('Lunch').click();
  await expect(page).toHaveURL(/\/expense\/[^/]+$/);
  // The edit icon is a ghost icon-button next to the delete button.
  await page.locator('button:has(svg.lucide-pencil)').click();
  await expect(page).toHaveURL(/\/edit$/);

  await page.getByLabel(/^amount/i).fill('100');
  await page.getByRole('button', { name: /save changes/i }).click();

  // EditExpense navigates back to ExpenseDetail, not GroupDetail.
  await expect(page).toHaveURL(/\/expense\/[^/]+$/);
  await page.goto('/dashboard');
  await expect(page.getByText(/you are owed ₹50\.00/i)).toBeVisible();
});

test('delete an expense and see the balance return to zero', async ({ page }) => {
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

  await page.getByRole('button', { name: /add first expense/i }).click();
  await page.getByLabel(/^description$/i).fill('Lunch');
  await page.getByLabel(/^amount/i).fill('40');
  await page.getByRole('button', { name: /^add .* expense$/i }).click();

  // Open the expense, delete it via the in-panel two-step confirm.
  await expect(page).toHaveURL(/\/group\/[^/]+$/);
  await page.getByText('Lunch').click();
  await page.locator('button:has(svg.lucide-trash-2)').first().click();
  await page.getByRole('button', { name: /confirm delete/i }).click();

  // Zero balance is rendered as "Settled up" and "settled", not 0.00.
  await expect(page).toHaveURL(/\/group\/[^/]+$/);
  await page.goto('/dashboard');
  await expect(page.getByText(/settled up/i)).toBeVisible();
  await expect(page.getByText(/^settled$/i)).toBeVisible();
  // And the expense really is gone, not merely hidden from the balance.
  await page.getByText('Trip').click();
  await expect(page.getByText('Lunch')).toHaveCount(0);
});
