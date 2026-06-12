import type { Page } from '@playwright/test';
import { readPageContent, navigate, clickElement, typeText, takeScreenshot } from '../tools/index.js';
import type { PageContent, InteractiveElement } from '../tools/navigation.js';
import { detectAuthState, isLogoutIntent, type AuthSnapshot, type AuthState, type SessionDefect, type SessionDefectAction } from './session.js';
import * as fs from 'fs';
import * as path from 'path';

// Tokens that strongly suggest a click is supposed to do something user-visible.
// We only run dead-click detection when one of these applies, to avoid false-positives
// on toggles, dropdowns, accordions, and other clicks that legitimately do nothing
// observable in URL/text terms.
const ACTION_TEXT_REGEX = /\b(submit|send|save|register|sign\s?up|sign\s?in|log\s?in|login|subscribe|unsubscribe|apply|continue|confirm|book|order|buy|add to cart|checkout|download|upload|share|print|create|delete|update|publish|join|get started|try free|start free trial|enroll|request|contact)\b/;

function isActionLikeElement(elInfo: { tagName?: string | undefined; type?: string | undefined; text?: string | null | undefined } | undefined): boolean {
  if (!elInfo) return false;
  const tag = (elInfo.tagName || '').toLowerCase();
  const type = (elInfo.type || '').toLowerCase();
  if (tag === 'button') return true;
  if (tag === 'input' && (type === 'submit' || type === 'button')) return true;
  const text = (elInfo.text || '').trim().toLowerCase();
  if (!text) return false;
  return ACTION_TEXT_REGEX.test(text);
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h;
}

interface ClickSnapshot {
  url: string;
  textHash: number;
  textLength: number;
  dialogCount: number;
  pageCount: number;
  contentBugCount: number;
}

export type DefectSeverity = 'low' | 'medium' | 'high';

export interface ReproStep {
  step: number;
  action: string;
  target: string | null;
  url: string;
  linkText?: string | null | undefined;
}

export interface DefectMeta {
  id: string;
  type: string;
  severity: DefectSeverity;
  detectedAtStep: number;
  reproduction: ReproStep[];
  evidenceScreenshot?: string | undefined;
}

export interface AuditBug extends DefectMeta {
  elementSelector: string;
  issueType: string;
  description: string;
  url: string;
  timestamp: string;
}

export interface SecurityFinding extends DefectMeta {
  elementSelector: string;
  description: string;
  url: string;
  timestamp: string;
}

export interface ContentBug extends DefectMeta {
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
  private actionHistory: Array<{
    step: number;
    action: string;
    target: string | null;
    result: string;
    error?: string | undefined;
    url?: string | undefined;
    linkText?: string | null | undefined;
  }> = [];
  private screenshots: Record<string, string> = {};
  private bugsLogged: AuditBug[] = [];
  private securityFindings: SecurityFinding[] = [];
  private contentBugsLogged: ContentBug[] = [];
  private clickedSelectors: string[] = [];
  private currentViewport = { width: 1280, height: 800 };
  private sessionDefects: SessionDefect[] = [];
  private baselineAuthSnapshot: AuthSnapshot | null = null;
  private expectedAuthState: AuthState = 'unknown';
  private logoutAcknowledged = false;
  private authHistory: Array<{ step: number; snapshot: AuthSnapshot }> = [];
  private stepScreenshots: Record<number, string> = {};
  private nextDefectIds = { content: 1, ui: 1, security: 1 };
  private currentStep = 0;
  private visitedSections = new Set<string>();
  private currentUrlStreak = 0;
  private previousUrl: string | null = null;
  private rejectedSelectors = new Set<string>();

  constructor(page: Page, baseUrl: string) {
    this.page = page;
    this.baseUrl = baseUrl;
  }

  private mintDefectId(prefix: 'CB' | 'UB' | 'SF'): string {
    const key = prefix === 'CB' ? 'content' : prefix === 'UB' ? 'ui' : 'security';
    const n = this.nextDefectIds[key]++;
    return `${prefix}-${String(n).padStart(3, '0')}`;
  }

  // Section = first path segment after the base host. Used to drive breadth-first
  // exploration: agents should bounce between sections rather than dwell in one.
  private sectionOf(url: string): string {
    try {
      const u = new URL(url);
      const base = new URL(this.baseUrl);
      if (u.host !== base.host) return 'external';
      const segs = u.pathname.split('/').filter(s => s.length > 0);
      if (segs.length === 0) return 'home';
      return segs[0]!;
    } catch {
      return 'unknown';
    }
  }

  private sectionOfHref(href: string, currentUrl: string): string {
    try {
      return this.sectionOf(new URL(href, currentUrl).toString());
    } catch {
      return 'unknown';
    }
  }

  // Pick a runner-driven alternative when the LLM proposes a click on something
  // that's already been clicked or that the loop-breaker just rejected. Prefers
  // links into sections we haven't visited yet.
  private findFreshAlternative(pageContent: PageContent): { selector: string; text: string | null } | null {
    const fresh: InteractiveElement[] = pageContent.interactiveElements.filter((el: InteractiveElement) => {
      if (!el.selector) return false;
      if (this.clickedSelectors.includes(el.selector)) return false;
      if (this.rejectedSelectors.has(el.selector)) return false;
      // Anchors and buttons only — skip raw inputs we don't know how to use.
      if (el.tagName !== 'a' && el.tagName !== 'button') return false;
      return true;
    });
    if (fresh.length === 0) return null;

    const score = (el: InteractiveElement): number => {
      let s = 0;
      const hrefMatch = el.selector.match(/href="([^"]+)"/);
      if (hrefMatch && hrefMatch[1]) {
        const target = this.sectionOfHref(hrefMatch[1], pageContent.url);
        if (target !== 'external' && !this.visitedSections.has(target)) s += 3;
        if (target === 'external') s -= 1;
      }
      // Slight preference for anchors over buttons (typically navigation).
      if (el.tagName === 'a') s += 1;
      return s;
    };

    fresh.sort((a: InteractiveElement, b: InteractiveElement) => score(b) - score(a));
    const pick = fresh[0]!;
    return { selector: pick.selector, text: pick.text ?? null };
  }

  private updateSectionAndStreak(currentUrl: string): void {
    this.visitedSections.add(this.sectionOf(currentUrl));
    if (this.previousUrl !== null && this.previousUrl === currentUrl) {
      this.currentUrlStreak += 1;
    } else {
      this.currentUrlStreak = 0;
    }
    this.previousUrl = currentUrl;
  }

  private buildReproductionTrail(currentStep: number, currentUrl: string, depth = 6): ReproStep[] {
    const recent = this.actionHistory.slice(-depth);
    return recent.map(h => ({
      step: h.step,
      action: h.action,
      target: h.target,
      url: h.url ?? currentUrl,
      linkText: h.linkText ?? null,
    }));
  }

  private async captureClickSnapshot(): Promise<ClickSnapshot> {
    const url = this.page.url();
    const bodyText = await this.page.locator('body').innerText().catch(() => '');
    const dialogCount = await this.page
      .locator('[role="dialog"]:visible, [aria-modal="true"]:visible, dialog[open]')
      .count()
      .catch(() => 0);
    const pageCount = this.page.context().pages().length;
    return {
      url,
      textHash: hashString(bodyText),
      textLength: bodyText.length,
      dialogCount,
      pageCount,
      contentBugCount: this.contentBugsLogged.length,
    };
  }

  private static firstLine(text: string | undefined): string {
    if (!text) return '';
    const line = text.split(/\r?\n/).find(l => l.trim().length > 0) ?? '';
    return line.length > 200 ? line.slice(0, 200) + '…' : line;
  }

  async runUIAgent(agentInstance: any, maxSteps = 10): Promise<void> {
    console.log(`🚀 Starting UI/UX Exploration at: ${this.baseUrl}`);
    await navigate(this.page, '/');
    let currentUrl = this.page.url();
    this.visitedUrls.push(currentUrl);

    let steps = 0;
    while (steps < maxSteps) {
      steps++;
      this.currentStep = steps;
      console.log(`\n--- UI Agent Step ${steps}/${maxSteps} ---`);
      console.log(`URL: ${currentUrl} | Viewport: ${this.currentViewport.width}x${this.currentViewport.height}`);

      // Take snapshot
      const pageTitleSanitized = (await this.page.title()).replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const screenshotName = `ui_step_${steps}_${pageTitleSanitized}_${this.currentViewport.width}x${this.currentViewport.height}`;
      const screenshotRes = await takeScreenshot(this.page, screenshotName);
      if (screenshotRes.success && screenshotRes.filePath) {
        this.screenshots[`${currentUrl}_${this.currentViewport.width}x${this.currentViewport.height}`] = screenshotRes.filePath;
        this.stepScreenshots[steps] = screenshotRes.filePath;
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

      const uiElInfo = pageContent.interactiveElements.find(el => el.selector === decision.target);
      this.actionHistory.push({
        step: steps,
        action: decision.action,
        target: decision.target,
        result: 'success',
        url: currentUrl,
        linkText: uiElInfo?.text ?? null,
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
        const severity: DefectSeverity = /critical|broken/i.test(issueType) ? 'high' : /minor|spacing|cosmetic/i.test(issueType) ? 'low' : 'medium';
        this.bugsLogged.push({
          id: this.mintDefectId('UB'),
          type: issueType,
          severity,
          detectedAtStep: steps,
          reproduction: this.buildReproductionTrail(steps, currentUrl),
          evidenceScreenshot: this.stepScreenshots[steps],
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
      this.currentStep = steps;
      console.log(`\n--- Security Agent Step ${steps}/${maxSteps} ---`);
      console.log(`URL: ${currentUrl}`);

      // Take snapshot
      const pageTitleSanitized = (await this.page.title()).replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const screenshotName = `sec_step_${steps}_${pageTitleSanitized}`;
      const screenshotRes = await takeScreenshot(this.page, screenshotName);
      if (screenshotRes.success && screenshotRes.filePath) {
        this.screenshots[currentUrl] = screenshotRes.filePath;
        this.stepScreenshots[steps] = screenshotRes.filePath;
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

      const secElInfo = pageContent.interactiveElements.find(el => el.selector === decision.target);
      this.actionHistory.push({
        step: steps,
        action: decision.action,
        target: decision.target,
        result: 'success',
        url: currentUrl,
        linkText: secElInfo?.text ?? null,
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
          id: this.mintDefectId('SF'),
          type: 'INPUT_VALIDATION',
          severity,
          detectedAtStep: steps,
          reproduction: this.buildReproductionTrail(steps, currentUrl),
          evidenceScreenshot: this.stepScreenshots[steps],
          elementSelector: decision.target || 'N/A',
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

    const highCount = this.bugsLogged.filter(b => b.severity === 'high').length;
    const medCount = this.bugsLogged.filter(b => b.severity === 'medium').length;
    const lowCount = this.bugsLogged.filter(b => b.severity === 'low').length;

    let md = `# UI/UX & Formatting Audit Report\n\n`;
    md += `- **Date**: ${new Date().toLocaleString()}\n`;
    md += `- **Target Site**: ${this.baseUrl}\n`;
    md += `- **Total defects**: ${this.bugsLogged.length} (${highCount} P1, ${medCount} P2, ${lowCount} P3)\n\n`;

    md += `## 📋 Defect Summary\n\n`;
    if (this.bugsLogged.length === 0) {
      md += `✅ *No visual formatting or alignment bugs logged during this run.*\n\n`;
    } else {
      md += `| ID | Type | Severity | Step | Page | One-liner |\n`;
      md += `| --- | --- | --- | --- | --- | --- |\n`;
      this.bugsLogged.forEach(b => {
        md += `| [${b.id}](#defect-${b.id.toLowerCase()}) | ${b.issueType} | ${this.severityBadge(b.severity)} | ${b.detectedAtStep} | ${AgentRunner.redactUrl(b.url)} | ${AgentRunner.truncate(b.description, 120)} |\n`;
      });
      md += `\n`;
    }

    md += `## 🐞 Defects\n\n`;
    if (this.bugsLogged.length === 0) {
      md += `_None._\n\n`;
    } else {
      this.bugsLogged.forEach(bug => {
        md += `### <a id="defect-${bug.id.toLowerCase()}"></a>${bug.id} — ${bug.issueType} (${this.severityBadge(bug.severity)})\n\n`;
        md += `**Where**: step ${bug.detectedAtStep} on ${AgentRunner.redactUrl(bug.url)}\n\n`;
        md += `**Element**: \`${bug.elementSelector}\`\n\n`;
        md += `**Description**: ${bug.description}\n\n`;
        md += `**Reproduction trail**\n\n`;
        md += this.renderReproductionTable(bug.reproduction);
        md += `**Evidence**\n\n`;
        md += `- Screenshot: ${bug.evidenceScreenshot ? `[view](${bug.evidenceScreenshot})` : '_unavailable_'}\n`;
        md += `- Timestamp: ${bug.timestamp}\n\n`;
      });
    }

    md += `## 📑 Explored Viewports & Screenshots\n\n`;
    for (const [key, value] of Object.entries(this.screenshots)) {
      const parts = key.split('_');
      const viewport = parts.pop();
      const url = parts.join('_');
      const relPath = AgentRunner.redactUrl(url.replace(this.baseUrl, '/'));
      md += `- **${relPath}** at **${viewport}** — [View Screenshot](${value})\n`;
    }
    md += `\n`;

    const { table, failureTraces } = this.renderActionHistoryTable();
    md += `## 📜 Action History\n\n`;
    md += table + `\n`;
    if (failureTraces.length > 0) {
      md += `<details><summary>Full Playwright traces for failed steps</summary>\n${failureTraces}\n</details>\n`;
    }

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

    const highCount = this.securityFindings.filter(b => b.severity === 'high').length;
    const medCount = this.securityFindings.filter(b => b.severity === 'medium').length;
    const lowCount = this.securityFindings.filter(b => b.severity === 'low').length;

    let md = `# Input Security & Validation Report\n\n`;
    md += `- **Date**: ${new Date().toLocaleString()}\n`;
    md += `- **Target Site**: ${this.baseUrl}\n`;
    md += `- **Total findings**: ${this.securityFindings.length} (${highCount} P1, ${medCount} P2, ${lowCount} P3)\n\n`;

    md += `## 📋 Findings Summary\n\n`;
    if (this.securityFindings.length === 0) {
      md += `✅ *No input vulnerabilities or boundary issues logged during this audit.*\n\n`;
    } else {
      md += `| ID | Type | Severity | Step | Page | One-liner |\n`;
      md += `| --- | --- | --- | --- | --- | --- |\n`;
      this.securityFindings.forEach(f => {
        md += `| [${f.id}](#defect-${f.id.toLowerCase()}) | ${f.type} | ${this.severityBadge(f.severity)} | ${f.detectedAtStep} | ${AgentRunner.redactUrl(f.url)} | ${AgentRunner.truncate(f.description, 120)} |\n`;
      });
      md += `\n`;
    }

    md += `## 🛡️ Findings\n\n`;
    if (this.securityFindings.length === 0) {
      md += `_None._\n\n`;
    } else {
      this.securityFindings.forEach(f => {
        md += `### <a id="defect-${f.id.toLowerCase()}"></a>${f.id} — ${f.type} (${this.severityBadge(f.severity)})\n\n`;
        md += `**Where**: step ${f.detectedAtStep} on ${AgentRunner.redactUrl(f.url)}\n\n`;
        md += `**Element**: \`${f.elementSelector}\`\n\n`;
        md += `**Description**: ${f.description}\n\n`;
        md += `**Reproduction trail**\n\n`;
        md += this.renderReproductionTable(f.reproduction);
        md += `**Evidence**\n\n`;
        md += `- Screenshot: ${f.evidenceScreenshot ? `[view](${f.evidenceScreenshot})` : '_unavailable_'}\n`;
        md += `- Timestamp: ${f.timestamp}\n\n`;
      });
    }

    const { table, failureTraces } = this.renderActionHistoryTable();
    md += `## 📜 Action History\n\n`;
    md += table + `\n`;
    if (failureTraces.length > 0) {
      md += `<details><summary>Full Playwright traces for failed steps</summary>\n${failureTraces}\n</details>\n`;
    }

    fs.writeFileSync(reportPath, md, 'utf-8');
    console.log(`📝 Saved security report to: ${reportPath}`);
  }

  async runContentAgent(agentInstance: any, maxSteps = 10): Promise<void> {
    console.log(`\n🚀 Starting Content Context & Integrity Audit at: ${this.baseUrl}`);

    // Declared up-front so the new-tab handler's closure resolves to this binding
    // (handleNewPage is registered before the main loop begins).
    let lastAction: { action: string; selector: string | null; text: string | null } | null = null;

    // Listen for new tab openings
    const context = this.page.context();
    const handleNewPage = async (newPage: any) => {
      console.log(`🌐 [New Tab Detector] Detected new tab opening...`);
      try {
        await newPage.waitForLoadState('domcontentloaded', { timeout: 10000 });
        const newUrl = newPage.url();
        const newTitle = await newPage.title().catch(() => 'Untitled');
        console.log(`🌐 [New Tab Detector] Loaded: "${newTitle}" | URL: ${newUrl}`);

        // Take a screenshot of the new tab
        const pageTitleSanitized = newTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const screenshotName = `content_tab_${Date.now()}_${pageTitleSanitized}`;
        const screenshotRes = await takeScreenshot(newPage, screenshotName);
        if (screenshotRes.success && screenshotRes.filePath) {
          this.screenshots[newUrl] = screenshotRes.filePath;
        }

        // Scan page text for common error cues
        const bodyText = await newPage.locator('body').innerText().catch(() => '');
        
        const tabScreenshot = screenshotRes.success ? screenshotRes.filePath : undefined;
        const tabRepro = this.buildReproductionTrail(this.currentStep, newUrl);

        // 1. Check for unresolved placeholders in the URL
        if (newUrl.includes('SUBSCRIBER_ID') || newUrl.includes('placeholder')) {
          this.contentBugsLogged.push({
            id: this.mintDefectId('CB'),
            type: 'PLACEHOLDER_URL',
            severity: 'high',
            detectedAtStep: this.currentStep,
            reproduction: tabRepro,
            evidenceScreenshot: tabScreenshot,
            linkText: lastAction?.text || 'External Link',
            expectedTopic: 'Substituted subscriber page URL',
            actualTopic: 'Placeholder URL',
            description: `New tab opened to a template URL containing unresolved placeholders: "${newUrl}"`,
            url: newUrl,
            timestamp: new Date().toISOString()
          });
          console.log(`🐞 Logged Content Bug: [New tab has unresolved placeholder: ${newUrl}]`);
        }
        // 2. Check for 404 page errors
        else if (newTitle.includes('404') || newTitle.toLowerCase().includes('not found') || bodyText.toLowerCase().includes('page not found')) {
          this.contentBugsLogged.push({
            id: this.mintDefectId('CB'),
            type: 'BROKEN_LINK',
            severity: 'high',
            detectedAtStep: this.currentStep,
            reproduction: tabRepro,
            evidenceScreenshot: tabScreenshot,
            linkText: lastAction?.text || 'External Link',
            expectedTopic: 'Active target page content',
            actualTopic: '404 Not Found / Error Page',
            description: `New tab opened to a broken link resulting in a 404 page error: "${newUrl}"`,
            url: newUrl,
            timestamp: new Date().toISOString()
          });
          console.log(`🐞 Logged Content Bug: [New tab is a 404 page: ${newUrl}]`);
        }

        // Close the tab to save resources
        await newPage.close();
      } catch (err: any) {
        console.error(`❌ [New Tab Detector] Error auditing new tab:`, err.message || err);
      }
    };
    
    context.on('page', handleNewPage);

    await navigate(this.page, '/');
    let currentUrl = this.page.url();
    this.visitedUrls.push(currentUrl);

    // Capture baseline auth state. If the test logged in beforehand we expect 'authenticated'
    // and will treat a later drop to 'anonymous' as a SESSION_DROPPED defect.
    this.baselineAuthSnapshot = await detectAuthState(this.page);
    this.expectedAuthState = this.baselineAuthSnapshot.state;
    console.log(`🔐 Baseline auth state: ${this.expectedAuthState} (cookies: ${this.baselineAuthSnapshot.outsetaCookieCount}, localStorage: ${this.baselineAuthSnapshot.outsetaLocalStorageKeyCount}, loginTriggerVisible: ${this.baselineAuthSnapshot.loginTriggerVisible}, authIndicatorVisible: ${this.baselineAuthSnapshot.authIndicatorVisible})`);

    let steps = 0;

    while (steps < maxSteps) {
      steps++;
      this.currentStep = steps;
      console.log(`\n--- Content Agent Step ${steps}/${maxSteps} ---`);

      // Take screenshot FIRST so the sentinel can attach evidence captured before any remediation.
      const pageTitleSanitized = (await this.page.title()).replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const screenshotName = `content_step_${steps}_${pageTitleSanitized}`;
      const screenshotRes = await takeScreenshot(this.page, screenshotName);
      if (screenshotRes.success && screenshotRes.filePath) {
        this.screenshots[currentUrl] = screenshotRes.filePath;
        this.stepScreenshots[steps] = screenshotRes.filePath;
      }

      // Session sentinel: was the user silently logged out by the previous action?
      // Runs BEFORE the auto-login helper so a drop is detected before it gets papered over.
      await this.checkSessionIntegrity(steps, currentUrl);

      // Auto-login helper: if login modal is opened and inputs are visible, fill them automatically.
      // The sentinel above has already recorded the drop (if any) before remediation.
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
          // Re-establish the authenticated baseline so we keep watching for further drops.
          this.expectedAuthState = 'authenticated';
          this.logoutAcknowledged = false;
        }
      }

      // Read page content
      const pageContent = await readPageContent(this.page);

      // SoundCloud Verification (Frame Scanner)
      let soundCloudErrorFound = false;
      for (const frame of this.page.frames()) {
        try {
          const bodyText = await frame.locator('body').innerText();
          if (bodyText && bodyText.includes('You have not provided a valid SoundCloud URL')) {
            soundCloudErrorFound = true;
            break;
          }
        } catch (e) {
          // ignore cross-origin frames
        }
      }
      if (soundCloudErrorFound) {
        const alreadyLogged = this.contentBugsLogged.some(b => b.url === currentUrl && b.description.includes('SoundCloud'));
        if (!alreadyLogged) {
          this.contentBugsLogged.push({
            id: this.mintDefectId('CB'),
            type: 'BROKEN_EMBED',
            severity: 'high',
            detectedAtStep: steps,
            reproduction: this.buildReproductionTrail(steps, currentUrl),
            evidenceScreenshot: this.stepScreenshots[steps],
            linkText: lastAction?.text || 'SoundCloud Embed',
            expectedTopic: 'Valid SoundCloud Audio Player',
            actualTopic: 'SoundCloud URL Error Message',
            description: 'The embedded SoundCloud player iframe displays: "You have not provided a valid SoundCloud URL. Learn more about using SoundCloud players."',
            url: currentUrl,
            timestamp: new Date().toISOString()
          });
          console.log(`🐞 Logged Content Bug: [SoundCloud embed error on ${currentUrl}]`);
          lastAction = { action: 'LOG_CONTENT_BUG', selector: null, text: null };
        }
      }

      // Update breadth-first tracking before consulting the LLM so it sees fresh
      // section coverage and URL-streak data.
      this.updateSectionAndStreak(currentUrl);

      // Consult LLM
      const stepsRemaining = maxSteps - steps;
      const decision: any = await agentInstance.decideNextAction(
        this.visitedUrls,
        pageContent,
        lastAction,
        stepsRemaining,
        this.contentBugsLogged,
        this.clickedSelectors,
        Array.from(this.visitedSections),
        this.currentUrlStreak
      );

      console.log(`Thought: "${decision.thought}"`);
      console.log(`Proposed action: ${decision.action} | Target: ${decision.target}`);

      // Loop-breaker: if the LLM proposes clicking something it (or an earlier
      // step) already clicked, substitute a fresh alternative — preferring links
      // into sections we haven't visited yet. Falls back to BACK when nothing
      // fresh is available.
      if (decision.action === 'CLICK' && decision.target && this.clickedSelectors.includes(decision.target)) {
        console.log(`🔁 Loop-breaker: LLM proposed repeat selector "${decision.target}".`);
        this.rejectedSelectors.add(decision.target);
        const alt = this.findFreshAlternative(pageContent);
        if (alt) {
          console.log(`🔁 Loop-breaker: substituting fresh selector "${alt.selector}" (text: "${alt.text ?? ''}").`);
          decision.target = alt.selector;
          decision.params = { ...(decision.params ?? {}), linkText: alt.text };
        } else if (this.visitedUrls.length > 1) {
          console.log(`🔁 Loop-breaker: no fresh alternatives on this page — falling back to BACK.`);
          decision.action = 'BACK';
          decision.target = null;
        } else {
          console.log(`🔁 Loop-breaker: no fresh alternatives and no history — finishing.`);
          decision.action = 'FINISH';
          decision.target = 'Loop-breaker exhausted; nothing else to audit.';
        }
      }

      console.log(`Executed action: ${decision.action} | Target: ${decision.target}`);

      const contentElInfo = pageContent.interactiveElements.find(el => el.selector === decision.target);
      this.actionHistory.push({
        step: steps,
        action: decision.action,
        target: decision.target,
        result: 'success',
        url: currentUrl,
        linkText: contentElInfo?.text ?? decision.params?.linkText ?? null,
      });

      if (decision.action === 'FINISH') {
        console.log(`🏁 Content Agent finished: ${decision.target}`);
        break;
      }

      if (decision.action === 'CLICK' && decision.target) {
        const elInfo = pageContent.interactiveElements.find(el => el.selector === decision.target);

        // Dead-click detection pre-state. Multi-signal snapshot so we can tell whether
        // ANYTHING user-observable happened: URL, body text, dialog count, page count, or
        // a content bug logged by the new-tab listener.
        const preClickSnapshot = await this.captureClickSnapshot();

        const resolvedLinkText = elInfo ? (elInfo.text || decision.params?.linkText || null) : (decision.params?.linkText || null);
        lastAction = {
          action: 'CLICK',
          selector: decision.target,
          text: resolvedLinkText
        };

        if (isLogoutIntent(decision.target, resolvedLinkText)) {
          this.logoutAcknowledged = true;
          console.log(`🔓 Logout intent recognized — subsequent session drop will be treated as expected.`);
        }

        this.clickedSelectors.push(decision.target);

        const clickRes = await clickElement(this.page, decision.target);
        await this.page.waitForTimeout(1500); // Wait for page/modal transitions
        currentUrl = this.page.url();

        if (!clickRes.success) {
          this.actionHistory[this.actionHistory.length - 1]!.result = 'failed';
          this.actionHistory[this.actionHistory.length - 1]!.error = clickRes.error;
        } else {
          if (!this.visitedUrls.includes(currentUrl)) {
            this.visitedUrls.push(currentUrl);
          }

          // Generic dead-click detection (replaces the previous Submit-News-only check).
          // Only fires on action-like elements (button, input[type=submit], or text containing
          // an action verb like submit/send/subscribe/etc.) — toggles and dropdowns are excluded.
          if (isActionLikeElement(elInfo)) {
            const postClickSnapshot = await this.captureClickSnapshot();
            const noChange =
              preClickSnapshot.url === postClickSnapshot.url &&
              preClickSnapshot.textHash === postClickSnapshot.textHash &&
              preClickSnapshot.textLength === postClickSnapshot.textLength &&
              preClickSnapshot.dialogCount === postClickSnapshot.dialogCount &&
              preClickSnapshot.pageCount === postClickSnapshot.pageCount &&
              preClickSnapshot.contentBugCount === postClickSnapshot.contentBugCount;

            if (noChange) {
              const alreadyLogged = this.contentBugsLogged.some(b =>
                b.type === 'DEAD_CLICK' &&
                b.url === currentUrl &&
                (b.linkText === (resolvedLinkText || '') ||
                  b.reproduction.some(r => r.target === decision.target))
              );
              if (!alreadyLogged) {
                const label = resolvedLinkText || decision.target;
                this.contentBugsLogged.push({
                  id: this.mintDefectId('CB'),
                  type: 'DEAD_CLICK',
                  severity: 'medium',
                  detectedAtStep: steps,
                  reproduction: this.buildReproductionTrail(steps, currentUrl),
                  evidenceScreenshot: this.stepScreenshots[steps],
                  linkText: resolvedLinkText || 'Unknown action element',
                  expectedTopic: 'A visible change: navigation, modal opening, content update, or new tab',
                  actualTopic: 'No observable change (URL, page text, dialog count, tab count, and bug log all unchanged)',
                  description: `Clicking the action element "${label}" produced no observable change after 1500ms. The control appears to be unwired or a no-op handler.`,
                  url: currentUrl,
                  timestamp: new Date().toISOString()
                });
                console.log(`🐞 Logged Content Bug: [Dead click on "${label}" at ${currentUrl}]`);
                lastAction = { action: 'LOG_CONTENT_BUG', selector: null, text: null };
              }
            }
          }
        }
      } else if (decision.action === 'LOG_CONTENT_BUG' && decision.params) {
        const { linkText, expectedTopic, actualTopic, description } = decision.params;
        this.contentBugsLogged.push({
          id: this.mintDefectId('CB'),
          type: 'CONTENT_MISMATCH',
          severity: 'medium',
          detectedAtStep: steps,
          reproduction: this.buildReproductionTrail(steps, currentUrl),
          evidenceScreenshot: this.stepScreenshots[steps],
          linkText: linkText || 'Unknown Link',
          expectedTopic: expectedTopic || 'Unknown Expected Topic',
          actualTopic: actualTopic || 'Unknown Actual Content',
          description: description || 'No description provided.',
          url: currentUrl,
          timestamp: new Date().toISOString()
        });
        console.log(`🐞 Logged Content Bug: [promised "${expectedTopic}" but loaded "${actualTopic}"]`);
        lastAction = { action: 'LOG_CONTENT_BUG', selector: null, text: null };
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

    context.off('page', handleNewPage);
    await this.saveContentReport();
  }

  private async checkSessionIntegrity(step: number, currentUrl: string): Promise<void> {
    const snapshot = await detectAuthState(this.page);
    this.authHistory.push({ step, snapshot });

    if (!this.baselineAuthSnapshot) return;
    if (this.expectedAuthState !== 'authenticated') return;
    if (snapshot.state !== 'anonymous') return;
    if (this.logoutAcknowledged) return;

    const precedingActions: SessionDefectAction[] = this.actionHistory.slice(-6).map(h => ({
      step: h.step,
      action: h.action,
      target: h.target,
      url: this.visitedUrls[this.visitedUrls.length - 1] || currentUrl,
    }));

    const baselineScreenshot = this.stepScreenshots[1] ?? (this.baselineAuthSnapshot ? this.screenshots[this.baselineAuthSnapshot.url] : undefined);
    const failureScreenshot = this.stepScreenshots[step] ?? this.screenshots[currentUrl];

    this.sessionDefects.push({
      type: 'SESSION_DROPPED',
      detectedAtStep: step,
      detectedAtUrl: currentUrl,
      baselineSnapshot: this.baselineAuthSnapshot,
      failureSnapshot: snapshot,
      precedingActions,
      baselineScreenshot,
      failureScreenshot,
      timestamp: new Date().toISOString(),
    });

    console.log(
      `🚨 SESSION_DROPPED at step ${step}: was authenticated at ${this.baselineAuthSnapshot.url}, ` +
      `now anonymous at ${currentUrl} (cookies ${this.baselineAuthSnapshot.outsetaCookieCount} → ${snapshot.outsetaCookieCount}, ` +
      `loginTriggerVisible: ${snapshot.loginTriggerVisible}).`
    );

    // Don't re-fire on every subsequent step
    this.expectedAuthState = 'anonymous';
  }

  private severityBadge(sev: DefectSeverity): string {
    if (sev === 'high') return '🔴 P1';
    if (sev === 'medium') return '🟠 P2';
    return '🟡 P3';
  }

  private renderReproductionTable(repro: ReproStep[]): string {
    if (repro.length === 0) return `_No preceding actions recorded._\n\n`;
    let s = `| Step | Action | Target | Link text | URL |\n`;
    s += `| --- | --- | --- | --- | --- |\n`;
    repro.forEach(a => {
      const target = a.target ? `\`${AgentRunner.truncate(a.target, 80)}\`` : '-';
      const text = a.linkText ? `"${AgentRunner.truncate(a.linkText, 60)}"` : '-';
      s += `| ${a.step} | ${a.action} | ${target} | ${text} | ${AgentRunner.redactUrl(a.url)} |\n`;
    });
    return s + `\n`;
  }

  private renderActionHistoryTable(): { table: string; failureTraces: string } {
    let table = `| Step | Action | Target | URL | Result |\n`;
    table += `| --- | --- | --- | --- | --- |\n`;
    let failureTraces = '';
    this.actionHistory.forEach(h => {
      const target = h.target ? `\`${AgentRunner.truncate(h.target, 80)}\`` : '-';
      const url = h.url ? AgentRunner.redactUrl(h.url) : '-';
      let resultText: string;
      if (h.result === 'success') {
        resultText = '✅ Success';
      } else {
        resultText = `❌ ${AgentRunner.firstLine(h.error) || 'failed'}`;
        if (h.error) {
          failureTraces += `\n#### Step ${h.step} — full trace\n\n\`\`\`\n${h.error}\n\`\`\`\n`;
        }
      }
      table += `| ${h.step} | ${h.action} | ${target} | ${url} | ${resultText} |\n`;
    });
    return { table, failureTraces };
  }

  private static truncate(s: string, n: number): string {
    if (s.length <= n) return s;
    return s.slice(0, n) + '…';
  }

  // Strip credential-bearing query params (Outseta JWT access tokens, etc.) before
  // putting URLs into a shareable report. Targets known param names plus a fallback
  // for any value that looks like a base64-prefixed JWT.
  private static REDACT_PARAM_REGEX = /([?&])(access_token|id_token|refresh_token|token|jwt|oauth_token|api_key|authorization|password)=([^&#]+)/gi;
  private static REDACT_JWT_VALUE_REGEX = /=eyJ[A-Za-z0-9_.-]{20,}/g;

  private static redactUrl(url: string | null | undefined): string {
    if (!url) return url ?? '';
    return url
      .replace(AgentRunner.REDACT_PARAM_REGEX, '$1$2=[REDACTED]')
      .replace(AgentRunner.REDACT_JWT_VALUE_REGEX, '=eyJ[REDACTED]');
  }

  private sentinelEverEngaged(): boolean {
    if (this.baselineAuthSnapshot?.state === 'authenticated') return true;
    return this.authHistory.some(h => h.snapshot.state === 'authenticated');
  }

  private firstAuthenticatedStep(): number | null {
    const entry = this.authHistory.find(h => h.snapshot.state === 'authenticated');
    return entry ? entry.step : null;
  }

  // Collapse content bugs that share a root cause (same defect type + same
  // destination URL host+path + same normalized actualTopic). Multiple
  // gated-content links all landing on /access-denied with actualTopic
  // "Access Denied" become one card with N instances instead of N cards.
  // The underlying contentBugsLogged array is untouched — this is a
  // render-time view.
  private static rootCauseKey(bug: ContentBug): string {
    let urlKey: string;
    try {
      const u = new URL(bug.url);
      urlKey = `${u.host}${u.pathname}`;
    } catch {
      urlKey = bug.url;
    }
    const topicKey = (bug.actualTopic || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
    return `${bug.type}|${urlKey}|${topicKey}`;
  }

  private groupContentBugs(): Map<string, ContentBug[]> {
    const groups = new Map<string, ContentBug[]>();
    for (const bug of this.contentBugsLogged) {
      const key = AgentRunner.rootCauseKey(bug);
      const arr = groups.get(key) ?? [];
      arr.push(bug);
      groups.set(key, arr);
    }
    return groups;
  }

  private async saveContentReport() {
    const reportDir = path.resolve(process.cwd(), 'reports');
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = path.join(reportDir, `content_report_${timestamp}.md`);

    const totalDefects = this.contentBugsLogged.length + this.sessionDefects.length;
    const highCount =
      this.contentBugsLogged.filter(b => b.severity === 'high').length +
      this.sessionDefects.length; // session drops are always P1

    const sentinelEngaged = this.sentinelEverEngaged();
    const firstAuthStep = this.firstAuthenticatedStep();
    let baselineLabel: string;
    if (this.baselineAuthSnapshot?.state === 'authenticated') {
      baselineLabel = 'authenticated';
    } else if (sentinelEngaged && firstAuthStep !== null) {
      baselineLabel = `${this.baselineAuthSnapshot?.state ?? 'unknown'} (sentinel engaged at step ${firstAuthStep} after auto-login)`;
    } else {
      baselineLabel = this.baselineAuthSnapshot?.state ?? 'not captured';
    }

    const contentGroups = this.groupContentBugs();
    const distinctContentDefects = contentGroups.size;
    const distinctTotal = distinctContentDefects + this.sessionDefects.length;

    let md = `# Content Context & Integrity Report\n\n`;
    md += `- **Date**: ${new Date().toLocaleString()}\n`;
    md += `- **Target Site**: ${this.baseUrl}\n`;
    md += `- **Distinct defects**: ${distinctTotal} (${highCount} P1, ${this.contentBugsLogged.filter(b => b.severity === 'medium').length} P2, ${this.contentBugsLogged.filter(b => b.severity === 'low').length} P3)\n`;
    md += `- **Content defects**: ${distinctContentDefects} distinct (${this.contentBugsLogged.length} instances)\n`;
    md += `- **Session integrity defects**: ${this.sessionDefects.length}\n`;
    md += `- **Baseline auth state**: ${baselineLabel}\n\n`;

    md += `## 📋 Defect Summary\n\n`;
    if (distinctTotal === 0) {
      md += `✅ *No defects logged during this run.*\n\n`;
    } else {
      md += `| ID | Type | Severity | Step | Instances | Where | One-liner |\n`;
      md += `| --- | --- | --- | --- | --- | --- | --- |\n`;
      this.sessionDefects.forEach((d, idx) => {
        const sdNum = String(idx + 1).padStart(3, '0');
        md += `| [SD-${sdNum}](#defect-sd-${sdNum}) | ${d.type} | 🔴 P1 | ${d.detectedAtStep} | 1 | ${AgentRunner.redactUrl(d.detectedAtUrl)} | User was silently logged out mid-journey. |\n`;
      });
      for (const bugs of contentGroups.values()) {
        const primary = bugs[0]!;
        const instLabel = bugs.length > 1 ? `${bugs.length} ×` : '1';
        md += `| [${primary.id}](#defect-${primary.id.toLowerCase()}) | ${primary.type} | ${this.severityBadge(primary.severity)} | ${primary.detectedAtStep} | ${instLabel} | ${AgentRunner.redactUrl(primary.url)} | ${AgentRunner.truncate(primary.description, 120)} |\n`;
      }
      md += `\n`;
    }

    md += `## 🔐 Session Integrity Defects\n\n`;
    if (this.sessionDefects.length === 0) {
      if (sentinelEngaged) {
        const fromStep = firstAuthStep !== null ? ` from step ${firstAuthStep} onward` : '';
        md += `✅ *Session remained authenticated for the entire audit. Sentinel was engaged${fromStep}.*\n\n`;
      } else {
        md += `ℹ️ *Sentinel was not engaged — no authenticated state was observed during this run.*\n\n`;
      }
    } else {
      this.sessionDefects.forEach((d, idx) => {
        const sdId = `SD-${String(idx + 1).padStart(3, '0')}`;
        md += `### <a id="defect-sd-${String(idx + 1).padStart(3, '0')}"></a>${sdId} — ${d.type} (🔴 P1)\n\n`;
        md += `**Where**: step ${d.detectedAtStep} on ${AgentRunner.redactUrl(d.detectedAtUrl)}\n\n`;
        md += `**Expected**: Subscriber session persists across the actions below.\n\n`;
        md += `**Actual**: Session token absent and login trigger visible after step ${d.detectedAtStep}; the user would now have to log in again to continue.\n\n`;
        md += `**Auth signal comparison**\n\n`;
        md += `| | Baseline | At failure |\n`;
        md += `| --- | --- | --- |\n`;
        md += `| URL | ${AgentRunner.redactUrl(d.baselineSnapshot.url)} | ${AgentRunner.redactUrl(d.failureSnapshot.url)} |\n`;
        md += `| State | \`${d.baselineSnapshot.state}\` | \`${d.failureSnapshot.state}\` |\n`;
        md += `| Outseta cookies | ${d.baselineSnapshot.outsetaCookieCount} (${d.baselineSnapshot.outsetaCookieNames.join(', ') || 'none'}) | ${d.failureSnapshot.outsetaCookieCount} (${d.failureSnapshot.outsetaCookieNames.join(', ') || 'none'}) |\n`;
        md += `| Outseta localStorage keys | ${d.baselineSnapshot.outsetaLocalStorageKeyCount} (${d.baselineSnapshot.outsetaLocalStorageKeys.join(', ') || 'none'}) | ${d.failureSnapshot.outsetaLocalStorageKeyCount} (${d.failureSnapshot.outsetaLocalStorageKeys.join(', ') || 'none'}) |\n`;
        md += `| Login trigger visible | ${d.baselineSnapshot.loginTriggerVisible} | ${d.failureSnapshot.loginTriggerVisible} |\n`;
        md += `| Login modal visible | ${d.baselineSnapshot.loginModalVisible} | ${d.failureSnapshot.loginModalVisible} |\n`;
        md += `| Auth indicator visible | ${d.baselineSnapshot.authIndicatorVisible} | ${d.failureSnapshot.authIndicatorVisible} |\n\n`;
        md += `**Reproduction trail** (preceding ${d.precedingActions.length} action(s))\n\n`;
        md += this.renderReproductionTable(d.precedingActions.map(a => ({ ...a, linkText: null })));
        md += `**Evidence**\n\n`;
        md += `- Baseline screenshot: ${d.baselineScreenshot ? `[view](${d.baselineScreenshot})` : '_unavailable_'}\n`;
        md += `- Failure screenshot: ${d.failureScreenshot ? `[view](${d.failureScreenshot})` : '_unavailable_'}\n`;
        md += `- Timestamp: ${d.timestamp}\n\n`;
      });
    }

    md += `## 🐞 Content Defects\n\n`;
    if (contentGroups.size === 0) {
      md += `✅ *No semantic content mismatches or target rendering failures were logged.*\n\n`;
    } else {
      for (const bugs of contentGroups.values()) {
        const primary = bugs[0]!;
        const instanceCount = bugs.length;
        md += `### <a id="defect-${primary.id.toLowerCase()}"></a>${primary.id} — ${primary.type} (${this.severityBadge(primary.severity)})`;
        if (instanceCount > 1) md += ` — ${instanceCount} instances`;
        md += `\n\n`;
        md += `**Where**: step ${primary.detectedAtStep} on ${AgentRunner.redactUrl(primary.url)}\n\n`;
        md += `**Link text**: "${primary.linkText}"\n\n`;

        if (instanceCount > 1) {
          md += `**All affected links** (${instanceCount} instances — grouped because they share defect type, destination, and observed outcome):\n\n`;
          md += `| Instance ID | Step | Link text | Source page |\n`;
          md += `| --- | --- | --- | --- |\n`;
          bugs.forEach(b => {
            const sourceUrl = b.reproduction.length > 0
              ? b.reproduction[b.reproduction.length - 1]!.url
              : '-';
            md += `| ${b.id} | ${b.detectedAtStep} | "${AgentRunner.truncate(b.linkText, 60)}" | ${AgentRunner.redactUrl(sourceUrl)} |\n`;
          });
          md += `\n`;
        }

        md += `**Expected**: ${primary.expectedTopic}\n\n`;
        md += `**Actual**: ${primary.actualTopic}\n\n`;
        md += `**Description**: ${primary.description}\n\n`;
        md += `**Reproduction trail** (first instance, preceding ${primary.reproduction.length} action(s))\n\n`;
        md += this.renderReproductionTable(primary.reproduction);
        md += `**Evidence**\n\n`;
        md += `- Page screenshot (first instance): ${primary.evidenceScreenshot ? `[view](${primary.evidenceScreenshot})` : '_unavailable_'}\n`;
        md += `- First detected: ${primary.timestamp}\n`;
        if (instanceCount > 1) {
          md += `- Last detected: ${bugs[bugs.length - 1]!.timestamp}\n`;
        }
        md += `\n`;
      }
    }

    const { table, failureTraces } = this.renderActionHistoryTable();
    md += `## 📜 Action History\n\n`;
    md += table + `\n`;

    if (failureTraces.length > 0) {
      md += `<details><summary>Full Playwright traces for failed steps</summary>\n${failureTraces}\n</details>\n`;
    }

    fs.writeFileSync(reportPath, md, 'utf-8');
    console.log(`📝 Saved content audit report to: ${reportPath}`);
  }
}
