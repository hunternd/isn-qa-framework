import { test, expect } from '@playwright/test';
import { navigate, readPageContent, takeScreenshot } from '../src/tools/index.js';

test('verify framework tools integration', async ({ page }) => {
  // 1. Test Navigate
  console.log('Navigating to target site...');
  const navResult = await navigate(page, '/');
  expect(navResult.success).toBe(true);
  console.log('Successfully navigated. Current URL is:', navResult.currentUrl);

  // 2. Test Read Page Content
  console.log('Reading page content...');
  const pageContent = await readPageContent(page);
  expect(pageContent.title).toContain('Independent Sponsor News');
  console.log(`Page Title: "${pageContent.title}"`);
  console.log(`Interactive Elements Found: ${pageContent.interactiveElements.length}`);
  
  if (pageContent.interactiveElements.length > 0) {
    console.log('Sample Interactive Elements:');
    pageContent.interactiveElements.slice(0, 5).forEach((el, index) => {
      console.log(`  [${index + 1}] tag=${el.tagName}, selector="${el.selector}", text="${el.text || ''}"`);
    });
  }

  // 3. Test Screenshot
  console.log('Taking screenshot...');
  const screenshotResult = await takeScreenshot(page, 'homepage_test');
  expect(screenshotResult.success).toBe(true);
  console.log('Screenshot saved to:', screenshotResult.filePath);
});
