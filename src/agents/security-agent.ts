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
    this.model = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';
  }

  async decideNextAction(
    visitedUrls: string[],
    pageContent: PageContent,
    stepsRemaining: number
  ): Promise<SecurityAgentDecision> {
    if (this.isMockMode) {
      return this.decideMockAction(visitedUrls, pageContent);
    }

    try {
      if (!this.anthropic) {
        throw new Error('Anthropic client is not initialized.');
      }

      const response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 1000,
        system: `You are the "Security & Auth Agent" in an agentic QA framework. Your goal is to inspect the site "https://www.independentsponsor.news/", audit search boxes, subscription inputs, and contact forms for vulnerability exposures or input validation gaps.
Your capabilities include:
1. type: Input text into an input or textarea element (e.g. testing boundary inputs, script tags, SQL symbols, or invalid structures).
2. click: Click a form submit button or checkbox.
3. goBack: Return to the previous page in history.
4. logSecurity: Report a specific security vulnerability, boundary issue, or raw application stack dump you encountered.
5. finish: Complete your auditing task.

Rules:
- Identify form textareas or input fields on the page.
- Test form validation handling by inputting invalid structured strings (e.g., test invalid emails, boundary values, or basic script strings '<script>').
- Never perform destructive actions. Keep audits clean, non-intrusive, and local.
- Check how the system handles invalid forms (e.g., does it reveal detailed stack errors in page HTML, or validate gracefully?).`,
        messages: [
          {
            role: 'user',
            content: `Current page URL: ${pageContent.url}
Page Title: ${pageContent.title}
Steps remaining in this security inspection: ${stepsRemaining}
Visited pages so far: ${JSON.stringify(visitedUrls, null, 2)}

Interactive Elements on this page:
${JSON.stringify(pageContent.interactiveElements.map(el => ({
  tag: el.tagName,
  type: el.type,
  text: el.text,
  selector: el.selector,
  placeholder: el.placeholder,
})), null, 2)}

Select the next action using one of the tools provided.`
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
      return this.decideMockAction(visitedUrls, pageContent);
    }
  }

  private decideMockAction(visitedUrls: string[], pageContent: PageContent): SecurityAgentDecision {
    // In mock mode, we look for input fields (inputs or textareas)
    const inputs = pageContent.interactiveElements.filter(el =>
      (el.tagName === 'input' && el.type !== 'submit' && el.type !== 'button') || el.tagName === 'textarea'
    );

    if (inputs.length > 0 && inputs[0]) {
      const targetInput = inputs[0];
      // Let's type an invalid email format to test validation
      return {
        thought: `Local mock decision: Found input field "${targetInput.selector}". Type boundary email validation check.`,
        action: 'TYPE',
        target: targetInput.selector,
        params: { text: 'test-invalid-email-format' }
      };
    }

    // Now log a mock security audit observation
    if (pageContent.url.includes('/contact')) {
      return {
        thought: 'Local mock decision: Log standard observation regarding input sanitization on inputs.',
        action: 'LOG_SECURITY',
        target: 'input[type="email"]',
        params: {
          severity: 'low',
          description: 'Verified subscription form. Input fields trigger proper HTML5 native client-side validation for emails.'
        }
      };
    }

    // Fallback: Click Contact menu link to look for forms
    const contactLink = pageContent.interactiveElements.find(el => (el.text || '').toLowerCase().includes('contact'));
    if (contactLink && !visitedUrls.includes(new URL('/contact', pageContent.url).toString())) {
      return {
        thought: 'Local mock decision: Navigate to Contact section to audit input forms.',
        action: 'CLICK',
        target: contactLink.selector
      };
    }

    return {
      thought: 'Local mock decision: Completed basic security mock audits.',
      action: 'FINISH',
      target: 'Completed mock security audits.'
    };
  }
}
