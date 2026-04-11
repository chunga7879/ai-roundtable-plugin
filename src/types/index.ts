import * as path from 'path';
import { ValidationError } from '../errors';

export enum RoundType {
  REQUIREMENTS = 'requirements',
  ARCHITECT = 'architect',
  DEVELOPER = 'developer',
  REVIEWER = 'reviewer',
  QA = 'qa',
  DEVOPS = 'devops',
  DOCUMENTATION = 'documentation',
}

export enum AgentName {
  COPILOT = 'copilot',
  CLAUDE = 'claude',
  GPT = 'gpt',
  GEMINI = 'gemini',
  DEEPSEEK = 'deepseek',
}

export enum ProviderMode {
  COPILOT = 'copilot',
  API_KEYS = 'api_keys',
}

export interface RoundConfig {
  roundType: RoundType;
  maxTokens: number;
}

export interface Message {
  id: string;
  role: 'user' | 'agent' | 'system' | 'error';
  agentName?: AgentName | string;
  content: string;
  timestamp: number;
  isSubAgentFeedback?: boolean;
  retryable?: boolean;
  streaming?: boolean;
}

export interface FileChange {
  filePath: string;
  content: string;
  isNew: boolean;
  isDeleted?: boolean;
}

export interface AgentResponse {
  content: string;
  fileChanges: FileChange[];
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface RoundRequest {
  userMessage: string;
  roundType: RoundType;
  mainAgent: AgentName;
  subAgents: AgentName[];
  workspaceContext: WorkspaceContext;
  conversationHistory: ConversationTurn[];
  /** Files already read in a previous turn — skip re-reading these via tool calls. */
  cachedFiles: Map<string, string>;
  /** Command outputs from the current turn — passed to sub-agents for verification. */
  cachedCommandOutputs: Map<string, CommandOutput>;
}

export interface WorkspaceContext {
  files: WorkspaceFile[];
  activeFilePath?: string;
}

export interface WorkspaceFile {
  path: string;
  content: string;
  language: string;
  truncated?: boolean;
}

export type ModelTier = 'light' | 'heavy';

export interface ExtensionConfig {
  providerMode: ProviderMode;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  googleApiKey?: string;
  deepseekApiKey?: string;
  copilotModelFamily?: string;
  modelTier: ModelTier;
  runnerTimeoutMs: number;
  enableMetrics?: boolean;
}

export interface SubAgentVerification {
  agentName: AgentName;
  feedback: string;
}

export type ToolCall =
  | { id: string; name: 'read_file'; filePath: string }
  | { id: string; name: 'run_command'; command: string }
  | { id: string; name: 'write_file'; filePath: string; content: string }
  | { id: string; name: 'delete_file'; filePath: string };

export interface CommandOutput {
  command: string;
  stdout: string;
  exitCode: number;
}

export interface ToolResult {
  id: string;
  content: string;
  isError: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface RoundResult {
  mainAgentResponse: string;
  subAgentVerifications: SubAgentVerification[];
  reflectedResponse: string;
  fileChanges: FileChange[];
  tokenUsage?: TokenUsage;
  /** Command the AI suggested to run after Apply to verify its changes (e.g. "npm test"). */
  verifyCommand?: string;
}

// ── Session persistence ───────────────────────────────────────────────────────

export interface SessionIndexEntry {
  id: string;
  workspaceId: string;
  roundType: RoundType;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  /** First 80 chars of the first user turn — shown in the history list. */
  preview: string;
}

export interface PersistedSession {
  id: string;
  workspaceId: string;
  roundType: RoundType;
  createdAt: number;
  updatedAt: number;
  turns: ConversationTurn[];
}

export type WebviewToExtensionMessage =
  | { type: 'sendMessage'; payload: SendMessagePayload }
  | { type: 'applyChanges'; payload: ApplyChangesPayload }
  | { type: 'setModelTier'; payload: { tier: ModelTier } }
  | { type: 'rejectChanges' }
  | { type: 'requestConfig' }
  | { type: 'configureProvider' }
  | { type: 'clearChat' }
  | { type: 'retryLastMessage' }
  | { type: 'cancelRequest' }
  | { type: 'requestSessionList' }
  | { type: 'restoreSession'; payload: { sessionId: string } };

export interface SendMessagePayload {
  userMessage: string;
  roundType: RoundType;
  mainAgent: AgentName;
  subAgents: AgentName[];
}

export interface ApplyChangesPayload {
  fileChanges: FileChange[];
}

export interface ContextFileSummary {
  path: string;
  truncated: boolean;
}

export type ExtensionToWebviewMessage =
  | { type: 'addMessage'; payload: Message }
  | { type: 'removeMessage'; payload: { id: string } }
  | { type: 'addCollapsibleMessage'; payload: { id: string; title: string; content: string } }
  | { type: 'updateMessage'; payload: { id: string; content: string } }
  | { type: 'streamChunk'; payload: { id: string; chunk: string } }
  | { type: 'finalizeMessage'; payload: { id: string; content: string } }
  | { type: 'interruptMessage'; payload: { id: string } }
  | { type: 'stopStreaming'; payload: { id: string } }
  | { type: 'collapseMessage'; payload: { id: string; content: string; label: string } }
  | { type: 'setLoading'; payload: { loading: boolean } }
  | { type: 'showFileChanges'; payload: { fileChanges: FileChange[] } }
  | { type: 'clearFileChanges' }
  | { type: 'configLoaded'; payload: { providerMode: ProviderMode; hasApiKeys: boolean; availableAgents: AgentName[]; modelTier: ModelTier } }
  | { type: 'error'; payload: { message: string } }
  | { type: 'suggestInstall'; payload: { command: string } }
  | { type: 'contextFileRead'; payload: { path: string } }
  | { type: 'pipelineProgress'; payload: { stage: 'thinking' | 'verifying' | 'reflecting' } }
  | { type: 'clearMessages' }
  | { type: 'clearContextFiles' }
  | { type: 'toolCallProgress'; payload: { msgId: string; filePath: string } }
  | { type: 'commandChunk'; payload: { msgId: string; command: string; chunk: string } }
  | { type: 'commandOutput'; payload: { msgId: string; command: string; stdout: string; exitCode: number } }
  | { type: 'contextUsage'; payload: { pct: number; label: string } }
  | { type: 'sessionListLoaded'; payload: { sessions: SessionIndexEntry[] } }
  | { type: 'roundChanged'; payload: { roundType: RoundType } }
  | { type: 'sessionRestored'; payload: { turns: ConversationTurn[]; roundType: RoundType } }
  | { type: 'restoreDraftFileChanges'; payload: { fileChanges: FileChange[]; roundType: RoundType; savedAt: number } };

// ── Input validation helpers ──────────────────────────────────────────────────

const VALID_ROUND_TYPES = new Set<string>(Object.values(RoundType));
const VALID_AGENT_NAMES = new Set<string>(Object.values(AgentName));
const MAX_USER_MESSAGE_LENGTH = 32_000;

/**
 * Validates and sanitizes a `SendMessagePayload` received from the webview.
 * Throws `ValidationError` if any field is invalid.
 */
export function validateSendMessagePayload(raw: unknown): SendMessagePayload {
  if (typeof raw !== 'object' || raw === null) {
    throw new ValidationError('sendMessage payload must be an object.');
  }

  const obj = raw as Record<string, unknown>;

  const userMessage = obj['userMessage'];
  if (typeof userMessage !== 'string' || userMessage.trim().length === 0) {
    throw new ValidationError('userMessage must be a non-empty string.');
  }
  if (userMessage.length > MAX_USER_MESSAGE_LENGTH) {
    throw new ValidationError(
      `userMessage exceeds maximum length of ${MAX_USER_MESSAGE_LENGTH} characters.`,
    );
  }

  const roundType = obj['roundType'];
  if (typeof roundType !== 'string' || !VALID_ROUND_TYPES.has(roundType)) {
    throw new ValidationError(`Invalid roundType: ${String(roundType)}`);
  }

  const mainAgent = obj['mainAgent'];
  if (typeof mainAgent !== 'string' || !VALID_AGENT_NAMES.has(mainAgent)) {
    throw new ValidationError(`Invalid mainAgent: ${String(mainAgent)}`);
  }

  const subAgents = obj['subAgents'];
  if (!Array.isArray(subAgents)) {
    throw new ValidationError('subAgents must be an array.');
  }
  const seenSubAgents = new Set<string>();
  for (const agent of subAgents) {
    if (typeof agent !== 'string' || !VALID_AGENT_NAMES.has(agent)) {
      throw new ValidationError(`Invalid sub-agent name: ${String(agent)}`);
    }
    if (agent === mainAgent) {
      throw new ValidationError('subAgents must not include the mainAgent.');
    }
    if (seenSubAgents.has(agent)) {
      throw new ValidationError(`Duplicate sub-agent name: ${agent}`);
    }
    seenSubAgents.add(agent);
  }

  return {
    userMessage: userMessage.trim(),
    roundType: roundType as RoundType,
    mainAgent: mainAgent as AgentName,
    subAgents: subAgents as AgentName[],
  };
}

/**
 * Validates an `ApplyChangesPayload` received from the webview.
 * Throws `ValidationError` if any field is invalid.
 */
export function validateApplyChangesPayload(raw: unknown): ApplyChangesPayload {
  if (typeof raw !== 'object' || raw === null) {
    throw new ValidationError('applyChanges payload must be an object.');
  }

  const obj = raw as Record<string, unknown>;
  const fileChanges = obj['fileChanges'];

  if (!Array.isArray(fileChanges)) {
    throw new ValidationError('fileChanges must be an array.');
  }

  for (const change of fileChanges) {
    if (typeof change !== 'object' || change === null) {
      throw new ValidationError('Each fileChange must be an object.');
    }
    const c = change as Record<string, unknown>;
    if (typeof c['filePath'] !== 'string' || (c['filePath']).trim().length === 0) {
      throw new ValidationError('fileChange.filePath must be a non-empty string.');
    }
    if ((c['filePath']).includes('..')) {
      throw new ValidationError(
        `fileChange.filePath must not contain directory traversal: ${String(c['filePath'])}`,
      );
    }
    if (path.isAbsolute((c['filePath']).trim())) {
      throw new ValidationError(
        `fileChange.filePath must be a relative path: ${String(c['filePath'])}`,
      );
    }
    if (typeof c['content'] !== 'string') {
      throw new ValidationError('fileChange.content must be a string.');
    }
    if (typeof c['isNew'] !== 'boolean') {
      throw new ValidationError('fileChange.isNew must be a boolean.');
    }
  }

  return { fileChanges: fileChanges as FileChange[] };
}
