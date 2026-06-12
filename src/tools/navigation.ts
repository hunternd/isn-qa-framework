import type { Page } from '@playwright/test';

/**
 * Navigates to a specified URL.
 * Supports both relative URLs (resolved against baseURL) and absolute URLs.
 */
export async function navigate(page: Page, url: string): Promise<{ success: boolean; currentUrl: string; error?: string }> {
  try {
    const response = await page.goto(url, { waitUntil: 'load' });
    const currentUrl = page.url();
    // page.goto returns null when no HTTP request is issued — most commonly a
    // same-page hash change (e.g. /news#newsletter → /news#insights). Those are
    // legitimate navigations; the absence of a thrown exception means the
    // operation completed.
    if (!response) {
      return { success: true, currentUrl };
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

    // Targeted check for the most common framework dropdown pattern that slips
    // past CSS-based visibility checks: Webflow uses `.w-dropdown-list` for the
    // container and applies `.w--open` only when expanded. Generic ARIA menus
    // can also expose state via aria-expanded.
    function isInsideClosedDropdown(el: Element): boolean {
      let current: Element | null = el;
      while (current) {
        if (current.classList && current.classList.contains('w-dropdown-list')) {
          return !current.classList.contains('w--open');
        }
        const role = current.getAttribute('role');
        if (role === 'menu' && current.getAttribute('aria-expanded') === 'false') {
          return true;
        }
        current = current.parentElement;
      }
      return false;
    }

    // Walks ancestors AND hit-tests the element to confirm it's actually visible.
    // The previous version only inspected the element itself, which let Webflow
    // nav dropdown items slip through — they have a non-zero rect even when the
    // parent dropdown is collapsed via transform: scaleY(0) or off-screen
    // positioning. The hit-test catches anything that isn't actually reachable
    // by a click at its own center coordinate.
    function isReallyVisible(el: Element): boolean {
      if (isInsideClosedDropdown(el)) return false;
      // 1. Modern checkVisibility API — handles display, visibility, opacity,
      //    content-visibility, and ancestors in one call.
      const maybeCheck = (el as Element & { checkVisibility?: (opts?: object) => boolean }).checkVisibility;
      if (typeof maybeCheck === 'function') {
        if (!maybeCheck.call(el, { checkOpacity: true, checkVisibilityCSS: true })) {
          return false;
        }
      }
      // 2. Ancestor walk picks up aria-hidden, hidden attr, and CSS states that
      //    checkVisibility may handle differently across browsers.
      let current: Element | null = el;
      while (current) {
        const style = window.getComputedStyle(current);
        if (style.display === 'none') return false;
        if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        if (parseFloat(style.opacity) === 0) return false;
        if (current.getAttribute('aria-hidden') === 'true') return false;
        if (current.hasAttribute('hidden')) return false;
        current = current.parentElement;
      }
      // 3. Non-zero rect check.
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;

      // 4. Off-screen positioning trick (e.g. position: absolute; top: -9999px).
      //    Allow elements below the fold (reachable via scroll) but reject anything
      //    pushed far off the left/top edge.
      if (rect.right < -50 || rect.bottom < -50) return false;
      if (rect.left > window.innerWidth + 1000) return false;

      // 5. Hit-test at the element's own center. If something else is at the top
      //    (a collapsed parent's transparent overlay, a sticky cookie banner,
      //    a transform-collapsed dropdown wrapper), the click will be intercepted
      //    and our agent will burn steps timing out. Skip the hit-test when the
      //    center is outside the viewport — the user can still scroll to it.
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const inViewport = cx >= 0 && cx <= window.innerWidth && cy >= 0 && cy <= window.innerHeight;
      if (inViewport) {
        const topEl = document.elementFromPoint(cx, cy);
        if (!topEl) return false;
        // Accept the element itself, any descendant (e.g. icon inside a button),
        // and any ancestor that wraps it transparently.
        if (topEl !== el && !el.contains(topEl) && !topEl.contains(el)) {
          return false;
        }
      }
      return true;
    }

    // Find links, buttons, inputs, selects, textareas, and elements with roles like button
    const querySelectors = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"]';
    const foundElements = document.querySelectorAll(querySelectors);

    foundElements.forEach(el => {
      if (isReallyVisible(el)) {
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
