import type { Page } from '@playwright/test';

/**
 * Clicks on an element specified by the selector.
 * Waits for the element to be visible and enabled before clicking.
 */
export async function clickElement(
  page: Page,
  selector: string,
  options?: { timeout?: number; force?: boolean }
): Promise<{ success: boolean; error?: string }> {
  try {
    // Wait for the element to be attached and visible
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: 'visible', timeout: options?.timeout ?? 5000 });
    
    // Click the element
    await locator.click({
      force: options?.force ?? false,
      timeout: options?.timeout ?? 5000,
    });
    
    return { success: true };
  } catch (err: any) {
    return {
      success: false,
      error: `Failed to click element with selector "${selector}": ${err.message || String(err)}`,
    };
  }
}
