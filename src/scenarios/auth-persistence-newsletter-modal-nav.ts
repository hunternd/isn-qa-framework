import type { Scenario } from './types.js';

// Reproduces the user-reported bug confirmed by screen recording:
// 1. From the home page, the subscriber clicks the newsletter card.
//    The newsletter content renders (the user perceives this as a modal
//    overlay; in our automation it renders as a full newsletter page).
// 2. The subscriber hovers main nav "News" — the Webflow dropdown opens
//    with Newsletters / Insights / ISN in Ten.
// 3. The subscriber clicks "Newsletters" in the dropdown. In their
//    browser, this navigates to /news#newsletter AND silently drops the
//    subscriber session: LOG OUT / PROFILE are replaced by LOG IN /
//    SUBSCRIBE in the nav.
//
// Caveat: Playwright's synthetic hover + click on the Webflow dropdown
// link reliably triggers the click event but does NOT cause the
// navigation in our automation, even with raw mouse positioning. The
// reason is unclear — likely Webflow's click handler defers to its own
// SPA routing which behaves differently for synthetic events. To still
// exercise the post-transition auth state, the scenario follows the
// best-effort hoverThenClick with an explicit goto to the target URL.
// This means:
//   - If the click DOES navigate in some future Playwright/site
//     combination, the verify after hoverThenClick will catch any
//     auth drop on the actual click path.
//   - If the click doesn't navigate, the explicit goto guarantees we
//     still test the post-/news#newsletter auth state.
// The cross-section scenario already confirms goto-only transitions
// don't drop auth, so a session-sentinel failure on this scenario's
// final verify means the click event chain specifically (not just the
// URL change) is implicated.
export const authPersistenceNewsletterModalNav: Scenario = {
  id: 'auth-persistence-newsletter-modal-nav',
  description: 'From home page, click the newsletter card, then hover the main nav News dropdown and click the Newsletters item. Verifies subscriber session persists across this exact interaction sequence (user-reported auth-drop in screen recording).',
  requiresAuth: true,
  invariants: ['never_silently_logged_out'],
  steps: [
    { goto: '/' },
    { verify: 'still-authenticated' },
    // Click the newsletter card from the home page. In the user's flow
    // this opens a modal overlay; in our automation it's a full page nav.
    { clickSelector: 'a[href="/newsletters/isn-newsletter-june-05-2026"]' },
    { verify: 'still-authenticated' },
    // Best-effort replay of the user's click chain. Synthetic events on
    // the Webflow dropdown link don't reliably trigger navigation, so
    // this step may not change the URL even on success.
    {
      hoverThenClick: {
        hover: 'div.w-dropdown-toggle:has-text("News")',
        click: 'a.w-dropdown-link[href="/news#newsletter"]',
      },
    },
    { verify: 'still-authenticated' },
    // Guarantee we end up at the target URL the click WOULD navigate to,
    // so the final verify exercises the post-transition auth state even
    // when the synthetic click is swallowed.
    { goto: '/news#newsletter' },
    { verify: 'still-authenticated' },
  ],
};
