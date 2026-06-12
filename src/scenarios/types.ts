// Declarative QA journeys executed deterministically by ScenarioRunner.
// Unlike the LLM-driven content agent (which explores breadth-first), scenarios
// reproduce specific user paths on every run so regressions in known-important
// flows surface reliably.

// Recognized content kinds for a content-kind click step. Matched by href pattern
// against the page's interactive elements at click time.
export type ContentKind = 'newsletter' | 'insight' | 'any-article' | 'external';

export type Step =
  | { goto: string }
  | { click: { kind: ContentKind; nth?: number } }
  | { clickSelector: string }
  // Hover a selector. Useful for Webflow-style nav dropdowns that open on
  // hover rather than click — without this, scripting "open dropdown then
  // click item" requires force-clicking hidden elements.
  | { hoverSelector: string }
  // Invoke the DOM click handler directly via element.click() in page.evaluate.
  // Bypasses Playwright's visibility/intercept retry layer, which is the only
  // way to reach nav dropdown items that close before the click lands. Useful
  // for reproducing user-reported bugs where the click TARGET matters (event
  // handlers, auth checks attached to nav links) but the precise interaction
  // model is hard to replay through the page surface.
  | { clickDirect: string }
  // Atomic hover-then-click. For Webflow-style nav dropdowns that open on
  // hover and close when the mouse leaves: a separate hoverSelector then
  // clickSelector loses the hover state between commands, leaving the dropdown
  // closed by the time the click locator is resolved. This combines both into
  // one step so Playwright moves the mouse straight from the hover target to
  // the click target while the dropdown is still open.
  | { hoverThenClick: { hover: string; click: string } }
  | { back: true }
  | { ensureAuth: true }
  | { verify: 'still-authenticated' };

export type Invariant = 'never_silently_logged_out' | 'no_console_errors';

export interface Scenario {
  id: string;
  description: string;
  // If true, ScenarioRunner authenticates the page before the first step.
  // A failure to authenticate fails the scenario immediately.
  requiresAuth?: boolean;
  steps: Step[];
  invariants?: Invariant[];
}

export interface AuthSnapshotSummary {
  state: 'authenticated' | 'anonymous' | 'unknown';
  outsetaCookieCount: number;
  outsetaLocalStorageKeyCount: number;
  loginTriggerVisible: boolean;
  loginModalVisible: boolean;
  authIndicatorVisible: boolean;
}

export interface ScenarioStepResult {
  step: number;
  kind: string;
  description: string;
  status: 'pass' | 'fail' | 'skip';
  url: string;
  // Only populated for verify steps.
  authSnapshot?: AuthSnapshotSummary | undefined;
  error?: string | undefined;
  screenshot?: string | undefined;
}

export interface ScenarioResult {
  scenarioId: string;
  description: string;
  status: 'pass' | 'fail';
  totalSteps: number;
  stepsExecuted: number;
  failedAtStep: number | null;
  stepResults: ScenarioStepResult[];
  durationMs: number;
  reportPath?: string;
}
