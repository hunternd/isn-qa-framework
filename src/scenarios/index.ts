import type { Scenario } from './types.js';
import { authPersistenceCrossSection } from './auth-persistence-cross-section.js';
import { authPersistenceNewsletterModalNav } from './auth-persistence-newsletter-modal-nav.js';

export const ALL_SCENARIOS: Scenario[] = [
  authPersistenceCrossSection,
  authPersistenceNewsletterModalNav,
];

export type { Scenario, Step, ContentKind, ScenarioResult, ScenarioStepResult } from './types.js';
