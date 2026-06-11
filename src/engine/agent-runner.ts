import type { Page } from '@playwright/test';
import { readPageContent, navigate, clickElement, typeText, takeScreenshot } from '../tools/index.js';
import * as fs from 'fs';
import * as path from 'path';

export interface AuditBug {
  elementSelector: string;
  issueType: string;
  description: string;
  url: string;
  timestamp: string;
}

export interface SecurityFinding {
  elementSelector: string;
  severity: 'low' | 'medium' | 'high';
  description: string;
  url: string;
  timestamp: string;
}

export interface ContentBug {
  linkText: string;
  expectedTopic: string;
  actualTopic: string;
  description: string;
  url: string;
  timestamp: string;
}

export class AgentRunner {
  private page: Page;
  private baseUrl: string;
  private visitedUrls: string[] = [];
  private actionHistory: Array<{ step: number; action: string; target: string | null; result: string; error?: string | undefined }> = [];
  private screenshots: Record<string, string> = {};
  private bugsLogged: AuditBug[] = [];
  private securityFindings: SecurityFinding[] = [];
  private contentBugsLogged: ContentBug[] = [];
  private currentViewport = { width: 1280, height: 800 };

  constructor(page: Page, baseUrl: string) {
    this.page = page;
    this.baseUrl = baseUrl;
  }

  async runUIAgent(agentInstance: any, maxSteps = 10): Promise<void> {
    console.log(`🚀 Starting UI/UX Exploration at: ${this.baseUrl}`);
    await navigate(this.page, '/');
    let currentUrl = this.page.url();
    this.visitedUrls.push(currentUrl);

    let steps = 0;
    while (steps < maxSteps) {
      steps++;
      console.log(`\n--- UI Agent Step ${steps}/${maxSteps} ---`);
      console.log(`URL: ${currentUrl} | Viewport: ${this.currentViewport.width}x${this.currentViewport.height}`);

      // Take snapshot
      const pageTitleSanitized = (await this.page.title()).replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const screenshotName = `ui_step_${steps}_${pageTitleSanitized}_${this.currentViewport.width}x${this.currentViewport.height}`;
      const screenshotRes = await takeScreenshot(this.page, screenshotName);
      if (screenshotRes.success && screenshotRes.filePath) {
        this.screenshots[`${currentUrl}_${this.currentViewport.width}x${this.currentViewport.height}`] = screenshotRes.filePath;
      }

      // Read page content
      const pageContent = await readPageContent(this.page);
      
      // Decide action
      const stepsRemaining = maxSteps - steps;
      const decision = await agentInstance.decideNextAction(
        this.visitedUrls,
        pageContent,
        this.currentViewport,
        stepsRemaining
      );

      console.log(`Thought: "${decision.thought}"`);
      console.log(`Action: ${decision.action} | Target: ${decision.target}`);

      this.actionHistory.push({
        step: steps,
        action: decision.action,
        target: decision.target,
        result: 'success'
      });

      if (decision.action === 'FINISH') {
        console.log(`🏁 UI Agent finished: ${decision.target}`);
        break;
      }

      if (decision.action === 'RESIZE_VIEWPORT' && decision.params) {
        const { width, height } = decision.params;
        this.currentViewport = { width, height };
        await this.page.setViewportSize({ width, height });
        await this.page.waitForTimeout(1000);
      } else if (decision.action === 'CLICK' && decision.target) {
        const clickRes = await clickElement(this.page, decision.target);
        await this.page.waitForTimeout(1000);
        currentUrl = this.page.url();
        if (!clickRes.success) {
          this.actionHistory[this.actionHistory.length - 1]!.result = 'failed';
          this.actionHistory[this.actionHistory.length - 1]!.error = clickRes.error;
        } else if (!this.visitedUrls.includes(currentUrl)) {
          this.visitedUrls.push(currentUrl);
        }
      } else if (decision.action === 'LOG_BUG' && decision.params) {
        const { issueType, description } = decision.params;
        this.bugsLogged.push({
          elementSelector: decision.target || 'N/A',
          issueType,
          description,
          url: currentUrl,
          timestamp: new Date().toISOString()
        });
        console.log(`🐞 Logged Layout Bug: [${issueType}] ${description}`);
      } else if (decision.action === 'BACK') {
        try {
          await this.page.goBack();
          currentUrl = this.page.url();
        } catch (err: any) {
          this.actionHistory[this.actionHistory.length - 1]!.result = 'failed';
          this.actionHistory[this.actionHistory.length - 1]!.error = err.message;
        }
      }
    }

    await this.saveUIReport();
  }

  async runSecurityAgent(agentInstance: any, maxSteps = 10): Promise<void> {
    console.log(`🚀 Starting Security & Form Audit at: ${this.baseUrl}`);
    await navigate(this.page, '/');
    let currentUrl = this.page.url();
    this.visitedUrls.push(currentUrl);

    let steps = 0;
    while (steps < maxSteps) {
      steps++;
      console.log(`\n--- Security Agent Step ${steps}/${maxSteps} ---`);
      console.log(`URL: ${currentUrl}`);

      // Take snapshot
      const pageTitleSanitized = (await this.page.title()).replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const screenshotName = `sec_step_${steps}_${pageTitleSanitized}`;
      const screenshotRes = await takeScreenshot(this.page, screenshotName);
      if (screenshotRes.success && screenshotRes.filePath) {
        this.screenshots[currentUrl] = screenshotRes.filePath;
      }

      // Read page content
      const pageContent = await readPageContent(this.page);

      // Decide action
      const stepsRemaining = maxSteps - steps;
      const decision = await agentInstance.decideNextAction(
        this.visitedUrls,
        pageContent,
        stepsRemaining
      );

      console.log(`Thought: "${decision.thought}"`);
      console.log(`Action: ${decision.action} | Target: ${decision.target}`);

      this.actionHistory.push({
        step: steps,
        action: decision.action,
        target: decision.target,
        result: 'success'
      });

      if (decision.action === 'FINISH') {
        console.log(`🏁 Security Agent finished: ${decision.target}`);
        break;
      }

      if (decision.action === 'TYPE' && decision.target && decision.params) {
        const { text } = decision.params;
        const typeRes = await typeText(this.page, decision.target, text);
        if (!typeRes.success) {
          this.actionHistory[this.actionHistory.length - 1]!.result = 'failed';
          this.actionHistory[this.actionHistory.length - 1]!.error = typeRes.error;
        }
      } else if (decision.action === 'CLICK' && decision.target) {
        const clickRes = await clickElement(this.page, decision.target);
        await this.page.waitForTimeout(1000);
        currentUrl = this.page.url();
        if (!clickRes.success) {
          this.actionHistory[this.actionHistory.length - 1]!.result = 'failed';
          this.actionHistory[this.actionHistory.length - 1]!.error = clickRes.error;
        } else if (!this.visitedUrls.includes(currentUrl)) {
          this.visitedUrls.push(currentUrl);
        }
      } else if (decision.action === 'LOG_SECURITY' && decision.params) {
        const { severity, description } = decision.params;
        this.securityFindings.push({
          elementSelector: decision.target || 'N/A',
          severity,
          description,
          url: currentUrl,
          timestamp: new Date().toISOString()
        });
        console.log(`🛡️ Logged Security Observation: [${severity}] ${description}`);
      } else if (decision.action === 'BACK') {
        try {
          await this.page.goBack();
          currentUrl = this.page.url();
        } catch (err: any) {
          this.actionHistory[this.actionHistory.length - 1]!.result = 'failed';
          this.actionHistory[this.actionHistory.length - 1]!.error = err.message;
        }
      }
    }

    await this.saveSecurityReport();
  }

  private async saveUIReport() {
    const reportDir = path.resolve(process.cwd(), 'reports');
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = path.join(reportDir, `ui_ux_report_${timestamp}.md`);

    let md = `# UI/UX & Formatting Audit Report\n\n`;
    md += `- **Date**: ${new Date().toLocaleString()}\n`;
    md += `- **Target Site**: ${this.baseUrl}\n`;
    md += `- **Bugs/Observations Logged**: ${this.bugsLogged.length}\n\n`;

    md += `## 🐞 Visual & Responsive Bugs Logged\n\n`;
    if (this.bugsLogged.length === 0) {
      md += `✅ *No visual formatting or alignment bugs logged during this run.*\n\n`;
    } else {
      md += `| Page URL | Element Selector | Issue Type | Description | Timestamp |\n`;
      md += `| --- | --- | --- | --- | --- |\n`;
      this.bugsLogged.forEach(bug => {
        md += `| ${bug.url} | \`${bug.elementSelector}\` | **${bug.issueType}** | ${bug.description} | ${bug.timestamp} |\n`;
      });
      md += `\n`;
    }

    md += `## 📑 Explored Viewports & Screenshots\n\n`;
    for (const [key, value] of Object.entries(this.screenshots)) {
      const parts = key.split('_');
      const viewport = parts.pop();
      const url = parts.join('_');
      const relPath = url.replace(this.baseUrl, '/');
      md += `- **${relPath}** at **${viewport}** — [View Screenshot](${value})\n`;
    }
    md += `\n`;

    md += `## 📜 History of Actions\n\n`;
    md += `| Step | Action | Target / Details | Result |\n`;
    md += `| --- | --- | --- | --- |\n`;
    this.actionHistory.forEach(h => {
      const details = h.target ? `\`${h.target}\`` : '-';
      const resultText = h.result === 'success' ? '✅ Success' : `❌ Failed (${h.error || 'unknown'})`;
      md += `| ${h.step} | ${h.action} | ${details} | ${resultText} |\n`;
    });

    fs.writeFileSync(reportPath, md, 'utf-8');
    console.log(`📝 Saved UI/UX audit report to: ${reportPath}`);
  }

  private async saveSecurityReport() {
    const reportDir = path.resolve(process.cwd(), 'reports');
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = path.join(reportDir, `security_report_${timestamp}.md`);

    let md = `# Input Security & Validation Report\n\n`;
    md += `- **Date**: ${new Date().toLocaleString()}\n`;
    md += `- **Target Site**: ${this.baseUrl}\n`;
    md += `- **Observations Logged**: ${this.securityFindings.length}\n\n`;

    md += `## 🛡️ Input Validation & Sanitization Observations\n\n`;
    if (this.securityFindings.length === 0) {
      md += `✅ *No input vulnerabilities or boundary issues logged during this audit.*\n\n`;
    } else {
      md += `| Page URL | Element Selector | Severity | Description | Timestamp |\n`;
      md += `| --- | --- | --- | --- | --- |\n`;
      this.securityFindings.forEach(f => {
        md += `| ${f.url} | \`${f.elementSelector}\` | **${f.severity.toUpperCase()}** | ${f.description} | ${f.timestamp} |\n`;
      });
      md += `\n`;
    }

    md += `## 📜 History of Actions\n\n`;
    md += `| Step | Action | Target / Details | Result |\n`;
    md += `| --- | --- | --- | --- |\n`;
    this.actionHistory.forEach(h => {
      const details = h.target ? `\`${h.target}\`` : '-';
      const resultText = h.result === 'success' ? '✅ Success' : `❌ Failed (${h.error || 'unknown'})`;
      md += `| ${h.step} | ${h.action} | ${details} | ${resultText} |\n`;
    });

    fs.writeFileSync(reportPath, md, 'utf-8');
    console.log(`📝 Saved security report to: ${reportPath}`);
  }

  async runContentAgent(agentInstance: any, maxSteps = 10): Promise<void> {
    console.log(`\n🚀 Starting Content Context & Integrity Audit at: ${this.baseUrl}`);
    await navigate(this.page, '/');
    let currentUrl = this.page.url();
    this.visitedUrls.push(currentUrl);

    let lastAction: { action: string; selector: string | null; text: string | null } | null = null;
    let steps = 0;

    while (steps < maxSteps) {
      steps++;
      console.log(`\n--- Content Agent Step ${steps}/${maxSteps} ---`);
      // Auto-login helper: if login modal is opened and inputs are visible, fill them automatically!
      if (await this.page.locator('#o-auth-username').isVisible()) {
        console.log('🔑 Auto-login helper: Login modal detected. Filling credentials...');
        const email = process.env.QA_USER_EMAIL || '';
        const password = process.env.QA_USER_PASSWORD || '';
        if (email && password) {
          await typeText(this.page, '#o-auth-username', email);
          await typeText(this.page, '#o-auth-password', password);
          const submitBtn = this.page.locator('button.o--Button--btn').filter({ hasText: /login|log in|sign in/i }).first();
          await submitBtn.click();
          await this.page.locator('#o-auth-username').waitFor({ state: 'hidden', timeout: 15000 });
          await this.page.waitForTimeout(1000);
          console.log('🔑 Auto-login helper: Successfully authenticated.');
          currentUrl = this.page.url();
        }
      }

      // Take screenshot
      const pageTitleSanitized = (await this.page.title()).replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const screenshotName = `content_step_${steps}_${pageTitleSanitized}`;
      const screenshotRes = await takeScreenshot(this.page, screenshotName);
      if (screenshotRes.success && screenshotRes.filePath) {
        this.screenshots[currentUrl] = screenshotRes.filePath;
      }

      // Read page content
      const pageContent = await readPageContent(this.page);

      // Consult LLM
      const stepsRemaining = maxSteps - steps;
      const decision: any = await agentInstance.decideNextAction(
        this.visitedUrls,
        pageContent,
        lastAction,
        stepsRemaining
      );

      console.log(`Thought: "${decision.thought}"`);
      console.log(`Action: ${decision.action} | Target: ${decision.target}`);

      this.actionHistory.push({
        step: steps,
        action: decision.action,
        target: decision.target,
        result: 'success'
      });

      if (decision.action === 'FINISH') {
        console.log(`🏁 Content Agent finished: ${decision.target}`);
        break;
      }

      if (decision.action === 'CLICK' && decision.target) {
        const elInfo = pageContent.interactiveElements.find(el => el.selector === decision.target);
        lastAction = {
          action: 'CLICK',
          selector: decision.target,
          text: elInfo ? (elInfo.text || decision.params?.linkText || null) : (decision.params?.linkText || null)
        };

        const clickRes = await clickElement(this.page, decision.target);
        await this.page.waitForTimeout(1500); // Wait for page/modal transitions
        currentUrl = this.page.url();

        if (!clickRes.success) {
          this.actionHistory[this.actionHistory.length - 1]!.result = 'failed';
          this.actionHistory[this.actionHistory.length - 1]!.error = clickRes.error;
        } else if (!this.visitedUrls.includes(currentUrl)) {
          this.visitedUrls.push(currentUrl);
        }
      } else if (decision.action === 'LOG_CONTENT_BUG' && decision.params) {
        const { linkText, expectedTopic, actualTopic, description } = decision.params;
        this.contentBugsLogged.push({
          linkText: linkText || 'Unknown Link',
          expectedTopic: expectedTopic || 'Unknown Expected Topic',
          actualTopic: actualTopic || 'Unknown Actual Content',
          description: description || 'No description provided.',
          url: currentUrl,
          timestamp: new Date().toISOString()
        });
        console.log(`🐞 Logged Content Bug: [promised "${expectedTopic}" but loaded "${actualTopic}"]`);
      } else if (decision.action === 'BACK') {
        try {
          await this.page.goBack();
          currentUrl = this.page.url();
          lastAction = { action: 'BACK', selector: null, text: null };
        } catch (err: any) {
          this.actionHistory[this.actionHistory.length - 1]!.result = 'failed';
          this.actionHistory[this.actionHistory.length - 1]!.error = err.message;
        }
      }
    }

    await this.saveContentReport();
  }

  private async saveContentReport() {
    const reportDir = path.resolve(process.cwd(), 'reports');
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = path.join(reportDir, `content_report_${timestamp}.md`);

    let md = `# Content Context & Integrity Report\n\n`;
    md += `- **Date**: ${new Date().toLocaleString()}\n`;
    md += `- **Target Site**: ${this.baseUrl}\n`;
    md += `- **Content Mismatches Logged**: ${this.contentBugsLogged.length}\n\n`;

    md += `## 🐞 Content Mismatches & Broken Redirections Logged\n\n`;
    if (this.contentBugsLogged.length === 0) {
      md += `✅ *No semantic content mismatches or target rendering failures were logged.*\n\n`;
    } else {
      md += `| Link Text | Expected Content | Actual Content | Discrepancy | Loaded Page URL | Timestamp |\n`;
      md += `| --- | --- | --- | --- | --- | --- |\n`;
      this.contentBugsLogged.forEach(bug => {
        md += `| "${bug.linkText}" | ${bug.expectedTopic} | ${bug.actualTopic} | ${bug.description} | ${bug.url} | ${bug.timestamp} |\n`;
      });
      md += `\n`;
    }

    md += `## 📜 History of Actions\n\n`;
    md += `| Step | Action | Target / Details | Result |\n`;
    md += `| --- | --- | --- | --- |\n`;
    this.actionHistory.forEach(h => {
      const details = h.target ? `\`${h.target}\`` : '-';
      const resultText = h.result === 'success' ? '✅ Success' : `❌ Failed (${h.error || 'unknown'})`;
      md += `| ${h.step} | ${h.action} | ${details} | ${resultText} |\n`;
    });

    fs.writeFileSync(reportPath, md, 'utf-8');
    console.log(`📝 Saved content audit report to: ${reportPath}`);
  }
}
