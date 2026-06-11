import { test, expect } from '@playwright/test';
import { NavigationOrchestrator } from '../src/engine/orchestrator.js';

test('run autonomous navigation exploration on target site', async ({ page }) => {
  // Set test timeout to 60 seconds because exploring multiple pages can take time
  test.setTimeout(60000);

  console.log('Initializing Navigation Orchestrator...');
  const baseUrl = 'https://www.independentsponsor.news/';
  
  // Create the orchestrator with max depth 3 and max steps 10 (to keep verification fast but comprehensive)
  const orchestrator = new NavigationOrchestrator(page, baseUrl, 3, 10);

  console.log('Running exploration...');
  const finalState = await orchestrator.runExploration();

  console.log('Exploration complete.');
  console.log(`Visited ${finalState.visitedUrls.length} pages.`);
  console.log(`Broken links discovered: ${finalState.brokenLinks.length}`);

  // Assert that we explored at least the homepage
  expect(finalState.visitedUrls.length).toBeGreaterThanOrEqual(1);
  expect(finalState.visitedUrls[0]).toBe(baseUrl);
});
