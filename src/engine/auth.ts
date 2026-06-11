import type { Page } from '@playwright/test';
import { clickElement, typeText } from '../tools/index.js';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

export const AUTH_FILE = path.resolve(process.cwd(), 'reports', '.auth', 'user.json');

/**
 * Log in to the application and save browser context state (cookies/local storage) to a JSON file.
 */
export async function loginAndSaveSession(page: Page, baseUrl: string): Promise<boolean> {
  const email = process.env.QA_USER_EMAIL;
  const password = process.env.QA_USER_PASSWORD;

  if (!email || !password) {
    console.error('❌ Error: QA_USER_EMAIL and QA_USER_PASSWORD must be defined in the .env file.');
    return false;
  }

  console.log('🔑 Performing login authentication...');
  try {
    await page.goto(baseUrl);
    
    // 1. Click "Log In" trigger
    const loginTriggerSelector = 'a[href*="widgetMode=login"]';
    console.log('Clicking login trigger...');
    const clickTrigger = await clickElement(page, loginTriggerSelector);
    if (!clickTrigger.success) {
      throw new Error(`Failed to click login trigger: ${clickTrigger.error}`);
    }

    // 2. Wait for credentials inputs to become visible
    console.log('Waiting for login modal inputs...');
    await page.locator('#o-auth-username').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#o-auth-password').waitFor({ state: 'visible', timeout: 10000 });

    // 3. Type credentials
    console.log('Filling username and password...');
    await typeText(page, '#o-auth-username', email);
    await typeText(page, '#o-auth-password', password);

    // 4. Click Submit Button
    console.log('Submitting login form...');
    const submitBtn = page.locator('button.o--Button--btn').filter({ hasText: /login|log in|sign in/i }).first();
    await submitBtn.click();

    // 5. Wait for the login modal/username input to disappear, indicating successful auth
    console.log('Waiting for authentication to complete...');
    await page.locator('#o-auth-username').waitFor({ state: 'hidden', timeout: 15000 });
    
    // Wait an additional second for any cookies/localStorage keys to settle
    await page.waitForTimeout(1000);
    console.log('Session established successfully.');

    // Ensure auth folder exists
    const authDir = path.dirname(AUTH_FILE);
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }

    // Save storage state
    await page.context().storageState({ path: AUTH_FILE });
    console.log(`💾 Saved authenticated storage state to: ${AUTH_FILE}`);
    return true;
  } catch (err: any) {
    console.error(`❌ Authentication failed: ${err.message || String(err)}`);
    return false;
  }
}

/**
 * Helper to check if a valid session file exists.
 */
export function hasSession(): boolean {
  if (fs.existsSync(AUTH_FILE)) {
    const stats = fs.statSync(AUTH_FILE);
    // Ensure the file is not empty and was created recently (e.g., within the last 24 hours)
    const ageInHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
    return stats.size > 0 && ageInHours < 24;
  }
  return false;
}
