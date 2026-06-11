import { test, expect } from '@playwright/test';
import { AgentRunner } from '../src/engine/agent-runner.js';
import { ContentAgent } from '../src/agents/content-agent.js';
import { loginAndSaveSession, hasSession } from '../src/engine/auth.js';

test.describe('Content Context & Integrity Agent Audit', () => {
  test.setTimeout(180000);

  const baseUrl = 'https://www.independentsponsor.news/';

  test('run Content Agent verification loop', async ({ page }) => {
    // 1. Ensure authenticated session exists
    if (!hasSession()) {
      console.log('No valid session file found. Authenticating first...');
      const authenticated = await loginAndSaveSession(page, baseUrl);
      expect(authenticated).toBe(true);
    } else {
      console.log('Using pre-existing authenticated subscriber session.');
    }

    // 2. Initialize Runner and Content Agent
    console.log('Initializing Content Agent and Runner...');
    const runner = new AgentRunner(page, baseUrl);
    const agent = new ContentAgent();

    // 3. Execute content audit loop (max 15 steps)
    await runner.runContentAgent(agent, 15);
    console.log('Content Agent audit complete.');
  });
});
