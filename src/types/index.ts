import { ValidationError } from '../errors';

export enum RoundType {
  REQUIREMENTS = 'requirements',
  ARCHITECT = 'architect',
  DEVELOPER = 'developer',
  REVIEWER = 'reviewer',
  QA = 'qa',
  DEVOPS = 'devops',
  RUNNER = 'runner',
}

export enum AgentName {
  COPILOT = 'copilot',
  CLAUDE = 'claude',
  GPT = 'gpt',
  GEMINI = 'gemini',
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
}

export interface FileChange {
  filePath: string;
  content: string;
  isNew: boolean;
}

export interface AgentResponse {
  content: string;
  fileChanges: FileChange[];
}

export interface RoundRequest {
  userMessage: string;
  roundType: RoundType;
  mainAgent: AgentName;
  subAgents: AgentName[];
  workspaceContext: WorkspaceContext;
}

export interface WorkspaceContext {
  files: WorkspaceFile[];
  activeFilePath?: string;
}

export interface WorkspaceFile {
  path: string;
  content: string;
  language: string;
}

export interface ExtensionConfig {
  providerMode: ProviderMode;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  googleApiKey?: string;
}

export interface SubAgentVerification {
  agentName: AgentName;
  feedback: string;
}

export interface RoundResult {
  mainAgentResponse: string;
  subAgentVerifications: SubAgentVerification[];
  reflectedResponse: string;
  fileChanges: FileChange[];
}

export type WebviewToExtensionMessage =
  | { type: 'sendMessage'; payload: SendMessagePayload }
  | { type: 'applyChanges'; payload: ApplyChangesPayload }
  | { type: 'rejectChanges' }
  | { type: 'requestConfig' }
  | { type: 'configureProvider' };

export interface SendMessagePayload {
  userMessage: string;
  roundType: RoundType;
  mainAgent: AgentName;
  subAgents: AgentName[];
}

export interface ApplyChangesPayload {
  fileChanges: FileChange[];
}

export type ExtensionToWebviewMessage =
  | { type: 'addMessage'; payload: Message }
  | { type: 'updateMessage'; payload: { id: string; content: string } }
  | { type: 'setLoading'; payload: { loading: boolean } }
  | { type: 'showFileChanges'; payload: { fileChanges: FileChange[] } }
  | { type: 'clearFileChanges' }
  | { type: 'configLoaded'; payload: { providerMode: ProviderMode; hasApiKeys: boolean } }
  | { type: 'error'; payload: { message: string } };

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
  for (const agent of subAgents) {
    if (typeof agent !== 'string' || !VALID_AGENT_NAMES.has(agent)) {
      throw new ValidationError(`Invalid sub-agent name: ${String(agent)}`);
    }
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
    if (typeof c['filePath'] !== 'string' || (c['filePath'] as string).trim().length === 0) {
      throw new ValidationError('fileChange.filePath must be a non-empty string.');
    }
    if ((c['filePath'] as string).includes('..')) {
      throw new ValidationError(
        `fileChange.filePath must not contain directory traversal: ${String(c['filePath'])}`,
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
