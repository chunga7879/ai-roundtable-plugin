# AI Roundtable — Workflow

## Overview

AI Roundtable is a VS Code extension that runs a structured multi-agent AI pipeline in your workspace. Every request goes through up to three steps:

1. **Main agent** — produces the initial response using workspace files as context
2. **Sub-agents** — independently verify the main agent's output (skipped if none selected)
3. **Reflection** — main agent incorporates feedback and produces the final response

The number of sub-agents selected determines which steps run and how the pipeline behaves.

---

## Architecture

```
VS Code Extension Host
├── extension.ts           ← Activation, command registration, ConfigManager
├── errors.ts              ← Typed error hierarchy
├── panels/
│   ├── ChatPanel.ts       ← Webview panel lifecycle, message routing
│   ├── RoundOrchestrator.ts ← Coordinates pipeline per round turn
│   └── webview/index.html ← Chat UI (vanilla JS, sandboxed webview)
├── agents/
│   ├── AgentRunner.ts     ← High-level round runner
│   ├── RoundExecutionStages.ts ← Stage execution + tool handling policy
│   ├── CopilotProvider.ts ← vscode.lm API (GitHub Copilot)
│   └── ApiKeyProvider.ts  ← Direct HTTPS to Anthropic / OpenAI / Google / DeepSeek
├── metrics/
│   └── RoundMetricsLogger.ts ← Optional local A/B metrics logging/reporting
├── workspace/
│   ├── WorkspaceReader.ts ← Collects open/visible/workspace files as context
│   ├── WorkspaceWriter.ts ← Applies WorkspaceEdit + diff previews
│   ├── WorkspaceRootResolver.ts ← Multi-root workspace targeting
│   ├── WorkspacePath.ts   ← Path normalization/formatting helpers
│   └── CommandSanitizer.ts ← run_command normalization/safety helpers
├── sessions/
│   └── SessionManager.ts  ← Persists and restores conversation history
├── verification/
│   └── issueParser.ts     ← Extracts consensus issues from verifier outputs
├── prompts/
│   ├── roundPrompts.ts        ← Prompt builders (main/sub/reflection)
│   ├── roundPromptCatalog.ts  ← Round-specific expertise/instructions
│   └── roundPromptPolicies.ts ← Shared tool/reflection/sub-agent policies
└── types/index.ts         ← Shared types + webview input validators
```

---

## Provider Setup

### GitHub Copilot mode
- Uses `vscode.lm` API — no API keys needed
- Requires an active GitHub Copilot subscription
- Auto family order (heavy): `gpt-4o → gpt-4 → claude → gemini`
- Auto family order (light): `gpt-4o-mini → gpt-4o → claude → gemini`

### API Keys mode
- Keys stored in `vscode.SecretStorage` (OS keychain — never in settings or logs)
- Configure via Command Palette: `AI Roundtable: Configure Provider`

| Agent | Provider | Model |
|---|---|---|
| `claude` | Anthropic | heavy: `claude-sonnet-4-6` / light: `claude-haiku-4-5-20251001` |
| `gpt` | OpenAI | heavy: `gpt-4o` / light: `gpt-4o-mini` |
| `gemini` | Google | auto-selects from heavy/light candidate families |
| `deepseek` | DeepSeek | heavy: `deepseek-coder` / light: `deepseek-chat` |

Agents without a configured key are automatically disabled in the UI.

---

## The 3-Step Pipeline

### Step 1 — Main Agent

**Input:**
- System prompt: role expertise + execution instructions (tool-call directives, output format rules, Definition of Done)
- Workspace context: list of files in the workspace (agent reads specific files via `read_file` tool)
- Conversation history: all prior turns in the current round
- User message

**What happens:**
- Agent calls `read_file` for files it needs (up to the tool call limit)
- Agent produces prose response and/or calls `write_file` for each file it creates or modifies
- Agent may call `run_command` only for checks against current on-disk workspace state (for example dependency/security checks)
- Validation of newly written files belongs in `VERIFY:` post-apply commands, not `run_command`

**Output:**
- Text response (streamed to UI)
- Zero or more file writes via `write_file` tool

---

### Step 2 — Sub-Agent Verification (skipped if no sub-agents selected)

**Input per sub-agent:**
- System prompt: role expertise only — no tool-call instructions (sub-agents cannot call tools)
- Files read by the main agent during Step 1
- Files written by the main agent during Step 1
- Command outputs produced by the main agent during Step 1
- Prior user turns from conversation history (for context)
- Main agent's full response from Step 1
- User message

Sub-agents run **in parallel**. Each produces independent feedback without seeing the other sub-agents' responses.

**Output per sub-agent:**
- Feedback text (shown in UI as a verifier message)
- If a sub-agent fails: `[Verification unavailable: <reason>]` — the round continues without that agent's feedback

---

### Step 3 — Reflection (skipped if no valid sub-agent feedback)

**Input:**
- Reflection system prompt (role expertise + reflection-only overrides)
- Main agent's Step 1 response
- For all rounds: full content of files written in Step 1 (so reflection can apply precise fixes via `write_file`)
- All valid sub-agent feedbacks

**Reflection rules:**
- Mandatory issues come from code-extracted consensus list (`[MANDATORY CONSENSUS ISSUES — CODE-EXTRACTED]`)
- ALL valid sub-agents flagged the same issue → main agent **must** correct it
- Only some sub-agents flagged an issue → main agent decides; must write `REJECTED [agent]: [reason]` if rejecting feedback
- `read_file` and `run_command` are disabled in reflection
- Reflection may modify only files written in Step 1 of the same turn
- If a required fix touches other files, reflection must emit `OUT_OF_SCOPE_CHANGES_JSON` instead of editing them

**Output:**
- Final refined text response (streamed to UI)
- Zero or more file writes via `write_file` tool

---

## Round-by-Round Workflow

### Requirements

**Role**: Principal Product Engineer

#### Main Agent Only

**Input:**
- System prompt: INVEST criteria, Gherkin acceptance criteria, ambiguity checklists
- `read_file` call to `docs/requirements.md` (if it exists in the workspace)
- User message describing the feature or change

**Process:**
1. Reads existing `docs/requirements.md` if present (treats it as baseline; extends rather than rewrites)
2. Applies INVEST criteria and Gherkin-style acceptance criteria
3. Surfaces ambiguities: idempotency, ownership, deletion, pagination
4. Writes the complete merged specification via `write_file`

**Output:**
- Prose explanation of what changed and why
- `write_file: docs/requirements.md` — complete specification

#### Main Agent + 1 Sub-Agent

Same Step 1 as above, then:

**Sub-agent input:**
- Sub-agent verifier prompt (requirements expertise, no tool instructions)
- Content of `docs/requirements.md` as read by the main agent
- Main agent's response
- User message

**Sub-agent output:** Feedback on completeness, missing acceptance criteria, unclear scope

**Reflection input:**
- Main agent's initial response + feedback
- Reflection rules apply

**Final output:**
- More thorough specification addressing surfaced ambiguities
- `write_file: docs/requirements.md` — updated complete specification

#### Main Agent + Multiple Sub-Agents

Same as above, with all sub-agents running in parallel. If all sub-agents flag the same missing requirement, main agent must add it. If only some flag it, main agent decides whether to include it.

---

### Architect

**Role**: Distinguished Software Architect

#### Main Agent Only

**Input:**
- System prompt: Clean Architecture, 12-Factor, security architecture, API contract standards
- `read_file` calls to `docs/requirements.md`, `docs/architecture.md`, `docs/file-structure.md` (if present)
- User message describing the design change or request

**Process:**
1. Reads requirements as the authoritative feature set
2. Reads existing architecture doc as current design baseline (extends, never rewrites unchanged sections)
3. Produces architecture document (tech stack decisions, layered diagram, data model, API contract, security architecture)
4. Updates file structure if new files are introduced, removed, or renamed

**Output:**
- Prose describing what changed and why (not a summary of unchanged sections)
- `write_file: docs/architecture.md` — always written (complete merged document)
- `write_file: docs/file-structure.md` — written only if file structure changed

#### Main Agent + 1 Sub-Agent

Same Step 1, then:

**Sub-agent input:**
- Architecture expertise prompt
- Content of all docs read by main agent
- Main agent's proposed architecture
- User message

**Sub-agent output:** Challenge on tech stack choices, scalability, security design

**Reflection:** Main agent revises if sub-agent raises unanimous concern

#### Main Agent + Multiple Sub-Agents

Sub-agents may challenge different aspects (e.g. one flags security, another flags scalability). Unanimous issues are mandatory corrections; partial disagreements are at main agent's discretion.

---

### Developer

**Role**: Principal Software Engineer

#### Main Agent Only

**Input:**
- System prompt: Clean Code, error handling, security (OWASP), performance, maintainability standards
- `read_file` calls to existing source files (workspace files are the source of truth — docs are hints only)
- User message describing the feature, fix, or refactor

**Process:**
1. Reads existing files before writing — extends or fixes rather than rewrites
2. Writes complete, immediately runnable code via `write_file` for each file
3. Uses `run_command` only for dependency/security checks against current on-disk workspace state when needed
4. Emits pre-output flags: `⚠️ UNVERIFIED`, `⚠️ SECURITY_SENSITIVE`, `⚠️ VERSION_CONFLICT` when applicable
5. Emits `VERIFY:` command(s) for post-apply validation of newly written code

**Output:**
- Prose: what was changed and any flags
- `write_file: <path>` — one call per file created or modified (complete content, no placeholders)
- `VERIFY: <command>` — suggested post-apply validation command

#### Main Agent + 1 Sub-Agent

Same Step 1, then:

**Sub-agent input:**
- Developer expertise prompt (no tool instructions)
- All files read during Step 1
- All files written during Step 1 (with content)
- Command outputs from Step 1
- Main agent's prose response
- User message

**Sub-agent output:** Code quality review — error handling gaps, security issues, test coverage

**Reflection input:**
- Main agent response + sub-agent feedback
- Full content of all files written in Step 1 (so the agent can produce targeted fixes)

**Reflection output:**
- Corrected code via `write_file` for each file that needs changes

#### Main Agent + Multiple Sub-Agents

Sub-agents may each flag different issues. If all flag the same missing error handler or security gap, main agent must fix it. Reflection includes full file content to enable precise surgical fixes.

---

### Reviewer

**Role**: Staff Engineer

#### Main Agent Only

**Input:**
- System prompt: OWASP Top 10, correctness bugs, race conditions, HITL gate rules
- `read_file` calls to all source files in scope
- `docs/requirements.md`, `docs/architecture.md` as reference (if present)
- User message defining the review scope

**Process:**
1. Checks for HITL gate triggers (new deps, migration files, `.env` modifications) — if triggered, outputs `⛔ HITL_REQUIRED` and stops
2. Reviews code against OWASP Top 10 and checklist (CRITICAL → IMPORTANT → SUGGESTION)
3. Two-step output: findings first — does NOT emit file fixes until user confirms

**Output (Step A — findings):**
- Structured review: `🔴 CRITICAL`, `🟡 IMPORTANT`, `🔵 SUGGESTION` findings
- Each finding: file + line number + description + corrected code
- Ends with: `APPROVED` or `CHANGES_REQUIRED` + confirmation prompt

**Output (Step B — after user confirms):**
- `write_file: <path>` for each file requiring correction

#### Main Agent + 1 Sub-Agent

Sub-agent provides an independent review pass. Main agent reflects on feedback but still follows the two-step rule — no file fixes are emitted until the user confirms after Step A.

#### Main Agent + Multiple Sub-Agents

All reviewers provide independent passes. Main agent aggregates findings. Unanimous CRITICAL findings must be addressed. The two-step rule is enforced regardless of the number of sub-agents.

---

### QA

**Role**: Principal QA Engineer

#### Main Agent Only

**Input:**
- System prompt: 80% branch coverage floor, unit/integration/edge/resilience/security test requirements
- `read_file` calls to existing source files and existing test files
- User message specifying what to test

**Process:**
1. Reads existing test files — extends coverage rather than rewriting
2. Identifies untested branches, edge cases, failure paths, and security scenarios
3. Writes complete test files via `write_file`
4. Outputs `VERIFY: <test command>` so the user can run tests after Apply

**Output:**
- Prose: what coverage was added and why
- `write_file: <test path>` — extended or new test files

#### Main Agent + 1 Sub-Agent

**Sub-agent input:**
- QA expertise prompt
- All files read during Step 1 (source + existing tests)
- Test files written during Step 1 (with content)
- Main agent's response
- User message

**Sub-agent output:** Identifies coverage gaps, incorrect assertions, missing scenarios

**Reflection:** Main agent adds missing test cases, fixes incorrect assertions. Full file content is passed to enable precise changes.

#### Main Agent + Multiple Sub-Agents

Each sub-agent may surface different missing scenarios. If all agree on a missing test scenario, main agent must add it. Reflection passes full file content for precision.

---

### DevOps

**Role**: Senior Platform Engineer

#### Main Agent Only

**Input:**
- System prompt: multi-stage Docker, 12-Factor, security misconfiguration checks
- `read_file` calls to `Dockerfile`, `.github/workflows/`, `.env.example` (if present)
- User message describing the infrastructure change

**Process:**
1. Audits and corrects existing configs rather than regenerating from scratch
2. Generates multi-stage Dockerfile (non-root user, pinned base image), `.env.example`, CI workflow
3. Writes all files via `write_file`

**Output:**
- `write_file: Dockerfile`
- `write_file: .env.example`
- `write_file: .github/workflows/ci.yml`
- (Only files actually changed)

#### Main Agent + 1 Sub-Agent

**Sub-agent input:**
- DevOps expertise prompt
- All config files read during Step 1
- Files written during Step 1
- Main agent's response

**Sub-agent output:** Security misconfiguration findings, 12-Factor compliance gaps

**Reflection:** Main agent revises affected configs via `write_file`

#### Main Agent + Multiple Sub-Agents

Each sub-agent may specialize (e.g. one focuses on Docker security, another on CI compliance). Unanimous findings are mandatory corrections.

---

### Documentation

**Role**: Staff Technical Writer

#### Main Agent Only

**Input:**
- System prompt: accuracy-first, source code as ground truth, Keep a Changelog format
- `read_file` calls to all source files (documents what code actually does)
- `read_file` calls to existing `README.md`, `CHANGELOG.md`, `docs/` files
- User message specifying what to document

**Process:**
1. Reads source files as the single source of truth
2. Updates existing docs — does not rewrite accurate sections
3. Writes complete documentation via `write_file`

**Output:**
- `write_file: README.md`
- `write_file: CHANGELOG.md` (Keep a Changelog format)
- `write_file: docs/<api or other>.md` as applicable

#### Main Agent + 1 Sub-Agent

**Sub-agent input:**
- Documentation expertise prompt
- All source files read during Step 1
- Documentation files written during Step 1 (with content)
- Main agent's response

**Sub-agent output:** Accuracy check against actual code, stale or missing sections

**Reflection:** Main agent corrects inaccuracies and fills gaps

#### Main Agent + Multiple Sub-Agents

Sub-agents independently verify accuracy across different parts of the docs. All flagged inaccuracies must be corrected. Reflection re-emits all documentation files with corrections applied.

---

## File Changes Flow

```
Agent calls write_file tool during Step 1 and/or Step 3
  → Normalized path (.. and absolute paths rejected)
  → Deduplicated (last write wins per path)
  → Reflection writes restricted to Step-1-written paths and capped per turn

ChatPanel enriches isNew flag (stat() each file path)
  → Webview shows "Proposed File Changes" panel
      [MOD] src/auth.ts   [NEW] src/middleware/jwt.ts

User clicks a file → VS Code diff preview (current vs proposed)

"Apply All Changes"
  → validateApplyChangesPayload() (re-validated in extension host)
  → WorkspaceWriter.applyChanges() → vscode.workspace.applyEdit
  → If dependency files changed → approve/deny dialog for install command
  → If AI output a VERIFY: command → approve/deny dialog to run verification command
      → If command exits non-zero → output fed back to AI for diagnosis and fix
  → File cache cleared (next turn re-reads from disk)

"Discard" → panel hides, no changes written
```

---

## Conversation History

- Each round type maintains its own conversation history
- History resets when the user switches round type
- History is passed to the main agent on every turn (multi-turn within a round)
- Sub-agent verification calls receive prior user turns for context, but not the full assistant history — only the main agent's latest response
- Sessions are persisted to disk via `SessionManager` and can be restored across VS Code restarts

---

## Security Model

| Surface | Protection |
|---|---|
| API keys | `vscode.SecretStorage` — never in settings or logs |
| Webview input | Validated before dispatch (typed, length-checked, path-traversal-rejected) |
| File paths from agent | `..` rejected, absolute paths rejected (tool handler + apply validation) |
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
  → write_file calls for src/auth/*.ts → apply changes
  → package.json changed → approve/deny: npm install

Reviewer round (GPT main, Claude sub)
  "Review the auth implementation"
  → new deps detected → ⛔ HITL_REQUIRED: run npm audit first
  → findings → user confirms → write_file calls with fixes

QA round (Claude main)
  "Write tests for the auth module"
  → write_file calls for tests/auth/*.test.ts → apply changes
  → "Run verification command? npm test" dialog → Approve → fix failures and retry
```

---

### 2 — Bug fix

**Goal**: Fix a specific bug in an open file.

```
Open the buggy file in VS Code (becomes active file context)

Developer round (Claude main)
  "getUser() returns undefined for deleted users, should throw NotFoundError"
  → read_file: src/users/service.ts
  → write_file: src/users/service.ts with fix → apply changes
  → "Run verification command?" dialog → Approve
```

---

### 3 — Code review before PR

**Goal**: Review changed files for bugs and security issues.

```
Open changed files in VS Code (visible tabs → context)

Reviewer round (Claude main, GPT sub)
  "Review these changes for correctness and security"
  → OWASP Top 10 checked automatically
  → Sub-agent provides independent verification
  → CRITICAL / IMPORTANT / SUGGESTION findings
  → User confirms → write_file calls with corrections
```

---

### 4 — Test coverage gap

**Goal**: Improve test coverage on an existing module.

```
Open source file + its test file in VS Code

QA round (Claude main)
  "Add missing branch coverage for WorkspaceWriter.applyChanges"
  → read_file: src/workspace/WorkspaceWriter.ts
  → read_file: tests/unit/WorkspaceWriter.class.test.ts
  → write_file: tests/unit/WorkspaceWriter.class.test.ts → apply
  → "Run verification command? npx jest --coverage tests/unit/WorkspaceWriter.class.test.ts" dialog
     → Approve → identify remaining gaps → fix and retry
```

---

### 5 — Documentation generation

**Goal**: Generate an accurate README from the current codebase.

```
Documentation round (Claude main)
  "Generate the README for this project"
  → workspace context includes source files
  → write_file: README.md → review diff → apply
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
  → write_file: docs/architecture.md with key/value schema

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
| `clearChat` | — | Clear current conversation |
| `retryLastMessage` | — | Retry the last failed message |
| `cancelRequest` | — | Cancel the in-flight request |
| `requestSessionList` | — | Load saved sessions |
| `restoreSession` | `{ sessionId }` | Restore a prior session |
| `setModelTier` | `{ tier }` | Switch between light and heavy model tier |

### Extension Host → Webview

| Type | Payload | Description |
|---|---|---|
| `addMessage` | `{ id, role, agentName?, content, isSubAgentFeedback? }` | Append a message |
| `updateMessage` | `{ id, content }` | Update existing message |
| `streamChunk` | `{ id, chunk }` | Append streaming chunk to a message |
| `finalizeMessage` | `{ id, content }` | Mark a streaming message as complete |
| `setLoading` | `{ loading }` | Enable/disable input |
| `showFileChanges` | `{ fileChanges[] }` | Show proposed changes panel |
| `clearFileChanges` | — | Hide changes panel |
| `configLoaded` | `{ providerMode, hasApiKeys, availableAgents, modelTier }` | Send config to webview |
| `error` | `{ message }` | Show error message |
| `suggestInstall` | `{ command }` | Suggest running an install command |
| `pipelineProgress` | `{ stage }` | Show thinking/verifying/reflecting indicator |
| `toolCallProgress` | `{ msgId, filePath }` | Show file being read or written |
| `contextUsage` | `{ pct, label }` | Show context window usage gauge |
| `sessionListLoaded` | `{ sessions[] }` | Return list of saved sessions |
| `sessionRestored` | `{ turns, roundType }` | Restore conversation turns from a session |
