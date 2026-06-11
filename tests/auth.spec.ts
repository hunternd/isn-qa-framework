import { test, expect } from '@playwright/test';
import { loginAndSaveSession, AUTH_FILE } from '../src/engine/auth.js';
import * as fs from 'fs';

test('authenticate user credentials and save storage state', async ({ page }) => {
  // Set 45 seconds timeout because login contains network wait
  test.setTimeout(45000);

  const baseUrl = 'https://www.independentsponsor.news/';
  
  console.log('Running login test...');
  const success = await loginAndSaveSession(page, baseUrl);
  
  expect(success).toBe(true);
  expect(fs.existsSync(AUTH_FILE)).toBe(true);
  console.log('Successfully completed authentication test. Session saved.');
});
