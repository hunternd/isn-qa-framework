import { test, expect } from '@playwright/test';

test('boot verification - check playwright integration', async ({ page }) => {
  await page.goto('/');
  const title = await page.title();
  expect(title).toBeTruthy();
  console.log('Successfully loaded target page. Title is:', title);
});
