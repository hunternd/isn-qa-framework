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
