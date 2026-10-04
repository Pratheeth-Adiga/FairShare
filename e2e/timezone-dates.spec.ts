import { test, expect } from '@playwright/test';

// Verify date-only entries stay stable across small and large timezone shifts.

test('date-only expense shown in the same tz survives midnight-adjacent entries', async ({ browser }) => {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata' });
  const page = await ctx.newPage();
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
  await page.getByLabel(/^description$/i).fill('NewYearLunch');
  await page.getByLabel(/^amount/i).fill('40');
  // Explicitly type Jan 1 so we're not relying on today's date.
  await page.getByLabel(/^date$/i).fill('2026-01-01');
  await page.getByRole('button', { name: /^add .* expense$/i }).click();

  // The date should remain Jan 1 in the author's timezone.
  await expect(page).toHaveURL(/\/group\/[^/]+$/);
  await expect(page.getByText(/1\/1\/2026|01\/01\/2026|Jan 1, 2026/)).toBeVisible();
  await ctx.close();
});

test('same expense viewed from a very different timezone renders the author\'s calendar day', async ({ browser }) => {
  // a Tokyo-authored Jan 1 must still display as Jan 1 in Los Angeles
  const tokyoCtx = await browser.newContext({ timezoneId: 'Asia/Tokyo' });
  const tokyoPage = await tokyoCtx.newPage();
  await tokyoPage.goto('/');

  await tokyoPage.getByRole('button', { name: /get started/i }).click();
  await tokyoPage.getByPlaceholder(/enter your name/i).fill('Tester');
  await tokyoPage.getByRole('button', { name: /^continue$/i }).click();

  await tokyoPage.getByTitle('Create group', { exact: true }).click();
  await tokyoPage.getByLabel(/group name/i).fill('Trip');
  await tokyoPage.getByLabel(/group name/i).press('Enter');

  await tokyoPage.getByRole('button', { name: /^add$/i }).click();
  await tokyoPage.getByLabel(/member name/i).fill('Alice');
  await tokyoPage.getByRole('button', { name: /^add member$/i }).click();

  await tokyoPage.getByRole('button', { name: /add first expense/i }).click();
  await tokyoPage.getByLabel(/^description$/i).fill('TokyoLunch');
  await tokyoPage.getByLabel(/^amount/i).fill('50');
  await tokyoPage.getByLabel(/^date$/i).fill('2026-01-01');
  await tokyoPage.getByRole('button', { name: /^add .* expense$/i }).click();

  // Export the group as JSON so we can re-import it into an LA context.
  await tokyoPage.locator('button:has(svg.lucide-settings)').click();
  const downloadPromise = tokyoPage.waitForEvent('download');
  await tokyoPage.getByRole('button', { name: /export json/i }).click();
  const download = await downloadPromise;
  const path = await download.path();
  const fs = await import('node:fs/promises');
  const exportJson = await fs.readFile(path!, 'utf-8');
  await tokyoCtx.close();

  const laCtx = await browser.newContext({ timezoneId: 'America/Los_Angeles' });
  const laPage = await laCtx.newPage();
  await laPage.goto('/');
  await laPage.getByRole('button', { name: /get started/i }).click();
  await laPage.getByPlaceholder(/enter your name/i).fill('LATester');
  await laPage.getByRole('button', { name: /^continue$/i }).click();
  await laPage.getByTitle('Create group', { exact: true }).click();
  await laPage.getByLabel(/group name/i).fill('Placeholder');
  await laPage.getByLabel(/group name/i).press('Enter');
  await laPage.locator('button:has(svg.lucide-settings)').click();
  await laPage.setInputFiles('input[type="file"][accept*="json" i]', {
    name: 'trip.json',
    mimeType: 'application/json',
    buffer: Buffer.from(exportJson, 'utf-8'),
  });
  // a file for a different group than the one open asks first
  await laPage.getByRole('button', { name: /^import$/i }).click();
  await expect(laPage.getByText(/imported "trip"/i)).toBeVisible();
  await laPage.keyboard.press('Escape');
  await laPage.goto('/dashboard');
  // The imported group appears on Dashboard once importDocument's async work resolves.
  await expect(laPage.getByText('Trip')).toBeVisible();
  await laPage.getByText('Trip').click();

  // The LA viewer must see the author's calendar day (Jan 1), NOT Dec 31.
  await expect(laPage.getByText(/1\/1\/2026|01\/01\/2026|Jan 1, 2026/)).toBeVisible();
  await expect(laPage.getByText(/12\/31\/2025|Dec 31, 2025/)).not.toBeVisible();
  await laCtx.close();
});
