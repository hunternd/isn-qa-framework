# isn-qa-framework

An agent-driven UI testing framework powered by **Playwright** and specialized AI agents to autonomously explore, navigate, and test web applications.

## Technical Architecture

- **Automation Core**: [Playwright](https://playwright.dev/) (TypeScript)
- **Agent Orchestration**: LangGraph (or similar state-based framework) to manage specialized QA nodes.
- **LLM Integration**: Anthropic Claude (via API) for reasoning and UI analysis.
- **Data Layer**: Local JSON/Markdown logs for exploration findings and screenshots.

## Getting Started

### Prerequisites

- Node.js (version 22+ recommended)
- npm

### Installation

1. Clone the repository and navigate to the project directory:
   ```bash
   cd isn-qa-framework
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Install Playwright browser binaries:
   ```bash
   npx playwright install chromium
   ```

### Running Tests

To run the local integration/boot verification tests:
```bash
npm test
```

To run with UI mode:
```bash
npm run test:ui
```

### Running the Web Dashboard

The framework includes an interactive, glassmorphic web dashboard that serves as a QA command center. To start it:

```bash
npm run dashboard
```

Once running, navigate to [http://localhost:3000](http://localhost:3000) in your browser. The dashboard allows you to:
- 📊 **Inspect All Reports**: Drill down into Executive, UI/UX, Content Integrity, Security, and Navigation logs.
- 🚨 **Track Defects**: View exact mismatches, broken links, or console errors with status filtering.
- 🕸️ **Visualize Navigation**: View dynamic interactive flowcharts of application architecture (renders Mermaid diagrams).
- 🖼️ **Browse Screen Captures**: View step-by-step screenshots linked directly to actions and viewports.
- 💻 **Active Test Cockpit**: Select and trigger any of the test suites (e.g. coordinated audit, content check) to run in the background, streaming colorful console outputs live to the terminal simulator in your browser.

