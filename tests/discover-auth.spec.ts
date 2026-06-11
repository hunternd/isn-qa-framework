import { test, expect } from '@playwright/test';
import { readPageContent, clickElement, takeScreenshot } from '../src/tools/index.js';

test('discover login modal selectors and buttons', async ({ page }) => {
  console.log('Navigating to homepage...');
  await page.goto('/');

  // 1. Scan page content for login trigger elements
  const pageContent = await readPageContent(page);
  console.log('\n--- Scanning for Login Trigger Elements ---');
  
  const loginTriggers = pageContent.interactiveElements.filter(el => {
    const text = (el.text || '').toLowerCase();
    const id = (el.id || '').toLowerCase();
    const className = (el.className || '').toLowerCase();
    
    return text.includes('log in') || text.includes('login') || 
           text.includes('sign in') || text.includes('signin') ||
           id.includes('login') || id.includes('signin') ||
           className.includes('login') || className.includes('signin');
  });

  if (loginTriggers.length === 0) {
    console.log('No explicit login buttons found by text/class matching. Printing all primary links:');
    pageContent.interactiveElements.slice(0, 10).forEach(el => {
      console.log(`  tag=${el.tagName}, selector="${el.selector}", text="${el.text || ''}"`);
    });
    return;
  }

  console.log(`Found ${loginTriggers.length} potential login buttons:`);
  loginTriggers.forEach((el, idx) => {
    console.log(`  [${idx + 1}] tag=${el.tagName}, selector="${el.selector}", text="${el.text || ''}"`);
  });

  // Choose the first trigger and click it
  const targetTrigger = loginTriggers[0]!;
  console.log(`\nClicking login trigger selector: "${targetTrigger.selector}"`);
  
  await clickElement(page, targetTrigger.selector);
  
  // Wait for modal transition/animations
  console.log('Waiting for modal to load...');
  await page.waitForTimeout(2500);

  // 2. Scan the page again now that the modal should be open
  const modalContent = await readPageContent(page);
  
  console.log('\n--- Input fields currently visible on page ---');
  const inputFields = modalContent.interactiveElements.filter(el => 
    el.tagName === 'input' || el.tagName === 'textarea' || el.tagName === 'button'
  );

  inputFields.forEach((el, idx) => {
    console.log(`  [${idx + 1}] tag=${el.tagName}, type=${el.type || 'N/A'}, id=${el.id || 'N/A'}, name=${el.name || 'N/A'}, placeholder="${el.placeholder || ''}", selector="${el.selector}"`);
  });

  // 3. Take a screenshot of the modal
  console.log('\nTaking screenshot of the opened login modal...');
  const screenshotRes = await takeScreenshot(page, 'discovered_login_modal');
  console.log('Screenshot saved to:', screenshotRes.filePath);
});
