import { test, expect } from '@playwright/test';
import { ScenarioRunner } from '../src/engine/scenario-runner.js';
import { ALL_SCENARIOS } from '../src/scenarios/index.js';

const baseUrl = 'https://www.independentsponsor.news/';

test.describe('Declarative QA scenarios', () => {
  test.setTimeout(300000);

  for (const scenario of ALL_SCENARIOS) {
    test(`scenario: ${scenario.id}`, async ({ page }) => {
      const runner = new ScenarioRunner(page, baseUrl);
      const result = await runner.runScenario(scenario);
      console.log(`📊 ${scenario.id}: ${result.status.toUpperCase()} (${result.stepsExecuted}/${result.totalSteps} steps, ${(result.durationMs / 1000).toFixed(1)}s)`);
      if (result.status === 'fail') {
        console.log(`❌ Failed at step ${result.failedAtStep}: ${result.stepResults.find(r => r.status === 'fail')?.error}`);
      }
      expect(result.status, `Scenario "${scenario.id}" failed at step ${result.failedAtStep}`).toBe('pass');
    });
  }
});
