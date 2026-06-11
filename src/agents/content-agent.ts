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
    clickedSelectors: string[] = []
  ): Promise<ContentAgentDecision> {
    if (this.isMockMode) {
      return this.decideMockAction(visitedUrls, pageContent, lastAction, bugsLogged, clickedSelectors);
    }

    try {
      if (!this.anthropic) {
        throw new Error('Anthropic client is not initialized.');
      }

      const response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 1000,
        system: `You are the "Authenticated Content Agent" in an agentic QA framework. Your goal is to systematically verify that links, buttons, and embedded components on "https://www.independentsponsor.news/" render correct semantic content and function properly.

Your capabilities include:
1. click: Click an article link, navigation link, or interactive button.
2. logContentBug: Report a mismatch or defect (e.g., broken links, invalid SoundCloud player embeds, or inactive buttons).
3. goBack: Return to the previous page in history to verify other links.
4. finish: Complete your content audit.

Rules for Systematic Auditing:
- Do NOT stop after logging your first bug. Continue auditing other links on the site.
- If you log a bug for a page, immediately go back to the index page or navigate to another section to check other elements.
- Look out for:
  1. SoundCloud Audio Player errors: Check if there is an error message stating "You have not provided a valid SoundCloud URL" or similar layout failures.
  2. Dead Action buttons (e.g. "Submit News"): If clicking a button doesn't change the URL, open a form/modal, or update the page content, it is inactive.
  3. Mismatched Topics: If a link promises one article topic/date but renders another.
- Refer to the list of already logged bugs so you do not log the exact same bug twice.

User Journey Rules:
- If you encounter an "Access Denied" page:
  1. Act like a normal user: look for the "Log In" link/button (often a link containing Outseta login trigger) and click it.
  2. The runner will handle inputting the credentials. Once logged in, go back/navigate and click the SAME article link again.
  3. If it opens successfully, navigate back to newsletters list and click a DIFFERENT newsletter.
  4. If that second newsletter (or any subsequent page) triggers an "Access Denied" message, log it immediately as a DEFECT using logContentBug (specifying in the description that the user was already logged in when denied).
- If the current page content does not match the link that was clicked (excluding expected authentication gates), log a bug immediately.
- Pay close attention to dates (e.g., year mismatches), titles, topics, and empty/broken content segments.`,
        messages: [
          {
            role: 'user',
            content: `Current page URL: ${pageContent.url}
Page Title: ${pageContent.title}
Last action taken: ${lastAction ? `${lastAction.action} on "${lastAction.selector}" (Text: "${lastAction.text || 'None'}")` : 'None (Starting Page)'}
Steps remaining in this content audit: ${stepsRemaining}
Visited pages: ${JSON.stringify(visitedUrls, null, 2)}
Already clicked elements/selectors in this session: ${JSON.stringify(clickedSelectors, null, 2)}
Already logged content defects in this session: ${JSON.stringify(bugsLogged, null, 2)}

Interactive Elements on this page:
${JSON.stringify(pageContent.interactiveElements.map(el => ({
  tag: el.tagName,
  text: el.text,
  selector: el.selector,
})), null, 2)}

Inspect the current page or select a link to click next. If the page content contradicts what the last clicked link promised, or is broken/inactive, log a content bug.`
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
      return this.decideMockAction(visitedUrls, pageContent, lastAction, bugsLogged, clickedSelectors);
    }
  }

  private decideMockAction(
    visitedUrls: string[],
    pageContent: PageContent,
    lastAction: { action: string; selector: string | null; text: string | null } | null,
    bugsLogged: any[] = [],
    clickedSelectors: string[] = []
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

    // 3. Otherwise, look for an article/newsletter/insight link to audit
    const unvisitedLinks = pageContent.interactiveElements.filter(el => {
      if (el.tagName !== 'a') return false;
      if (clickedSelectors.includes(el.selector)) return false; // Skip if already clicked!
      
      const text = (el.text || '').toLowerCase();
      const href = el.selector.match(/href="([^"]+)"/)?.[1] || '';
      
      const isAuditable = text.includes('newsletter') || text.includes('insight') || text.includes('read') || text.includes('submit');
      if (!isAuditable) return false;
      
      try {
        const absUrl = new URL(href, pageContent.url).toString();
        return !visitedUrls.includes(absUrl);
      } catch (e) {
        return false;
      }
    });

    if (unvisitedLinks.length > 0) {
      const targetLink = unvisitedLinks[0];
      if (targetLink) {
        return {
          thought: `Local mock decision: Click link "${targetLink.text}" to audit its contents.`,
          action: 'CLICK',
          target: targetLink.selector,
          params: {
            linkText: targetLink.text
          }
        };
      }
    }

    // Fallback: click News link or go back
    const newsLink = pageContent.interactiveElements.find(el => (el.text || '').toLowerCase().includes('news'));
    if (newsLink && pageContent.url === 'https://www.independentsponsor.news/') {
      return {
        thought: 'Local mock decision: Click News link to look for newsletter content.',
        action: 'CLICK',
        target: newsLink.selector
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
