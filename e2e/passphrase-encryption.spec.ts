import { test, expect } from '@playwright/test';

// End-to-end coverage for the key-encryption flow. Enabling encryption in
// Settings must (a) prompt on next boot, (b) reject the wrong passphrase,
// (c) unlock with the correct one.

test('enable key encryption, reload, unlock with the correct passphrase', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: /get started/i }).click();
  await page.getByPlaceholder(/enter your name/i).fill('Tester');
  await page.getByRole('button', { name: /^continue$/i }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  // Enable encryption from Settings.
  await page.getByRole('link', { name: /settings/i }).click();
  await expect(page).toHaveURL(/\/settings$/);

  // Click the hidden toggle because confirmation changes its state.
  const encryptCard = page.locator('div.rounded-lg', { hasText: /encrypt private key at rest/i });
  await encryptCard.locator('input[type="checkbox"]').click({ force: true });

  // Passphrase dialog.
  await page.getByPlaceholder(/^new passphrase$/i).fill('correct-horse-battery');
  await page.getByPlaceholder(/^confirm passphrase$/i).fill('correct-horse-battery');
  await page.getByRole('button', { name: /^encrypt$/i }).click();

  // Wait for the async encryption + save to complete: the dialog closes and
  // the copy switches to the "encrypted" wording.
  await expect(page.getByText(/your private key is encrypted/i)).toBeVisible();

  // Reload: this is the moment initialize() sees the encrypted key.
  await page.reload();

  // Passphrase prompt must appear; wrong passphrase must fail.
  await expect(page.getByRole('heading', { name: /unlock fairshare/i })).toBeVisible();
  await page.getByPlaceholder(/enter passphrase/i).fill('wrong');
  await page.getByRole('button', { name: /^unlock$/i }).click();
  await expect(page.getByText(/unlock failed|incorrect/i)).toBeVisible();

  // Correct passphrase unlocks. Reload happened on /settings, so we stay
  // there; assert the lock screen is gone and the app is interactive.
  await page.getByPlaceholder(/enter passphrase/i).fill('correct-horse-battery');
  await page.getByRole('button', { name: /^unlock$/i }).click();
  await expect(page.getByRole('heading', { name: /unlock fairshare/i })).not.toBeVisible();

  // Sanity: identity survived; the Onboarding screen must not reappear.
  await expect(page.getByRole('button', { name: /get started/i })).not.toBeVisible();

  // Navigate away and back to confirm identity works end-to-end.
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: /fairshare/i })).toBeVisible();
});
