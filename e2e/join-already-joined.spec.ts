import { test, expect } from '@playwright/test';

// Visiting an invite link for a group already joined locally must not restart the handshake.
test('visiting an invite link for a group already joined shows the short-circuit card', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: /get started/i }).click();
  await page.getByPlaceholder(/enter your name/i).fill('Tester');
  await page.getByRole('button', { name: /^continue$/i }).click();

  await page.getByTitle('Create group', { exact: true }).click();
  await page.getByLabel(/group name/i).fill('Trip');
  await page.getByLabel(/group name/i).press('Enter');

  await expect(page).toHaveURL(/\/group\/([^/]+)$/);
  const groupUrl = page.url();
  const groupId = groupUrl.split('/group/')[1];

  // Visit an invite link pointing at the group we already own.
  await page.goto(`/join?topic=${encodeURIComponent(groupId)}&name=Trip`);

  await expect(page.getByText(/you're already in this group/i)).toBeVisible();
  await page.getByRole('button', { name: /open group/i }).click();
  await expect(page).toHaveURL(new RegExp(`/group/${groupId}$`));
});
