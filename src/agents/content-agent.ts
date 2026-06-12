import Anthropic from '@anthropic-ai/sdk';
import type { PageContent } from '../tools/navigation.js';
import * as dotenv from 'dotenv';

dotenv.config();

export interface ContentAgentDecision {
  thought: string;
  action: 'CLICK' | 'BACK' | 'LOG_CONTENT_BUG' | 'FINISH';
  target: string | null;
  params?: {
    linkText?: string | undefined;
    expectedTopic?: string | undefined;
    actualTopic?: string | undefined;
    description?: string | undefined;
  };
}

export class ContentAgent {
  private anthropic: Anthropic | null = null;
  private model: string;
  private isMockMode: boolean = false;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey.startsWith('dummy')) {
      console.log('🤖 Anthropic API key not detected or is dummy. Running Content Agent in local MOCK/CRAWLER mode.');
      this.isMockMode = true;
    } else {
      this.anthropic = new Anthropic({ apiKey });
    }
    this.model = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';
  }

  async decideNextAction(
    visitedUrls: string[],
    pageContent: PageContent,
    lastAction: { action: string; selector: string | null; text: string | null } | null,
    stepsRemaining: number,
    bugsLogged: any[] = [],
    clickedSelectors: string[] = [],
    visitedSections: string[] = [],
    urlStreak: number = 0
  ): Promise<ContentAgentDecision> {
    if (this.isMockMode) {
      return this.decideMockAction(visitedUrls, pageContent, lastAction, bugsLogged, clickedSelectors, visitedSections);
    }

    try {
      if (!this.anthropic) {
        throw new Error('Anthropic client is not initialized.');
      }

      const KNOWN_SECTIONS = ['home', 'newsletters', 'insights', 'news', 'about', 'contact'];
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
        system: `You are a QA subscriber exploring https://www.independentsponsor.news/ to uncover defects that real users will eventually hit. Your job is BREADTH-FIRST EXPLORATION — touch many different surfaces rather than deeply auditing one.

Coverage targets for this audit:
- Visit at least 2 different sections (e.g. newsletters, insights, about, contact) before finishing.
- Click at least 3 distinct article/newsletter links across those sections.
- After auditing 1-2 items in a section, MOVE TO A DIFFERENT SECTION rather than dwelling.

Hard constraints (the runner will override you if you violate these):
- NEVER pick a selector that already appears in "Already clicked selectors". The runner will substitute a different one and log a loop-breaker warning.
- If your current URL has not changed for 2+ steps (urlStreak >= 1), STOP repeating the same click. Pick a link to a DIFFERENT section, or use goBack.
- Avoid selectors whose class names suggest hidden nav dropdowns (e.g. classes containing "dropdown" or "nav-menu"). Prefer the direct link in the page body.

What to look for (be opportunistic, not exhaustive):
- Content that contradicts the link you clicked — wrong date, wrong topic, blank or error-stating page.
- Hrefs that look malformed (spaces, two URLs concatenated, unresolved placeholders like SUBSCRIBER_ID or USER_ID).
- Buttons or CTAs that visibly do nothing when clicked.
- New tabs opening to 404s, error pages, or URLs with template placeholders.
- Embedded players or widgets showing error messages.
- Visible "Access Denied" pages when you were already logged in. (The framework's sentinel catches silent session drops automatically — you only need to flag VISIBLE access-denied while authenticated.)

Use logContentBug for any of the above. Don't bother re-logging duplicates — that list is provided.

When the audit feels covered (2+ sections, 3+ articles, key surfaces checked, or only 1-2 steps remain), use finish with a summary of what you found and what you skipped.`,
        messages: [
          {
            role: 'user',
            content: `Current page URL: ${pageContent.url}
Current section: ${currentSection}
Page Title: ${pageContent.title}
Last action taken: ${lastAction ? `${lastAction.action} on "${lastAction.selector}" (Text: "${lastAction.text || 'None'}")` : 'None (Starting Page)'}
Steps remaining: ${stepsRemaining}
URL streak: ${urlStreak} (number of consecutive prior steps that ended at the SAME URL — if >= 1, your last click did not navigate you anywhere; pick something different)

Coverage so far:
- Sections visited: ${JSON.stringify(visitedSections)}
- Likely-unvisited sections to consider next: ${JSON.stringify(unvisitedSections)}
- Distinct selectors clicked: ${clickedSelectors.length}

Visited URLs (sampled): ${JSON.stringify(visitedUrls.slice(-10), null, 2)}

Already clicked selectors (DO NOT re-pick; runner will reject):
${JSON.stringify(clickedSelectors, null, 2)}

Already logged content defects (do not re-log):
${JSON.stringify(bugsLogged.map((b: any) => ({ id: b.id, type: b.type, linkText: b.linkText, url: b.url })), null, 2)}

Interactive elements on this page (pick from these for click, or use goBack/finish):
${JSON.stringify(pageContent.interactiveElements.map(el => ({
  tag: el.tagName,
  text: el.text,
  selector: el.selector,
})), null, 2)}

Pick the next action. Strongly prefer elements that take you to an UNVISITED section. If nothing useful remains on this page, use goBack.`
          }
        ],
        tools: [
          {
            name: 'click',
            description: 'Click a content link to verify its target.',
            input_schema: {
              type: 'object',
              properties: {
                selector: { type: 'string', description: 'CSS selector of the link.' }
              },
              required: ['selector']
            }
          },
          {
            name: 'logContentBug',
            description: 'Log a semantic content mismatch or broken layout content.',
            input_schema: {
              type: 'object',
              properties: {
                linkText: { type: 'string', description: 'The text label of the clicked link.' },
                expectedTopic: { type: 'string', description: 'The topic/date promised by the link label.' },
                actualTopic: { type: 'string', description: 'The actual topic/date displayed on the loaded page.' },
                description: { type: 'string', description: 'Detailed description of the mismatch.' }
              },
              required: ['linkText', 'expectedTopic', 'actualTopic', 'description']
            }
          },
          {
            name: 'goBack',
            description: 'Go back to the previous page to continue auditing other links.',
            input_schema: {
              type: 'object',
              properties: {}
            }
          },
          {
            name: 'finish',
            description: 'Complete the content verification audit.',
            input_schema: {
              type: 'object',
              properties: {
                summary: { type: 'string', description: 'A summary of content audit findings.' }
              },
              required: ['summary']
            }
          }
        ]
      });

      const textBlocks = response.content.filter(b => b.type === 'text');
      const thought = textBlocks.map(t => t.type === 'text' ? t.text : '').join(' ').trim() || 'Verifying content alignment.';

      const toolCall = response.content.find(b => b.type === 'tool_use');
      if (!toolCall || toolCall.type !== 'tool_use') {
        return { thought, action: 'FINISH', target: 'No tool called by content agent.' };
      }

      const toolName = toolCall.name;
      const toolInput = toolCall.input as any;

      if (toolName === 'click') {
        return { thought, action: 'CLICK', target: toolInput.selector };
      } else if (toolName === 'logContentBug') {
        return {
          thought,
          action: 'LOG_CONTENT_BUG',
          target: null,
          params: {
            linkText: toolInput.linkText,
            expectedTopic: toolInput.expectedTopic,
            actualTopic: toolInput.actualTopic,
            description: toolInput.description
          }
        };
      } else if (toolName === 'goBack') {
        return { thought, action: 'BACK', target: null };
      } else {
        return { thought, action: 'FINISH', target: toolInput.summary || 'Finished content verification.' };
      }

    } catch (err: any) {
      console.error('LLM Content Agent API error, falling back to local crawler logic:', err.message || err);
      return this.decideMockAction(visitedUrls, pageContent, lastAction, bugsLogged, clickedSelectors, visitedSections);
    }
  }

  private decideMockAction(
    visitedUrls: string[],
    pageContent: PageContent,
    lastAction: { action: string; selector: string | null; text: string | null } | null,
    bugsLogged: any[] = [],
    clickedSelectors: string[] = [],
    visitedSections: string[] = []
  ): ContentAgentDecision {
    // 1. If we just logged a bug, go back to look for other links
    if (lastAction && lastAction.action === 'LOG_CONTENT_BUG') {
      if (visitedUrls.length > 1) {
        return {
          thought: 'Local mock decision: Backtracking after logging a content bug.',
          action: 'BACK',
          target: null
        };
      }
    }

    // 2. If we just clicked a link, check for issues on the page
    if (lastAction && lastAction.action === 'CLICK' && lastAction.text) {
      const pageTitle = pageContent.title.toLowerCase();
      const pageText = pageContent.text || '';
      
      // Access Denied Check
      if (pageContent.url.includes('/access-denied') || pageTitle.includes('access denied')) {
        const bugAlreadyLogged = bugsLogged.some(b => b.url === pageContent.url && b.description.includes('Access Denied'));
        if (!bugAlreadyLogged) {
          return {
            thought: `Local mock decision: Access Denied bug detected on ${pageContent.url}.`,
            action: 'LOG_CONTENT_BUG',
            target: null,
            params: {
              linkText: lastAction.text,
              expectedTopic: 'Subscriber Page Content',
              actualTopic: 'Access Denied',
              description: 'Landed on Access Denied page when attempting to view subscriber content.'
            }
          };
        }
      }

      // SoundCloud Player Check
      if (pageText.includes('You have not provided a valid SoundCloud URL')) {
        const bugAlreadyLogged = bugsLogged.some(b => b.url === pageContent.url && b.description.includes('SoundCloud'));
        if (!bugAlreadyLogged) {
          return {
            thought: `Local mock decision: Invalid SoundCloud player detected on ${pageContent.url}.`,
            action: 'LOG_CONTENT_BUG',
            target: null,
            params: {
              linkText: lastAction.text,
              expectedTopic: 'Valid SoundCloud Player embed',
              actualTopic: 'Invalid SoundCloud URL message',
              description: 'SoundCloud widget displays warning: "You have not provided a valid SoundCloud URL."'
            }
          };
        }
      }
    }

    // 3. Otherwise, rank fresh links by section diversity. Pick the highest-scoring
    // link not yet clicked, preferring links into sections we have NOT visited yet.
    const sectionFromHref = (href: string): string => {
      try {
        const u = new URL(href, pageContent.url);
        const segs = u.pathname.split('/').filter(s => s.length > 0);
        if (segs.length === 0) return 'home';
        return segs[0]!;
      } catch {
        return 'unknown';
      }
    };

    type Cand = { el: any; href: string; section: string; score: number };
    const candidates: Cand[] = [];
    for (const el of pageContent.interactiveElements) {
      if (el.tagName !== 'a' && el.tagName !== 'button') continue;
      if (clickedSelectors.includes(el.selector)) continue;
      const hrefMatch = el.selector.match(/href="([^"]+)"/);
      const href = hrefMatch?.[1] || '';
      const section = href ? sectionFromHref(href) : 'unknown';

      // Filter out obvious navigation noise: hidden dropdown items, "skip to content"
      // etc. would have classes containing dropdown/skip. Selector text proxies for this.
      if (/dropdown|skip-to/i.test(el.selector)) continue;

      let score = 0;
      // Big bonus for unvisited section.
      if (section !== 'external' && section !== 'unknown' && !visitedSections.includes(section)) score += 5;
      // Modest bonus for likely-article text.
      const text = (el.text || '').toLowerCase();
      if (/newsletter|insight|read|subscribe|submit/.test(text)) score += 2;
      // Prefer anchors with clean hrefs.
      if (href && !href.startsWith('#') && href !== 'javascript:void(0)') score += 1;
      // Mild penalty for external links — we want to test the site itself.
      if (section === 'external') score -= 2;

      candidates.push({ el, href, section, score });
    }

    candidates.sort((a, b) => b.score - a.score);
    const pick = candidates[0];
    if (pick && pick.score > 0) {
      return {
        thought: `Local mock decision: click "${pick.el.text || pick.el.selector}" to enter section "${pick.section}" (score ${pick.score}).`,
        action: 'CLICK',
        target: pick.el.selector,
        params: {
          linkText: pick.el.text
        }
      };
    }

    if (visitedUrls.length > 1) {
      return {
        thought: 'Local mock decision: No unvisited content links found. Backtracking...',
        action: 'BACK',
        target: null
      };
    }

    return {
      thought: 'Local mock decision: Finished mock content audit.',
      action: 'FINISH',
      target: 'Finished content audit.'
    };
  }
}
