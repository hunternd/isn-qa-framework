import Anthropic from '@anthropic-ai/sdk';
import type { PageContent } from '../tools/navigation.js';
import * as dotenv from 'dotenv';

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
    this.model = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';
  }

  async decideNextAction(
    visitedUrls: string[],
    pageContent: PageContent,
    currentViewport: { width: number; height: number },
    stepsRemaining: number
  ): Promise<UIAgentDecision> {
    if (this.isMockMode) {
      return this.decideMockAction(visitedUrls, pageContent, currentViewport);
    }

    try {
      if (!this.anthropic) {
        throw new Error('Anthropic client is not initialized.');
      }

      const response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 1000,
        system: `You are the "UI/UX & Formatting Agent" in an agentic QA framework. Your goal is to inspect the site "https://www.independentsponsor.news/", identify visual formatting bugs, responsiveness issues, overlay/pop-up obstruction issues, and accessibility flaws.
Your capabilities include:
1. click: Click a specific element to interact (e.g. to open a modal, collapse nav, etc.).
2. resizeViewport: Test different device screen sizes (e.g., Mobile: 375x812, Tablet: 768x1024, Desktop: 1280x800).
3. goBack: Return to the previous page in history.
4. logLayoutBug: Report a specific layout or visual bug you observed (e.g. overlapping text, unreadable contrast, missing alt texts).
5. finish: Complete your inspection.

Rules:
- Systematically test at least one desktop viewport and one mobile viewport.
- Look out for structural overlap, navigation menus that cover content, forms that break layout, and broken styling.
- Document visual findings using logLayoutBug before finishing.`,
        messages: [
          {
            role: 'user',
            content: `Current page URL: ${pageContent.url}
Page Title: ${pageContent.title}
Current Viewport Size: ${currentViewport.width}x${currentViewport.height}
Steps remaining in this UI/UX exploration: ${stepsRemaining}
Visited pages so far: ${JSON.stringify(visitedUrls, null, 2)}

Interactive Elements on this page:
${JSON.stringify(pageContent.interactiveElements.map(el => ({
  tag: el.tagName,
  text: el.text,
  selector: el.selector,
})), null, 2)}

Select the next action using one of the tools provided.`
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
      return this.decideMockAction(visitedUrls, pageContent, currentViewport);
    }
  }

  private decideMockAction(
    visitedUrls: string[],
    pageContent: PageContent,
    currentViewport: { width: number; height: number }
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

    // Otherwise click the news link to trigger navigation
    const newsLink = pageContent.interactiveElements.find(el => (el.text || '').toLowerCase().includes('news'));
    if (newsLink && !visitedUrls.includes(new URL('/news', pageContent.url).toString())) {
      return {
        thought: 'Local mock decision: Click News menu link to explore visual structure.',
        action: 'CLICK',
        target: newsLink.selector
      };
    }

    return {
      thought: 'Local mock decision: Completed basic UI/UX responsive inspections.',
      action: 'FINISH',
      target: 'Completed mock UI/UX checks.'
    };
  }
}
