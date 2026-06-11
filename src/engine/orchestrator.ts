import type { Page } from '@playwright/test';
import { NavigationAgent } from '../agents/nav-agent.js';
import { createInitialState, type NavigationAgentState, type ActionHistoryEntry } from './state.js';
import { navigate, readPageContent, clickElement, takeScreenshot } from '../tools/index.js';
import * as fs from 'fs';
import * as path from 'path';

export class NavigationOrchestrator {
  private page: Page;
  private agent: NavigationAgent;
  private state: NavigationAgentState;
  private consoleErrors: Array<{ url: string; message: string; timestamp: string }> = [];

  constructor(page: Page, baseUrl: string, maxDepth = 3, maxSteps = 20) {
    this.page = page;
    this.agent = new NavigationAgent();
    this.state = createInitialState(baseUrl, maxDepth, maxSteps);

    // Capture console errors
    this.page.on('console', msg => {
      if (msg.type() === 'error') {
        this.consoleErrors.push({
          url: this.page.url(),
          message: msg.text(),
          timestamp: new Date().toISOString(),
        });
      }
    });

    // Capture unhandled page exceptions
    this.page.on('pageerror', exception => {
      this.consoleErrors.push({
        url: this.page.url(),
        message: `Exception: ${exception.message}`,
        timestamp: new Date().toISOString(),
      });
    });
  }

  async runExploration(): Promise<NavigationAgentState> {
    console.log(`🚀 Starting exploration at target: ${this.state.baseUrl}`);
    
    // Step 0: Initial navigation
    const initialNav = await navigate(this.page, '/');
    const startUrl = this.page.url();
    this.state.visitedUrls.push(startUrl);

    if (!initialNav.success) {
      console.error(`❌ Initial navigation failed: ${initialNav.error || 'Unknown error'}`);
      this.state.brokenLinks.push({
        url: startUrl,
        parentUrl: 'Direct Input',
        error: initialNav.error || 'Failed to resolve page',
        timestamp: new Date().toISOString(),
      });
      await this.saveReport();
      return this.state;
    }

    let steps = 0;
    let currentUrl = startUrl;

    while (steps < this.state.maxSteps) {
      steps++;
      console.log(`\n--- Step ${steps}/${this.state.maxSteps} ---`);
      console.log(`Current URL: ${currentUrl}`);

      // 1. Take a screenshot for the current page
      const pageTitleSanitized = (await this.page.title()).replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const screenshotName = `step_${steps}_${pageTitleSanitized}`;
      const screenshotRes = await takeScreenshot(this.page, screenshotName);
      if (screenshotRes.success && screenshotRes.filePath) {
        this.state.screenshots[currentUrl] = screenshotRes.filePath;
      }

      // 2. Read current page content (text + interactive elements)
      const pageContent = await readPageContent(this.page);

      // Check if current URL was redirected or is new
      if (!this.state.visitedUrls.includes(currentUrl)) {
        this.state.visitedUrls.push(currentUrl);
      }

      // Calculate depth from baseUrl (simple path depth parser)
      const relativePath = currentUrl.replace(this.state.baseUrl, '');
      const depth = relativePath.split('/').filter(p => p.length > 0).length;
      this.state.currentDepth = depth;

      if (this.state.currentDepth > this.state.maxDepth) {
        console.log(`⚠️ Max depth reached (${depth}/${this.state.maxDepth}). Backing up...`);
        try {
          await this.page.goBack();
          currentUrl = this.page.url();
          continue;
        } catch {
          console.log('Unable to go back. Finishing exploration.');
          break;
        }
      }

      // 3. Consult LLM Navigation Agent for next decision
      const stepsRemaining = this.state.maxSteps - steps;
      const decision = await this.agent.decideNextAction(this.state, pageContent, stepsRemaining);

      console.log(`Thought: "${decision.thought}"`);
      console.log(`Action: ${decision.action} | Target: ${decision.target}`);

      // Record history entry
      const historyEntry: ActionHistoryEntry = {
        step: steps,
        action: decision.action,
        target: decision.target,
        result: 'success',
      };

      if (decision.action === 'FINISH') {
        this.state.actionHistory.push(historyEntry);
        console.log(`🏁 Agent finished exploration: ${decision.target || 'Completed'}`);
        break;
      }

      const prevUrl = currentUrl;

      // 4. Execute the chosen action
      if (decision.action === 'NAVIGATE' && decision.target) {
        const targetUrl = new URL(decision.target, this.state.baseUrl).toString();
        const navRes = await navigate(this.page, decision.target);
        currentUrl = this.page.url();
        
        if (navRes.success) {
          // Track siteMap transition
          this.trackNavigationLink(prevUrl, currentUrl);
        } else {
          console.error(`❌ Failed to navigate to ${decision.target}: ${navRes.error}`);
          historyEntry.result = 'failure';
          historyEntry.error = navRes.error;
          this.state.brokenLinks.push({
            url: targetUrl,
            parentUrl: prevUrl,
            error: navRes.error || 'Navigation failed',
            timestamp: new Date().toISOString(),
          });
        }

      } else if (decision.action === 'CLICK' && decision.target) {
        const clickRes = await clickElement(this.page, decision.target);
        // Wait briefly for any lazy loaders or navigation to complete
        await this.page.waitForTimeout(1000);
        currentUrl = this.page.url();

        if (clickRes.success) {
          this.trackNavigationLink(prevUrl, currentUrl);
        } else {
          console.error(`❌ Failed to click element ${decision.target}: ${clickRes.error}`);
          historyEntry.result = 'failure';
          historyEntry.error = clickRes.error;
        }

      } else if (decision.action === 'BACK') {
        try {
          await this.page.goBack();
          currentUrl = this.page.url();
          this.trackNavigationLink(prevUrl, currentUrl);
        } catch (err: any) {
          console.error(`❌ Failed to navigate back: ${err.message}`);
          historyEntry.result = 'failure';
          historyEntry.error = err.message;
        }
      }

      this.state.actionHistory.push(historyEntry);
    }

    console.log('\n🏁 Exploration finished! Saving final report...');
    await this.saveReport();
    return this.state;
  }

  private trackNavigationLink(fromUrl: string, toUrl: string) {
    if (fromUrl === toUrl) return;
    const targets = this.state.siteMap[fromUrl] || [];
    if (!targets.includes(toUrl)) {
      targets.push(toUrl);
      this.state.siteMap[fromUrl] = targets;
    }
  }

  private async saveReport() {
    const reportDir = path.resolve(process.cwd(), 'reports');
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = path.join(reportDir, `navigation_report_${timestamp}.md`);

    // Prepare content
    let md = `# Exploration QA Navigation Report\n\n`;
    md += `- **Date**: ${new Date().toLocaleString()}\n`;
    md += `- **Target Site**: ${this.state.baseUrl}\n`;
    md += `- **Total Pages Explored**: ${this.state.visitedUrls.length}\n`;
    md += `- **Broken Links Found**: ${this.state.brokenLinks.length}\n`;
    md += `- **Console Errors Logged**: ${this.consoleErrors.length}\n\n`;

    md += `## 🌐 Site Map\n\n`;
    if (Object.keys(this.state.siteMap).length === 0) {
      md += `*No transitions recorded.*\n\n`;
    } else {
      md += `\`\`\`mermaid\ngraph TD\n`;
      for (const [source, destinations] of Object.entries(this.state.siteMap)) {
        const srcLabel = source.replace(this.state.baseUrl, '/');
        for (const dest of destinations) {
          const destLabel = dest.replace(this.state.baseUrl, '/');
          md += `    "${srcLabel}" --> "${destLabel}"\n`;
        }
      }
      md += `\`\`\`\n\n`;
    }

    md += `## 📑 Explored Pages\n\n`;
    this.state.visitedUrls.forEach(url => {
      const relPath = url.replace(this.state.baseUrl, '/');
      const screenshot = this.state.screenshots[url] ? `[Screenshot](${this.state.screenshots[url]})` : 'None';
      md += `- **${relPath}** (${url}) — Visuals: ${screenshot}\n`;
    });
    md += `\n`;

    md += `## ❌ Broken Links\n\n`;
    if (this.state.brokenLinks.length === 0) {
      md += `✅ *No broken links found during exploration.*\n\n`;
    } else {
      md += `| Target URL | Source Page | Error Details | Timestamp |\n`;
      md += `| --- | --- | --- | --- |\n`;
      this.state.brokenLinks.forEach(b => {
        md += `| ${b.url} | ${b.parentUrl} | ${b.error} | ${b.timestamp} |\n`;
      });
      md += `\n`;
    }

    md += `## ⚠️ Console Errors & Unhandled Exceptions\n\n`;
    if (this.consoleErrors.length === 0) {
      md += `✅ *No console errors or unhandled exceptions logged.*\n\n`;
    } else {
      md += `| Page URL | Message | Timestamp |\n`;
      md += `| --- | --- | --- |\n`;
      this.consoleErrors.forEach(err => {
        md += `| ${err.url} | ${err.message} | ${err.timestamp} |\n`;
      });
      md += `\n`;
    }

    md += `## 📜 History of Actions\n\n`;
    md += `| Step | Action | Target / Details | Result |\n`;
    md += `| --- | --- | --- | --- |\n`;
    this.state.actionHistory.forEach(h => {
      const details = h.target ? `\`${h.target}\`` : '-';
      const resultText = h.result === 'success' ? '✅ Success' : `❌ Failed (${h.error || 'unknown'})`;
      md += `| ${h.step} | ${h.action} | ${details} | ${resultText} |\n`;
    });

    fs.writeFileSync(reportPath, md, 'utf-8');
    console.log(`📝 Saved exploration report to: ${reportPath}`);
  }
}
