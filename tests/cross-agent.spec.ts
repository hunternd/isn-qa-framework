import { test, expect } from '@playwright/test';
import { CrossAgentOrchestrator } from '../src/engine/cross-agent-orchestrator.js';

test('run coordinated cross-agent QA suite', async ({ page }) => {
  // Set test timeout to 2 minutes because running multiple agents takes time
  test.setTimeout(120000);

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
