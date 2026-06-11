export interface BrokenLink {
  url: string;
  parentUrl: string;
  error: string;
  timestamp: string;
}

export interface ActionHistoryEntry {
  step: number;
  action: string;
  target: string | null;
  result: 'success' | 'failure';
  error?: string | undefined;
}

export interface NavigationAgentState {
  baseUrl: string;
  visitedUrls: string[];
  urlQueue: string[];
  siteMap: Record<string, string[]>;
  brokenLinks: BrokenLink[];
  actionHistory: ActionHistoryEntry[];
  screenshots: Record<string, string>;
  currentDepth: number;
  maxDepth: number;
  maxSteps: number;
}

export function createInitialState(baseUrl: string, maxDepth: number = 3, maxSteps: number = 20): NavigationAgentState {
  return {
    baseUrl,
    visitedUrls: [],
    urlQueue: [baseUrl],
    siteMap: {},
    brokenLinks: [],
    actionHistory: [],
    screenshots: {},
    currentDepth: 0,
    maxDepth,
    maxSteps,
  };
}
