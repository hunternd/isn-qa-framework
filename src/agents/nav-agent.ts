import Anthropic from '@anthropic-ai/sdk';
import type { NavigationAgentState } from '../engine/state.js';
import type { PageContent } from '../tools/navigation.js';
import * as dotenv from 'dotenv';

dotenv.config();

export interface AgentDecision {
  thought: string;
  action: 'NAVIGATE' | 'CLICK' | 'BACK' | 'FINISH';
  target: string | null;
}

export class NavigationAgent {
  private anthropic: Anthropic | null = null;
  private model: string;
  private isMockMode: boolean = false;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey.startsWith('dummy')) {
      console.log('🤖 Anthropic API key not detected or is dummy. Running Navigation Agent in local MOCK/CRAWLER mode.');
      this.isMockMode = true;
    } else {
      this.anthropic = new Anthropic({ apiKey });
    }
    this.model = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';
  }

  async decideNextAction(state: NavigationAgentState, pageContent: PageContent, stepsRemaining: number): Promise<AgentDecision> {
    if (this.isMockMode) {
      return this.decideMockAction(state, pageContent);
    }

    try {
      if (!this.anthropic) {
        throw new Error('Anthropic client is not initialized.');
      }

      const response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 1000,
        system: `You are the "Navigation Agent" in an agentic QA framework. Your goal is to systematically explore the site "https://www.independentsponsor.news/", map its link structures, and identify broken links or navigation errors.
Your capabilities include:
1. navigate: Go directly to a relative URL (e.g. "/about").
2. click: Click a specific interactive element on the page using its selector.
3. goBack: Return to the previous page in history.
4. finish: Complete the exploration once you have mapped the site.

Rules:
- Prioritize visiting unexplored areas of the site map.
- Only follow internal links; do not navigate to external sites.
- If you encounter a 404, 500, or a blank page, document it.
- Never exceed a navigation depth of 3 levels.`,
        messages: [
          {
            role: 'user',
            content: `Current page URL: ${pageContent.url}
Page Title: ${pageContent.title}
Steps remaining in this exploration run: ${stepsRemaining}
Visited URLs so far: ${JSON.stringify(state.visitedUrls, null, 2)}
Broken links identified so far: ${JSON.stringify(state.brokenLinks, null, 2)}

Interactive Elements on this page:
${JSON.stringify(pageContent.interactiveElements.map(el => ({
  tag: el.tagName,
  text: el.text,
  selector: el.selector,
})), null, 2)}

Select the next action using one of the tools provided. Remember to prioritize unvisited pages and do not go beyond the max depth of 3 levels.`
          }
        ],
        tools: [
          {
            name: 'navigate',
            description: 'Navigate to a URL on the site.',
            input_schema: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'The absolute or relative URL to navigate to (e.g. "/about").' }
              },
              required: ['url']
            }
          },
          {
            name: 'click',
            description: 'Click an interactive element on the page using its CSS selector.',
            input_schema: {
              type: 'object',
              properties: {
                selector: { type: 'string', description: 'The CSS selector of the element to click.' }
              },
              required: ['selector']
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
            description: 'Finish exploration because the site map is fully discovered or no more actions are useful.',
            input_schema: {
              type: 'object',
              properties: {
                summary: { type: 'string', description: 'A brief summary of what was found and explored.' }
              },
              required: ['summary']
            }
          }
        ]
      });

      const textBlocks = response.content.filter(b => b.type === 'text');
      const thought = textBlocks.map(t => t.type === 'text' ? t.text : '').join(' ').trim() || 'Analyzing page content.';

      const toolCall = response.content.find(b => b.type === 'tool_use');
      if (!toolCall || toolCall.type !== 'tool_use') {
        // Fallback if no tool was called
        return {
          thought,
          action: 'FINISH',
          target: 'No tool called by LLM.',
        };
      }

      const toolName = toolCall.name;
      const toolInput = toolCall.input as any;

      if (toolName === 'navigate') {
        return { thought, action: 'NAVIGATE', target: toolInput.url };
      } else if (toolName === 'click') {
        return { thought, action: 'CLICK', target: toolInput.selector };
      } else if (toolName === 'goBack') {
        return { thought, action: 'BACK', target: null };
      } else {
        return { thought, action: 'FINISH', target: toolInput.summary || 'Completed exploration.' };
      }

    } catch (err: any) {
      console.error('LLM API error, falling back to local crawler logic:', err.message || err);
      return this.decideMockAction(state, pageContent);
    }
  }

  private decideMockAction(state: NavigationAgentState, pageContent: PageContent): AgentDecision {
    // Clean up current URL to get paths
    const currentUrlObj = new URL(pageContent.url);
    const currentPath = currentUrlObj.pathname;

    // Filter interactive elements for internal links (anchor tags 'a')
    const links = pageContent.interactiveElements.filter(el => {
      if (el.tagName !== 'a' || !el.selector) return false;
      // Exclude empty hrefs or external links if possible, but we don't have href in interactive element directly
      // However, we can use the selector to check if it's likely a standard text link.
      return el.text && el.text.trim().length > 0;
    });

    // Find the first link that we haven't visited yet
    // Since we don't have the exact URLs of links in readPageContent directly (only selectors/text),
    // we can attempt to click links that represent likely unvisited sections based on text,
    // or simulate a basic crawl behavior.
    // For a mock crawler, let's try to click menu links like "About", "News", "Contact"
    // that don't match our current location.
    for (const link of links) {
      const linkText = (link.text || '').toLowerCase();
      
      // Map common link texts to relative paths to check if visited
      let matchedPath = '';
      if (linkText.includes('about')) matchedPath = '/about';
      else if (linkText.includes('news')) matchedPath = '/news';
      else if (linkText.includes('contact')) matchedPath = '/contact';

      const fullMatchUrl = new URL(matchedPath || '/', state.baseUrl).toString();

      if (matchedPath && !state.visitedUrls.includes(fullMatchUrl) && pageContent.url !== fullMatchUrl) {
        return {
          thought: `Local mock decision: Click link "${link.text}" to explore ${matchedPath}.`,
          action: 'CLICK',
          target: link.selector,
        };
      }
    }

    // Fallback: If we have visited pages, let's go back or click the first menu link or finish
    if (state.visitedUrls.length > 1 && currentPath !== '/') {
      return {
        thought: 'Local mock decision: No unvisited primary menu links found on this page. Returning back to home.',
        action: 'BACK',
        target: null,
      };
    }

    return {
      thought: 'Local mock decision: Explored primary entry points. Finishing crawl.',
      action: 'FINISH',
      target: 'Explored home page and primary paths.',
    };
  }
}
