import type { Page } from '@playwright/test';

// Append Playwright's :visible pseudo-class so locator.first() prefers an
// actually-visible match over a hidden one with the same selector. This is the
// fix for the "shared href" case: navbar dropdown items and footer links can
// share `href="/news#newsletter"`, but the navbar one is hidden when the menu
// is collapsed. Without :visible, .first() picks the hidden DOM element and
// the click times out.
function visibleVariant(selector: string): string {
  if (selector.includes(':visible')) return selector;
  return `${selector}:visible`;
}

/**
 * Clicks on an element specified by the selector.
 * Waits for the element to be visible and enabled before clicking.
 */
export async function clickElement(
  page: Page,
  selector: string,
  options?: { timeout?: number; force?: boolean }
): Promise<{ success: boolean; error?: string }> {
  // Try the visibility-filtered variant first; fall back to the raw selector
  // only if no visible match exists (rare — usually means the element
  // genuinely isn't on the page).
  const visibleSelector = visibleVariant(selector);
  const timeout = options?.timeout ?? 5000;

  try {
    const visibleLocator = page.locator(visibleSelector).first();
    if (await visibleLocator.count() > 0) {
      await visibleLocator.waitFor({ state: 'visible', timeout });
      await visibleLocator.click({
        force: options?.force ?? false,
        timeout,
      });
      return { success: true };
    }
  } catch (err: any) {
    return {
      success: false,
      error: `Failed to click element with selector "${selector}": ${err.message || String(err)}`,
    };
  }

  // Fallback: original selector (preserves prior behavior when nothing visible matches).
  try {
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: 'visible', timeout });
    await locator.click({
      force: options?.force ?? false,
      timeout,
    });
    return { success: true };
  } catch (err: any) {
    return {
      success: false,
      error: `Failed to click element with selector "${selector}": ${err.message || String(err)}`,
    };
  }
}
