import { test, expect } from '@playwright/test';
import { AgentRunner } from '../src/engine/agent-runner.js';
import { UIAgent } from '../src/agents/ui-agent.js';
import { SecurityAgent } from '../src/agents/security-agent.js';

test.describe('Specialized QA Agents Verification', () => {
  // Set test timeout to 60 seconds because running multiple steps takes time
  test.setTimeout(60000);

  const baseUrl = 'https://www.independentsponsor.news/';

  test('run UI/UX and Formatting Agent exploration', async ({ page }) => {
    console.log('Initializing UI/UX & Formatting Agent and Runner...');
    const runner = new AgentRunner(page, baseUrl);
    const agent = new UIAgent();

    // Run UI exploration with max 6 steps
    await runner.runUIAgent(agent, 6);
    console.log('UI/UX exploration complete.');
  });

  test('run Security & Form Validation Agent exploration', async ({ page }) => {
    console.log('Initializing Security & Form Agent and Runner...');
    const runner = new AgentRunner(page, baseUrl);
    const agent = new SecurityAgent();

    // Run Security exploration with max 6 steps
    await runner.runSecurityAgent(agent, 6);
    console.log('Security exploration complete.');
  });
});
