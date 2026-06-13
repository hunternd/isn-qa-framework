import Anthropic from '@anthropic-ai/sdk';
import type { PageContent } from '../tools/navigation.js';
import * as dotenv from 'dotenv';

dotenv.config();

export interface SecurityAgentDecision {
  thought: string;
  action: 'TYPE' | 'CLICK' | 'BACK' | 'LOG_SECURITY' | 'FINISH';
  target: string | null;
  params?: any;
}

export class SecurityAgent {
  private anthropic: Anthropic | null = null;
  private model: string;
  private isMockMode: boolean = false;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey.startsWith('dummy')) {
      console.log('🤖 Anthropic API key not detected or is dummy. Running Security Agent in local MOCK/CRAWLER mode.');
      this.isMockMode = true;
    } else {
      this.anthropic = new Anthropic({ apiKey });
    }
    this.model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  }

  async decideNextAction(
    visitedUrls: string[],
    pageContent: PageContent,
    stepsRemaining: number,
    clickedSelectors: string[] = [],
    visitedSections: string[] = [],
    urlStreak: number = 0,
    findingsLogged: any[] = [],
    typedPairs: string[] = []
  ): Promise<SecurityAgentDecision> {
    if (this.isMockMode) {
      return this.decideMockAction(visitedUrls, pageContent, clickedSelectors, visitedSections);
    }

    try {
      if (!this.anthropic) {
        throw new Error('Anthropic client is not initialized.');
      }

      const KNOWN_SECTIONS = ['home', 'newsletters', 'insights', 'news', 'about', 'contact', 'privacy-policy', 'terms-of-use'];
      const unvisitedSections = KNOWN_SECTIONS.filter(s => !visitedSections.includes(s));
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
        system: `You are a QA security auditor inspecting input handling on https://www.independentsponsor.news/. Forms and inputs are scattered across sections (contact, subscribe, search, comment, newsletter signup), so your job is BREADTH-FIRST — find and probe as many distinct input surfaces across the site as you can.

Coverage targets for this audit:
- Visit at least 2 different sections with forms or inputs (contact, subscribe widget, newsletter signup, search, etc.).
- Test at least 2 distinct input fields with non-destructive boundary payloads (invalid email format, oversized strings, basic XSS-style markers like \`<script>\`, SQL-like quotes).
- After auditing the inputs on one page, MOVE to a different section.

Hard constraints (the runner will override you if you violate these):
- NEVER pick a selector that already appears in "Already clicked selectors". The runner will substitute a fresh one.
- NEVER type a (selector, payload) pair that already appears in "Already typed pairs". Same input with a DIFFERENT payload is fine (boundary testing). Same input + same payload is wasted; pick a different input, a different payload, or navigate to a new section. The runner will reject exact repeats.
- NEVER perform destructive actions (do not submit account changes, do not send messages with real-looking content, do not post). Use non-intrusive, clearly-test-only payloads.
- If urlStreak >= 1 your last click did not navigate; pick a link to a DIFFERENT section or use goBack.

What to look for:
- Forms that reveal raw stack traces, server errors, or internal field names when invalid input is submitted.
- Forms that strip dangerous input gracefully vs forms that echo \`<script>\` markers back unescaped into the page.
- Email or URL inputs that accept obviously malformed values without client-side validation.
- Hidden inputs containing sensitive-looking values (tokens, IDs) exposed in the DOM.
- Forms missing CSRF tokens, autocomplete on password-like fields, etc.

Use logSecurity for any of the above. Don't bother re-logging duplicates.

When 2+ sections + 2+ inputs have been probed and remaining steps are low, use finish with a summary.`,
        messages: [
          {
            role: 'user',
            content: `Current page URL: ${pageContent.url}
Current section: ${currentSection}
Page title: ${pageContent.title}
Steps remaining: ${stepsRemaining}
URL streak: ${urlStreak} (consecutive prior steps ending at the SAME URL — if >= 1, your last click didn't navigate)

Coverage so far:
- Sections visited: ${JSON.stringify(visitedSections)}
- Likely-unvisited sections: ${JSON.stringify(unvisitedSections)}
- Distinct selectors clicked: ${clickedSelectors.length}

Already clicked selectors (DO NOT re-pick; runner will reject):
${JSON.stringify(clickedSelectors, null, 2)}

Already typed (selector | payload) pairs (DO NOT repeat exact pairs; runner will reject):
${JSON.stringify(typedPairs, null, 2)}

Already logged security findings (do not re-log):
${JSON.stringify(findingsLogged.map((f: any) => ({ id: f.id, severity: f.severity, selector: f.elementSelector })), null, 2)}

Interactive elements on this page (pick from these for type/click, or use goBack/finish):
${JSON.stringify(pageContent.interactiveElements.map(el => ({
  tag: el.tagName,
  type: el.type,
  text: el.text,
  selector: el.selector,
  placeholder: el.placeholder,
})), null, 2)}

Pick the next action. Strongly prefer (1) typing a boundary payload into an unprobed input on this page, (2) navigating to an unvisited section to find more inputs, or (3) logging a real validation issue you observed.`
          }
        ],
        tools: [
          {
            name: 'type',
            description: 'Type a test string into an input or textarea field.',
            input_schema: {
              type: 'object',
              properties: {
                selector: { type: 'string', description: 'The CSS selector of the input element.' },
                text: { type: 'string', description: 'The payload string to enter (e.g. invalid format or script tag).' }
              },
              required: ['selector', 'text']
            }
          },
          {
            name: 'click',
            description: 'Click an element (such as a form submit button).',
            input_schema: {
              type: 'object',
              properties: {
                selector: { type: 'string', description: 'The CSS selector of the button/link.' }
              },
              required: ['selector']
            }
          },
          {
            name: 'logSecurity',
            description: 'Log a discovered input validation vulnerability or boundary bug.',
            input_schema: {
              type: 'object',
              properties: {
                elementSelector: { type: 'string', description: 'The CSS selector of the audited input field.' },
                severity: { type: 'string', enum: ['low', 'medium', 'high'], description: 'The severity level.' },
                description: { type: 'string', description: 'Describe how the system handled the invalid/unsafe input.' }
              },
              required: ['elementSelector', 'severity', 'description']
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
            description: 'Finish security auditing.',
            input_schema: {
              type: 'object',
              properties: {
                summary: { type: 'string', description: 'A brief summary of your security audit findings.' }
              },
              required: ['summary']
            }
          }
        ]
      });

      const textBlocks = response.content.filter(b => b.type === 'text');
      const thought = textBlocks.map(t => t.type === 'text' ? t.text : '').join(' ').trim() || 'Analyzing security components.';

      const toolCall = response.content.find(b => b.type === 'tool_use');
      if (!toolCall || toolCall.type !== 'tool_use') {
        return { thought, action: 'FINISH', target: 'No tool called by security agent.' };
      }

      const toolName = toolCall.name;
      const toolInput = toolCall.input as any;

      if (toolName === 'type') {
        return { thought, action: 'TYPE', target: toolInput.selector, params: { text: toolInput.text } };
      } else if (toolName === 'click') {
        return { thought, action: 'CLICK', target: toolInput.selector };
      } else if (toolName === 'logSecurity') {
        return { thought, action: 'LOG_SECURITY', target: toolInput.elementSelector, params: { severity: toolInput.severity, description: toolInput.description } };
      } else if (toolName === 'goBack') {
        return { thought, action: 'BACK', target: null };
      } else {
        return { thought, action: 'FINISH', target: toolInput.summary || 'Finished security audit.' };
      }

    } catch (err: any) {
      console.error('LLM Security Agent API error, falling back to local crawler logic:', err.message || err);
      return this.decideMockAction(visitedUrls, pageContent, clickedSelectors, visitedSections);
    }
  }

  private decideMockAction(
    visitedUrls: string[],
    pageContent: PageContent,
    clickedSelectors: string[] = [],
    visitedSections: string[] = [],
  ): SecurityAgentDecision {
    // First try a fresh input on this page (one we haven't typed into yet).
    const inputs = pageContent.interactiveElements.filter(el =>
      ((el.tagName === 'input' && el.type !== 'submit' && el.type !== 'button') || el.tagName === 'textarea')
      && !clickedSelectors.includes(el.selector)
    );

    if (inputs.length > 0 && inputs[0]) {
      const targetInput = inputs[0];
      return {
        thought: `Local mock decision: type a boundary email payload into fresh input "${targetInput.selector}".`,
        action: 'TYPE',
        target: targetInput.selector,
        params: { text: 'test-invalid-email-format' }
      };
    }

    // Try to navigate to an unvisited section — same heuristic as the UI mock.
    const sectionFromHref = (href: string): string => {
      try {
        const u = new URL(href, pageContent.url);
        const segs = u.pathname.split('/').filter(s => s.length > 0);
        return segs.length === 0 ? 'home' : segs[0]!;
      } catch {
        return 'unknown';
      }
    };
    const sectionLink = pageContent.interactiveElements.find(el => {
      if (el.tagName !== 'a') return false;
      if (clickedSelectors.includes(el.selector)) return false;
      const hrefMatch = el.selector.match(/href="([^"]+)"/);
      const href = hrefMatch?.[1] || '';
      if (!href || href.startsWith('#') || /^https?:\/\//.test(href)) return false;
      return !visitedSections.includes(sectionFromHref(href));
    });
    if (sectionLink) {
      return {
        thought: `Local mock decision: navigate to an unvisited section via "${sectionLink.text || sectionLink.selector}" to find more inputs.`,
        action: 'CLICK',
        target: sectionLink.selector,
      };
    }

    return {
      thought: 'Local mock decision: Completed basic security mock audits.',
      action: 'FINISH',
      target: 'Completed mock security audits.'
    };
  }
}
