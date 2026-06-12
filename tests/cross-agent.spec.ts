import { test, expect } from '@playwright/test';
import { CrossAgentOrchestrator } from '../src/engine/cross-agent-orchestrator.js';

test('run coordinated cross-agent QA suite', async ({ page }) => {
  // Bumped from 2min to 6min — coordinated suite runs nav (~10 steps) + UI on
  // up to 5 pages (3 steps each) + security on filtered pages (3 steps each),
  // each step ~8–12s with LLM context.
  test.setTimeout(360000);

  const baseUrl = 'https://www.independentsponsor.news/';
  console.log('Initializing Cross-Agent Orchestrator...');
  const orchestrator = new CrossAgentOrchestrator(page, baseUrl);

  console.log('Running coordinated QA suite...');
  const result = await orchestrator.runCoordinatedSuite();

  console.log('Coordinated suite complete.');
  console.log(`Mapped URL Count: ${result.totalVisitedPages}`);
  console.log(`UI Bugs Logged: ${result.uiBugs.length}`);
  console.log(`Security Observations: ${result.securityObservations.length}`);
  
  // Verify that the suite executed successfully and visited the target
  expect(result.totalVisitedPages).toBeGreaterThanOrEqual(1);
});
