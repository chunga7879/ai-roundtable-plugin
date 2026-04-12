# AI Roundtable

A VS Code extension that brings a structured multi-agent AI development workflow directly into your editor. Instead of a single AI answering every question, AI Roundtable runs a **pipeline of specialized AI agents** — a main agent that produces the work, and optional sub-agents that independently verify it — modeled after how real software teams operate.

**Why it exists**: Large language models make mistakes. A single model reviewing its own output catches far fewer issues than two independent models reviewing each other. AI Roundtable applies this principle to every phase of software development — requirements, architecture, code, review, testing, deployment, and documentation — so that the AI's output is more reliable before it touches your codebase.

---

## Prerequisites

- **VS Code** `^1.88.0`
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
npm run quality:check  # lint + coverage gate
```

Press `F5` in VS Code to launch the Extension Development Host.

### Development scripts

```bash
npm run compile             # compile extension
npm run compile:test:vscode # compile VS Code integration test entrypoint
npm run test                # jest unit/integration tests
npm run test:vscode         # launch VS Code extension test host
npm run quality:check       # lint + jest coverage
```

### Configure provider

Open the command palette (`Cmd+Shift+P`) and run:

```
AI Roundtable: Configure Provider
```

Choose **GitHub Copilot** (default) or **API Keys**. If you choose API Keys, you will be prompted to enter keys for each provider — all keys are stored in the OS keychain via `vscode.SecretStorage`, never in settings files.

### Copilot per-agent routing (optional)

By default, Copilot mode uses one global family/tier preference. You can override this per agent in VS Code settings:

```json
{
  "aiRoundtable.copilotModelFamily": "auto",
  "aiRoundtable.modelTier": "heavy",
  "aiRoundtable.copilotAgentFamilies": {
    "gpt": "gpt-4o",
    "claude": "claude"
  },
  "aiRoundtable.copilotAgentTiers": {
    "gpt": "heavy",
    "claude": "light"
  },
  "aiRoundtable.copilotStrictAgentFamily": false
}
```

- `copilotAgentFamilies`: override requested family per role agent (`claude`, `gpt`, `gemini`, `deepseek`)
- `copilotAgentTiers`: override light/heavy per role agent
- `copilotStrictAgentFamily=true`: fail fast if configured family is unavailable (no fallback)

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
8. If the AI suggested a verification command (e.g. `npm test`), a second approve/deny dialog follows — approving runs the command and feeds any failure back to the AI for analysis

### File deletions

When the AI removes a file via the `delete_file` tool, the file appears with a red **DEL** badge in the Proposed Changes panel and is deleted from disk when you click **Apply All Changes**.

### Verification after Apply

For Developer and QA rounds, the AI outputs a `VERIFY:` token at the end of its response specifying a command to run after your changes are on disk (e.g. `npm test`, `npx jest --coverage`). This token is stripped from the displayed response and surfaced as an approve/deny dialog immediately after **Apply All Changes**. If the command fails, the output is automatically sent back to the AI for diagnosis and fix suggestions.

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

### Metrics commands (optional)

If `aiRoundtable.enableMetrics` is enabled in settings, you can use:

- `AI Roundtable: Show A/B Report`
- `AI Roundtable: Clear Metrics`

---

## Project structure

```
src/
├── extension.ts          ← Activation, ConfigManager, command registration
├── errors.ts             ← Typed error hierarchy
├── types/index.ts        ← Enums, interfaces, webview message validators
├── prompts/
│   ├── roundPrompts.ts       ← Prompt builders (main/sub/reflection)
│   ├── roundPromptCatalog.ts ← Round-specific expertise/instructions
│   └── roundPromptPolicies.ts← Shared tool/reflection/sub-agent policies
├── agents/
│   ├── AgentRunner.ts    ← 3-step pipeline orchestration + VERIFY: extraction
│   ├── RoundExecutionStages.ts ← Stage execution (main/verify/reflect) + tool handlers
│   ├── CopilotProvider.ts← vscode.lm API (GitHub Copilot)
│   ├── ApiKeyProvider.ts ← Direct HTTPS: Anthropic / OpenAI / Google / DeepSeek
│   └── index.ts          ← Agent module exports
├── metrics/
│   └── RoundMetricsLogger.ts ← Local run metrics logger + markdown summary
├── workspace/
│   ├── WorkspaceReader.ts      ← Collects workspace context and handles read_file
│   ├── WorkspaceWriter.ts      ← Applies file writes/deletes and diff previews
│   ├── WorkspaceRootResolver.ts← Resolves multi-root workspace targets
│   ├── WorkspacePath.ts        ← Path formatting/resolution helpers
│   └── CommandSanitizer.ts     ← Normalizes/guards run_command execution
├── sessions/
│   └── SessionManager.ts ← Persists conversation history across sessions
├── verification/
│   └── issueParser.ts    ← Extracts consensus issues from verifier output
└── panels/
    ├── ChatPanel.ts      ← Webview lifecycle, message routing, apply/verify flow
    ├── RoundOrchestrator.ts ← Coordinates pipeline per round type
    └── webview/
        └── index.html    ← Chat UI (vanilla JS, sandboxed)
tests/
├── __mocks__/vscode.ts   ← VS Code API mock for Jest
├── unit/                 ← Unit tests
├── integration/          ← Integration tests for ChatPanel and pipeline behavior
└── vscode/               ← VS Code extension integration test entrypoint
```

---

## Troubleshooting

**"No GitHub Copilot language models are available"**
Ensure the GitHub Copilot extension is installed, you are signed in, and your subscription is active. Run `GitHub Copilot: Sign In` from the command palette.

**"No API key configured for claude"**
Run `AI Roundtable: Configure Provider`, choose API Keys, and enter your Anthropic key. The panel updates automatically — no need to reopen it.

**Extension does not activate**
Check that VS Code is `^1.88.0`. Run `Developer: Show Running Extensions` to confirm the extension is listed. If compile errors exist, run `npm run compile` and reload.

**File changes not applied after "Apply All Changes"**
The workspace must be open (not just a single file). Ensure VS Code has write permission to the target files. Check the Output panel (`AI Roundtable`) for error details.

**Copilot model selection times out (30s)**
This can happen if the Copilot API is temporarily unresponsive. The extension will throw `CopilotProviderError` and show an error in the panel. Retry the request, or switch to API key mode.

---

## Known limitations

- **Copilot model selection is best-effort** — even with per-agent family/tier preferences, VS Code Copilot may still resolve to a different available model under the requested family.
- **Conversation history resets when you switch round type** — switching from Developer to Reviewer starts a new conversation.
- **Max 80 workspace files** — large projects will still have some files omitted. Open the most relevant files before sending a request.
- **Shell command timeout: configurable (default 60 seconds, max 600)** — long-running commands may be cut off.
- **Max 80 KB per file** — files larger than 80 KB are truncated when read by the AI.
- **Max 140 read_file calls per turn** — uncached tool-driven file reads are capped per turn.
