import { test, expect } from '@playwright/test';

// End-to-end coverage for group backup export → delete → import round-trip.
// Locks in the guarantee that a user who exports a group JSON, wipes it, and
// re-imports the same file gets an identical group back (members + expenses).

test('export group JSON, delete it, and re-import it', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: /get started/i }).click();
  await page.getByPlaceholder(/enter your name/i).fill('Tester');
  await page.getByRole('button', { name: /^continue$/i }).click();

  // Group A with a member and one expense: the group we want to back up.
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

  // Open the group settings sheet, capture the JSON export.
  await expect(page).toHaveURL(/\/group\/[^/]+$/);
  await page.locator('button:has(svg.lucide-settings)').click();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /export json/i }).click();
  const download = await downloadPromise;
  const exportedText = await (async () => {
    const path = await download.path();
    if (!path) throw new Error('Download had no local path');
    const fs = await import('node:fs/promises');
    return fs.readFile(path, 'utf-8');
  })();
  expect(exportedText).toContain('Trip');
  expect(exportedText).toContain('Alice');
  expect(exportedText).toContain('Lunch');

  // Delete the group.
  await page.getByRole('button', { name: /^delete group$/i }).click();
  await page.getByRole('button', { name: /confirm delete/i }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText(/no groups yet/i)).toBeVisible();

  // Create a placeholder group just to reach the Import UI (Import JSON lives
  // inside a group's Settings sheet). A real user restoring from a fresh
  // install would do the same to get past the empty-state.
  await page.getByTitle('Create group', { exact: true }).click();
  await page.getByLabel(/group name/i).fill('Placeholder');
  await page.getByLabel(/group name/i).press('Enter');

  await page.locator('button:has(svg.lucide-settings)').click();
  await page.setInputFiles('input[type="file"][accept*="json" i]', {
    name: 'trip-export.json',
    mimeType: 'application/json',
    buffer: Buffer.from(exportedText, 'utf-8'),
  });
  // a file for a different group than the one open asks first
  await page.getByRole('button', { name: /^import$/i }).click();
  await expect(page.getByText(/imported "trip"/i)).toBeVisible();

  // Close the settings sheet and go back to the dashboard.
  await page.keyboard.press('Escape');
  await page.goto('/dashboard');

  // Original "Trip" must be back, with 2 members and its expense preserved.
  await expect(page.getByText('Trip')).toBeVisible();
  await page.getByText('Trip').click();
  await expect(page.getByRole('heading', { name: /members \(2\)/i })).toBeVisible();
  await expect(page.getByText('Lunch')).toBeVisible();
});
