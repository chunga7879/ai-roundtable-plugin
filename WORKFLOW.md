# AI Roundtable VS Code Extension — Workflow

## Overview

AI Roundtable is a VS Code extension that runs a **multi-agent AI pipeline** directly in your workspace. You pick a round type (e.g. Developer, Architect), choose a main agent and optional sub-agents (verifiers), describe what you want, and the extension autonomously:

1. Collects your workspace files as context
2. Runs the main agent
3. Runs sub-agents in parallel to verify the result
4. Has the main agent reflect on the feedback
5. Presents proposed file changes with a diff preview
6. Applies accepted changes directly to your workspace

---

## Architecture

```
VS Code Extension Host
│
├── extension.ts           ← Activation, command registration, ConfigManager
├── panels/
│   ├── ChatPanel.ts       ← Webview panel lifecycle, message routing
│   └── webview/
│       └── index.html     ← Chat UI (vanilla JS, runs in sandboxed webview)
├── agents/
│   ├── AgentRunner.ts     ← 3-step pipeline (main → sub verify → reflect)
│   ├── CopilotProvider.ts ← vscode.lm API (GitHub Copilot)
│   └── ApiKeyProvider.ts  ← Direct HTTPS to Anthropic / OpenAI / Google / DeepSeek
├── workspace/
│   ├── WorkspaceReader.ts ← Collects open/visible/workspace files as context
│   └── WorkspaceWriter.ts ← Parses FILE: blocks, applies WorkspaceEdit
├── prompts/
│   └── roundPrompts.ts    ← System prompts for all 8 round types
├── types/
│   └── index.ts           ← Shared types + webview input validators
└── errors.ts              ← Typed error hierarchy
```

---

## Phase 1 — First Run Setup

When the extension activates for the first time (`onStartupFinished`):

1. `activate()` in `extension.ts` runs
2. Reads current config via `ConfigManager.getConfig()`
3. If provider mode is `copilot` (default), checks `vscode.lm.selectChatModels({ vendor: 'copilot' })` after a 2-second delay
4. If GitHub Copilot is **not** found, shows an information message:
   > "GitHub Copilot was not found. Would you like to configure API keys instead?"
5. If user selects "Configure API Keys", the provider setup flow runs (see Phase 2)

Three commands are registered:
| Command | ID | Description |
|---|---|---|
| Open Panel | `aiRoundtable.openPanel` | Opens the chat panel |
| Configure Provider | `aiRoundtable.configureProvider` | Runs provider setup |
| Clear API Keys | `aiRoundtable.clearApiKeys` | Wipes all stored keys |

---

## Phase 2 — Provider Configuration

Two modes are supported:

### Mode A — GitHub Copilot (`copilot`)
- Uses `vscode.lm` API built into VS Code
- Requires an active **GitHub Copilot subscription**
- No API keys needed — uses the user's own subscription
- The extension calls `vscode.lm.selectChatModels({ vendor: 'copilot', family: '...' })` at request time
- Model family preference order: `gpt-4o → gpt-4 → claude → gemini → any`
- A 30-second timeout prevents VS Code from hanging if the API is unresponsive
- Model family can be pinned via `aiRoundtable.copilotModelFamily` setting (`auto` by default)

### Mode B — Direct API Keys (`api_keys`)
- Users enter one or more keys via `showInputBox` (password-masked)
- Keys are stored in **`vscode.SecretStorage`** (OS keychain: macOS Keychain / Windows Credential Manager / libsecret on Linux)
- Keys are **never** written to settings.json, logs, or source files
- Supported providers:

| Agent Name | Provider | Model | API Key Format |
|---|---|---|---|
| `claude` | Anthropic | `claude-sonnet-4-6` | `sk-ant-...` |
| `gpt` | OpenAI | `gpt-4o` | `sk-...` |
| `gemini` | Google | `gemini-1.5-pro` | `AIza...` |
| `deepseek` | DeepSeek | `deepseek-coder` | `sk-...` |

> Note: `copilot` agent cannot be used in API key mode — it always requires `vscode.lm`.

The config banner in the webview is shown when:
- Provider mode is `api_keys` AND no API keys have been stored

---

## Phase 3 — Chat Panel UI

Opening via command palette ("Open AI Roundtable Panel") or the activity bar icon creates a webview panel (`ChatPanel.createOrReveal`). Only one panel instance exists at a time — re-opening reveals the existing panel.

The webview UI has four sections:

```
┌─────────────────────────────────────────┐
│ ⚠ Config Banner (hidden when configured) │
├─────────────────────────────────────────┤
│ Controls                                 │
│   Round:      [Developer ▾]              │
│   Main Agent: [Claude    ▾]              │
│   Sub Agents: ☐ Copilot ☐ GPT ☐ Gemini  │
├─────────────────────────────────────────┤
│ Messages                                 │
│   You: "add JWT auth to this API"        │
│   System: Claude is thinking…            │
│   System: Verifiers running: GPT…        │
│   GPT (verifier): "missing refresh..."  │
│   Claude: [full response with code]      │
├─────────────────────────────────────────┤
│ Proposed File Changes (when present)     │
│   [MOD] src/auth.ts                      │
│   [NEW] src/middleware/jwt.ts            │
│   [Apply All Changes]   [Discard]        │
├─────────────────────────────────────────┤
│ [Describe what you want...         ][Send]│
└─────────────────────────────────────────┘
```

### Round Types

| Round | Role | What it does |
|---|---|---|
| `requirements` | Principal Product Engineer | Clarifies requirements, surfaces ambiguities, writes acceptance criteria in Gherkin format |
| `architect` | Distinguished Software Architect | Designs system, proposes tech stack, outputs architecture doc and file structure |
| `developer` | Principal Software Engineer | Writes complete production code for every file in the structure |
| `reviewer` | Staff Engineer | Adversarial code review, OWASP security checks, correctness — HITL gate for new deps |
| `qa` | Principal QA Engineer | Writes unit/integration/security tests, enforces ≥80% branch coverage |
| `devops` | Senior Platform Engineer | Dockerfile, CI/CD, env config, health endpoints |
| `runner` | SRE / Runtime Debugger | Executes a shell command, then analyzes stdout/stderr with AI |
| `documentation` | Staff Technical Writer | Generates README, API docs, CHANGELOG from the actual code |

### Input Rules
- Max message length: **32,000 characters**
- `Enter` sends, `Shift+Enter` adds a newline
- Input is disabled while a request is in-flight
- All payloads from the webview are validated before dispatch (typed, length-checked, path-traversal-rejected)

### Conversation History
- Each round type maintains its **own conversation history**
- History is **reset when the user switches round type**
- History is passed to the main agent on every turn, enabling multi-turn conversations within a round
- Sub-agent verification calls do **not** receive the user's conversation history — they only see the main agent's latest response

---

## Phase 4 — The 3-Step Agent Pipeline

When the user sends a message, `AgentRunner.runRound()` executes:

```
User message + workspace context
        │
        ▼
┌──────────────────────────────────────────┐
│ Step 1: Main Agent                        │
│  ─ System prompt for selected round       │
│  ─ Workspace files prepended as context  │
│  ─ Conversation history prepended        │
│  ─ Calls CopilotProvider or ApiKeyProvider│
│  ─ Returns initial response               │
└──────────────────────┬───────────────────┘
                       │
        ▼ (skip if no sub-agents selected,
           or all sub-agents == main agent)
┌──────────────────────────────────────────┐
│ Step 2: Sub Agents verify in parallel     │
│  ─ Each sub-agent runs independently     │
│  ─ Receives: main agent's response +     │
│    "please verify this for: [request]"   │
│  ─ No conversation history passed        │
│  ─ Sub-agent failure = graceful degrade  │
│    (shown as [Verification unavailable]) │
│  ─ Valid feedbacks collected             │
└──────────────────────┬───────────────────┘
                       │
        ▼ (skip if no valid feedbacks)
┌──────────────────────────────────────────┐
│ Step 3: Main Agent reflects              │
│  ─ Receives: original response +         │
│    all valid sub-agent feedbacks         │
│  ─ Produces final, improved response    │
└──────────────────────┬───────────────────┘
                       │
                       ▼
              Parse FILE: blocks
              → FileChange[]
```

### Cancellation
- A `CancellationTokenSource` is created per request
- Starting a new request cancels any in-flight request
- `isCancellationRequested` is checked after each `await`
- If cancelled, a "Request cancelled." system message is shown

### Progress Events
The pipeline emits these events to the UI in real time:

| Event | UI Message |
|---|---|
| `main_agent_start` | "Claude is thinking…" |
| `main_agent_done` | (silent) |
| `sub_agents_start` | "Verifiers running: GPT, Gemini…" |
| `sub_agents_done` | (silent) |
| `reflection_start` | "Claude is reflecting on feedback…" |
| `reflection_done` | (silent) |

---

## Phase 5 — Workspace Context

Before every request, `WorkspaceReader.buildContext()` collects files in this priority order:

1. **Currently active file** (the file you're editing)
2. **All visible editor tabs**
3. **Workspace files** — breadth-first from the root, sorted files-before-directories

### Limits
| Limit | Value |
|---|---|
| Max files included | 20 |
| Max file size | 50 KB (truncated with notice) |
| Max total context | 200 KB |

### Excluded automatically
- **Directories**: `node_modules`, `.git`, `dist`, `build`, `out`, `.next`, `.nuxt`, `coverage`, `__pycache__`, `.pytest_cache`, `venv`, `.venv`, `.tox`, `vendor`, `target`, `.gradle`
- **Extensions**: images, fonts, audio, video, archives, binaries, `.lock`, `.map`
- **Sensitive extensions**: `.pem`, `.key`, `.p12`, `.pfx`, `.cer`, `.crt`, `.der`
- **Filenames**: `.env`, `.npmrc`, `.pypirc`, `.netrc`, `.htpasswd`
- **Filename patterns**: `.env.*` (e.g. `.env.local`), files containing `secret`, `credential`, `password`, `private-key`

### Security
- Files outside the workspace root are rejected (symlink traversal prevention via `path.relative` check)

The context is prepended to the user message as:

```
[WORKSPACE CONTEXT]
Currently active file: src/auth.ts

FILE: src/auth.ts (typescript)
```typescript
// file content here
```

FILE: src/middleware.ts (typescript)
...

[END WORKSPACE CONTEXT]

---

User Request:
add JWT refresh token support
```

---

## Phase 6 — File Changes

If the agent response contains `FILE:` blocks, they are parsed and proposed to the user.

### Agent Output Format

Agents are instructed to output files like this:

```
FILE: src/auth/token.ts
```typescript
export function generateToken(userId: string): string {
  // implementation
}
```
```

### Parsing (`parseFileChanges`)
- Regex: `/^FILE:\s*(.+?)\s*\n```(?:\w+)?\n([\s\S]*?)```/gm`
- Path normalization: backslashes → forward slashes, strips leading `./` or `/`
- **Security rejections**: paths containing `..` are silently dropped
- **Deduplication**: only the first occurrence of a path is kept
- **Limit**: max 50 file changes per response

### Apply Flow

```
Agent produces FILE: blocks
        │
        ▼
WorkspaceWriter.parseFileChanges()
  → FileChange[] (path-sanitized)
        │
        ▼
ChatPanel enriches isNew flag
  → stat() each file to check existence
        │
        ▼
Webview shows "Proposed File Changes" panel
  ┌─ [MOD] src/auth.ts
  └─ [NEW] src/middleware/jwt.ts
        │
User clicks a file → preview diff
  → previewChange message → vscode.diff (left: current, right: proposed)
        │
User clicks "Apply All Changes"
  → validateApplyChangesPayload() (re-validates in extension host)
  → WorkspaceWriter.applyChanges()
  → vscode.workspace.applyEdit(WorkspaceEdit)
  → Existing files: replace full content
  → New files: createFile (including parent dirs)
        │
User clicks "Discard"
  → rejectChanges message → panel hides
```

---

## Phase 6b — Runner Round: Command Execution

The Runner round has a special flow for executing shell commands and feeding output to the AI.

```
User initiates runCommand { command, mainAgent, subAgents }
        │
        ▼
ChatPanel.handleRunCommand()
  ─ Saves command for runAgain
  ─ Posts executionStarted to webview (UI shows "Running: <command>")
        │
        ▼
cp.exec(command, { cwd: workspaceRoot, timeout: 60_000 })
  ─ stdout + stderr combined, truncated to 50 KB
  ─ Exit code captured
        │
        ▼
Posts executionComplete to webview
        │
        ▼
Auto-calls handleSendMessage with RUNNER round:
  "[Execution Output]
   Command: <command>
   Exit code: <N>

   <stdout/stderr>"
        │
        ▼
Standard 3-step pipeline runs (see Phase 4)
  ─ Main agent analyzes output
  ─ Sub-agents verify (optional)
  ─ Reflection (if feedback)
        │
        ▼
Runner AI response + any FILE: corrections
```

**`runAgain`**: re-executes the last command without user re-typing it. Useful for iterating on a test/build command after applying fixes.

---

## Phase 7 — Error Handling

All errors are caught and sanitized before reaching the UI:

| Error Type | Behavior |
|---|---|
| `CancellationError` | System message: "Request cancelled." |
| `AgentRunnerError` | Error message in chat (truncated to 300 chars) |
| `ProviderError` | Error message in chat |
| `WorkspaceWriterError` | Error message in chat |
| Any unexpected error | "An unexpected error occurred." |

**API keys are never included in error messages.** Error messages use provider names and HTTP status codes only.

---

## Security Model

| Surface | Protection |
|---|---|
| API key storage | `vscode.SecretStorage` (OS keychain) — never in settings or logs |
| Webview input | All payloads validated (`validateSendMessagePayload`, `validateApplyChangesPayload`) |
| File paths from agent | `..` rejection, absolute path rejection (2 layers: parser + webview handler) |
| Workspace traversal | `path.relative` check prevents symlink escapes |
| Webview XSS | `textContent` only (no `innerHTML`), strict CSP with per-session nonce |
| Error messages | Truncated to 300 chars, never include stack traces or API keys |
| Gemini API key | Appears in URL query param per Google convention — not logged by this extension, but may appear in proxy logs (accepted risk) |
| Sensitive files | `.env`, `.env.*`, `*secret*`, `*credential*`, `*password*`, private key extensions excluded from workspace context |

---

## Message Protocol (Webview ↔ Extension Host)

Communication is via `postMessage`. All messages are typed.

### Webview → Extension Host

| Type | Payload | Description |
|---|---|---|
| `sendMessage` | `{ userMessage, roundType, mainAgent, subAgents }` | Start a round |
| `applyChanges` | `{ fileChanges[] }` | Apply proposed file changes |
| `rejectChanges` | — | Discard proposed changes |
| `previewChange` | `{ fileChange }` | Open diff view for one file |
| `requestConfig` | — | Get current provider config |
| `configureProvider` | — | Open provider setup flow |
| `runCommand` | `{ command, mainAgent, subAgents }` | Execute shell command + run Runner AI |
| `runAgain` | — | Re-execute last `runCommand` |

### Extension Host → Webview

| Type | Payload | Description |
|---|---|---|
| `addMessage` | `{ id, role, agentName?, content, timestamp, isSubAgentFeedback? }` | Append a message |
| `updateMessage` | `{ id, content }` | Update existing message content |
| `setLoading` | `{ loading: boolean }` | Enable/disable input |
| `showFileChanges` | `{ fileChanges[] }` | Show proposed changes panel |
| `clearFileChanges` | — | Hide changes panel |
| `configLoaded` | `{ providerMode, hasApiKeys }` | Send config to webview |
| `error` | `{ message }` | Show error message |
| `executionStarted` | `{ command }` | Notify webview a shell command is running |
| `executionComplete` | `{ command, output, exitCode }` | Shell command finished |

---

## Use Cases

### Use case 1 — Greenfield feature (full pipeline)

**Goal**: Build a new JWT authentication module from scratch.

```
1. Requirements round (Claude main, GPT sub)
   → "Add JWT auth: login, logout, token refresh"
   → Output: docs/requirements.md with acceptance criteria

2. Architect round (Claude main, Gemini sub)
   → "Design the auth module per requirements.md"
   → Output: docs/architecture.md + docs/file-structure.md

3. Developer round (Claude main, GPT sub)
   → "Implement every file in docs/file-structure.md"
   → Output: FILE: blocks for src/auth/*.ts — apply changes

4. Reviewer round (GPT main, Claude sub)
   → "Review the auth implementation"
   → If new deps detected → HITL_REQUIRED gate triggers
   → Output: findings, then apply fixes

5. QA round (Claude main)
   → "Write tests for the auth module"
   → Output: FILE: tests/auth/*.test.ts — apply changes

6. Runner round
   → runCommand: "npm test"
   → AI analyzes test output, fixes failures
```

---

### Use case 2 — Bug fix with context

**Goal**: Fix a specific bug in an open file.

```
1. Open the buggy file in VS Code (it becomes Priority 1 context)

2. Developer round (Claude main)
   → "The getUser() function returns undefined for deleted users, it should throw NotFoundError"
   → Workspace context includes the open file automatically
   → Output: FILE: src/users/service.ts with the fix — apply changes

3. Runner round
   → runCommand: "npm test -- --testPathPattern=users"
   → AI confirms fix passes, or diagnoses remaining failures
```

---

### Use case 3 — Code review before PR

**Goal**: Review a set of changed files for bugs and security issues.

```
1. Open the changed files in VS Code (visible tabs → Priority 2 context)

2. Reviewer round (Claude main, GPT sub)
   → "Review these changes for correctness and security"
   → OWASP Top 10 checked automatically by the system prompt
   → Sub-agent provides independent verification
   → Output: CRITICAL / IMPORTANT / SUGGESTION findings
   → "Apply fixes" → FILE: blocks with corrections
```

---

### Use case 4 — Test coverage gap

**Goal**: Improve test coverage on an existing module.

```
1. Open the source file + its test file in VS Code

2. QA round (Claude main)
   → "Add missing branch coverage for the parseFileChanges function"
   → AI reads current tests from workspace context
   → Output: FILE: tests/unit/WorkspaceWriter.test.ts with new test cases
   → Apply changes

3. Runner round
   → runCommand: "npx jest --coverage tests/unit/WorkspaceWriter.test.ts"
   → AI reads coverage report, identifies remaining gaps
   → runAgain after each fix to verify
```

---

### Use case 5 — Documentation generation

**Goal**: Generate an accurate README from the current codebase.

```
1. Documentation round (Claude main)
   → "Generate the README for this project"
   → Workspace context includes source files (not node_modules)
   → System prompt: "document what the code actually does, not what it should do"
   → Output: FILE: README.md — review diff, apply
```

---

### Use case 6 — Multi-turn architecture discussion

**Goal**: Iterate on an architecture design over multiple turns.

```
Architect round — conversation history persists within the round:

Turn 1: "Design a rate limiting system for this API"
  → Claude proposes token bucket + Redis

Turn 2: "What if we want per-user AND per-IP limits simultaneously?"
  → Claude refines: dual counters, explains key structure

Turn 3: "Show me the Redis data model"
  → Claude outputs detailed key/value schema + FILE: docs/architecture.md

(Switching to Developer round resets history — new round, fresh context)
```

---

## Project Structure

```
ai-roundtable-plugin/
├── src/
│   ├── extension.ts          ← Activation, ConfigManager, commands
│   ├── errors.ts             ← RoundtableError → ProviderError, WorkspaceError, etc.
│   ├── types/index.ts        ← Enums, interfaces, webview validators
│   ├── prompts/
│   │   └── roundPrompts.ts   ← System prompts for all 8 rounds
│   ├── agents/
│   │   ├── AgentRunner.ts    ← 3-step pipeline orchestrator
│   │   ├── CopilotProvider.ts← vscode.lm integration
│   │   └── ApiKeyProvider.ts ← Anthropic / OpenAI / Google / DeepSeek HTTPS
│   ├── workspace/
│   │   ├── WorkspaceReader.ts← Context collection
│   │   └── WorkspaceWriter.ts← FILE: block parser + workspace apply
│   └── panels/
│       ├── ChatPanel.ts      ← Webview panel + message routing
│       └── webview/
│           └── index.html    ← Chat UI (vanilla JS)
├── tests/
│   ├── __mocks__/vscode.ts   ← VS Code API mock for Jest
│   ├── unit/                 ← Unit tests (190 passing)
│   └── integration/
│       └── ChatPanel.test.ts ← Integration tests for message routing
├── docs/
│   ├── requirements/
│   └── adr/
├── README.md
├── WORKFLOW.md               ← This file
└── package.json
```
