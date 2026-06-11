import { test, expect } from '@playwright/test';
import { AgentRunner } from '../src/engine/agent-runner.js';
import { ContentAgent } from '../src/agents/content-agent.js';

test.describe('Content QA User Handoff Journey', () => {
  test.setTimeout(120000);

  const baseUrl = 'https://www.independentsponsor.news/';

  test('run unauthenticated-to-authenticated content audit journey', async ({ browser }) => {
    console.log('Starting unauthenticated browser context...');
    
    // Create a fresh isolated context with NO pre-saved storage state to force starting unauthenticated
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 }
    });
    const page = await context.newPage();

    // Initialize Runner and Content Agent
    console.log('Initializing Content Agent and Runner...');
    const runner = new AgentRunner(page, baseUrl);
    const agent = new ContentAgent();

    // Execute content journey loop with 10 steps to allow for the full multi-step journey
    await runner.runContentAgent(agent, 10);
    console.log('Content Agent user journey complete.');

    await context.close();
  });
});
