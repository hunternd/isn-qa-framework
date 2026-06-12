import type { Scenario } from './types.js';

// The canonical session-drift scenario. Reproduces the user-reported pattern:
// open a piece of subscriber content, switch sections, open more, then return
// to the original section — and assert the session never silently drops
// anywhere along the way.
//
// The site currently exposes one newsletter and several insights, so the
// journey crosses Newsletter → Insights → Insights → Newsletter, rather than
// reading multiple distinct newsletters. Cross-section navigation is what
// matters for the session-drift bug class; the specific surface counts can be
// adjusted as the site adds more issues.
export const authPersistenceCrossSection: Scenario = {
  id: 'auth-persistence-cross-section',
  description: 'Read the latest newsletter, switch to Insights, read two insights, return to Newsletters — verifies authenticated state never silently drops mid-journey across section switches and back-navigation.',
  requiresAuth: true,
  invariants: ['never_silently_logged_out'],
  steps: [
    { goto: '/news#newsletter' },
    { click: { kind: 'newsletter', nth: 1 } },
    { verify: 'still-authenticated' },
    { back: true },
    { goto: '/news#insights' },
    { click: { kind: 'insight', nth: 1 } },
    { verify: 'still-authenticated' },
    { back: true },
    { click: { kind: 'insight', nth: 2 } },
    { verify: 'still-authenticated' },
    { goto: '/news#newsletter' },
    { click: { kind: 'newsletter', nth: 1 } },
    { verify: 'still-authenticated' },
  ],
};
