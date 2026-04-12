# AI Roundtable — User Guide

This guide walks you through setting up and using AI Roundtable effectively. It covers the concepts you need, step-by-step instructions for common tasks, and tips for getting the best results from the AI pipeline.

---

## Table of Contents

1. [Concepts](#concepts)
2. [Setup](#setup)
3. [Opening the Panel](#opening-the-panel)
4. [Choosing a Round](#choosing-a-round)
5. [Choosing Agents](#choosing-agents)
6. [Sending a Request](#sending-a-request)
7. [Reviewing and Applying File Changes](#reviewing-and-applying-file-changes)
8. [Verification After Applying Changes](#verification-after-applying-changes)
9. [Working with Sessions](#working-with-sessions)
10. [Model Tier (Light vs Heavy)](#model-tier-light-vs-heavy)
11. [A/B Metrics (Optional)](#ab-metrics-optional)
12. [Common Workflows](#common-workflows)
13. [Tips for Best Results](#tips-for-best-results)
14. [Troubleshooting](#troubleshooting)

---

## Concepts

### What is a Round?

A **round** is a specialized AI mode for a specific phase of software development. Each round gives the AI a different role and a different set of instructions. For example:

- The **Developer** round instructs the AI to act as a Principal Software Engineer who writes production-grade code.
- The **Reviewer** round instructs the AI to act as a Staff Engineer conducting an adversarial code review.
- The **QA** round instructs the AI to write tests targeting ≥80% branch coverage.

Switching to a different round changes the AI's behavior entirely and resets the conversation history.

### What is a Main Agent?

The **main agent** is the AI model that produces the response to your request. You choose which model acts as the main agent — Claude, GPT, Gemini, DeepSeek, or GitHub Copilot.

### What is a Sub-Agent?

**Sub-agents** are additional AI models that independently verify the main agent's response. After the main agent produces its output, each sub-agent reviews it and provides feedback. The main agent then reflects on the feedback and, if warranted, revises its response.

You can select zero, one, or multiple sub-agents. More sub-agents increases reliability at the cost of more API calls and latency.

Sub-agents do not have tool access. They verify using the primary agent's context package:
- files read by the primary agent,
- files written by the primary agent, and
- command outputs produced by the primary agent.

**Why use sub-agents?** A second independent model reviewing an output catches errors the first model missed. Two independent reviewers flagging the same issue is strong evidence that the issue is real — and the pipeline uses this signal to decide what the main agent must fix.

### What is Reflection?

After sub-agents provide feedback, the main agent runs a third time in **reflection** mode. It receives its original response, all sub-agent feedback, and a decision rule:

- If **all** sub-agents flagged the same issue → the main agent **must** correct it.
- If only **some** sub-agents flagged it → the main agent **decides**; it must explain any rejections.

Reflection has strict safety constraints:
- `read_file` and `run_command` are disabled.
- The agent may modify only files that were written in Step 1 of the same turn.
- If a required fix touches files outside that set, it must report them via `OUT_OF_SCOPE_CHANGES_JSON` instead of editing those files.

---

## Setup

### Option A — GitHub Copilot (recommended for existing subscribers)

1. Install the **GitHub Copilot** extension from the VS Code marketplace.
2. Sign in with your GitHub account and confirm your subscription is active.
3. Open AI Roundtable — it will automatically use Copilot. No API keys needed.

### Option B — API Keys

1. Open the Command Palette (`Cmd+Shift+P` on Mac, `Ctrl+Shift+P` on Windows/Linux).
2. Run `AI Roundtable: Configure Provider`.
3. Select **API Keys**.
4. Enter your key for each provider you want to use. You only need at least one key — unused providers are disabled in the UI.

| Provider | Where to get a key |
|---|---|
| Anthropic (Claude) | console.anthropic.com |
| OpenAI (GPT) | platform.openai.com |
| Google (Gemini) | aistudio.google.com |
| DeepSeek | platform.deepseek.com |

Keys are stored securely in your OS keychain via VS Code's `SecretStorage`. They are never written to settings files or logs.

---

## Opening the Panel

**Via command palette:**
1. Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
2. Type `AI Roundtable: Open AI Roundtable Panel` and press Enter

**Via activity bar:**
Click the AI Roundtable icon in the left sidebar.

---

## Choosing a Round

The round selector appears at the top of the panel. Choose the round that matches what you want to accomplish:

| Round | Use when you want to... |
|---|---|
| **Requirements** | Turn a vague idea into precise, testable acceptance criteria |
| **Architect** | Design system architecture, tech stack, API contracts, data models |
| **Developer** | Write new features, fix bugs, or refactor existing code |
| **Reviewer** | Get an adversarial code review before merging — includes OWASP security checks |
| **QA** | Write unit tests, integration tests, and edge case coverage |
| **DevOps** | Create or improve Dockerfiles, CI/CD pipelines, or environment configs |
| **Documentation** | Generate or update README, API docs, or CHANGELOG |

**Tip:** Run rounds in order for a new feature — Requirements → Architect → Developer → Reviewer → QA. Each round builds on the documents produced by the previous one.

---

## Choosing Agents

### Main Agent

Select the AI model that will do the primary work. If you have multiple API keys configured, you can choose any of them. If you only have Copilot, it will be the only option.

In Copilot mode, available role agents are `Claude`, `GPT`, and `Gemini`. `DeepSeek` is available only in API Keys mode.

**Which main agent to choose:**
- **Claude** — strong at reasoning, long-context comprehension, and following complex instructions
- **GPT** — reliable all-rounder, good at structured output
- **Gemini** — large context window, useful for whole-codebase analysis
- **DeepSeek** — cost-effective, strong at code

### Sub-Agents (optional)

Select one or more additional agents to verify the main agent's output. For most tasks:

- **No sub-agents** — faster, uses fewer API calls; fine for simple tasks or when you trust the model
- **1 sub-agent** — good balance: catches obvious errors without large cost
- **2+ sub-agents** — highest reliability; use for critical reviews, security-sensitive code, or complex architecture

**Note:** The main agent and sub-agents must be different. Selecting the same model as both main and sub-agent is rejected by input validation.

---

## Sending a Request

1. Select your round and agents.
2. Type your request in the input box at the bottom of the panel.
3. Press `Enter` or click **Send**.

The UI shows the pipeline as it runs:
- **Thinking** — main agent is generating its response
- **Verifying** — sub-agents are reviewing (if selected)
- **Reflecting** — main agent is incorporating feedback (if sub-agents provided valid feedback)

Execution examples:
- **Main only**: main stage only. Verifying/reflecting are skipped.
- **Copilot: main=claude, sub=gpt+gemini**: `claude` (main) → `gpt` + `gemini` (verifiers in parallel) → `claude` (reflection).
- **Copilot: main=gpt, sub=claude**: `gpt` (main) → `claude` (verifier) → `gpt` (reflection).
- Reflection runs only when at least one verifier returns valid feedback.

You can **cancel** a request at any time using the Cancel button that appears while the pipeline is running.

### What to write in your request

Be specific. The AI has access to your workspace files and will read them, but it needs to know what you want.

**Good requests:**
- "Add a rate limiter middleware to src/api/router.ts that limits to 100 requests per minute per IP"
- "Review src/auth/jwt.ts for security issues — focus on token validation"
- "Write unit tests for WorkspaceWriter.applyChanges in src/workspace/WorkspaceWriter.ts, targeting error branches"

**Vague requests (harder for the AI):**
- "Fix the auth"
- "Review everything"
- "Add tests"

### Conversation history

Within a round, the AI remembers your prior messages. You can iterate:

```
Turn 1: "Design a caching strategy for the user profile endpoint"
  → AI proposes Redis with 5-minute TTL

Turn 2: "What if the user updates their profile — how do we invalidate it?"
  → AI refines the design with cache invalidation on write

Turn 3: "Write the implementation"
  → AI writes the code based on the agreed design
```

Switching to a different round clears the history for that round and starts fresh.

---

## Reviewing and Applying File Changes

When the AI writes files (via the `write_file` tool), a **Proposed Changes** panel appears at the bottom of the chat.

File write rules:
- `write_file` is the only supported write path for agent-generated file updates.
- Every `write_file` call must include complete file content.
- If a file is updated again in the same turn, the full file must be sent again.
- `FILE:` blocks in plain response text are not used by apply flow.

### Reviewing changes

- Files marked `[NEW]` will be created.
- Files marked `[MOD]` already exist and will be modified.
- Files marked `[DEL]` will be deleted.
- Click any file to open a **diff view** — VS Code shows the current file on the left and the proposed version on the right.

### Applying changes

Click **Apply All Changes** to write all proposed files to disk at once.

- If the changes include a dependency file (e.g. `package.json`, `requirements.txt`, `Cargo.toml`), a dialog will offer to run the install command automatically. Click **Approve** to run it, or **Deny** to skip.
- The file cache is cleared after applying — the next request will re-read files from disk.

### Discarding changes

Click **Discard** to dismiss the proposed changes without writing anything. The AI's response remains visible in the chat.

---

## Verification After Applying Changes

For **Developer** and **QA** rounds, the AI suggests a verification command to run after your file changes are written to disk (e.g. `npm test`, `npx jest --coverage`). This happens automatically as part of **Apply All Changes**:

1. Click **Apply All Changes** — files are written to disk.
2. If a dependency file changed (e.g. `package.json`), a dialog offers to run the install command first.
3. A dialog then asks: `Run verification command? npm test` — click **Run** to execute it.
4. If the command fails, the output is shown in a collapsible bubble and automatically sent to the AI for diagnosis and fix suggestions.
5. The AI proposes corrected files — apply them and the verification dialog appears again.

**Timeout:** The default command timeout is 60 seconds (configurable up to 600 seconds via `aiRoundtable.runnerTimeout` in settings). Long-running commands may be cut off — use targeted commands (e.g. `npx jest --testPathPattern=auth`) rather than full test suites when iterating.

---

## Working with Sessions

AI Roundtable automatically saves your conversation history. You can return to a previous session after restarting VS Code.

### Restoring a session

1. Open the panel.
2. Click the **History** or **Sessions** button (clock icon in the panel header).
3. Select a prior session from the list to restore its conversation history and round type.

### Starting fresh

Click **Clear Chat** in the panel to start a new conversation within the current round, without switching rounds.

---

## Model Tier (Light vs Heavy)

The **model tier** lets you trade response quality for speed and cost:

- **Light** — uses a faster, smaller model variant. Faster responses, lower cost. Good for quick tasks or iteration.
- **Heavy** — uses the most capable model variant. Best quality, but slower and more expensive. Use for complex architecture decisions, security-sensitive code, or final reviews.

Toggle the tier using the **Light / Heavy** selector in the panel. The current tier applies to all agents for the current session.

If you use Copilot mode, you can optionally override tier/family per agent in Settings:
- `aiRoundtable.copilotAgentFamilies` (`claude`, `gpt`, `gemini`)
- `aiRoundtable.copilotAgentTiers` (`heavy` / `light`)
- `aiRoundtable.copilotStrictAgentFamily` (strict mode: fail instead of family fallback)

Default Copilot role-first chains (when no overrides are set):
- `claude` heavy/light: `claude`
- `gpt` heavy: `gpt-4o -> gpt-4`
- `gpt` light: `gpt-4o-mini -> gpt-4o`
- `gemini` heavy/light: `gemini`
- With `copilotStrictAgentFamily=false` (default), unavailable families can fall back to other available Copilot families.

---

## A/B Metrics (Optional)

You can record local run metrics and compare single-agent vs verifier-enabled runs.

1. Enable `aiRoundtable.enableMetrics` in VS Code settings.
2. Run your normal rounds (metrics are stored in extension local storage only).
3. Open Command Palette and run:
   - `AI Roundtable: Show A/B Report`
   - `AI Roundtable: Clear Metrics` (to reset local metrics)

The report includes run counts, average duration, token usage, reflection rate, and verifier issue/consensus signals.

---

## Common Workflows

### Write a new feature from scratch

```
1. Requirements round
   "As a user I want to reset my password via email link"
   → docs/requirements.md is created or updated

2. Architect round
   "Design the password reset flow per requirements.md"
   → docs/architecture.md and docs/file-structure.md updated

3. Developer round (Claude main, GPT sub)
   "Implement the password reset feature per file-structure.md"
   → File changes proposed → Apply All Changes
   → package.json changed? → Approve: npm install
   → "Run verification command? npm test" → Approve
   → Failures? → AI diagnoses and proposes fixes → Apply → repeat

4. Reviewer round (GPT main, Claude sub)
   "Review the password reset implementation"
   → Findings listed → Confirm → Fixes applied

5. QA round (Claude main)
   "Write tests for the password reset flow targeting 80% branch coverage"
   → Test files proposed → Apply
   → "Run verification command? npm test" → Approve → confirm all pass
```

---

### Fix a bug

```
1. Open the buggy file in VS Code (it becomes the active file context)

2. Developer round
   "The createOrder function throws a TypeError when items is undefined.
    Add a guard clause and throw a ValidationError instead."
   → AI reads the file, writes the fix → Apply
   → "Run verification command? npm test" → Approve → confirm fix passes
```

---

### Review code before a PR

```
1. Open the changed files in VS Code

2. Reviewer round (Claude main, GPT sub)
   "Review src/auth/ for security issues, correctness, and edge cases"
   → OWASP Top 10 checked
   → Sub-agent adds an independent pass
   → CRITICAL / IMPORTANT / SUGGESTION findings listed
   → Confirm → Fixes applied
```

---

### Improve test coverage

```
1. Open the source file and its test file in VS Code

2. QA round (Claude main)
   "Add missing test coverage for WorkspaceWriter.applyChanges — 
    focus on error paths and edge cases"
   → AI reads existing tests, extends them → Apply
   → "Run verification command? npx jest --coverage ..."
   → Approve → check coverage report → fix gaps and repeat
```

---

### Generate documentation

```
Documentation round (Claude main)
   "Generate an accurate README for this project.
    The source files are the source of truth."
   → AI reads source files → write_file: README.md
   → Review diff → Apply
```

---

## Tips for Best Results

**Open relevant files before sending a request.**
The AI receives a list of all workspace files and reads the ones it needs. Opening the files you care about (they appear as active/visible tabs) gives the AI priority signals about what to focus on.

**Use docs/ files as shared context across rounds.**
The `docs/requirements.md`, `docs/architecture.md`, and `docs/file-structure.md` files are automatically read by the appropriate rounds. Keeping them up to date as you iterate means each round builds correctly on the last.

**Be specific about scope.**
"Review src/auth.ts" is better than "review the auth code" — it removes ambiguity about which files to include.

**Use sub-agents for critical changes.**
Security-sensitive code, new dependencies, and architecture decisions benefit most from a second reviewer. One sub-agent is usually sufficient.

**Iterate within a round before switching.**
Conversation history persists within a round. You can ask follow-up questions, request changes, or clarify intent without restarting. The AI knows what it wrote in prior turns.

**Run the Reviewer round before merging.**
The Reviewer round checks OWASP Top 10 automatically and enforces a two-step process (findings first, fixes after confirmation) to prevent accidental changes. Use it as a final gate before any PR.

**Use targeted verification commands.**
When the AI prompts "Run verification command?", the suggested command is often `npm test` (full suite). If the suite is large, click **Deny** and ask the AI to verify with a narrower command instead (e.g. "verify with `npx jest --testPathPattern=auth`"). The AI's diagnosis is also more focused when the output is specific to the code you changed.

**Cancel and retry if a response is wrong.**
The Cancel button appears while a request is running. If the response takes an unexpected direction, cancel early and rephrase your request with more specific constraints.

---

## Current Limitations

- Sub-agents are verifier-only and cannot call tools (`read_file`, `run_command`, `write_file`, `delete_file`).
- Sub-agent verification can only use context passed from the primary agent (files read/written and command outputs from that turn).
- Reflection cannot call `read_file` or `run_command`.
- Reflection can modify only files written by the primary agent in Step 1 of the same turn.

---

## Troubleshooting

### "No GitHub Copilot language models are available"

The Copilot extension is either not installed, not signed in, or your subscription has lapsed.

1. Install **GitHub Copilot** from the VS Code marketplace.
2. Run `GitHub Copilot: Sign In` from the command palette.
3. Confirm your subscription is active at github.com/settings/copilot.

### "No API key configured for claude"

1. Open the Command Palette → `AI Roundtable: Configure Provider`.
2. Select **API Keys**.
3. Enter your Anthropic API key.

The panel updates automatically — you do not need to reopen it.

### File changes not applied after "Apply All Changes"

- Confirm a workspace folder is open (not just a loose file: `File → Open Folder`).
- Check VS Code has write permissions to the target directory.
- Open the Output panel (`View → Output`) and select **AI Roundtable** from the dropdown for error details.

### The AI keeps rewriting files I didn't ask it to change

The Developer and Architect rounds are scoped: if you name specific files or describe a specific change, the AI is instructed to write only those files. Make your request more specific:

> "Fix the error handling in src/users/service.ts only — do not change any other files."

### The Reviewer round stops with "⛔ HITL_REQUIRED"

This is expected behavior, not an error. The Reviewer round detected a new dependency or migration file — changes that require human verification before the AI proposes fixes. Follow the instructions in the `HITL_REQUIRED` message (typically: run a security audit, confirm the change is intentional, then re-run the Reviewer round).

### Responses are slow

- Switch to the **Light** model tier for faster responses on simpler tasks.
- Reduce the number of sub-agents — each sub-agent is an additional API call that runs in parallel.
- If using Copilot mode, try switching to API key mode — direct API calls can be faster than the Copilot API routing layer.

### Context window usage is near 100%

The context gauge in the panel header shows how much of the model's context window is in use. When it approaches the limit:

- Close tabs for files that are not relevant to your current task.
- Start a new session (`Clear Chat`) if you have accumulated many turns of history.
- Switch to a model with a larger context window (Claude or Gemini support up to 200K tokens).
