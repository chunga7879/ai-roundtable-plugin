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
