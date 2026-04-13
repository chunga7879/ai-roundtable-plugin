import * as vscode from 'vscode';
import type {
  AgentName,
  CommandOutput,
  ConversationTurn,
  FileChange,
  RoundType,
  RoundRequest,
  SubAgentVerification,
  ToolCall,
  ToolResult,
  TokenUsage,
} from '../types';
import {
  buildReflectionPrompt,
  buildReflectionSystemPrompt,
  buildSubAgentSystemPrompt,
  buildSubAgentUserMessage,
} from '../prompts/roundPrompts';
import { normalizePath } from '../workspace/WorkspaceWriter';
import { MAX_TOOL_CALLS } from '../workspace/WorkspaceReader';
import type { WorkspaceReader } from '../workspace/WorkspaceReader';
import type { ProgressEvent } from './AgentRunner';

const REFLECTION_ENABLED_TOOLS: ToolCall['name'][] = ['write_file', 'delete_file'];

export interface StageCallAgentOptions {
  systemPrompt: string;
  userMessage: string;
  conversationHistory?: ConversationTurn[];
  onChunk?: (chunk: string) => void;
  onToolCall?: (toolCall: ToolCall) => Promise<ToolResult>;
  enabledTools?: ToolCall['name'][];
}

export interface RoundToolHandlers {
  main: (toolCall: ToolCall) => Promise<ToolResult>;
  reflection: (toolCall: ToolCall) => Promise<ToolResult>;
  setAllowedReflectionFilePaths: (paths: string[]) => void;
  getAllFileChanges: () => FileChange[];
}

export interface MainStageResult {
  mainAgentResponse: string;
  mainAgentFileChanges: FileChange[];
}

interface RoundExecutionStagesDeps {
  workspaceReader: WorkspaceReader;
  callAgent: (
    agentName: AgentName,
    options: StageCallAgentOptions,
    cancellationToken: vscode.CancellationToken,
  ) => Promise<{ content: string; usage?: TokenUsage }>;
  shouldRetryMissingToolWrites: (roundType: RoundType, response: string) => boolean;
  buildMissingToolWriteRecoveryPrompt: (userMessage: string, mainAgentResponse: string) => string;
  toSafeErrorMessage: (err: unknown) => string;
  extractConsensusIssues: (verifications: SubAgentVerification[]) => string[];
  awaitWithCancellation: <T>(
    promise: Promise<T>,
    cancellationToken: vscode.CancellationToken,
  ) => Promise<T>;
}

export class RoundExecutionStages {
  private readonly workspaceReader: WorkspaceReader;
  private readonly callAgent: RoundExecutionStagesDeps['callAgent'];
  private readonly shouldRetryMissingToolWrites: RoundExecutionStagesDeps['shouldRetryMissingToolWrites'];
  private readonly buildMissingToolWriteRecoveryPrompt: RoundExecutionStagesDeps['buildMissingToolWriteRecoveryPrompt'];
  private readonly toSafeErrorMessage: RoundExecutionStagesDeps['toSafeErrorMessage'];
  private readonly extractConsensusIssues: RoundExecutionStagesDeps['extractConsensusIssues'];
  private readonly awaitWithCancellation: RoundExecutionStagesDeps['awaitWithCancellation'];

  constructor(deps: RoundExecutionStagesDeps) {
    this.workspaceReader = deps.workspaceReader;
    this.callAgent = deps.callAgent;
    this.shouldRetryMissingToolWrites = deps.shouldRetryMissingToolWrites;
    this.buildMissingToolWriteRecoveryPrompt = deps.buildMissingToolWriteRecoveryPrompt;
    this.toSafeErrorMessage = deps.toSafeErrorMessage;
    this.extractConsensusIssues = deps.extractConsensusIssues;
    this.awaitWithCancellation = deps.awaitWithCancellation;
  }

  buildFullUserMessage(
    workspaceContext: RoundRequest['workspaceContext'],
    cachedFiles: Map<string, string>,
    userMessage: string,
    buildFileListSection: (
      workspaceContext: RoundRequest['workspaceContext'],
      cachedFiles: Map<string, string>,
    ) => string,
  ): string {
    const fileListSection = buildFileListSection(workspaceContext, cachedFiles);
    return fileListSection
      ? `${fileListSection}\n\n---\n\nUser Request:\n${userMessage}`
      : userMessage;
  }

  createRoundToolHandlers(params: {
    mainAgent: AgentName;
    onProgress: (event: ProgressEvent) => void;
    onRunCommand?: (command: string) => Promise<CommandOutput>;
    cachedFiles: Map<string, string>;
    cachedCommandOutputs: Map<string, CommandOutput>;
    initialFileChanges?: FileChange[];
  }): RoundToolHandlers {
    const {
      mainAgent,
      onProgress,
      onRunCommand,
      cachedFiles,
      cachedCommandOutputs,
      initialFileChanges = [],
    } = params;
    let toolCallCount = 0;
    let reflectionWriteCount = 0;
    const maxReflectionWrites = 20;
    let allowedReflectionFilePaths: Set<string> = new Set();
    const allFileChanges: FileChange[] = [...initialFileChanges];

    const main = async (toolCall: ToolCall): Promise<ToolResult> => {
      if (toolCall.name === 'run_command') {
        if (!onRunCommand) {
          return { id: toolCall.id, content: 'Command execution is not available in this context.', isError: true };
        }
        onProgress({ type: 'tool_run_command', agentName: mainAgent, command: toolCall.command });
        const output = await onRunCommand(toolCall.command);
        const displayCommand = output.command || toolCall.command;
        cachedCommandOutputs.set(displayCommand, output);
        onProgress({
          type: 'tool_run_command_done',
          agentName: mainAgent,
          command: displayCommand,
          stdout: output.stdout || '(no output)',
          exitCode: output.exitCode,
        });
        const resultText = `Exit code: ${output.exitCode}\n\nOutput:\n${output.stdout || '(no output)'}`;
        return { id: toolCall.id, content: resultText, isError: output.exitCode !== 0 };
      }

      if (toolCall.name === 'write_file') {
        const normalized = normalizePath(toolCall.filePath);
        if (!normalized) {
          return { id: toolCall.id, content: `Invalid file path: ${toolCall.filePath}`, isError: true };
        }
        onProgress({ type: 'tool_write_file', agentName: mainAgent, filePath: normalized });
        this.upsertFileChange(allFileChanges, { filePath: normalized, content: toolCall.content, isNew: false });
        return { id: toolCall.id, content: `Staged write to ${normalized}`, isError: false };
      }

      if (toolCall.name === 'delete_file') {
        const normalized = normalizePath(toolCall.filePath);
        if (!normalized) {
          return { id: toolCall.id, content: `Invalid file path: ${toolCall.filePath}`, isError: true };
        }
        onProgress({ type: 'tool_delete_file', agentName: mainAgent, filePath: normalized });
        this.upsertFileChange(allFileChanges, { filePath: normalized, content: '', isNew: false, isDeleted: true });
        return { id: toolCall.id, content: `Staged delete of ${normalized}`, isError: false };
      }

      const cached = cachedFiles.get(toolCall.filePath);
      if (cached !== undefined) {
        onProgress({ type: 'tool_read', agentName: mainAgent, filePath: toolCall.filePath });
        return { id: toolCall.id, content: cached, isError: false };
      }

      if (toolCallCount >= MAX_TOOL_CALLS) {
        return {
          id: toolCall.id,
          content: `Tool call limit (${MAX_TOOL_CALLS}) reached. Work with the files already provided.`,
          isError: true,
        };
      }

      toolCallCount++;
      onProgress({ type: 'tool_read', agentName: mainAgent, filePath: toolCall.filePath });
      const result = await this.workspaceReader.readFileForTool(toolCall.filePath);
      if (!result.isError) {
        cachedFiles.set(toolCall.filePath, result.content);
      }
      return { id: toolCall.id, content: result.content, isError: result.isError };
    };

    const reflection = (toolCall: ToolCall): Promise<ToolResult> => {
      const resolve = (result: ToolResult): Promise<ToolResult> => Promise.resolve(result);
      if (toolCall.name === 'write_file') {
        if (reflectionWriteCount >= maxReflectionWrites) {
          return resolve({
            id: toolCall.id,
            content: `Reflection write limit (${maxReflectionWrites}) reached.`,
            isError: true,
          });
        }
        const normalized = normalizePath(toolCall.filePath);
        if (!normalized) {
          return resolve({ id: toolCall.id, content: `Invalid file path: ${toolCall.filePath}`, isError: true });
        }
        if (!allowedReflectionFilePaths.has(normalized)) {
          return resolve({
            id: toolCall.id,
            content: `Reflection may only modify files written in the initial response. Blocked path: ${normalized}`,
            isError: true,
          });
        }
        reflectionWriteCount++;
        onProgress({ type: 'tool_write_file', agentName: mainAgent, filePath: normalized });
        this.upsertFileChange(allFileChanges, { filePath: normalized, content: toolCall.content, isNew: false });
        return resolve({ id: toolCall.id, content: `Staged write to ${normalized}`, isError: false });
      }

      if (toolCall.name === 'delete_file') {
        const normalized = normalizePath(toolCall.filePath);
        if (!normalized) {
          return resolve({ id: toolCall.id, content: `Invalid file path: ${toolCall.filePath}`, isError: true });
        }
        if (!allowedReflectionFilePaths.has(normalized)) {
          return resolve({
            id: toolCall.id,
            content: `Reflection may only modify files written in the initial response. Blocked path: ${normalized}`,
            isError: true,
          });
        }
        onProgress({ type: 'tool_delete_file', agentName: mainAgent, filePath: normalized });
        this.upsertFileChange(allFileChanges, { filePath: normalized, content: '', isNew: false, isDeleted: true });
        return resolve({ id: toolCall.id, content: `Staged delete of ${normalized}`, isError: false });
      }

      if (toolCall.name === 'run_command') {
        return resolve({
          id: toolCall.id,
          content: 'run_command is not available during reflection. Use VERIFY: to suggest post-apply commands.',
          isError: true,
        });
      }

      return resolve({
        id: toolCall.id,
        content: 'read_file is not available during reflection. File contents are already provided in the prompt.',
        isError: true,
      });
    };

    return {
      main,
      reflection,
      setAllowedReflectionFilePaths: (paths: string[]) => {
        allowedReflectionFilePaths = new Set(paths);
      },
      getAllFileChanges: () => allFileChanges,
    };
  }

  async runMainAgentStage(params: {
    mainAgent: AgentName;
    roundType: RoundType;
    userMessage: string;
    systemPrompt: string;
    fullUserMessage: string;
    conversationHistory: ConversationTurn[];
    cancellationToken: vscode.CancellationToken;
    onProgress: (event: ProgressEvent) => void;
    toolHandlers: RoundToolHandlers;
    addUsage: (usage?: TokenUsage) => void;
  }): Promise<MainStageResult> {
    const {
      mainAgent,
      roundType,
      userMessage,
      systemPrompt,
      fullUserMessage,
      conversationHistory,
      cancellationToken,
      onProgress,
      toolHandlers,
      addUsage,
    } = params;

    onProgress({ type: 'main_agent_start', agentName: mainAgent });
    const { content: mainAgentResponse, usage: mainUsage } = await this.callAgent(
      mainAgent,
      {
        systemPrompt,
        userMessage: fullUserMessage,
        conversationHistory,
        onChunk: (chunk) => onProgress({ type: 'main_agent_chunk', agentName: mainAgent, chunk }),
        onToolCall: toolHandlers.main,
      },
      cancellationToken,
    );
    addUsage(mainUsage);
    this.assertNotCancelled(cancellationToken);

    if (
      toolHandlers.getAllFileChanges().length === 0
      && this.shouldRetryMissingToolWrites(roundType, mainAgentResponse)
    ) {
      const { usage: recoveryUsage } = await this.callAgent(
        mainAgent,
        {
          systemPrompt,
          userMessage: this.buildMissingToolWriteRecoveryPrompt(userMessage, mainAgentResponse),
          conversationHistory,
          onToolCall: toolHandlers.main,
        },
        cancellationToken,
      );
      addUsage(recoveryUsage);
      this.assertNotCancelled(cancellationToken);
    }

    onProgress({ type: 'main_agent_done', agentName: mainAgent });
    return {
      mainAgentResponse,
      mainAgentFileChanges: [...toolHandlers.getAllFileChanges()],
    };
  }

  async runSubAgentVerificationStage(params: {
    roundType: RoundType;
    mainAgent: AgentName;
    subAgents: AgentName[];
    userMessage: string;
    mainAgentResponse: string;
    mainAgentFileChanges: FileChange[];
    conversationHistory: ConversationTurn[];
    cachedFiles: Map<string, string>;
    cachedCommandOutputs: Map<string, CommandOutput>;
    cancellationToken: vscode.CancellationToken;
    onProgress: (event: ProgressEvent) => void;
    addUsage: (usage?: TokenUsage) => void;
  }): Promise<SubAgentVerification[]> {
    const {
      roundType,
      mainAgent,
      subAgents,
      userMessage,
      mainAgentResponse,
      mainAgentFileChanges,
      conversationHistory,
      cachedFiles,
      cachedCommandOutputs,
      cancellationToken,
      onProgress,
      addUsage,
    } = params;

    const uniqueSubAgents = Array.from(new Set(subAgents)).filter((a) => a !== mainAgent);
    if (uniqueSubAgents.length === 0) {
      return [];
    }

    onProgress({ type: 'sub_agents_start', agentNames: uniqueSubAgents });
    const verificationSystemPrompt = buildSubAgentSystemPrompt(roundType);
    const subAgentUserMessage = this.buildSubAgentVerificationMessage({
      userMessage,
      mainAgentResponse,
      conversationHistory,
      cachedFiles,
      mainAgentFileChanges,
      cachedCommandOutputs,
    });

    const verificationPromises = uniqueSubAgents.map(async (agentName) => {
      try {
        const { content: feedback, usage: subUsage } = await this.callAgent(
          agentName,
          {
            systemPrompt: verificationSystemPrompt,
            userMessage: subAgentUserMessage,
          },
          cancellationToken,
        );
        addUsage(subUsage);
        return { agentName, feedback };
      } catch (err) {
        if (err instanceof vscode.CancellationError) {
          throw err;
        }
        return {
          agentName,
          feedback: `[Verification unavailable: ${this.toSafeErrorMessage(err)}]`,
        };
      }
    });

    const subAgentVerifications = await this.awaitWithCancellation(
      Promise.all(verificationPromises),
      cancellationToken,
    );
    this.assertNotCancelled(cancellationToken);

    for (const verification of subAgentVerifications) {
      onProgress({
        type: 'sub_agent_feedback',
        agentName: verification.agentName,
        feedback: verification.feedback,
      });
    }
    onProgress({ type: 'sub_agents_done', agentNames: uniqueSubAgents });
    return subAgentVerifications;
  }

  async runReflectionStage(params: {
    roundType: RoundType;
    mainAgent: AgentName;
    mainAgentResponse: string;
    mainAgentFileChanges: FileChange[];
    subAgentVerifications: SubAgentVerification[];
    cancellationToken: vscode.CancellationToken;
    onProgress: (event: ProgressEvent) => void;
    toolHandlers: RoundToolHandlers;
    addUsage: (usage?: TokenUsage) => void;
  }): Promise<string> {
    const {
      roundType,
      mainAgent,
      mainAgentResponse,
      mainAgentFileChanges,
      subAgentVerifications,
      cancellationToken,
      onProgress,
      toolHandlers,
      addUsage,
    } = params;

    const validFeedbacks = subAgentVerifications.filter(
      (v) => !v.feedback.startsWith('[Verification unavailable'),
    );
    if (validFeedbacks.length === 0) {
      return mainAgentResponse;
    }

    onProgress({ type: 'reflection_start', agentName: mainAgent, mainAgentResponse });
    toolHandlers.setAllowedReflectionFilePaths(mainAgentFileChanges.map((f) => f.filePath));

    const writtenFilesSection = mainAgentFileChanges.length > 0
      ? `\n\n[FILES WRITTEN VIA write_file TOOL — re-emit any file you modify using write_file]\n${mainAgentFileChanges
          .map((f) => (
            f.isDeleted
              ? `[FILE DELETED: ${f.filePath}]`
              : `[FILE: ${f.filePath}]\n\`\`\`\n${f.content}\n\`\`\``
          ))
          .join('\n\n')}`
      : '';
    const reflectionUserMessage = buildReflectionPrompt(
      mainAgentResponse + writtenFilesSection,
      validFeedbacks.map((v) => ({ agentName: v.agentName, feedback: v.feedback })),
      this.extractConsensusIssues(validFeedbacks),
    );
    const { content: reflectedResponse, usage: reflectUsage } = await this.callAgent(
      mainAgent,
      {
        systemPrompt: buildReflectionSystemPrompt(roundType),
        userMessage: reflectionUserMessage,
        onChunk: (chunk) => onProgress({ type: 'reflection_chunk', agentName: mainAgent, chunk }),
        onToolCall: toolHandlers.reflection,
        enabledTools: REFLECTION_ENABLED_TOOLS,
      },
      cancellationToken,
    );
    addUsage(reflectUsage);
    this.assertNotCancelled(cancellationToken);
    onProgress({ type: 'reflection_done', agentName: mainAgent });
    return reflectedResponse;
  }

  private buildSubAgentVerificationMessage(params: {
    userMessage: string;
    mainAgentResponse: string;
    conversationHistory: ConversationTurn[];
    cachedFiles: Map<string, string>;
    mainAgentFileChanges: FileChange[];
    cachedCommandOutputs: Map<string, CommandOutput>;
  }): string {
    const {
      userMessage,
      mainAgentResponse,
      conversationHistory,
      cachedFiles,
      mainAgentFileChanges,
      cachedCommandOutputs,
    } = params;
    const priorUserTurns = conversationHistory
      .filter((t) => t.role === 'user')
      .map((t, i) => `[User request ${i + 1}]: ${t.content}`)
      .join('\n');
    const baseMessage = priorUserTurns
      ? `Prior conversation context:\n${priorUserTurns}\n\nThe primary agent was given the current request:\n${userMessage}\n\nVerify whether its response (shown below) correctly and completely addresses this request.`
      : `The primary agent was given the following request:\n\n${userMessage}\n\nVerify whether its response (shown below) correctly and completely addresses this request.`;

    const allFilesForSubAgent = Array.from(cachedFiles.entries()).map(([path, content]) => ({ path, content }));
    const resolvedFilesSection = allFilesForSubAgent.length > 0
      ? `[FILES READ BY PRIMARY AGENT]\n\n${allFilesForSubAgent
          .map((f) => `[FILE: ${f.path}]\n\`\`\`\n${f.content}\n\`\`\``)
          .join('\n\n')}\n\n[END FILES]`
      : '';
    const writtenFilesSection = mainAgentFileChanges.length > 0
      ? `[FILES WRITTEN BY PRIMARY AGENT]\n\n${mainAgentFileChanges
          .map((f) => (
            f.isDeleted
              ? `[FILE DELETED: ${f.filePath}]`
              : `[FILE: ${f.filePath}]\n\`\`\`\n${f.content}\n\`\`\``
          ))
          .join('\n\n')}\n\n[END WRITTEN FILES]`
      : '';
    const commandOutputsSection = cachedCommandOutputs.size > 0
      ? `[COMMANDS RUN BY PRIMARY AGENT]\n\n${Array.from(cachedCommandOutputs.values())
          .map((o) => `Command: ${o.command}\nExit code: ${o.exitCode}\n\`\`\`\n${o.stdout || '(no output)'}\n\`\`\``)
          .join('\n\n')}\n\n[END COMMANDS]`
      : '';

    const contextSections = [resolvedFilesSection, writtenFilesSection, commandOutputsSection]
      .filter(Boolean)
      .join('\n\n');
    return buildSubAgentUserMessage(mainAgentResponse, contextSections, baseMessage);
  }

  private upsertFileChange(fileChanges: FileChange[], change: FileChange): void {
    const existing = fileChanges.findIndex((f) => f.filePath === change.filePath);
    if (existing >= 0) {
      fileChanges[existing] = change;
      return;
    }
    fileChanges.push(change);
  }

  private assertNotCancelled(cancellationToken: vscode.CancellationToken): void {
    if (cancellationToken.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
  }
}
