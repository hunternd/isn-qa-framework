# Design Document: isn-qa-framework

**Status:** Draft
**Goal:** Build a dynamic, agent-driven UI testing framework using Playwright to identify authentication, navigation, and formatting issues.

## 1. Overview
The `isn-qa-framework` is a specialized QA platform where AI agents autonomously explore and test web applications. Unlike traditional static testing scripts, these agents navigate in real-time, adapting to UI changes and making logical decisions based on their specialized discipline.

## 2. Technical Architecture
- **Automation Core:** [Playwright](https://playwright.dev/) (TypeScript)
- **Agent Orchestration:** LangGraph (or a similar state-based agent framework) to manage specialized QA nodes.
- **LLM Integration:** Anthropic Claude (via API) for reasoning and UI analysis.
- **Data Layer:** Local JSON/Markdown logs for exploration findings and screenshots.

## 3. Specialized QA Agent Profiles
We will implement four primary agent roles, each with a specific "system prompt" and toolkit:

1.  **Security & Auth Agent:** Focuses on login flows, session management, RBAC, and boundary testing (e.g., unauthorized access attempts).
2.  **Navigation Agent:** Maps the application structure, verifies link integrity, checks routing consistency, and ensures the site map remains intact.
3.  **UI/UX & Formatting Agent:** Validates responsiveness across viewports, visual contrast, accessibility (a11y), form validation UX, and layout consistency.
4.  **Functional/E2E Agent:** Mimics real user journeys for core business workflows, verifying that actions result in the correct application state.

## 4. Proposed Repository Structure
```text
isn-qa-framework/
├── .github/workflows/      # CI/CD for agent-driven runs
├── config/                 # Environment and target application configs
├── src/
│   ├── agents/             # Specialized Agent definitions (prompts, logic)
│   │   ├── auth-agent.ts
│   │   ├── nav-agent.ts
│   │   ├── ui-agent.ts
│   │   └── functional-agent.ts
│   ├── tools/              # Playwright-based tools for agents
│   │   ├── click.ts
│   │   ├── type.ts
│   │   ├── screenshot.ts
│   │   └── navigation.ts
│   ├── engine/             # Orchestrator (LangGraph state management)
│   └── utils/              # Shared helpers
├── tests/                  # Boot-verification tests for the framework
├── reports/                # Generated findings, logs, and screenshots
├── package.json
├── playwright.config.ts    # Base Playwright configuration
└── README.md
```

## 5. Implementation Roadmap
1.  **Phase 1: Foundation (Current)**
    - Initialize repository with Playwright and TypeScript.
    - Set up the "Navigation Agent" as the first pilot agent.
    - Implement basic tools (Navigate, Screenshot, Read Page Content).
2.  **Phase 2: Specialized Profiles**
    - Implement Security, UI/UX, and Functional agents.
    - Add "Analysis Tools" (e.g., checking console logs, a11y audits).
3.  **Phase 3: Orchestration**
    - Implement a cross-agent orchestrator to hand off tasks (e.g., Auth Agent logs in, then hands off to Nav Agent).
4.  **Phase 4: Backend Integration (Future)**
    - Integrate API testing capabilities once backend access is granted.

## 6. Feedback & Approval
Please review the profiles and structure. Once approved, I will proceed with repository initialization.
