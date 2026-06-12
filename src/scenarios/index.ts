import type { Scenario } from './types.js';
import { authPersistenceCrossSection } from './auth-persistence-cross-section.js';

export const ALL_SCENARIOS: Scenario[] = [
  authPersistenceCrossSection,
];

export type { Scenario, Step, ContentKind, ScenarioResult, ScenarioStepResult } from './types.js';
