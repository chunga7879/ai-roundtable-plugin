# AI Roundtable

A VS Code extension that brings a structured multi-agent AI development workflow directly into your editor. Instead of a single AI answering every question, AI Roundtable runs a **pipeline of specialized AI agents** — a main agent that produces the work, and optional sub-agents that independently verify it — modeled after how real software teams operate.

**Why it exists**: Large language models make mistakes. A single model reviewing its own output catches far fewer issues than two independent models reviewing each other. AI Roundtable applies this principle to every phase of software development — requirements, architecture, code, review, testing, deployment, and documentation — so that the AI's output is more reliable before it touches your codebase.

---

## Prerequisites

- **VS Code** `^1.90.0`
- One of:
  - **GitHub Copilot** subscription (no API key required), or
  - One or more API keys: Anthropic (`sk-ant-...`), OpenAI (`sk-...`), Google (`AIza...`), DeepSeek (`sk-...`)
- **Node.js** `^20` (for development)

---

## Setup

### Install from VSIX

```bash
vsce package           # produces ai-roundtable-0.1.0.vsix
code --install-extension ai-roundtable-0.1.0.vsix
```

### Development

```bash
git clone <repo>
cd ai-roundtable-plugin
npm install
npm run compile        # or: npm run watch
```

Press `F5` in VS Code to launch the Extension Development Host.

### Configure provider

Open the command palette (`Cmd+Shift+P`) and run:

```
AI Roundtable: Configure Provider
```

Choose **GitHub Copilot** (default) or **API Keys**. If you choose API Keys, you will be prompted to enter keys for each provider — all keys are stored in the OS keychain via `vscode.SecretStorage`, never in settings files.

---

## Usage

### Open the panel

- Command palette: `AI Roundtable: Open AI Roundtable Panel`
- Or click the AI Roundtable icon in the activity bar

### Basic workflow

1. Select a **Round** (e.g. Developer)
2. Select a **Main Agent** (e.g. Claude)
3. Optionally select **Sub Agents** to verify the main agent's response
4. Type your request and press `Enter`
5. Review the response — file changes proposed by the AI appear in a **Proposed Changes** panel
6. Click a file to preview the diff, then **Apply All Changes** or **Discard**
7. If dependency files changed (e.g. `package.json`), an approve/deny dialog offers to run the install command automatically

### Shell commands

When the AI needs to run a command to complete its task, it outputs a `RUN: <command>` line which renders as a clickable **▶ command** button. Clicking shows an approve/deny dialog before anything executes.

### File deletions

When the AI deletes a file via the `delete_file` tool, the file appears with a red **DEL** badge in the Proposed Changes panel.

### Round types

| Round | Best used for |
|---|---|
| **Requirements** | Turning vague ideas into precise acceptance criteria |
| **Architect** | System design, tech stack decisions, API contracts |
| **Developer** | Writing complete, production-ready code |
| **Reviewer** | Adversarial code review with OWASP security checks — two-step: findings first, fixes on confirm |
| **QA** | Generating unit, integration, and security tests |
| **DevOps** | Dockerfile, CI/CD pipelines, environment configuration |
| **Documentation** | Generating README, API docs, CHANGELOG |

### Running a shell command

During any round, the AI may output a `RUN: <command>` line which renders as a clickable **▶ command** button. Clicking shows an approve/deny dialog before anything executes. The command runs in your workspace root with a configurable timeout (default 60 seconds).

---

## Project structure

```
src/
├── extension.ts          ← Activation, ConfigManager, command registration
├── errors.ts             ← Typed error hierarchy
├── types/index.ts        ← Enums, interfaces, webview message validators
├── prompts/
│   └── roundPrompts.ts   ← System prompts for all round types
├── agents/
│   ├── AgentRunner.ts    ← 3-step pipeline (main → sub-verify → reflect)
│   ├── CopilotProvider.ts← vscode.lm API (GitHub Copilot)
│   └── ApiKeyProvider.ts ← Direct HTTPS: Anthropic / OpenAI / Google / DeepSeek
├── workspace/
│   ├── WorkspaceReader.ts← Collects open files as AI context
│   └── WorkspaceWriter.ts← Parses file changes, applies WorkspaceEdit
├── sessions/
│   └── SessionManager.ts ← Persists conversation history across sessions
└── panels/
    ├── ChatPanel.ts      ← Webview lifecycle, message routing
    ├── RoundOrchestrator.ts ← Coordinates pipeline per round type
    └── webview/
        └── index.html    ← Chat UI (vanilla JS, sandboxed)
tests/
├── __mocks__/vscode.ts   ← VS Code API mock for Jest
├── unit/                 ← Unit tests
└── integration/          ← Integration tests for ChatPanel message routing
```

---

## Troubleshooting

**"No GitHub Copilot language models are available"**
Ensure the GitHub Copilot extension is installed, you are signed in, and your subscription is active. Run `GitHub Copilot: Sign In` from the command palette.

**"No API key configured for claude"**
Run `AI Roundtable: Configure Provider`, choose API Keys, and enter your Anthropic key. The panel updates automatically — no need to reopen it.

**Extension does not activate**
Check that VS Code is `^1.90.0`. Run `Developer: Show Running Extensions` to confirm the extension is listed. If compile errors exist, run `npm run compile` and reload.

**File changes not applied after "Apply All Changes"**
The workspace must be open (not just a single file). Ensure VS Code has write permission to the target files. Check the Output panel (`AI Roundtable`) for error details.

**Copilot model selection times out (30s)**
This can happen if the Copilot API is temporarily unresponsive. The extension will throw `CopilotProviderError` and show an error in the panel. Retry the request, or switch to API key mode.

---

## Known limitations

- **Copilot mode uses a single model for all agents** — sub-agents and main agent are the same underlying Copilot model, differentiated only by their system prompt role.
- **Conversation history resets when you switch round type** — switching from Developer to Reviewer starts a new conversation.
- **Max 50 workspace files** — large projects will have files truncated or omitted. Open the most relevant files before sending a request.
- **Shell command timeout: configurable (default 60 seconds)** — long-running commands (e.g. full test suites) may be cut off.
- **Max 50 file changes per response** — responses proposing more than 50 files will have the excess silently dropped.
