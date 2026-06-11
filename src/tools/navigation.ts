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

    // Helper to generate a unique selector or at least a highly specific one
    function getSelector(el: Element): string {
      if (el.id) {
        if (/^[0-9]/.test(el.id)) {
          return `[id="${el.id}"]`;
        }
        return `#${el.id}`;
      }
      if (el.getAttribute('name')) {
        return `${el.tagName.toLowerCase()}[name="${el.getAttribute('name')}"]`;
      }
      if (el.tagName.toLowerCase() === 'a') {
        const href = el.getAttribute('href');
        if (href && href !== '#' && !href.startsWith('javascript:')) {
          return `a[href="${href}"]`;
        }
      }
      
      let selector = el.tagName.toLowerCase();
      
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) {
        return `${selector}[aria-label="${ariaLabel}"]`;
      }
      
      const role = el.getAttribute('role');
      if (role) {
        selector += `[role="${role}"]`;
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
