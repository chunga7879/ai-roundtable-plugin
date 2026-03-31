# AI Roundtable

Multi-agent AI assistant for VS Code — run requirements, architecture, development, review, QA, DevOps, and debugging rounds with Claude, GPT, Gemini, DeepSeek, or GitHub Copilot.

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
5. Review the response — if FILE: blocks are present, a **Proposed Changes** panel appears
6. Click a file to preview the diff, then **Apply All Changes** or **Discard**
7. If dependency files changed (e.g. `package.json`), an approve/deny dialog offers to run the install command automatically

### Action buttons

When an AI response ends with a question (e.g. "Would you like me to apply fixes?"), it renders as clickable buttons instead of plain text. Clicking a button re-runs the round with that label as your message — sub-agent verification is skipped for these confirmation turns.

### Shell commands

When the AI needs to run a command to complete its task, it outputs a `RUN: <command>` line which renders as a clickable **▶ command** button. Clicking shows an approve/deny dialog before anything executes. If the command fails, the output is automatically fed to Runner AI for analysis.

### File deletions

When the AI moves or removes a file, it outputs `DELETE: path/to/file` alongside any `FILE:` blocks. Deleted files appear with a red **DEL** badge in the Proposed Changes panel.

### Round types

| Round | Best used for |
|---|---|
| **Requirements** | Turning vague ideas into precise acceptance criteria |
| **Architect** | System design, tech stack decisions, API contracts |
| **Developer** | Writing complete, production-ready code |
| **Reviewer** | Adversarial code review with OWASP security checks — two-step: findings first, fixes on confirm |
| **QA** | Generating unit, integration, and security tests |
| **DevOps** | Dockerfile, CI/CD pipelines, environment configuration |
| **Runner** | Running a terminal command — AI analysis triggered only on failure |
| **Documentation** | Generating README, API docs, CHANGELOG |

### Running a shell command (Runner round)

Select the Runner round, type a command in the **Run Command** input, and press **Run**. The command runs in your workspace root with a 60-second timeout. If it exits with a non-zero code, the output is automatically sent to Runner AI for diagnosis and fix suggestions. Use **Run Again** to re-execute after applying fixes.

---

## Project structure

```
src/
├── extension.ts          ← Activation, ConfigManager, command registration
├── errors.ts             ← Typed error hierarchy
├── types/index.ts        ← Enums, interfaces, webview message validators
├── prompts/
│   └── roundPrompts.ts   ← System prompts for all 8 round types
├── agents/
│   ├── AgentRunner.ts    ← 3-step pipeline (main → sub-verify → reflect)
│   ├── CopilotProvider.ts← vscode.lm API (GitHub Copilot)
│   └── ApiKeyProvider.ts ← Direct HTTPS: Anthropic / OpenAI / Google / DeepSeek
├── workspace/
│   ├── WorkspaceReader.ts← Collects open files as AI context
│   └── WorkspaceWriter.ts← Parses FILE: blocks, applies WorkspaceEdit
└── panels/
    ├── ChatPanel.ts      ← Webview lifecycle, message routing
    └── webview/
        └── index.html    ← Chat UI (vanilla JS, sandboxed)
tests/
├── __mocks__/vscode.ts   ← VS Code API mock for Jest
├── unit/                 ← Unit tests (190 passing)
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
- **Max 20 workspace files / 200 KB context** — large projects will have files truncated or omitted. Open the most relevant files before sending a request.
- **Runner round timeout: 60 seconds** — long-running commands (e.g. full test suites) may be cut off.
- **Max 50 file changes per response** — responses proposing more than 50 files will have the excess silently dropped.
- **Runner AI analysis only runs on failure** — if a command exits with code 0, no AI analysis is triggered.

