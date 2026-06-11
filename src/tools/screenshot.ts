import type { Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Takes a screenshot of the current page state and saves it under the reports/screenshots directory.
 */
export async function takeScreenshot(page: Page, fileName: string): Promise<{ success: boolean; filePath?: string; error?: string }> {
  try {
    const reportDir = path.resolve(process.cwd(), 'reports', 'screenshots');
    
    // Ensure screenshots folder exists
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    // Ensure filename ends with .png
    const sanitizedName = fileName.endsWith('.png') ? fileName : `${fileName}.png`;
    const filePath = path.join(reportDir, sanitizedName);

    await page.screenshot({ path: filePath, fullPage: true });
    
    return { success: true, filePath };
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}
