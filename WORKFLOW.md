# AI Roundtable — Workflow

## Overview

AI Roundtable is a VS Code extension that runs a multi-agent AI pipeline in your workspace. Pick a round type, choose a main agent and optional sub-agents (verifiers), describe what you want, and the extension:

1. Collects workspace files as context
2. Runs the main agent
3. Runs sub-agents in parallel to verify the result (if selected)
4. Has the main agent reflect on the feedback
5. Presents proposed file changes with diff preview
6. Applies accepted changes directly to your workspace

---

## Architecture

```
VS Code Extension Host
├── extension.ts           ← Activation, command registration, ConfigManager
├── panels/
│   ├── ChatPanel.ts       ← Webview panel lifecycle, message routing
│   └── webview/index.html ← Chat UI (vanilla JS, sandboxed webview)
├── agents/
│   ├── AgentRunner.ts     ← 3-step pipeline (main → sub verify → reflect)
│   ├── CopilotProvider.ts ← vscode.lm API (GitHub Copilot)
│   └── ApiKeyProvider.ts  ← Direct HTTPS to Anthropic / OpenAI / Google / DeepSeek
├── workspace/
│   ├── WorkspaceReader.ts ← Collects open/visible/workspace files as context
│   └── WorkspaceWriter.ts ← Parses FILE: blocks, applies WorkspaceEdit
├── prompts/
│   └── roundPrompts.ts    ← System prompts for all 8 round types
├── types/index.ts         ← Shared types + webview input validators
└── errors.ts              ← Typed error hierarchy
```

---

## Provider Setup

### GitHub Copilot mode
- Uses `vscode.lm` API — no API keys needed
- Requires an active GitHub Copilot subscription
- Model family order: `gpt-4o → gpt-4 → claude → gemini → any`

### API Keys mode
- Keys stored in `vscode.SecretStorage` (OS keychain — never in settings or logs)
- Configure via Command Palette: `AI Roundtable: Configure Provider`

| Agent | Provider | Model |
|---|---|---|
| `claude` | Anthropic | `claude-sonnet-4-6` |
| `gpt` | OpenAI | `gpt-4o` |
| `gemini` | Google | `gemini-1.5-pro` |
| `deepseek` | DeepSeek | `deepseek-coder` |

Agents without a configured key are automatically disabled in the UI.

---

## 3-Step Agent Pipeline

Every round follows the same pipeline:

```
Step 1 — Main agent
  Receives: system prompt + workspace context + conversation history + user message
  Produces: initial response

Step 2 — Sub-agents verify in parallel (skipped if none selected)
  Each sub-agent receives: main agent's response + user message
  Produces: independent feedback (shown in UI as verifier messages)
  Failure: gracefully degraded → shown as [Verification unavailable]

Step 3 — Main agent reflects (skipped if no valid feedback)
  Receives: initial response + all sub-agent feedbacks
  Rules:
    - ALL sub-agents flagged the same issue → mandatory correction
    - Only some flagged it → main agent decides; must write REJECTED [agent]: [reason] if rejecting
  Produces: final refined response

→ FILE: blocks parsed → proposed as file changes
```

---

## Round Types

### Requirements
**Role**: Principal Product Engineer

**Main agent only:**
- Checks `docs/requirements.md` in workspace — extends it if found, creates fresh if not
- Applies INVEST criteria and Gherkin acceptance criteria
- Surfaces ambiguities (idempotency, ownership, deletion, pagination)
- Outputs `FILE: docs/requirements.md`

**With sub-agents:**
- Sub-agents verify completeness of requirements and surface additional ambiguities
- Main agent reflects and produces a more thorough spec

---

### Architect
**Role**: Distinguished Software Architect

**Main agent only:**
- Reads `docs/requirements.md`, `docs/architecture.md`, `docs/file-structure.md` if present
- Applies Clean Architecture + 12-Factor principles
- Outputs `FILE: docs/architecture.md` + `FILE: docs/file-structure.md`

**With sub-agents:**
- Sub-agents challenge tech stack choices, scalability, and security architecture
- Main agent reflects — if unanimous disagreement on a design choice, it must revise

---

### Developer
**Role**: Principal Software Engineer

**Main agent only:**
- Reads existing source files before writing — extends rather than rewrites
- Writes complete, immediately runnable code for every file in `docs/file-structure.md`
- All output uses `FILE: path\n\`\`\`lang\ncode\`\`\`` format — no prose code blocks
- Flags `⚠️ UNVERIFIED`, `⚠️ SECURITY_SENSITIVE`, `⚠️ VERSION_CONFLICT` when applicable
- If dependency files change → after Apply, prompts to run install command

**With sub-agents:**
- Sub-agents review code quality, error handling, and security
- If all sub-agents flag the same issue (e.g. missing error handling), main agent must fix it

---

### Reviewer
**Role**: Staff Engineer

**Main agent only:**
- Checks `docs/requirements.md` and `docs/architecture.md` for correctness baseline
- HITL gate: new entries in `package.json`, `requirements.txt`, `pyproject.toml`, `Cargo.toml`, `go.mod`, or new migration files → outputs `⛔ HITL_REQUIRED` with specific user actions
- Auto-generated lockfiles (`package-lock.json`, `yarn.lock`, etc.) are ignored
- Two-step output: findings first → user confirms → FILE: fixes

**With sub-agents:**
- Sub-agents provide independent review passes
- Main agent reflects on feedback but still follows two-step rule (no FILE: blocks until user confirms)

---

### QA
**Role**: Principal QA Engineer

**Main agent only:**
- Reads existing test files — extends coverage rather than rewriting
- Hard floor: ≥80% branch coverage on changed files
- Covers unit, integration, edge cases, failure/resilience, and security tests (when touching auth/payment/crypto paths)
- All output uses `FILE:` format

**With sub-agents:**
- Sub-agents identify coverage gaps and incorrect assertions
- If unanimous agreement on a missing test scenario, main agent must add it

---

### DevOps
**Role**: Senior Platform Engineer

**Main agent only:**
- Reads existing `Dockerfile`, `.github/workflows/`, `.env.example` — audits and corrects rather than regenerating
- Generates: multi-stage Dockerfile (non-root, pinned base image), `.env.example`, `.github/workflows/ci.yml`
- All output uses `FILE:` format

**With sub-agents:**
- Sub-agents audit for security misconfiguration and 12-Factor compliance
- Main agent reflects on findings

---

### Runner
**Role**: SRE / Runtime Debugger

**Flow:**
```
User types command → Run button
  → cp.exec(command, { cwd: workspaceRoot, timeout: 60s })
  → stdout + stderr combined (max 50 KB)
  → executionComplete posted to UI
  → auto-feeds output into 3-step pipeline as RUNNER round message
  → AI analyzes: errors (root cause + fix), warnings, successes, test failures
  → FILE: corrections if needed
```

**With sub-agents:**
- Sub-agents verify the AI's diagnosis and proposed fixes
- Useful for ambiguous failures where multiple root causes are possible

**`runAgain`**: re-executes the last command without re-typing. Useful for iterating after applying fixes.

**AI-suggested commands**: If the AI outputs `RUN: <command>` during any round, it renders as a clickable button in the UI. Clicking shows an approve/deny dialog before execution.

---

### Documentation
**Role**: Staff Technical Writer

**Main agent only:**
- Reads source files as the single source of truth — documents what code actually does
- Updates existing `README.md`, `CHANGELOG.md`, `docs/` — does not rewrite accurate sections
- Outputs `README.md`, API docs, `CHANGELOG.md` (Keep a Changelog format) as `FILE:` blocks

**With sub-agents:**
- Sub-agents verify accuracy against the actual code and flag stale or missing sections
- Main agent reflects and produces more thorough documentation

---

## File Changes Flow

```
Agent outputs FILE: blocks
  → parseFileChanges() — path-sanitized, deduplicated, max 50 files
  → ChatPanel enriches isNew flag (stat() each file)
  → Webview shows "Proposed File Changes" panel
      [MOD] src/auth.ts   [NEW] src/middleware/jwt.ts
  → Click file → vscode.diff preview (current vs proposed)
  → "Apply All Changes"
      → validateApplyChangesPayload() (re-validated in extension host)
      → WorkspaceWriter.applyChanges() → vscode.workspace.applyEdit
      → If dependency files changed → approve/deny dialog for install command
  → "Discard" → panel hides, no changes written
```

---

## Conversation History

- Each round type has its own conversation history
- History resets when the user switches round type
- History is passed to the main agent on every turn (multi-turn within a round)
- Sub-agent verification calls do not receive conversation history — only the main agent's latest response

---

## Security Model

| Surface | Protection |
|---|---|
| API keys | `vscode.SecretStorage` — never in settings or logs |
| Webview input | Validated before dispatch (typed, length-checked, path-traversal-rejected) |
| File paths from agent | `..` rejected, absolute paths rejected (2 layers: parser + handler) |
| Workspace traversal | `path.relative` check prevents symlink escapes |
| Webview XSS | `textContent` only (no `innerHTML`), strict CSP with per-session nonce |
| Error messages | Truncated to 300 chars, never include stack traces or API keys |
| Sensitive files | `.env`, `*secret*`, `*credential*`, `*password*`, private key extensions excluded from workspace context |

---

## Use Cases

### 1 — Greenfield feature (full pipeline)

**Goal**: Build a new JWT authentication module from scratch.

```
Requirements round (Claude main, GPT sub)
  "Add JWT auth: login, logout, token refresh"
  → docs/requirements.md with acceptance criteria

Architect round (Claude main, Gemini sub)
  "Design the auth module per requirements.md"
  → docs/architecture.md + docs/file-structure.md

Developer round (Claude main, GPT sub)
  "Implement every file in docs/file-structure.md"
  → FILE: blocks for src/auth/*.ts → apply changes
  → package.json changed → approve/deny: npm install

Reviewer round (GPT main, Claude sub)
  "Review the auth implementation"
  → new deps detected → ⛔ HITL_REQUIRED: run npm audit first
  → findings → user confirms → FILE: fixes

QA round (Claude main)
  "Write tests for the auth module"
  → FILE: tests/auth/*.test.ts → apply changes

Runner round
  runCommand: "npm test"
  → AI analyzes failures, proposes fixes → runAgain
```

---

### 2 — Bug fix

**Goal**: Fix a specific bug in an open file.

```
Open the buggy file in VS Code (becomes Priority 1 context)

Developer round (Claude main)
  "getUser() returns undefined for deleted users, should throw NotFoundError"
  → FILE: src/users/service.ts with fix → apply changes

Runner round
  runCommand: "npm test -- --testPathPattern=users"
  → AI confirms fix passes, or diagnoses remaining failures
```

---

### 3 — Code review before PR

**Goal**: Review changed files for bugs and security issues.

```
Open changed files in VS Code (visible tabs → Priority 2 context)

Reviewer round (Claude main, GPT sub)
  "Review these changes for correctness and security"
  → OWASP Top 10 checked automatically
  → Sub-agent provides independent verification
  → CRITICAL / IMPORTANT / SUGGESTION findings
  → User confirms → FILE: corrections
```

---

### 4 — Test coverage gap

**Goal**: Improve test coverage on an existing module.

```
Open source file + its test file in VS Code

QA round (Claude main)
  "Add missing branch coverage for parseFileChanges"
  → AI reads current tests from workspace context
  → FILE: tests/unit/WorkspaceWriter.test.ts → apply

Runner round
  runCommand: "npx jest --coverage tests/unit/WorkspaceWriter.test.ts"
  → AI reads coverage report, identifies remaining gaps → runAgain
```

---

### 5 — Documentation generation

**Goal**: Generate an accurate README from the current codebase.

```
Documentation round (Claude main)
  "Generate the README for this project"
  → workspace context includes source files
  → FILE: README.md → review diff → apply
```

---

### 6 — Multi-turn architecture discussion

**Goal**: Iterate on a design over multiple turns.

```
Architect round — conversation history persists within the round

Turn 1: "Design a rate limiting system for this API"
  → Claude proposes token bucket + Redis

Turn 2: "What if we want per-user AND per-IP limits simultaneously?"
  → Claude refines: dual counters, explains key structure

Turn 3: "Show me the Redis data model"
  → FILE: docs/architecture.md with key/value schema

(Switching to Developer round resets history)
```

---

## Message Protocol

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
| `runAgain` | — | Re-execute last command |
| `executeCommand` | `{ command }` | Request approve/deny then execute a command |

### Extension Host → Webview

| Type | Payload | Description |
|---|---|---|
| `addMessage` | `{ id, role, agentName?, content, isSubAgentFeedback? }` | Append a message |
| `updateMessage` | `{ id, content }` | Update existing message |
| `setLoading` | `{ loading }` | Enable/disable input |
| `showFileChanges` | `{ fileChanges[] }` | Show proposed changes panel |
| `clearFileChanges` | — | Hide changes panel |
| `configLoaded` | `{ providerMode, hasApiKeys, availableAgents }` | Send config to webview |
| `error` | `{ message }` | Show error message |
| `executionStarted` | `{ command }` | Shell command is running |
| `executionComplete` | `{ command, output, exitCode }` | Shell command finished |
