import type { Page } from '@playwright/test';
import { NavigationOrchestrator } from './orchestrator.js';
import { AgentRunner } from './agent-runner.js';
import { UIAgent } from '../agents/ui-agent.js';
import { SecurityAgent } from '../agents/security-agent.js';
import * as fs from 'fs';
import * as path from 'path';

export interface CoordinatedQAResult {
  targetUrl: string;
  totalVisitedPages: number;
  sitemapMermaid: string;
  brokenLinks: any[];
  consoleErrors: any[];
  uiBugs: any[];
  securityObservations: any[];
}

export class CrossAgentOrchestrator {
  private page: Page;
  private baseUrl: string;

  constructor(page: Page, baseUrl: string) {
    this.page = page;
    this.baseUrl = baseUrl;
  }

  async runCoordinatedSuite(): Promise<CoordinatedQAResult> {
    console.log(`\n======================================================`);
    console.log(`🎬 STARTING COORDINATED CROSS-AGENT QA SUITE`);
    console.log(`Target application: ${this.baseUrl}`);
    console.log(`======================================================\n`);

    // --- STEP 1: Map the site using Navigation Agent ---
    console.log('[Phase 1/3] Launching Navigation Agent for site-mapping...');
    // Limit to depth 3, max 10 steps to discover core paths quickly
    const navOrchestrator = new NavigationOrchestrator(this.page, this.baseUrl, 3, 10);
    const navState = await navOrchestrator.runExploration();

    const discoveredUrls = navState.visitedUrls;
    console.log(`\n[Phase 1 Complete] Navigation Agent mapped ${discoveredUrls.length} pages.`);

    // Capture console errors compiled by the navigation orchestrator
    // (We'll access them in report output)

    // --- STEP 2: Hand off discovered pages to UI/UX Agent ---
    console.log('\n[Phase 2/3] Handing off discovered URLs to UI/UX Agent for responsive testing...');
    const uiRunner = new AgentRunner(this.page, this.baseUrl);
    const uiAgent = new UIAgent();
    
    // Instead of crawling from scratch, we can run UI/UX checks directly on the list of mapped URLs
    for (const url of discoveredUrls.slice(0, 5)) { // Test up to 5 core pages to optimize run time
      const relativePath = url.replace(this.baseUrl, '/');
      console.log(`\nVisual Inspection on: ${relativePath}`);
      await this.page.goto(url);
      
      // Let UIAgent analyze the page under current desktop viewport, then resize to mobile
      await uiRunner.runUIAgent(uiAgent, 3); // 3 steps of UI checks per page
    }
    console.log('[Phase 2 Complete] UI/UX Agent completed layout checks.');

    // --- STEP 3: Hand off pages with form inputs to Security & Form Agent ---
    console.log('\n[Phase 3/3] Scanning for forms/inputs and handing off to Security Agent...');
    const secRunner = new AgentRunner(this.page, this.baseUrl);
    const secAgent = new SecurityAgent();

    // Audit pages that are likely to contain inputs or forms
    // We filter from discoveredUrls or target common pages like contact / newsletters
    const targetSecurityUrls = discoveredUrls.filter(url => 
      url.includes('contact') || url.includes('subscribe') || url === this.baseUrl
    );

    for (const url of targetSecurityUrls) {
      const relativePath = url.replace(this.baseUrl, '/');
      console.log(`\nInput Validation Security Audit on: ${relativePath}`);
      await this.page.goto(url);
      await secRunner.runSecurityAgent(secAgent, 3); // 3 steps of input boundary checks per page
    }
    console.log('[Phase 3 Complete] Security Agent completed form validations.');

    // --- STEP 4: Compile Unified Executive Report ---
    const result = await this.compileExecutiveReport(navState, uiRunner, secRunner);
    return result;
  }

  // Strip credential-bearing query params from URLs before rendering them
  // (mirrors AgentRunner.redactUrl — same patterns).
  private static REDACT_PARAM_REGEX = /([?&])(access_token|id_token|refresh_token|token|jwt|oauth_token|api_key|authorization|password)=([^&#]+)/gi;
  private static REDACT_JWT_VALUE_REGEX = /=eyJ[A-Za-z0-9_.-]{20,}/g;
  private static redactUrl(url: string | null | undefined): string {
    if (!url) return url ?? '';
    return url
      .replace(CrossAgentOrchestrator.REDACT_PARAM_REGEX, '$1$2=[REDACTED]')
      .replace(CrossAgentOrchestrator.REDACT_JWT_VALUE_REGEX, '=eyJ[REDACTED]');
  }

  private static truncate(s: string, n: number): string {
    if (!s) return '';
    return s.length <= n ? s : s.slice(0, n) + '…';
  }

  private static severityBadge(sev: string): string {
    const s = (sev || '').toLowerCase();
    if (s === 'high') return '🔴 P1';
    if (s === 'medium') return '🟠 P2';
    if (s === 'low') return '🟡 P3';
    return '⚪️ —';
  }

  // Group by defect type + URL host+path + element selector. The same UI bug
  // surfacing at three viewports, or the same security finding on the same
  // input across two probe payloads, collapses to a single card with N
  // instances — same logic that already deduplicates content defects.
  private groupByRootCause<T extends { type?: string; issueType?: string; url: string; elementSelector?: string }>(items: T[]): Map<string, T[]> {
    const groups = new Map<string, T[]>();
    for (const item of items) {
      let urlKey: string;
      try {
        const u = new URL(item.url);
        urlKey = `${u.host}${u.pathname}`;
      } catch {
        urlKey = item.url;
      }
      const typeKey = (item.type || item.issueType || 'UNTYPED').toLowerCase();
      const selKey = (item.elementSelector || '').slice(0, 80);
      const key = `${typeKey}|${urlKey}|${selKey}`;
      const arr = groups.get(key) ?? [];
      arr.push(item);
      groups.set(key, arr);
    }
    return groups;
  }

  private async compileExecutiveReport(navState: any, uiRunner: any, secRunner: any): Promise<CoordinatedQAResult> {
    const reportDir = path.resolve(process.cwd(), 'reports');
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = path.join(reportDir, `executive_qa_report_${timestamp}.md`);

    const visitedPages = navState.visitedUrls;
    const brokenLinks = navState.brokenLinks;
    const consoleErrors = (navState as any).consoleErrors ?? [];

    const uiBugs = (uiRunner as any).bugsLogged || [];
    const securityFindings = (secRunner as any).securityFindings || [];

    const uiGroups = this.groupByRootCause(uiBugs);
    const secGroups = this.groupByRootCause(securityFindings);

    // Severity counts across all sources (broken links + console errors
    // count as P1 by definition since they're observable runtime failures).
    const countSeverity = (items: any[], sev: string) =>
      items.filter(i => (i.severity || '').toLowerCase() === sev).length;
    const p1 = countSeverity(uiBugs, 'high') + countSeverity(securityFindings, 'high') + brokenLinks.length + consoleErrors.length;
    const p2 = countSeverity(uiBugs, 'medium') + countSeverity(securityFindings, 'medium');
    const p3 = countSeverity(uiBugs, 'low') + countSeverity(securityFindings, 'low');
    const distinctTotal = uiGroups.size + secGroups.size + brokenLinks.length + consoleErrors.length;
    const totalInstances = uiBugs.length + securityFindings.length + brokenLinks.length + consoleErrors.length;

    // Sitemap Mermaid
    let mermaid = `graph TD\n`;
    if (Object.keys(navState.siteMap).length === 0) {
      mermaid += `    "/" --> "No transitions recorded."\n`;
    } else {
      for (const [source, destinations] of Object.entries(navState.siteMap)) {
        const srcLabel = source.replace(this.baseUrl, '/');
        for (const dest of destinations as string[]) {
          const destLabel = dest.replace(this.baseUrl, '/');
          mermaid += `    "${srcLabel}" --> "${destLabel}"\n`;
        }
      }
    }

    let md = `# 📊 Coordinated QA Executive Report\n\n`;
    md += `- **Date**: ${new Date().toLocaleString()}\n`;
    md += `- **Target Host**: [${this.baseUrl}](${this.baseUrl})\n`;
    md += `- **Pages mapped**: ${visitedPages.length}\n`;
    md += `- **Distinct defects**: ${distinctTotal} (${p1} P1, ${p2} P2, ${p3} P3) — ${totalInstances} instances total\n`;
    md += `- **UI/UX**: ${uiGroups.size} distinct (${uiBugs.length} instances)\n`;
    md += `- **Security**: ${secGroups.size} distinct (${securityFindings.length} instances)\n`;
    md += `- **Site integrity**: ${brokenLinks.length} broken link(s), ${consoleErrors.length} console error(s)\n\n`;

    md += `## 📋 Defect Summary\n\n`;
    if (distinctTotal === 0) {
      md += `✅ *No defects logged across the coordinated run.*\n\n`;
    } else {
      md += `| Source | ID | Type | Severity | Step | Instances | Where | One-liner |\n`;
      md += `| --- | --- | --- | --- | --- | --- | --- | --- |\n`;
      // UI rows
      for (const bugs of uiGroups.values()) {
        const primary: any = bugs[0]!;
        const inst = bugs.length > 1 ? `${bugs.length} ×` : '1';
        md += `| 🎨 UI | [${primary.id}](#defect-${primary.id.toLowerCase()}) | ${primary.issueType} | ${CrossAgentOrchestrator.severityBadge(primary.severity)} | ${primary.detectedAtStep ?? '-'} | ${inst} | ${CrossAgentOrchestrator.redactUrl(primary.url)} | ${CrossAgentOrchestrator.truncate(primary.description, 100)} |\n`;
      }
      // Security rows
      for (const findings of secGroups.values()) {
        const primary: any = findings[0]!;
        const inst = findings.length > 1 ? `${findings.length} ×` : '1';
        md += `| 🛡️ SEC | [${primary.id}](#defect-${primary.id.toLowerCase()}) | ${primary.type || 'INPUT_VALIDATION'} | ${CrossAgentOrchestrator.severityBadge(primary.severity)} | ${primary.detectedAtStep ?? '-'} | ${inst} | ${CrossAgentOrchestrator.redactUrl(primary.url)} | ${CrossAgentOrchestrator.truncate(primary.description, 100)} |\n`;
      }
      // Broken links
      brokenLinks.forEach((b: any, i: number) => {
        const id = `BL-${String(i + 1).padStart(3, '0')}`;
        md += `| 🌐 NAV | ${id} | BROKEN_LINK | 🔴 P1 | - | 1 | ${CrossAgentOrchestrator.redactUrl(b.url)} | ${CrossAgentOrchestrator.truncate(b.error, 100)} |\n`;
      });
      // Console errors
      consoleErrors.forEach((e: any, i: number) => {
        const id = `CE-${String(i + 1).padStart(3, '0')}`;
        md += `| 🌐 NAV | ${id} | CONSOLE_ERROR | 🔴 P1 | - | 1 | ${CrossAgentOrchestrator.redactUrl(e.url)} | ${CrossAgentOrchestrator.truncate(e.message, 100)} |\n`;
      });
      md += `\n`;
    }

    md += `## 🌐 Application Navigation Architecture\n\n`;
    md += `Navigation Agent discovered page transitions during mapping:\n\n`;
    md += `\`\`\`mermaid\n${mermaid}\`\`\`\n\n`;

    // UI defect cards
    md += `## 🎨 UI/UX Defects\n\n`;
    if (uiGroups.size === 0) {
      md += `✅ *No visual formatting or responsiveness defects logged.*\n\n`;
    } else {
      for (const bugs of uiGroups.values()) {
        const primary: any = bugs[0]!;
        const inst = bugs.length;
        md += `### <a id="defect-${primary.id.toLowerCase()}"></a>${primary.id} — ${primary.issueType} (${CrossAgentOrchestrator.severityBadge(primary.severity)})`;
        if (inst > 1) md += ` — ${inst} instances`;
        md += `\n\n`;
        md += `**Where**: ${CrossAgentOrchestrator.redactUrl(primary.url)}\n\n`;
        md += `**Element**: \`${primary.elementSelector}\`\n\n`;
        md += `**Description**: ${primary.description}\n\n`;
        if (inst > 1) {
          md += `**All instances** (grouped by element + page + issue type):\n\n`;
          md += `| Instance ID | Step | Selector |\n`;
          md += `| --- | --- | --- |\n`;
          bugs.forEach((b: any) => {
            md += `| ${b.id} | ${b.detectedAtStep ?? '-'} | \`${CrossAgentOrchestrator.truncate(b.elementSelector, 80)}\` |\n`;
          });
          md += `\n`;
        }
      }
    }

    // Security defect cards
    md += `## 🛡️ Security Findings\n\n`;
    if (secGroups.size === 0) {
      md += `✅ *No input validation or boundary issues logged.*\n\n`;
    } else {
      for (const findings of secGroups.values()) {
        const primary: any = findings[0]!;
        const inst = findings.length;
        md += `### <a id="defect-${primary.id.toLowerCase()}"></a>${primary.id} — ${primary.type || 'INPUT_VALIDATION'} (${CrossAgentOrchestrator.severityBadge(primary.severity)})`;
        if (inst > 1) md += ` — ${inst} instances`;
        md += `\n\n`;
        md += `**Where**: ${CrossAgentOrchestrator.redactUrl(primary.url)}\n\n`;
        md += `**Element**: \`${primary.elementSelector}\`\n\n`;
        md += `**Description**: ${primary.description}\n\n`;
        if (inst > 1) {
          md += `**All instances**:\n\n`;
          md += `| Instance ID | Step | Selector |\n`;
          md += `| --- | --- | --- |\n`;
          findings.forEach((f: any) => {
            md += `| ${f.id} | ${f.detectedAtStep ?? '-'} | \`${CrossAgentOrchestrator.truncate(f.elementSelector, 80)}\` |\n`;
          });
          md += `\n`;
        }
      }
    }

    // Site integrity
    md += `## 📑 Site Integrity\n\n`;
    if (brokenLinks.length === 0 && consoleErrors.length === 0) {
      md += `✅ *No broken links or console errors during navigation mapping.*\n\n`;
    } else {
      if (brokenLinks.length > 0) {
        md += `### Broken links\n\n`;
        md += `| Target | Source page | Error |\n`;
        md += `| --- | --- | --- |\n`;
        brokenLinks.forEach((b: any) => {
          md += `| ${CrossAgentOrchestrator.redactUrl(b.url)} | ${b.parentUrl.replace(this.baseUrl, '/')} | ${CrossAgentOrchestrator.truncate(b.error, 200)} |\n`;
        });
        md += `\n`;
      }
      if (consoleErrors.length > 0) {
        md += `### Console errors\n\n`;
        md += `| Page | Message | Timestamp |\n`;
        md += `| --- | --- | --- |\n`;
        consoleErrors.forEach((e: any) => {
          md += `| ${CrossAgentOrchestrator.redactUrl(e.url)} | ${CrossAgentOrchestrator.truncate(e.message, 200)} | ${e.timestamp} |\n`;
        });
        md += `\n`;
      }
    }

    fs.writeFileSync(reportPath, md, 'utf-8');
    console.log(`\n📝 Executive report saved to: ${reportPath}`);

    return {
      targetUrl: this.baseUrl,
      totalVisitedPages: visitedPages.length,
      sitemapMermaid: mermaid,
      brokenLinks,
      consoleErrors,
      uiBugs,
      securityObservations: securityFindings,
    };
  }
}
