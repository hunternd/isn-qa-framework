import type { Page } from '@playwright/test';
import { navigate, clickElement, readPageContent, takeScreenshot } from '../tools/index.js';
import { detectAuthState, type AuthSnapshot } from './session.js';
import type {
  Scenario,
  Step,
  ContentKind,
  ScenarioResult,
  ScenarioStepResult,
  AuthSnapshotSummary,
} from '../scenarios/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

// Maps each content kind to a regex matched against an anchor's href.
const KIND_HREF_MATCHERS: Record<ContentKind, RegExp> = {
  newsletter: /\/newsletters\//,
  insight: /\/insights\//,
  'any-article': /\/(newsletters|insights)\//,
  external: /^https?:\/\//,
};

export class ScenarioRunner {
  private page: Page;
  private baseUrl: string;

  constructor(page: Page, baseUrl: string) {
    this.page = page;
    this.baseUrl = baseUrl;
  }

  async runScenario(scenario: Scenario): Promise<ScenarioResult> {
    const start = Date.now();
    const stepResults: ScenarioStepResult[] = [];

    // Initial navigation so we have a real URL to authenticate against.
    await navigate(this.page, '/');

    // Pre-flight auth if the scenario requires it.
    if (scenario.requiresAuth) {
      const ensured = await this.ensureAuth();
      if (!ensured) {
        const stepResult: ScenarioStepResult = {
          step: 0,
          kind: 'ensureAuth',
          description: 'Pre-flight authentication',
          status: 'fail',
          url: this.page.url(),
          error: 'Could not authenticate (missing creds, login flow broken, or detector returned unauthenticated after submit).',
        };
        const result: ScenarioResult = {
          scenarioId: scenario.id,
          description: scenario.description,
          status: 'fail',
          totalSteps: scenario.steps.length,
          stepsExecuted: 0,
          failedAtStep: 0,
          stepResults: [stepResult],
          durationMs: Date.now() - start,
        };
        result.reportPath = await this.saveReport(scenario, result);
        return result;
      }
    }

    let stepsExecuted = 0;
    let failedAtStep: number | null = null;
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i]!;
      const stepNumber = i + 1;
      stepsExecuted = stepNumber;
      const stepResult = await this.executeStep(step, stepNumber, scenario.id);
      stepResults.push(stepResult);
      if (stepResult.status === 'fail') {
        failedAtStep = stepNumber;
        break;
      }
    }

    const status: 'pass' | 'fail' = failedAtStep === null ? 'pass' : 'fail';
    const result: ScenarioResult = {
      scenarioId: scenario.id,
      description: scenario.description,
      status,
      totalSteps: scenario.steps.length,
      stepsExecuted,
      failedAtStep,
      stepResults,
      durationMs: Date.now() - start,
    };
    result.reportPath = await this.saveReport(scenario, result);
    return result;
  }

  private async executeStep(step: Step, stepNumber: number, scenarioId: string): Promise<ScenarioStepResult> {
    try {
      if ('goto' in step) {
        const res = await navigate(this.page, step.goto);
        await this.page.waitForTimeout(800);
        const screenshot = await this.snap(scenarioId, stepNumber, `goto_${step.goto.replace(/[^a-z0-9]/gi, '_')}`);
        if (!res.success) {
          return this.fail(stepNumber, 'goto', `Navigate to ${step.goto}`, res.error || 'navigate failed', screenshot);
        }
        return this.pass(stepNumber, 'goto', `Navigate to ${step.goto}`, screenshot);
      }

      if ('click' in step) {
        const matched = await this.findByKind(step.click.kind, step.click.nth ?? 1);
        if (!matched) {
          const screenshot = await this.snap(scenarioId, stepNumber, `click_${step.click.kind}_nth${step.click.nth ?? 1}_NOMATCH`);
          return this.fail(
            stepNumber,
            'click',
            `Click ${step.click.kind} #${step.click.nth ?? 1}`,
            `No matching ${step.click.kind} link found on page (need at least ${step.click.nth ?? 1}).`,
            screenshot,
          );
        }
        const res = await clickElement(this.page, matched.selector);
        await this.page.waitForTimeout(1500);
        const screenshot = await this.snap(scenarioId, stepNumber, `click_${step.click.kind}_nth${step.click.nth ?? 1}`);
        if (!res.success) {
          return this.fail(
            stepNumber,
            'click',
            `Click ${step.click.kind} #${step.click.nth ?? 1} ("${matched.text}")`,
            res.error || 'click failed',
            screenshot,
          );
        }
        return this.pass(
          stepNumber,
          'click',
          `Click ${step.click.kind} #${step.click.nth ?? 1} ("${matched.text}") → ${this.page.url()}`,
          screenshot,
        );
      }

      if ('clickSelector' in step) {
        const res = await clickElement(this.page, step.clickSelector);
        await this.page.waitForTimeout(1500);
        const screenshot = await this.snap(scenarioId, stepNumber, `clickSelector`);
        if (!res.success) {
          return this.fail(stepNumber, 'clickSelector', `Click selector "${step.clickSelector}"`, res.error || 'click failed', screenshot);
        }
        return this.pass(stepNumber, 'clickSelector', `Click selector "${step.clickSelector}" → ${this.page.url()}`, screenshot);
      }

      if ('clickDirect' in step) {
        // Invoke .click() on the matched element directly via page.evaluate.
        // For anchors, this triggers navigation as if the user clicked.
        const urlBefore = this.page.url();
        const found = await this.page.evaluate((sel) => {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (!el) return { ok: false, reason: 'no element' };
          el.click();
          return { ok: true, reason: '' };
        }, step.clickDirect);
        await this.page.waitForTimeout(1500);
        const screenshot = await this.snap(scenarioId, stepNumber, `clickDirect`);
        if (!found.ok) {
          return this.fail(stepNumber, 'clickDirect', `Direct click on "${step.clickDirect}"`, `Element not found: ${found.reason}`, screenshot);
        }
        return this.pass(
          stepNumber,
          'clickDirect',
          `Direct click on "${step.clickDirect}" (${urlBefore} → ${this.page.url()})`,
          screenshot,
        );
      }

      if ('hoverThenClick' in step) {
        const { hover, click } = step.hoverThenClick;
        try {
          // Raw mouse path. The flow:
          //   1. Move cursor to the hover target's center (opens Webflow
          //      dropdown via CSS :hover).
          //   2. Wait briefly for the open animation.
          //   3. Re-resolve the click target's bbox AFTER the dropdown is
          //      open — before hover it has 0×0 layout, so locator.click()
          //      can't find a clickable area.
          //   4. Move smoothly to the new bbox (steps: 5) so the cursor stays
          //      within the dropdown wrapper and :hover doesn't drop.
          //   5. Click via mouse.down + mouse.up at the final coords.
          const hoverSel = hover.includes(':visible') ? hover : `${hover}:visible`;
          const hoverBox = await this.page.locator(hoverSel).first().boundingBox();
          if (!hoverBox) throw new Error(`Hover target "${hover}" has no bounding box.`);
          await this.page.mouse.move(hoverBox.x + hoverBox.width / 2, hoverBox.y + hoverBox.height / 2);
          await this.page.waitForTimeout(400);
          const clickBox = await this.page.locator(click).first().boundingBox();
          if (!clickBox || clickBox.width === 0 || clickBox.height === 0) {
            throw new Error(`Click target "${click}" still has zero layout after hover — dropdown did not open.`);
          }
          await this.page.mouse.move(clickBox.x + clickBox.width / 2, clickBox.y + clickBox.height / 2, { steps: 5 });
          await this.page.mouse.down();
          await this.page.mouse.up();
          await this.page.waitForTimeout(1800);
        } catch (err: any) {
          const screenshot = await this.snap(scenarioId, stepNumber, 'hoverThenClick_FAILED');
          return this.fail(
            stepNumber,
            'hoverThenClick',
            `Hover "${hover}" then click "${click}"`,
            err.message || String(err),
            screenshot,
          );
        }
        const screenshot = await this.snap(scenarioId, stepNumber, 'hoverThenClick');
        return this.pass(
          stepNumber,
          'hoverThenClick',
          `Hover "${hover}" then click "${click}" → ${this.page.url()}`,
          screenshot,
        );
      }

      if ('hoverSelector' in step) {
        try {
          // Prefer the visible variant so we don't try to hover an off-screen
          // duplicate (same trick the click tool uses).
          const sel = step.hoverSelector.includes(':visible') ? step.hoverSelector : `${step.hoverSelector}:visible`;
          await this.page.locator(sel).first().hover({ timeout: 5000 });
          // Give the dropdown animation time to expand and its child links to
          // become visible to subsequent click steps.
          await this.page.waitForTimeout(700);
        } catch (err: any) {
          const screenshot = await this.snap(scenarioId, stepNumber, 'hoverSelector_FAILED');
          return this.fail(stepNumber, 'hoverSelector', `Hover selector "${step.hoverSelector}"`, err.message || String(err), screenshot);
        }
        const screenshot = await this.snap(scenarioId, stepNumber, 'hoverSelector');
        return this.pass(stepNumber, 'hoverSelector', `Hover selector "${step.hoverSelector}"`, screenshot);
      }

      if ('back' in step) {
        try {
          await this.page.goBack();
          await this.page.waitForTimeout(700);
          // SPAs like Webflow tabs listen to hashchange on initial nav but the
          // back-button typically doesn't replay the event, so a `back` to a
          // hash-anchored URL leaves the page on whatever tab was last active
          // rather than the one named in the hash. Re-fire the event so the
          // tab content lines up with the URL.
          const url = this.page.url();
          if (/#./.test(url)) {
            await this.page.evaluate(() => {
              window.dispatchEvent(new HashChangeEvent('hashchange', {
                oldURL: '',
                newURL: window.location.href,
              }));
            }).catch(() => null);
            await this.page.waitForTimeout(500);
          }
        } catch (err: any) {
          const screenshot = await this.snap(scenarioId, stepNumber, 'back_FAILED');
          return this.fail(stepNumber, 'back', 'Browser back', err.message || String(err), screenshot);
        }
        const screenshot = await this.snap(scenarioId, stepNumber, 'back');
        return this.pass(stepNumber, 'back', `Browser back → ${this.page.url()}`, screenshot);
      }

      if ('ensureAuth' in step) {
        const ok = await this.ensureAuth();
        const screenshot = await this.snap(scenarioId, stepNumber, ok ? 'ensureAuth' : 'ensureAuth_FAILED');
        if (!ok) return this.fail(stepNumber, 'ensureAuth', 'Ensure authenticated', 'Could not authenticate.', screenshot);
        return this.pass(stepNumber, 'ensureAuth', 'Ensure authenticated', screenshot);
      }

      if ('verify' in step) {
        if (step.verify === 'still-authenticated') {
          const snapshot = await detectAuthState(this.page);
          const screenshot = await this.snap(scenarioId, stepNumber, 'verify_authenticated');
          const summary = this.summarizeSnapshot(snapshot);
          if (snapshot.state !== 'authenticated') {
            return {
              step: stepNumber,
              kind: 'verify',
              description: 'Verify still authenticated',
              status: 'fail',
              url: this.page.url(),
              authSnapshot: summary,
              error: `Auth state is "${snapshot.state}" (expected "authenticated"). loginTrigger: ${snapshot.loginTriggerVisible}, loginModal: ${snapshot.loginModalVisible}, cookies: ${snapshot.outsetaCookieCount}, localStorage: ${snapshot.outsetaLocalStorageKeyCount}.`,
              screenshot,
            };
          }
          return {
            step: stepNumber,
            kind: 'verify',
            description: 'Verify still authenticated',
            status: 'pass',
            url: this.page.url(),
            authSnapshot: summary,
            screenshot,
          };
        }
      }

      return this.fail(stepNumber, 'unknown', 'Unknown step kind', `Unhandled step shape: ${JSON.stringify(step)}`);
    } catch (err: any) {
      return this.fail(stepNumber, 'error', `Step ${stepNumber} threw`, err.message || String(err));
    }
  }

  private summarizeSnapshot(s: AuthSnapshot): AuthSnapshotSummary {
    return {
      state: s.state,
      outsetaCookieCount: s.outsetaCookieCount,
      outsetaLocalStorageKeyCount: s.outsetaLocalStorageKeyCount,
      loginTriggerVisible: s.loginTriggerVisible,
      loginModalVisible: s.loginModalVisible,
      authIndicatorVisible: s.authIndicatorVisible,
    };
  }

  private pass(step: number, kind: string, description: string, screenshot?: string): ScenarioStepResult {
    return { step, kind, description, status: 'pass', url: this.page.url(), screenshot };
  }

  private fail(step: number, kind: string, description: string, error: string, screenshot?: string): ScenarioStepResult {
    return { step, kind, description, status: 'fail', url: this.page.url(), error, screenshot };
  }

  private async snap(scenarioId: string, stepNumber: number, label: string): Promise<string | undefined> {
    const name = `scenario_${scenarioId}_step${String(stepNumber).padStart(2, '0')}_${label}`;
    const res = await takeScreenshot(this.page, name).catch(() => null);
    return res?.success ? res.filePath : undefined;
  }

  private async findByKind(kind: ContentKind, nth: number): Promise<{ selector: string; text: string } | null> {
    const content = await readPageContent(this.page);
    const pattern = KIND_HREF_MATCHERS[kind];
    const matches = content.interactiveElements.filter(el => {
      if (el.tagName !== 'a') return false;
      const hrefMatch = el.selector.match(/href="([^"]+)"/);
      if (!hrefMatch || !hrefMatch[1]) return false;
      return pattern.test(hrefMatch[1]);
    });
    if (matches.length < nth) return null;
    const pick = matches[nth - 1]!;
    return { selector: pick.selector, text: (pick.text ?? '').trim() };
  }

  // Mirrors the auth-flow logic in src/engine/auth.ts but used in-place during
  // a scenario rather than as a session-state pre-step.
  private async ensureAuth(): Promise<boolean> {
    const before = await detectAuthState(this.page);
    if (before.state === 'authenticated') return true;

    const email = process.env.QA_USER_EMAIL || '';
    const password = process.env.QA_USER_PASSWORD || '';
    if (!email || !password) return false;

    try {
      // Click the visible login trigger if the modal isn't already shown.
      if (!before.loginModalVisible) {
        const trigger = this.page.locator('a[href*="widgetMode=login"]:visible').first();
        if (await trigger.count() > 0) {
          await trigger.click({ timeout: 4000 }).catch(() => null);
        }
      }
      await this.page.locator('#o-auth-username').waitFor({ state: 'visible', timeout: 6000 });
      await this.page.locator('#o-auth-username').fill(email);
      await this.page.locator('#o-auth-password').fill(password);
      const submit = this.page.locator('button.o--Button--btn').filter({ hasText: /login|log in|sign in/i }).first();
      await submit.click();
      await this.page.locator('#o-auth-username').waitFor({ state: 'hidden', timeout: 12000 });
      await this.page.waitForTimeout(1500);
      const after = await detectAuthState(this.page);
      return after.state === 'authenticated';
    } catch {
      return false;
    }
  }

  private async saveReport(scenario: Scenario, result: ScenarioResult): Promise<string> {
    const reportDir = path.resolve(process.cwd(), 'reports');
    if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = path.join(reportDir, `scenario_report_${scenario.id}_${ts}.md`);

    const passed = result.stepResults.filter(r => r.status === 'pass').length;
    const failed = result.stepResults.filter(r => r.status === 'fail').length;

    let md = `# Scenario Report — ${scenario.id}\n\n`;
    md += `- **Description**: ${scenario.description}\n`;
    md += `- **Status**: ${result.status === 'pass' ? '✅ PASS' : '❌ FAIL'}\n`;
    md += `- **Duration**: ${(result.durationMs / 1000).toFixed(1)}s\n`;
    md += `- **Steps**: ${passed}/${result.totalSteps} passed${failed ? `, ${failed} failed` : ''}`;
    if (result.failedAtStep !== null) md += ` (failed at step ${result.failedAtStep})`;
    md += `\n`;
    md += `- **Date**: ${new Date().toLocaleString()}\n\n`;

    md += `## Step results\n\n`;
    md += `| # | Status | Kind | Description | URL |\n`;
    md += `| --- | --- | --- | --- | --- |\n`;
    for (const r of result.stepResults) {
      const status = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '⏭️';
      md += `| ${r.step} | ${status} | ${r.kind} | ${r.description} | ${r.url} |\n`;
    }
    md += `\n`;

    const failures = result.stepResults.filter(r => r.status === 'fail');
    if (failures.length > 0) {
      md += `## ❌ Failures\n\n`;
      for (const f of failures) {
        md += `### Step ${f.step} — ${f.kind}\n\n`;
        md += `- **URL at failure**: ${f.url}\n`;
        md += `- **Error**: ${f.error || '(none)'}\n`;
        if (f.authSnapshot) {
          md += `- **Auth snapshot**: state=\`${f.authSnapshot.state}\`, loginTrigger=${f.authSnapshot.loginTriggerVisible}, loginModal=${f.authSnapshot.loginModalVisible}, cookies=${f.authSnapshot.outsetaCookieCount}, localStorage=${f.authSnapshot.outsetaLocalStorageKeyCount}, authIndicator=${f.authSnapshot.authIndicatorVisible}\n`;
        }
        if (f.screenshot) md += `- **Screenshot**: [view](${f.screenshot})\n`;
        md += `\n`;
      }
    }

    const verifySteps = result.stepResults.filter(r => r.kind === 'verify');
    if (verifySteps.length > 0) {
      md += `## 🔐 Auth checks\n\n`;
      md += `| Step | Status | State | Cookies | localStorage | Login trigger | Login modal | Auth indicator |\n`;
      md += `| --- | --- | --- | --- | --- | --- | --- | --- |\n`;
      for (const v of verifySteps) {
        const status = v.status === 'pass' ? '✅' : '❌';
        const s = v.authSnapshot;
        md += `| ${v.step} | ${status} | ${s?.state ?? '?'} | ${s?.outsetaCookieCount ?? '?'} | ${s?.outsetaLocalStorageKeyCount ?? '?'} | ${s?.loginTriggerVisible ?? '?'} | ${s?.loginModalVisible ?? '?'} | ${s?.authIndicatorVisible ?? '?'} |\n`;
      }
      md += `\n`;
    }

    md += `## 📸 Screenshots\n\n`;
    for (const r of result.stepResults) {
      if (!r.screenshot) continue;
      const status = r.status === 'pass' ? '✅' : '❌';
      md += `- Step ${r.step} ${status} (${r.kind}): [view](${r.screenshot})\n`;
    }

    fs.writeFileSync(reportPath, md, 'utf-8');
    console.log(`📝 Saved scenario report to: ${reportPath}`);
    return reportPath;
  }
}
