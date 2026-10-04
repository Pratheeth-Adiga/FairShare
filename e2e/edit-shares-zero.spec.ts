import { test, expect } from '@playwright/test';

// Regression: zero shares must remain valid in EditExpense.

test('EditExpense allows saving a shares split with one member set to 0', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: /get started/i }).click();
  await page.getByPlaceholder(/enter your name/i).fill('Tester');
  await page.getByRole('button', { name: /^continue$/i }).click();

  await page.getByTitle('Create group', { exact: true }).click();
  await page.getByLabel(/group name/i).fill('Trip');
  await page.getByLabel(/group name/i).press('Enter');

  // Add two members so there's a real 3-way split to work with.
  for (const name of ['Alice', 'Bob']) {
    await page.getByRole('button', { name: /^add$/i }).click();
    await page.getByLabel(/member name/i).fill(name);
    await page.getByRole('button', { name: /^add member$/i }).click();
  }

  // Create an expense with the default equal split so we have something to edit.
  await page.getByRole('button', { name: /add first expense/i }).click();
  await page.getByLabel(/^description$/i).fill('Lunch');
  await page.getByLabel(/^amount/i).fill('30');
  await page.getByRole('button', { name: /^add .* expense$/i }).click();

  // Open the expense and enter Edit mode.
  await page.getByText('Lunch').click();
  await page.locator('button:has(svg.lucide-pencil)').click();
  await expect(page).toHaveURL(/\/edit$/);

  // Switch to "Shares" split. The useEffect defaults every share to '1'.
  await page.getByLabel(/split type/i).selectOption({ label: 'Shares' });

  // Zero out Bob's share: the user explicitly excludes him from this split.
  // The shares inputs are unlabeled, so target by the row containing "Bob".
  const bobRow = page.locator('div.flex.items-center', { has: page.getByText('Bob', { exact: true }) });
  await bobRow.locator('input[type="number"]').fill('0');

  // Save. With .every(> 0) the button was disabled; with .some(> 0) it is not.
  const save = page.getByRole('button', { name: /save changes/i });
  await expect(save).toBeEnabled();
  await save.click();

  // Successful save routes back to ExpenseDetail.
  await expect(page).toHaveURL(/\/expense\/[^/]+$/);
});
