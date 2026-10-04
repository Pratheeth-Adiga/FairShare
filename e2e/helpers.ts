import { expect, type Page } from '@playwright/test';

export async function seedIdentity(page: Page, name: string): Promise<void> {
  await page.goto('/?e2eHook=1');
  await page.getByRole('button', { name: /get started/i }).click();
  await page.getByPlaceholder(/enter your name/i).fill(name);
  await page.getByRole('button', { name: /^continue$/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

export async function copyDocument(source: Page, destination: Page, groupId: string): Promise<void> {
  const document = await source.evaluate(group => window.__fairshare!.getGroupDoc(group), groupId);
  await destination.evaluate(
    ([group, doc]) => window.__fairshare!.mergeRemoteDocument(group as string, doc),
    [groupId, document] as const,
  );
}