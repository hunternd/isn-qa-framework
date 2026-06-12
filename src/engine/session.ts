import type { Page } from '@playwright/test';

export type AuthState = 'authenticated' | 'anonymous' | 'unknown';

const LOGIN_TRIGGER_SELECTOR = 'a[href*="widgetMode=login"]';
const LOGIN_MODAL_SELECTOR = '#o-auth-username';
// Authenticated-state DOM signals observed on Outseta-backed sites:
// - explicit widgetMode markers in href
// - the post-login profile redirect on outseta.com
// - the #o-authenticated fragment Outseta uses to gate state
// - generic logout / profile / account hrefs
const AUTH_INDICATOR_SELECTORS = [
  'a[href*="widgetMode=profile"]',
  'a[href*="widgetMode=account"]',
  'a[href*="widgetMode=logout"]',
  'a[href*="logout"]',
  'a[href*="outseta.com/profile"]',
  'a[href*="#o-authenticated"]',
];
// Text-based fallback for sites where the auth links don't use Outseta hrefs
// (e.g. ISN's "Log Out" link points back to "/"). Match against trimmed link text.
const AUTH_INDICATOR_TEXT_REGEX = /^(log\s*out|sign\s*out|my\s*account|profile|account settings|dashboard)$/i;
const OUTSETA_COOKIE_PATTERNS = [/outseta/i, /access[._-]?token/i, /jwt/i];
// localStorage keys Outseta uses to persist a *session token* (not just settings).
// Be specific here — Outseta also writes settings keys like `outseta.nocode--...settings`
// for anonymous users, and matching those would produce false-positive "authenticated"
// states. Real session tokens contain "AccessToken" / "RefreshToken" / "IdToken".
const OUTSETA_LOCAL_STORAGE_PATTERNS = [
  /AccessToken/i,
  /RefreshToken/i,
  /IdToken/i,
  /\.jwt$/i,
];
const LOGOUT_CLICK_PATTERNS = [/log[\s_-]?out/i, /sign[\s_-]?out/i, /widgetmode=logout/i];

export interface AuthSnapshot {
  state: AuthState;
  loginTriggerVisible: boolean;
  loginModalVisible: boolean;
  authIndicatorVisible: boolean;
  outsetaCookieCount: number;
  outsetaCookieNames: string[];
  outsetaLocalStorageKeyCount: number;
  outsetaLocalStorageKeys: string[];
  url: string;
  timestamp: string;
}

async function anyLocatorVisible(page: Page, selector: string): Promise<boolean> {
  try {
    const locators = await page.locator(selector).all();
    for (const loc of locators) {
      if (await loc.isVisible().catch(() => false)) return true;
    }
  } catch {
    // ignore — treat as not visible
  }
  return false;
}

async function detectAuthIndicatorByText(page: Page): Promise<boolean> {
  try {
    const links = await page.locator('a:visible, button:visible').all();
    for (const loc of links) {
      const text = (await loc.textContent().catch(() => null))?.trim() ?? '';
      if (text && AUTH_INDICATOR_TEXT_REGEX.test(text)) {
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

async function detectOutsetaLocalStorageKeys(page: Page): Promise<string[]> {
  return await page.evaluate((patterns) => {
    try {
      const compiled = patterns.map(p => new RegExp(p, 'i'));
      const out: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        if (compiled.some(re => re.test(key))) {
          out.push(key);
        }
      }
      return out;
    } catch {
      return [];
    }
  }, OUTSETA_LOCAL_STORAGE_PATTERNS.map(p => p.source)).catch(() => []);
}

export async function detectAuthState(page: Page): Promise<AuthSnapshot> {
  const loginTriggerVisible = await anyLocatorVisible(page, LOGIN_TRIGGER_SELECTOR);
  const loginModalVisible = await anyLocatorVisible(page, LOGIN_MODAL_SELECTOR);

  let authIndicatorVisible = false;
  for (const sel of AUTH_INDICATOR_SELECTORS) {
    if (await anyLocatorVisible(page, sel)) {
      authIndicatorVisible = true;
      break;
    }
  }
  if (!authIndicatorVisible) {
    authIndicatorVisible = await detectAuthIndicatorByText(page);
  }

  const cookies = await page.context().cookies().catch(() => []);
  const outsetaCookies = cookies.filter(c =>
    OUTSETA_COOKIE_PATTERNS.some(p => p.test(c.name)) || /outseta/i.test(c.domain)
  );

  const outsetaLocalStorageKeys = await detectOutsetaLocalStorageKeys(page);

  const hasTokenSignal = outsetaCookies.length > 0 || outsetaLocalStorageKeys.length > 0;

  // Decision order: visible login modal or trigger always wins as "anonymous" — those
  // are concrete UI states asking the user to authenticate, regardless of any stale
  // tokens that may linger in storage. Otherwise look for token or DOM indicators.
  let state: AuthState;
  if (loginModalVisible) {
    state = 'anonymous';
  } else if (loginTriggerVisible) {
    state = 'anonymous';
  } else if (hasTokenSignal || authIndicatorVisible) {
    state = 'authenticated';
  } else {
    state = 'unknown';
  }

  return {
    state,
    loginTriggerVisible,
    loginModalVisible,
    authIndicatorVisible,
    outsetaCookieCount: outsetaCookies.length,
    outsetaCookieNames: outsetaCookies.map(c => c.name),
    outsetaLocalStorageKeyCount: outsetaLocalStorageKeys.length,
    outsetaLocalStorageKeys,
    url: page.url(),
    timestamp: new Date().toISOString(),
  };
}

export function isLogoutIntent(target: string | null, linkText: string | null): boolean {
  const haystack = `${target || ''} ${linkText || ''}`;
  return LOGOUT_CLICK_PATTERNS.some(p => p.test(haystack));
}

export interface SessionDefectAction {
  step: number;
  action: string;
  target: string | null;
  url: string;
  linkText?: string | null;
}

export interface SessionDefect {
  type: 'SESSION_DROPPED';
  detectedAtStep: number;
  detectedAtUrl: string;
  baselineSnapshot: AuthSnapshot;
  failureSnapshot: AuthSnapshot;
  precedingActions: SessionDefectAction[];
  baselineScreenshot?: string | undefined;
  failureScreenshot?: string | undefined;
  timestamp: string;
}
