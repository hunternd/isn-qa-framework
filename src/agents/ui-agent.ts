import Anthropic from '@anthropic-ai/sdk';
import type { PageContent } from '../tools/navigation.js';
import * as dotenv from 'dotenv';
import { DEFAULT_MODEL } from './config.js';

dotenv.config();

export interface UIAgentDecision {
  thought: string;
  action: 'CLICK' | 'BACK' | 'RESIZE_VIEWPORT' | 'LOG_BUG' | 'FINISH';
  target: string | null;
  params?: any;
}

export class UIAgent {
  private anthropic: Anthropic | null = null;
  private model: string;
  private isMockMode: boolean = false;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey.startsWith('dummy')) {
      console.log('🤖 Anthropic API key not detected or is dummy. Running UI/UX Agent in local MOCK/CRAWLER mode.');
      this.isMockMode = true;
    } else {
      this.anthropic = new Anthropic({ apiKey });
    }
    this.model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  }

  async decideNextAction(
    visitedUrls: string[],
    pageContent: PageContent,
    currentViewport: { width: number; height: number },
    stepsRemaining: number,
    clickedSelectors: string[] = [],
    visitedSections: string[] = [],
    visitedViewports: Array<{ width: number; height: number }> = [],
    urlStreak: number = 0,
    bugsLogged: any[] = []
  ): Promise<UIAgentDecision> {
    if (this.isMockMode) {
      return this.decideMockAction(visitedUrls, pageContent, currentViewport, clickedSelectors, visitedSections);
    }

    try {
      if (!this.anthropic) {
        throw new Error('Anthropic client is not initialized.');
      }

      const KNOWN_SECTIONS = ['home', 'newsletters', 'insights', 'news', 'about', 'contact', 'privacy-policy', 'terms-of-use'];
      const unvisitedSections = KNOWN_SECTIONS.filter(s => !visitedSections.includes(s));
      const STANDARD_VIEWPORTS = [
        { name: 'mobile', width: 375, height: 812 },
        { name: 'tablet', width: 768, height: 1024 },
        { name: 'desktop', width: 1280, height: 800 },
      ];
      const visitedViewportLabels = STANDARD_VIEWPORTS
        .filter(v => visitedViewports.some(vv => vv.width === v.width && vv.height === v.height))
        .map(v => v.name);
      const unvisitedViewportLabels = STANDARD_VIEWPORTS
        .filter(v => !visitedViewports.some(vv => vv.width === v.width && vv.height === v.height))
        .map(v => v.name);
      const currentSection = (() => {
        try {
          const u = new URL(pageContent.url);
          const segs = u.pathname.split('/').filter(s => s.length > 0);
          return segs.length === 0 ? 'home' : segs[0]!;
        } catch {
          return 'unknown';
        }
      })();

      const response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 1000,
        system: `You are a QA designer inspecting https://www.independentsponsor.news/ for layout, responsiveness, and accessibility defects that real users will hit. Your job is BREADTH-FIRST visual coverage — touch many surfaces at multiple viewports rather than deeply auditing one.

Coverage targets for this audit:
- Visit at least 2 different sections (newsletters, insights, about, contact, etc.).
- Test at least 2 different viewports (mobile 375×812, tablet 768×1024, desktop 1280×800).
- After auditing 1–2 elements in a section at a viewport, MOVE to a different section or a different viewport rather than dwelling.

Hard constraints (the runner will override you if you violate these):
- NEVER pick a selector that already appears in "Already clicked selectors". The runner will substitute a fresh one and log a loop-breaker warning.
- If urlStreak >= 1 your last click did not navigate; pick a link to a DIFFERENT section, resize the viewport, or use goBack.
- Avoid selectors with class names suggesting hidden nav dropdowns (e.g. classes containing "dropdown" or "nav-menu"). Prefer direct links in the page body.

What to look for (be opportunistic):
- Overlapping or clipped text and images at the current viewport.
- Navigation that obscures content (sticky bars, modals not dismissing, dropdowns covering buttons).
- Elements that visibly break at mobile widths — buttons running off-screen, text wrapping awkwardly, images stretched.
- Low-contrast text against background, missing alt text, missing aria-labels on icon-only buttons.
- Forms with broken alignment or labels that don't associate with their inputs.

Use logLayoutBug for any of the above. Don't bother re-logging duplicates — that list is provided.

Use resizeViewport to switch to an unvisited viewport when coverage is uneven. When 2+ sections × 2+ viewports have been touched and remaining steps are low, use finish with a summary.`,
        messages: [
          {
            role: 'user',
            content: `Current page URL: ${pageContent.url}
Current section: ${currentSection}
Current viewport: ${currentViewport.width}x${currentViewport.height}
Page title: ${pageContent.title}
Steps remaining: ${stepsRemaining}
URL streak: ${urlStreak} (consecutive prior steps ending at the SAME URL — if >= 1, your last click didn't navigate)

Coverage so far:
- Sections visited: ${JSON.stringify(visitedSections)}
- Likely-unvisited sections: ${JSON.stringify(unvisitedSections)}
- Viewports tested: ${JSON.stringify(visitedViewportLabels)}
- Viewports not yet tested: ${JSON.stringify(unvisitedViewportLabels)}
- Distinct selectors clicked: ${clickedSelectors.length}

Already clicked selectors (DO NOT re-pick; runner will reject):
${JSON.stringify(clickedSelectors, null, 2)}

Already logged layout defects (do not re-log):
${JSON.stringify(bugsLogged.map((b: any) => ({ id: b.id, issueType: b.issueType, selector: b.elementSelector })), null, 2)}

Interactive elements on this page (pick from these for click, or use resizeViewport / goBack / finish):
${JSON.stringify(pageContent.interactiveElements.map(el => ({
  tag: el.tagName,
  text: el.text,
  selector: el.selector,
})), null, 2)}

Pick the next action. Strongly prefer (1) resizing to an unvisited viewport if any remain, (2) navigating to an unvisited section, or (3) logging a real layout defect you observe.`
          }
        ],
        tools: [
          {
            name: 'click',
            description: 'Click an element using its CSS selector.',
            input_schema: {
              type: 'object',
              properties: {
                selector: { type: 'string', description: 'The CSS selector of the element.' }
              },
              required: ['selector']
            }
          },
          {
            name: 'resizeViewport',
            description: 'Resize the browser viewport to test responsiveness.',
            input_schema: {
              type: 'object',
              properties: {
                width: { type: 'number', description: 'Width of the viewport in pixels.' },
                height: { type: 'number', description: 'Height of the viewport in pixels.' }
              },
              required: ['width', 'height']
            }
          },
          {
            name: 'logLayoutBug',
            description: 'Log a specific UI/UX/Formatting bug you discovered.',
            input_schema: {
              type: 'object',
              properties: {
                elementSelector: { type: 'string', description: 'The CSS selector of the bug-ridden element.' },
                issueType: { type: 'string', enum: ['overlap', 'responsiveness', 'contrast', 'alignment', 'other'], description: 'The type of layout issue.' },
                description: { type: 'string', description: 'Detailed description of the bug.' }
              },
              required: ['elementSelector', 'issueType', 'description']
            }
          },
          {
            name: 'goBack',
            description: 'Go back to the previous page in history.',
            input_schema: {
              type: 'object',
              properties: {}
            }
          },
          {
            name: 'finish',
            description: 'Finish UI/UX inspection.',
            input_schema: {
              type: 'object',
              properties: {
                summary: { type: 'string', description: 'A brief summary of your visual findings.' }
              },
              required: ['summary']
            }
          }
        ]
      });

      const textBlocks = response.content.filter(b => b.type === 'text');
      const thought = textBlocks.map(t => t.type === 'text' ? t.text : '').join(' ').trim() || 'Analyzing UI/UX components.';

      const toolCall = response.content.find(b => b.type === 'tool_use');
      if (!toolCall || toolCall.type !== 'tool_use') {
        return { thought, action: 'FINISH', target: 'No tool called by UI agent.' };
      }

      const toolName = toolCall.name;
      const toolInput = toolCall.input as any;

      if (toolName === 'click') {
        return { thought, action: 'CLICK', target: toolInput.selector };
      } else if (toolName === 'resizeViewport') {
        return { thought, action: 'RESIZE_VIEWPORT', target: null, params: { width: toolInput.width, height: toolInput.height } };
      } else if (toolName === 'logLayoutBug') {
        return { thought, action: 'LOG_BUG', target: toolInput.elementSelector, params: { issueType: toolInput.issueType, description: toolInput.description } };
      } else if (toolName === 'goBack') {
        return { thought, action: 'BACK', target: null };
      } else {
        return { thought, action: 'FINISH', target: toolInput.summary || 'Finished UI/UX analysis.' };
      }

    } catch (err: any) {
      console.error('LLM UI Agent API error, falling back to local crawler logic:', err.message || err);
      return this.decideMockAction(visitedUrls, pageContent, currentViewport, clickedSelectors, visitedSections);
    }
  }

  private decideMockAction(
    visitedUrls: string[],
    pageContent: PageContent,
    currentViewport: { width: number; height: number },
    clickedSelectors: string[] = [],
    visitedSections: string[] = []
  ): UIAgentDecision {
    // In mock mode, we want to simulate resizing and inspecting
    // E.g. if we are in desktop (1280x800), let's resize to mobile (375x812) to test responsiveness
    if (currentViewport.width > 500) {
      return {
        thought: 'Local mock decision: Resize to mobile viewport to test site responsiveness.',
        action: 'RESIZE_VIEWPORT',
        target: null,
        params: { width: 375, height: 812 }
      };
    }

    // Now log a layout observation mock bug
    if (pageContent.url.includes('/about')) {
      return {
        thought: 'Local mock decision: Log a potential UX formatting observation about font scaling in mobile view.',
        action: 'LOG_BUG',
        target: '.w-container',
        params: {
          issueType: 'responsiveness',
          description: 'Observed container margins have narrow padding in mobile viewports (375px).'
        }
      };
    }

    // Otherwise pick a fresh link to an unvisited section, skipping anything
    // already clicked (matches the loop-breaker contract used by the runner).
    const sectionFromHref = (href: string): string => {
      try {
        const u = new URL(href, pageContent.url);
        const segs = u.pathname.split('/').filter(s => s.length > 0);
        return segs.length === 0 ? 'home' : segs[0]!;
      } catch {
        return 'unknown';
      }
    };
    const candidate = pageContent.interactiveElements.find(el => {
      if (el.tagName !== 'a') return false;
      if (clickedSelectors.includes(el.selector)) return false;
      const hrefMatch = el.selector.match(/href="([^"]+)"/);
      const href = hrefMatch?.[1] || '';
      if (!href || href.startsWith('#') || /^https?:\/\//.test(href)) return false;
      return !visitedSections.includes(sectionFromHref(href));
    });
    if (candidate) {
      return {
        thought: `Local mock decision: navigate into an unvisited section via "${candidate.text || candidate.selector}".`,
        action: 'CLICK',
        target: candidate.selector,
      };
    }

    return {
      thought: 'Local mock decision: Completed basic UI/UX responsive inspections.',
      action: 'FINISH',
      target: 'Completed mock UI/UX checks.'
    };
  }
}
