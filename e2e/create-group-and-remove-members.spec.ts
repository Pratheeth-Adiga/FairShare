import { test, expect } from '@playwright/test';

// End-to-end smoke test for the two bug classes fixed recently:
//  1. Multi-member remove failing to remove all selected members (dialog bug)
//  2. Member count in Dashboard drifting from actual document state (mirror bug)

test('create group, add members, remove multiple via manage-members dialog', async ({ page }) => {
  await page.goto('/');

  // Onboarding
  await page.getByRole('button', { name: /get started/i }).click();
  await page.getByPlaceholder(/enter your name/i).fill('Tester');
  await page.getByRole('button', { name: /^continue$/i }).click();

  // Dashboard
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByTitle('Create group', { exact: true }).click();

  // Create Group dialog
  await page.getByLabel(/group name/i).fill('Roommates');
  await page.getByLabel(/group name/i).press('Enter');

  // GroupDetail: creator is member #1
  await expect(page).toHaveURL(/\/group\//);
  await expect(page.getByRole('heading', { name: /members \(1\)/i })).toBeVisible();

  // Add three members via the "Add" button in the members header
  for (const name of ['Alice', 'Bob', 'Carol']) {
    await page.getByRole('button', { name: /^add$/i }).click();
    await page.getByLabel(/member name/i).fill(name);
    await page.getByRole('button', { name: /^add member$/i }).click();
  }
  await expect(page.getByRole('heading', { name: /members \(4\)/i })).toBeVisible();

  // Open Manage Members, select Alice and Bob, remove them
  await page.getByRole('button', { name: /manage members/i }).click();
  await page.getByLabel('Select Alice').check();
  await page.getByLabel('Select Bob').check();
  await page.getByRole('button', { name: /remove selected \(2\)/i }).click();
  await page.getByRole('button', { name: /^confirm$/i }).click();

  // Both members should be gone; count is now 2 (self + Carol).
  // This asserts the multi-remove loop actually removed both selected members.
  await expect(page.getByRole('heading', { name: /members \(2\)/i })).toBeVisible();

  // Dashboard should reflect the current derived member count (not a stale
  // mirror). This asserts the memberCount-duplication fix in groups.store.
  await page.goto('/dashboard');
  await expect(page.getByText(/2 members/i)).toBeVisible();
});
