import type { Page } from '@playwright/test';

/**
 * Types text into an input or textarea element specified by the selector.
 * Optionally clears the input before typing.
 */
export async function typeText(
  page: Page,
  selector: string,
  text: string,
  options?: { clearFirst?: boolean; delay?: number; timeout?: number }
): Promise<{ success: boolean; error?: string }> {
  try {
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: 'visible', timeout: options?.timeout ?? 5000 });

    if (options?.clearFirst ?? true) {
      await locator.fill('');
    }

    await locator.pressSequentially(text, {
      delay: options?.delay ?? 50,
      timeout: options?.timeout ?? 5000,
    });

    return { success: true };
  } catch (err: any) {
    return {
      success: false,
      error: `Failed to type text into element with selector "${selector}": ${err.message || String(err)}`,
    };
  }
}
