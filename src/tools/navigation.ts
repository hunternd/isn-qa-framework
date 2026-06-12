import type { Page } from '@playwright/test';

/**
 * Navigates to a specified URL.
 * Supports both relative URLs (resolved against baseURL) and absolute URLs.
 */
export async function navigate(page: Page, url: string): Promise<{ success: boolean; currentUrl: string; error?: string }> {
  try {
    const response = await page.goto(url, { waitUntil: 'load' });
    const currentUrl = page.url();
    if (!response) {
      return { success: false, currentUrl, error: 'Failed to get a response from the page.' };
    }
    const status = response.status();
    if (status >= 400) {
      return { success: false, currentUrl, error: `HTTP status code: ${status}` };
    }
    return { success: true, currentUrl };
  } catch (err: any) {
    return { success: false, currentUrl: page.url(), error: err.message || String(err) };
  }
}

export interface InteractiveElement {
  tagName: string;
  type?: string | undefined;
  id?: string | undefined;
  className?: string | undefined;
  text?: string | undefined;
  name?: string | undefined;
  placeholder?: string | undefined;
  ariaLabel?: string | undefined;
  selector: string;
}

export interface PageContent {
  title: string;
  url: string;
  text: string;
  interactiveElements: InteractiveElement[];
}

/**
 * Extracts content from the page, including title, text content, and interactive elements.
 * This structured data is designed to be passed to LLM agents for decision making.
 */
export async function readPageContent(page: Page): Promise<PageContent> {
  const title = await page.title();
  const url = page.url();

  // Extract page text content (cleaned up)
  const text = await page.evaluate(() => {
    // Remove scripts, styles, and SVG text content
    const elementsToRemove = document.querySelectorAll('script, style, svg');
    elementsToRemove.forEach(el => el.remove());
    return document.body.innerText || '';
  });

  // Extract interactive elements
  const interactiveElements = await page.evaluate(() => {
    const elements: InteractiveElement[] = [];

    function escapeAttr(s: string): string {
      return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    function isStableId(id: string): boolean {
      if (id.length > 50) return false;
      // Hex-like IDs (uuids, hashes) are auto-generated and change across runs.
      if (/^[a-f0-9]{16,}$/i.test(id)) return false;
      return true;
    }

    function isCleanHref(href: string | null): boolean {
      if (!href) return false;
      if (href === '#' || href === '') return false;
      if (href.startsWith('javascript:')) return false;
      // Malformed (multi-value) hrefs like "https://x.com news@x.com".
      if (href.includes(' ')) return false;
      // Query strings carry UTM and per-render tokens that break stability.
      if (href.includes('?')) return false;
      // Template placeholders e.g. SUBSCRIBER_ID, USER_ID, ACCESS_TOKEN.
      if (/\b[A-Z][A-Z_]{3,}\b/.test(href)) return false;
      if (href.length > 80) return false;
      return true;
    }

    // Helper to generate a stable, short, locator-friendly selector.
    // Priority: data-testid → stable id → name → aria-label → clean href → text → class fallback.
    function getSelector(el: Element): string {
      const tag = el.tagName.toLowerCase();

      const testId = el.getAttribute('data-testid');
      if (testId) {
        return `[data-testid="${escapeAttr(testId)}"]`;
      }

      if (el.id && isStableId(el.id)) {
        if (/^[0-9]/.test(el.id)) {
          return `[id="${escapeAttr(el.id)}"]`;
        }
        return `#${el.id}`;
      }

      const name = el.getAttribute('name');
      if (name) {
        return `${tag}[name="${escapeAttr(name)}"]`;
      }

      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) {
        return `${tag}[aria-label="${escapeAttr(ariaLabel)}"]`;
      }

      if (tag === 'a') {
        const href = el.getAttribute('href');
        if (isCleanHref(href)) {
          return `a[href="${href}"]`;
        }
      }

      // Text-based fallback — works for nav links, buttons, "here" links inside templated
      // newsletter footers, and any anchor whose href was UTM-laden or placeholder-laden.
      const rawText = (el.textContent || '').trim().replace(/\s+/g, ' ');
      if (rawText) {
        const snippet = rawText.length > 40 ? rawText.slice(0, 40) : rawText;
        return `${tag}:has-text("${escapeAttr(snippet)}")`;
      }

      // Final fallback: tag + role + first class.
      let selector = tag;
      const role = el.getAttribute('role');
      if (role) {
        selector += `[role="${escapeAttr(role)}"]`;
      }
      if (el.className && typeof el.className === 'string') {
        const cleanClasses = el.className.trim().split(/\s+/).filter(c => c && !c.includes(':') && !c.includes('{'));
        if (cleanClasses.length > 0 && cleanClasses[0]) {
          selector += `.${cleanClasses[0]}`;
        }
      }
      return selector;
    }

    // Find links, buttons, inputs, selects, textareas, and elements with roles like button
    const querySelectors = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"]';
    const foundElements = document.querySelectorAll(querySelectors);

    foundElements.forEach(el => {
      // Basic visibility check
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const isVisible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';

      if (isVisible) {
        elements.push({
          tagName: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || undefined,
          id: el.id || undefined,
          className: el.className || undefined,
          text: (el.textContent || '').trim().substring(0, 100) || undefined,
          name: el.getAttribute('name') || undefined,
          placeholder: el.getAttribute('placeholder') || undefined,
          ariaLabel: el.getAttribute('aria-label') || undefined,
          selector: getSelector(el),
        });
      }
    });

    return elements;
  });

  return {
    title,
    url,
    text,
    interactiveElements,
  };
}
