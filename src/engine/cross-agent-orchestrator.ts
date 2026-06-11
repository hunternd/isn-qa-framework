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

  private async compileExecutiveReport(navState: any, uiRunner: any, secRunner: any): Promise<CoordinatedQAResult> {
    const reportDir = path.resolve(process.cwd(), 'reports');
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = path.join(reportDir, `executive_qa_report_${timestamp}.md`);

    // Compile values
    const visitedPages = navState.visitedUrls;
    const brokenLinks = navState.brokenLinks;
    const consoleErrors = (navOrchestratorInstance: any) => {
      // Gather errors from orchestrator listeners
      return (navOrchestratorInstance as any).consoleErrors || [];
    };
    
    // Access logs from runners using internal fields
    const uiBugs = (uiRunner as any).bugsLogged || [];
    const securityObservations = (secRunner as any).securityFindings || [];

    // Sitemap Mermaid compilation
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

    // Build markdown
    let md = `# 📊 Coordinated QA Executive Report\n\n`;
    md += `## 📋 Run Information\n`;
    md += `- **Date**: ${new Date().toLocaleString()}\n`;
    md += `- **Target Host**: [${this.baseUrl}](${this.baseUrl})\n`;
    md += `- **Site Map Mapped Pages**: ${visitedPages.length}\n`;
    md += `- **Broken Link Health Errors**: ${brokenLinks.length === 0 ? '✅ 0 Errors' : `❌ ${brokenLinks.length} Broken Link(s)`}\n`;
    md += `- **Visual/UX Issues Logged**: ${uiBugs.length === 0 ? '✅ 0 Issues' : `⚠️ ${uiBugs.length} Layout Observation(s)`}\n`;
    md += `- **Security Audit Logs**: ${securityObservations.length === 0 ? '✅ 0 Vulnerabilities' : `🛡️ ${securityObservations.length} Observation(s)`}\n\n`;

    md += `## 🌐 Application Navigation Architecture\n`;
    md += `The Navigation Agent discovered page transitions and mapped the site structure:\n\n`;
    md += `\`\`\`mermaid\n${mermaid}\`\`\`\n\n`;

    md += `## 🐞 UI/UX & Formatting Audit Summary\n`;
    if (uiBugs.length === 0) {
      md += `✅ *No visual formatting or responsiveness bugs were logged in this session.*\n\n`;
    } else {
      md += `| Page | Element Selector | Issue Type | Description |\n`;
      md += `| --- | --- | --- | --- |\n`;
      uiBugs.forEach((bug: any) => {
        md += `| ${bug.url.replace(this.baseUrl, '/')} | \`${bug.elementSelector}\` | **${bug.issueType.toUpperCase()}** | ${bug.description} |\n`;
      });
      md += `\n`;
    }

    md += `## 🛡️ Input Sanitization & Security Validation Audit\n`;
    if (securityObservations.length === 0) {
      md += `✅ *No input validation vulnerabilities or boundary issues were logged during this audit.*\n\n`;
    } else {
      md += `| Page | Field Selector | Severity | Audit Observations |\n`;
      md += `| --- | --- | --- | --- |\n`;
      securityObservations.forEach((sec: any) => {
        md += `| ${sec.url.replace(this.baseUrl, '/')} | \`${sec.elementSelector}\` | **${sec.severity.toUpperCase()}** | ${sec.description} |\n`;
      });
      md += `\n`;
    }

    md += `## 📑 Site Integrity & Health Check\n`;
    md += `### Broken Links\n`;
    if (brokenLinks.length === 0) {
      md += `✅ *Zero broken links encountered.*\n\n`;
    } else {
      md += `| Target Link | Source Page | Error Details |\n`;
      md += `| --- | --- | --- |\n`;
      brokenLinks.forEach((b: any) => {
        md += `| ${b.url} | ${b.parentUrl.replace(this.baseUrl, '/')} | ${b.error} |\n`;
      });
      md += `\n`;
    }

    fs.writeFileSync(reportPath, md, 'utf-8');
    console.log(`\n📝 Executive report successfully generated and saved to: ${reportPath}`);

    return {
      targetUrl: this.baseUrl,
      totalVisitedPages: visitedPages.length,
      sitemapMermaid: mermaid,
      brokenLinks,
      consoleErrors: [],
      uiBugs,
      securityObservations,
    };
  }
}
