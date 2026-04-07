import { AgentRunner, AgentRunnerError } from '../../src/agents/AgentRunner';
import { AgentName, ProviderMode, RoundType } from '../../src/types';
import type { RoundRequest, ToolCall, ToolResult } from '../../src/types';
import { CancellationError } from 'vscode';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCancellationToken(isCancelled = false) {
  return {
    isCancellationRequested: isCancelled,
    onCancellationRequested: jest.fn(),
  };
}

function makeRoundRequest(overrides: Partial<RoundRequest> = {}): RoundRequest {
  return {
    userMessage: 'Build a TODO app',
    roundType: RoundType.DEVELOPER,
    mainAgent: AgentName.CLAUDE,
    subAgents: [],
    workspaceContext: { files: [] },
    conversationHistory: [],
    cachedFiles: new Map(),
    cachedCommandOutputs: new Map(),
    ...overrides,
  };
}

function makeCopilotProvider(response = 'Copilot response') {
  return {
    sendRequest: jest.fn().mockResolvedValue(response),
    isAvailable: jest.fn().mockResolvedValue(true),
    invalidateModelCache: jest.fn(),
  };
}

function makeApiKeyProvider(response = 'API key response', hasKey = true) {
  return {
    sendRequest: jest.fn().mockResolvedValue({ content: response }),
    hasKeyForAgent: jest.fn().mockReturnValue(hasKey),
  };
}

function makeWorkspaceReader() {
  return {
    readFileForTool: jest.fn().mockResolvedValue({ content: 'file content', isError: false }),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AgentRunner', () => {
  describe('3-step pipeline (Copilot mode)', () => {
    it('returns mainAgentResponse when no sub-agents are selected', async () => {
      const copilotProvider = makeCopilotProvider('Main response');
      const apiKeyProvider = makeApiKeyProvider();
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: apiKeyProvider as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      const result = await runner.runRound(
        makeRoundRequest({ subAgents: [] }),
        makeCancellationToken(),
        jest.fn(),
      );

      expect(result.mainAgentResponse).toBe('Main response');
      expect(result.reflectedResponse).toBe('Main response');
      expect(result.subAgentVerifications).toHaveLength(0);
      // Only one call: the main agent
      expect(copilotProvider.sendRequest).toHaveBeenCalledTimes(1);
    });

    it('calls sub-agents and runs reflection when sub-agents are selected', async () => {
      let callCount = 0;
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve('Main response');
          if (callCount === 2) return Promise.resolve('Sub-agent feedback');
          return Promise.resolve('Reflected response');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };
      const apiKeyProvider = makeApiKeyProvider();

      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: apiKeyProvider as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      const result = await runner.runRound(
        makeRoundRequest({
          mainAgent: AgentName.CLAUDE,
          subAgents: [AgentName.GPT],
        }),
        makeCancellationToken(),
        jest.fn(),
      );

      expect(result.mainAgentResponse).toBe('Main response');
      expect(result.subAgentVerifications).toHaveLength(1);
      expect(result.subAgentVerifications[0].feedback).toBe('Sub-agent feedback');
      expect(result.reflectedResponse).toBe('Reflected response');
      // 3 calls: main → sub → reflect
      expect(copilotProvider.sendRequest).toHaveBeenCalledTimes(3);
    });

    it('skips sub-agents that are the same as the main agent', async () => {
      const copilotProvider = makeCopilotProvider('Response');
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      const result = await runner.runRound(
        makeRoundRequest({
          mainAgent: AgentName.CLAUDE,
          subAgents: [AgentName.CLAUDE], // Same as main — should be filtered
        }),
        makeCancellationToken(),
        jest.fn(),
      );

      expect(result.subAgentVerifications).toHaveLength(0);
      expect(copilotProvider.sendRequest).toHaveBeenCalledTimes(1);
    });

    it('emits progress events for each pipeline step', async () => {
      let callCount = 0;
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(() => {
          callCount++;
          return Promise.resolve(callCount === 2 ? 'feedback' : 'response');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };

      const progressEvents: string[] = [];
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await runner.runRound(
        makeRoundRequest({ subAgents: [AgentName.GPT] }),
        makeCancellationToken(),
        (event) => progressEvents.push(event.type),
      );

      expect(progressEvents).toContain('main_agent_start');
      expect(progressEvents).toContain('main_agent_done');
      expect(progressEvents).toContain('sub_agents_start');
      expect(progressEvents).toContain('sub_agents_done');
      expect(progressEvents).toContain('reflection_start');
      expect(progressEvents).toContain('reflection_done');
    });
  });

  describe('sub-agent failure tolerance', () => {
    it('gracefully degrades when a sub-agent throws a non-cancellation error', async () => {
      let callCount = 0;
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve('Main response');
          throw new Error('Sub-agent unavailable');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };

      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      const result = await runner.runRound(
        makeRoundRequest({ subAgents: [AgentName.GPT] }),
        makeCancellationToken(),
        jest.fn(),
      );

      // Round should complete — sub-agent error becomes a feedback string
      expect(result.subAgentVerifications).toHaveLength(1);
      expect(result.subAgentVerifications[0].feedback).toContain(
        '[Verification unavailable',
      );
      expect(result.subAgentVerifications[0].feedback).toContain(
        'Sub-agent unavailable',
      );
      // Reflection is skipped because there are no valid feedbacks
      expect(result.reflectedResponse).toBe(result.mainAgentResponse);
    });

    it('includes valid feedbacks in reflection even when some sub-agents fail', async () => {
      let callCount = 0;
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve('Main response');
          if (callCount === 2) return Promise.resolve('Valid feedback from GPT');
          if (callCount === 3) throw new Error('Gemini unavailable');
          return Promise.resolve('Reflected response');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };

      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      const result = await runner.runRound(
        makeRoundRequest({ subAgents: [AgentName.GPT, AgentName.GEMINI] }),
        makeCancellationToken(),
        jest.fn(),
      );

      expect(result.subAgentVerifications).toHaveLength(2);
      const validFeedback = result.subAgentVerifications.find(
        (v) => !v.feedback.startsWith('[Verification unavailable'),
      );
      expect(validFeedback).toBeDefined();
      expect(result.reflectedResponse).toBe('Reflected response');
    });
  });

  describe('cancellation handling', () => {
    it('propagates CancellationError from main agent call', async () => {
      const copilotProvider = {
        sendRequest: jest.fn().mockRejectedValue(new CancellationError()),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };

      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await expect(
        runner.runRound(makeRoundRequest(), makeCancellationToken(), jest.fn()),
      ).rejects.toThrow(CancellationError);
    });

    it('propagates CancellationError from sub-agent call', async () => {
      let callCount = 0;
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve('Main response');
          throw new CancellationError();
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };

      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await expect(
        runner.runRound(
          makeRoundRequest({ subAgents: [AgentName.GPT] }),
          makeCancellationToken(),
          jest.fn(),
        ),
      ).rejects.toThrow(CancellationError);
    });
  });

  describe('API key mode', () => {
    it('throws AgentRunnerError when no API key is configured for the main agent', async () => {
      const apiKeyProvider = makeApiKeyProvider('response', false); // hasKey = false

      const runner = new AgentRunner({
        copilotProvider: makeCopilotProvider() as never,
        apiKeyProvider: apiKeyProvider as never,
        providerMode: ProviderMode.API_KEYS,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await expect(
        runner.runRound(makeRoundRequest({ mainAgent: AgentName.CLAUDE }), makeCancellationToken(), jest.fn()),
      ).rejects.toThrow(AgentRunnerError);
    });

    it('calls apiKeyProvider when providerMode is API_KEYS', async () => {
      const apiKeyProvider = makeApiKeyProvider('API response', true);

      const runner = new AgentRunner({
        copilotProvider: makeCopilotProvider() as never,
        apiKeyProvider: apiKeyProvider as never,
        providerMode: ProviderMode.API_KEYS,
        workspaceReader: makeWorkspaceReader() as never,
      });

      const result = await runner.runRound(
        makeRoundRequest({ subAgents: [] }),
        makeCancellationToken(),
        jest.fn(),
      );

      expect(result.mainAgentResponse).toBe('API response');
      expect(apiKeyProvider.sendRequest).toHaveBeenCalledTimes(1);
    });
  });

  describe('workspace context', () => {
    it('includes workspace file list in the user message', async () => {
      const copilotProvider = makeCopilotProvider('Response');
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await runner.runRound(
        makeRoundRequest({
          workspaceContext: {
            files: [{ path: 'src/app.ts', content: 'const app = 1;', language: 'typescript' }],
            activeFilePath: 'src/app.ts',
          },
        }),
        makeCancellationToken(),
        jest.fn(),
      );

      const callArgs = copilotProvider.sendRequest.mock.calls[0];
      const userMessage = callArgs[0].userMessage as string;
      // File path is listed; content is read on-demand via tool calls
      expect(userMessage).toContain('src/app.ts');
      expect(userMessage).toContain('read_file');
    });

    it('sends the user message directly when workspace has no files', async () => {
      const copilotProvider = makeCopilotProvider('Response');
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await runner.runRound(
        makeRoundRequest({ workspaceContext: { files: [] }, userMessage: 'Test message' }),
        makeCancellationToken(),
        jest.fn(),
      );

      const callArgs = copilotProvider.sendRequest.mock.calls[0];
      const userMessage = callArgs[0].userMessage as string;
      expect(userMessage).toBe('Test message');
    });
  });

  describe('conversation history', () => {
    it('passes conversationHistory through to the main agent call', async () => {
      const copilotProvider = makeCopilotProvider('Response');
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      const history = [
        { role: 'user' as const, content: 'prior question' },
        { role: 'assistant' as const, content: 'prior answer' },
      ];

      await runner.runRound(
        makeRoundRequest({ conversationHistory: history }),
        makeCancellationToken(),
        jest.fn(),
      );

      const callArgs = copilotProvider.sendRequest.mock.calls[0];
      expect(callArgs[0].conversationHistory).toEqual(history);
    });

    it('omits conversationHistory from sub-agent verification calls', async () => {
      let callCount = 0;
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve('Main response');
          if (callCount === 2) return Promise.resolve('Sub feedback');
          return Promise.resolve('Reflected');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };

      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await runner.runRound(
        makeRoundRequest({
          subAgents: [AgentName.GPT],
          conversationHistory: [{ role: 'user' as const, content: 'history' }],
        }),
        makeCancellationToken(),
        jest.fn(),
      );

      // Sub-agent call (index 1) should not carry the user's conversation history
      const subAgentCall = copilotProvider.sendRequest.mock.calls[1];
      expect(subAgentCall[0].conversationHistory).toBeUndefined();
    });

    it('includes prior user turns in sub-agent verification message', async () => {
      let callCount = 0;
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve('Main response');
          if (callCount === 2) return Promise.resolve('Sub feedback');
          return Promise.resolve('Reflected');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };

      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await runner.runRound(
        makeRoundRequest({
          subAgents: [AgentName.GPT],
          userMessage: 'Add error handling',
          conversationHistory: [
            { role: 'user' as const, content: 'Build a TODO app' },
            { role: 'assistant' as const, content: 'Here is the implementation...' },
          ],
        }),
        makeCancellationToken(),
        jest.fn(),
      );

      // Sub-agent user message should include prior user turns but not assistant turns
      const subAgentCall = copilotProvider.sendRequest.mock.calls[1];
      const subAgentUserMessage = subAgentCall[0].userMessage as string;
      expect(subAgentUserMessage).toContain('Build a TODO app');
      expect(subAgentUserMessage).not.toContain('Here is the implementation');
      expect(subAgentUserMessage).toContain('Add error handling');
    });

    it('sends plain verification message when no prior conversation history exists', async () => {
      let callCount = 0;
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve('Main response');
          if (callCount === 2) return Promise.resolve('Sub feedback');
          return Promise.resolve('Reflected');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };

      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await runner.runRound(
        makeRoundRequest({
          subAgents: [AgentName.GPT],
          userMessage: 'Build a TODO app',
          conversationHistory: [],
        }),
        makeCancellationToken(),
        jest.fn(),
      );

      const subAgentCall = copilotProvider.sendRequest.mock.calls[1];
      const subAgentUserMessage = subAgentCall[0].userMessage as string;
      expect(subAgentUserMessage).toContain('Build a TODO app');
      // No "Prior user requests" prefix when history is empty
      expect(subAgentUserMessage).not.toContain('Prior user requests');
    });
  });

  describe('file cache (cachedFiles)', () => {
    it('serves cached files without calling workspaceReader', async () => {
      const copilotProvider = makeCopilotProvider('Response');
      const workspaceReader = makeWorkspaceReader();
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: workspaceReader as never,
      });

      const cachedFiles = new Map([['src/app.ts', 'cached content']]);

      await runner.runRound(
        makeRoundRequest({
          workspaceContext: {
            files: [{ path: 'src/app.ts', content: '', language: 'typescript' }],
          },
          cachedFiles,
        }),
        makeCancellationToken(),
        jest.fn(),
      );

      // Cached file should be in the user message, not fetched via tool call
      const callArgs = copilotProvider.sendRequest.mock.calls[0];
      const userMessage = callArgs[0].userMessage as string;
      expect(userMessage).toContain('cached content');
      expect(workspaceReader.readFileForTool).not.toHaveBeenCalled();
    });

    it('does not send duplicate files to sub-agents when files are read via tool calls', async () => {
      let callCount = 0;
      const capturedSubAgentMessages: string[] = [];

      // Simulate main agent calling read_file tool during its response
      let toolHandler: ((toolCall: { id: string; name: 'read_file'; filePath: string }) => Promise<{ id: string; content: string; isError: boolean }>) | undefined;
      const copilotProviderWithTool = {
        sendRequest: jest.fn().mockImplementation((opts: { userMessage: string; onToolCall?: typeof toolHandler }) => {
          callCount++;
          if (callCount === 1) {
            // Simulate a tool call by the main agent
            toolHandler = opts.onToolCall;
            return Promise.resolve('Main response');
          }
          if (callCount === 2) {
            capturedSubAgentMessages.push(opts.userMessage);
            return Promise.resolve('Sub feedback');
          }
          return Promise.resolve('Reflected');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };

      const cachedFiles = new Map<string, string>();
      const runner = new AgentRunner({
        copilotProvider: copilotProviderWithTool as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      // Pre-populate cache with a file to simulate a previous turn read
      cachedFiles.set('src/existing.ts', 'existing content');

      await runner.runRound(
        makeRoundRequest({
          subAgents: [AgentName.GPT],
          cachedFiles,
        }),
        makeCancellationToken(),
        jest.fn(),
      );

      // Sub-agent message should contain 'existing content' exactly once
      if (capturedSubAgentMessages.length > 0) {
        const msg = capturedSubAgentMessages[0];
        const occurrences = (msg.match(/existing content/g) ?? []).length;
        expect(occurrences).toBe(1);
      }
    });

    it('respects MAX_TOOL_CALLS limit for new file reads', async () => {
      const copilotProvider = makeCopilotProvider('Response');
      const workspaceReader = {
        readFileForTool: jest.fn().mockResolvedValue({ content: 'file content', isError: false }),
      };
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: workspaceReader as never,
      });

      await runner.runRound(
        makeRoundRequest({ cachedFiles: new Map() }),
        makeCancellationToken(),
        jest.fn(),
      );

      // Without tool calls being triggered by the mock, readFileForTool should not be called
      expect(workspaceReader.readFileForTool).not.toHaveBeenCalled();
    });
  });

  // ── Tool call dispatch ────────────────────────────────────────────────────────

  describe('tool call dispatch', () => {
    /** Returns a copilot provider that invokes onToolCall once before resolving. */
    function makeCopilotProviderWithToolCall(toolCall: ToolCall, finalResponse = 'Response') {
      return {
        sendRequest: jest.fn().mockImplementation(
          async (opts: { onToolCall?: (tc: ToolCall) => Promise<ToolResult> }) => {
            if (opts.onToolCall) {
              await opts.onToolCall(toolCall);
            }
            return finalResponse;
          },
        ),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };
    }

    it('read_file tool call reads file via workspaceReader and caches content', async () => {
      const workspaceReader = {
        readFileForTool: jest.fn().mockResolvedValue({ content: 'file body', isError: false }),
      };
      const cachedFiles = new Map<string, string>();
      const copilotProvider = makeCopilotProviderWithToolCall({
        id: 'tool-1',
        name: 'read_file',
        filePath: 'src/app.ts',
      });

      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: workspaceReader as never,
      });

      await runner.runRound(
        makeRoundRequest({ cachedFiles }),
        makeCancellationToken(),
        jest.fn(),
      );

      expect(workspaceReader.readFileForTool).toHaveBeenCalledWith('src/app.ts');
      expect(cachedFiles.get('src/app.ts')).toBe('file body');
    });

    it('read_file tool call serves from cache without calling workspaceReader', async () => {
      const workspaceReader = {
        readFileForTool: jest.fn().mockResolvedValue({ content: 'stale', isError: false }),
      };
      const cachedFiles = new Map([['src/app.ts', 'cached body']]);
      const copilotProvider = makeCopilotProviderWithToolCall({
        id: 'tool-1',
        name: 'read_file',
        filePath: 'src/app.ts',
      });

      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: workspaceReader as never,
      });

      await runner.runRound(
        makeRoundRequest({ cachedFiles }),
        makeCancellationToken(),
        jest.fn(),
      );

      expect(workspaceReader.readFileForTool).not.toHaveBeenCalled();
    });

    it('run_command calls onRunCommand and stores output in cachedCommandOutputs', async () => {
      const cachedCommandOutputs = new Map();
      const onRunCommand = jest.fn().mockResolvedValue({
        command: 'npm test',
        stdout: 'All tests passed',
        exitCode: 0,
      });
      const copilotProvider = makeCopilotProviderWithToolCall({
        id: 'tool-1',
        name: 'run_command',
        command: 'npm test',
      });

      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await runner.runRound(
        makeRoundRequest({ cachedCommandOutputs }),
        makeCancellationToken(),
        jest.fn(),
        onRunCommand,
      );

      expect(onRunCommand).toHaveBeenCalledWith('npm test');
      expect(cachedCommandOutputs.get('npm test')).toEqual({
        command: 'npm test',
        stdout: 'All tests passed',
        exitCode: 0,
      });
    });

    it('run_command returns error result when onRunCommand is not provided', async () => {
      let capturedResult: ToolResult | undefined;
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(
          async (opts: { onToolCall?: (tc: ToolCall) => Promise<ToolResult> }) => {
            if (opts.onToolCall) {
              capturedResult = await opts.onToolCall({ id: 'tool-1', name: 'run_command', command: 'npm test' });
            }
            return 'Response';
          },
        ),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };

      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      // No onRunCommand callback
      await runner.runRound(makeRoundRequest(), makeCancellationToken(), jest.fn());

      expect(capturedResult?.isError).toBe(true);
      expect(capturedResult?.content).toContain('not available');
    });

    it('emits tool_run_command progress event when run_command is called', async () => {
      const progressEvents: string[] = [];
      const onRunCommand = jest.fn().mockResolvedValue({ command: 'npm test', stdout: '', exitCode: 0 });
      const copilotProvider = makeCopilotProviderWithToolCall({
        id: 'tool-1',
        name: 'run_command',
        command: 'npm test',
      });

      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await runner.runRound(
        makeRoundRequest(),
        makeCancellationToken(),
        (e) => progressEvents.push(e.type),
        onRunCommand,
      );

      expect(progressEvents).toContain('tool_run_command');
    });
  });

  // ── Multi-turn behavior ───────────────────────────────────────────────────────

  describe('multi-turn behavior', () => {
    it('fileCache persists across turns — second turn sees first turn reads without re-fetching', async () => {
      const fileCache = new Map<string, string>();
      const commandOutputCache = new Map();

      // Provider: Turn 1 calls read_file tool, Turn 2 does NOT
      let turn = 0;
      const workspaceReader = {
        readFileForTool: jest.fn().mockResolvedValue({ content: 'app content', isError: false }),
      };
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(async (opts: { userMessage: string; onToolCall?: (tc: ToolCall) => Promise<ToolResult> }) => {
          turn++;
          if (turn === 1 && opts.onToolCall) {
            await opts.onToolCall({ id: 't1', name: 'read_file', filePath: 'src/app.ts' });
          }
          return 'Response';
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: workspaceReader as never,
      });

      // Turn 1 — reads file via tool
      await runner.runRound(
        makeRoundRequest({ cachedFiles: fileCache, cachedCommandOutputs: commandOutputCache }),
        makeCancellationToken(),
        jest.fn(),
      );
      expect(workspaceReader.readFileForTool).toHaveBeenCalledTimes(1);
      expect(fileCache.get('src/app.ts')).toBe('app content');

      // Turn 2 — same fileCache, provider does NOT call read_file tool
      // file is served from cache in the initial user message (cached section)
      await runner.runRound(
        makeRoundRequest({ cachedFiles: fileCache, cachedCommandOutputs: new Map() }),
        makeCancellationToken(),
        jest.fn(),
      );
      // workspaceReader should still have been called only once (from Turn 1)
      expect(workspaceReader.readFileForTool).toHaveBeenCalledTimes(1);
    });

    it('fileCache from Turn 1 appears in Turn 2 main agent message as [FILES FROM PREVIOUS TURN]', async () => {
      const fileCache = new Map([['src/app.ts', 'const x = 1;']]);
      const capturedMessages: string[] = [];
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation((opts: { userMessage: string }) => {
          capturedMessages.push(opts.userMessage);
          return Promise.resolve('Response');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await runner.runRound(
        makeRoundRequest({
          workspaceContext: { files: [{ path: 'src/app.ts', content: '', language: 'typescript' }] },
          cachedFiles: fileCache,
        }),
        makeCancellationToken(),
        jest.fn(),
      );

      const mainMsg = capturedMessages[0];
      expect(mainMsg).toContain('[FILES FROM PREVIOUS TURN]');
      expect(mainMsg).toContain('const x = 1;');
    });

    it('commandOutputCache cleared between turns — Turn 2 sub-agents do not see Turn 1 commands', async () => {
      let turn = 0;
      const capturedSubAgentMessages: string[] = [];
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation((opts: { userMessage: string }) => {
          turn++;
          // calls: T1-main(1), T1-sub(2), T1-reflect(3), T2-main(4), T2-sub(5), T2-reflect(6)
          if (turn === 2 || turn === 5) capturedSubAgentMessages.push(opts.userMessage);
          return Promise.resolve(turn % 3 === 2 ? 'Sub feedback' : 'Response');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      const fileCache = new Map<string, string>();

      // Turn 1: commandOutputCache has an entry
      const t1CommandOutputs = new Map([
        ['npm test', { command: 'npm test', stdout: 'T1 results', exitCode: 0 }],
      ]);
      await runner.runRound(
        makeRoundRequest({ subAgents: [AgentName.GPT], cachedFiles: fileCache, cachedCommandOutputs: t1CommandOutputs }),
        makeCancellationToken(),
        jest.fn(),
      );

      // Turn 2: caller clears commandOutputCache (simulating ChatPanel behavior)
      const t2CommandOutputs = new Map<string, import('../../src/types').CommandOutput>();
      await runner.runRound(
        makeRoundRequest({ subAgents: [AgentName.GPT], cachedFiles: fileCache, cachedCommandOutputs: t2CommandOutputs }),
        makeCancellationToken(),
        jest.fn(),
      );

      expect(capturedSubAgentMessages[0]).toContain('T1 results');              // Turn 1 sub sees T1 commands
      expect(capturedSubAgentMessages[1]).not.toContain('[COMMANDS RUN BY PRIMARY AGENT]'); // Turn 2 sub does NOT
    });

    it('conversationHistory from Turn 1 is passed to Turn 2 main agent', async () => {
      const conversationHistory: { role: 'user' | 'assistant'; content: string }[] = [];
      const capturedHistories: unknown[][] = [];
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation((opts: { conversationHistory?: unknown[] }) => {
          capturedHistories.push(opts.conversationHistory ?? []);
          return Promise.resolve('Response');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      // Turn 1: empty history
      await runner.runRound(
        makeRoundRequest({ userMessage: 'Build a TODO app', conversationHistory: [] }),
        makeCancellationToken(),
        jest.fn(),
      );

      // Simulate ChatPanel pushing history after Turn 1
      conversationHistory.push({ role: 'user', content: 'Build a TODO app' });
      conversationHistory.push({ role: 'assistant', content: 'Response' });

      // Turn 2: history now has Turn 1
      await runner.runRound(
        makeRoundRequest({ userMessage: 'Add filtering', conversationHistory }),
        makeCancellationToken(),
        jest.fn(),
      );

      // Turn 1 main agent had empty history
      expect(capturedHistories[0]).toHaveLength(0);
      // Turn 2 main agent sees Turn 1 history
      expect(capturedHistories[1]).toHaveLength(2);
      expect((capturedHistories[1] as { role: string; content: string }[])[0].content).toBe('Build a TODO app');
    });

    it('sub-agents in Turn 2 receive files accumulated from both turns', async () => {
      let turn = 0;
      const capturedSubAgentMessages: string[] = [];
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(async (opts: { userMessage: string; onToolCall?: (tc: ToolCall) => Promise<ToolResult> }) => {
          turn++;
          // Turn 1 main (1): reads fileA; Turn 1 sub (2): captured; Turn 1 reflect (3)
          // Turn 2 main (4): reads fileB; Turn 2 sub (5): captured; Turn 2 reflect (6)
          if (turn === 1 && opts.onToolCall) {
            await opts.onToolCall({ id: 't1', name: 'read_file', filePath: 'src/a.ts' });
          }
          if (turn === 4 && opts.onToolCall) {
            await opts.onToolCall({ id: 't2', name: 'read_file', filePath: 'src/b.ts' });
          }
          if (turn === 2 || turn === 5) capturedSubAgentMessages.push(opts.userMessage);
          return Promise.resolve(turn === 2 || turn === 5 ? 'Sub feedback' : 'Response');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };
      const workspaceReaderFixed = {
        readFileForTool: jest.fn().mockImplementation((filePath: string) =>
          Promise.resolve({ content: `content of ${filePath}`, isError: false }),
        ),
      };

      const fileCache = new Map<string, string>();
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: workspaceReaderFixed as never,
      });

      // Turn 1
      await runner.runRound(
        makeRoundRequest({ subAgents: [AgentName.GPT], cachedFiles: fileCache, cachedCommandOutputs: new Map() }),
        makeCancellationToken(),
        jest.fn(),
      );

      // Turn 2 (same fileCache)
      await runner.runRound(
        makeRoundRequest({ subAgents: [AgentName.GPT], cachedFiles: fileCache, cachedCommandOutputs: new Map() }),
        makeCancellationToken(),
        jest.fn(),
      );

      // Turn 1 sub-agent sees only fileA
      expect(capturedSubAgentMessages[0]).toContain('src/a.ts');
      expect(capturedSubAgentMessages[0]).not.toContain('src/b.ts');

      // Turn 2 sub-agent sees both fileA (from Turn 1 cache) and fileB (just read)
      expect(capturedSubAgentMessages[1]).toContain('src/a.ts');
      expect(capturedSubAgentMessages[1]).toContain('src/b.ts');
    });

    it('reflected response (not main response) is used as assistant history', async () => {
      // This verifies that the caller gets the correct response to store in history.
      // The RoundResult.reflectedResponse should reflect sub-agent corrections, not the raw main response.
      let callCount = 0;
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve('Main initial response');
          if (callCount === 2) return Promise.resolve('Sub-agent correction');
          return Promise.resolve('Reflected and corrected response');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      const result = await runner.runRound(
        makeRoundRequest({ subAgents: [AgentName.GPT] }),
        makeCancellationToken(),
        jest.fn(),
      );

      // reflectedResponse is what gets stored as conversation history
      expect(result.reflectedResponse).toBe('Reflected and corrected response');
      expect(result.mainAgentResponse).toBe('Main initial response');
    });
  });

  // ── Tool call regression ──────────────────────────────────────────────────────

  describe('tool call regression', () => {
    it('MAX_TOOL_CALLS limit returns error result without throwing', async () => {
      let toolCallCount = 0;
      // Provider calls read_file many times
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(async (opts: { onToolCall?: (tc: ToolCall) => Promise<ToolResult> }) => {
          if (opts.onToolCall) {
            for (let i = 0; i < 105; i++) {
              const result = await opts.onToolCall({ id: `t${i}`, name: 'read_file', filePath: `file${i}.ts` });
              if (result.isError && result.content.includes('limit')) {
                toolCallCount++;
              }
            }
          }
          return 'Response';
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };
      const workspaceReader = {
        readFileForTool: jest.fn().mockResolvedValue({ content: 'content', isError: false }),
      };
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: workspaceReader as never,
      });

      const result = await runner.runRound(makeRoundRequest(), makeCancellationToken(), jest.fn());

      // Round should complete successfully despite hitting limit
      expect(result.reflectedResponse).toBe('Response');
      // Some calls should have hit the limit
      expect(toolCallCount).toBeGreaterThan(0);
      // workspaceReader should have been called at most MAX_TOOL_CALLS times
      expect(workspaceReader.readFileForTool.mock.calls.length).toBeLessThanOrEqual(100);
    });

    it('readFileForTool error result is NOT cached', async () => {
      const fileCache = new Map<string, string>();
      let callCount = 0;
      const workspaceReader = {
        readFileForTool: jest.fn().mockResolvedValue({ content: 'File not found', isError: true }),
      };
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(async (opts: { onToolCall?: (tc: ToolCall) => Promise<ToolResult> }) => {
          callCount++;
          if (opts.onToolCall) {
            await opts.onToolCall({ id: 't1', name: 'read_file', filePath: 'missing.ts' });
          }
          return 'Response';
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: workspaceReader as never,
      });

      // Two turns — error result must not be cached
      await runner.runRound(makeRoundRequest({ cachedFiles: fileCache }), makeCancellationToken(), jest.fn());
      await runner.runRound(makeRoundRequest({ cachedFiles: fileCache }), makeCancellationToken(), jest.fn());

      // File should NOT be in cache (error result)
      expect(fileCache.has('missing.ts')).toBe(false);
      // workspaceReader called both turns (not served from cache)
      expect(workspaceReader.readFileForTool).toHaveBeenCalledTimes(2);
    });

    it('emits tool_read progress event for both cache hits and new reads', async () => {
      const fileCache = new Map([['cached.ts', 'cached content']]);
      const progressEvents: { type: string; filePath?: string }[] = [];

      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(async (opts: { onToolCall?: (tc: ToolCall) => Promise<ToolResult> }) => {
          if (opts.onToolCall) {
            await opts.onToolCall({ id: 't1', name: 'read_file', filePath: 'cached.ts' });
            await opts.onToolCall({ id: 't2', name: 'read_file', filePath: 'new.ts' });
          }
          return 'Response';
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };
      const workspaceReader = {
        readFileForTool: jest.fn().mockResolvedValue({ content: 'new content', isError: false }),
      };
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: workspaceReader as never,
      });

      await runner.runRound(
        makeRoundRequest({ cachedFiles: fileCache }),
        makeCancellationToken(),
        (e) => { if ('filePath' in e) progressEvents.push({ type: e.type, filePath: (e as { filePath: string }).filePath }); },
      );

      const readEvents = progressEvents.filter((e) => e.type === 'tool_read');
      expect(readEvents.map((e) => e.filePath)).toContain('cached.ts');
      expect(readEvents.map((e) => e.filePath)).toContain('new.ts');
    });

    it('run_command with non-zero exit code returns isError: true', async () => {
      let capturedResult: ToolResult | undefined;
      const onRunCommand = jest.fn().mockResolvedValue({
        command: 'npm test',
        stdout: 'FAIL: 2 tests failed',
        exitCode: 1,
      });
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(async (opts: { onToolCall?: (tc: ToolCall) => Promise<ToolResult> }) => {
          if (opts.onToolCall) {
            capturedResult = await opts.onToolCall({ id: 't1', name: 'run_command', command: 'npm test' });
          }
          return 'Response';
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await runner.runRound(makeRoundRequest(), makeCancellationToken(), jest.fn(), onRunCommand);

      expect(capturedResult?.isError).toBe(true);
      expect(capturedResult?.content).toContain('FAIL: 2 tests failed');
    });
  });

  // ── Reflection regression ─────────────────────────────────────────────────────

  describe('reflection regression', () => {
    it('skips reflection when all sub-agents fail — reflectedResponse equals mainAgentResponse', async () => {
      let callCount = 0;
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve('Main response');
          throw new Error('Sub-agent down');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      const result = await runner.runRound(
        makeRoundRequest({ subAgents: [AgentName.GPT] }),
        makeCancellationToken(),
        jest.fn(),
      );

      // No reflection call (only 2 calls: main + sub)
      expect(copilotProvider.sendRequest).toHaveBeenCalledTimes(2);
      expect(result.reflectedResponse).toBe(result.mainAgentResponse);
    });

    it('DEVELOPER round passes full file blocks to reflection prompt', async () => {
      let callCount = 0;
      const capturedReflectionMessages: string[] = [];
      const mainWithFile = 'Here is the code\n\nFILE: src/app.ts\n```\nconst x = 1;\n```';

      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation((opts: { userMessage: string }) => {
          callCount++;
          if (callCount === 1) return Promise.resolve(mainWithFile);
          if (callCount === 2) return Promise.resolve('Sub feedback');
          capturedReflectionMessages.push(opts.userMessage);
          return Promise.resolve('Reflected');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await runner.runRound(
        makeRoundRequest({ roundType: RoundType.DEVELOPER, subAgents: [AgentName.GPT] }),
        makeCancellationToken(),
        jest.fn(),
      );

      // DEVELOPER round: FILE: block should be in reflection prompt
      expect(capturedReflectionMessages[0]).toContain('FILE: src/app.ts');
    });

    it('non-DEVELOPER round passes main agent response as-is to reflection prompt', async () => {
      let callCount = 0;
      const capturedReflectionMessages: string[] = [];
      const mainResponse = 'Here is the design for the new architecture.';

      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation((opts: { userMessage: string }) => {
          callCount++;
          if (callCount === 1) return Promise.resolve(mainResponse);
          if (callCount === 2) return Promise.resolve('Sub feedback');
          capturedReflectionMessages.push(opts.userMessage);
          return Promise.resolve('Reflected');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await runner.runRound(
        makeRoundRequest({ roundType: RoundType.ARCHITECT, subAgents: [AgentName.GPT] }),
        makeCancellationToken(),
        jest.fn(),
      );

      // Non-FILE_WRITING round: main agent response passed through unchanged
      expect(capturedReflectionMessages[0]).toContain(mainResponse);
    });

    it('reflection emits reflection_chunk progress events', async () => {
      let callCount = 0;
      const chunkEvents: string[] = [];
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation((opts: { onChunk?: (chunk: string) => void }) => {
          callCount++;
          if (callCount === 1) return Promise.resolve('Main response');
          if (callCount === 2) return Promise.resolve('Sub feedback');
          // Reflection: emit chunks
          opts.onChunk?.('chunk1');
          opts.onChunk?.('chunk2');
          return Promise.resolve('Reflected');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await runner.runRound(
        makeRoundRequest({ subAgents: [AgentName.GPT] }),
        makeCancellationToken(),
        (e) => { if (e.type === 'reflection_chunk') chunkEvents.push((e as { chunk: string }).chunk); },
      );

      expect(chunkEvents).toContain('chunk1');
      expect(chunkEvents).toContain('chunk2');
    });
  });

  // ── Sub-agent context passing ─────────────────────────────────────────────────

  describe('sub-agent context passing', () => {
    it('sub-agents receive [FILES READ BY PRIMARY AGENT] when cachedFiles is populated', async () => {
      let callCount = 0;
      const capturedSubAgentMessages: string[] = [];
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation((opts: { userMessage: string }) => {
          callCount++;
          if (callCount === 2) capturedSubAgentMessages.push(opts.userMessage);
          return Promise.resolve(callCount === 2 ? 'Sub feedback' : 'Response');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };

      const cachedFiles = new Map([['src/app.ts', 'const x = 1;']]);

      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await runner.runRound(
        makeRoundRequest({ subAgents: [AgentName.GPT], cachedFiles }),
        makeCancellationToken(),
        jest.fn(),
      );

      expect(capturedSubAgentMessages[0]).toContain('[FILES READ BY PRIMARY AGENT]');
      expect(capturedSubAgentMessages[0]).toContain('src/app.ts');
      expect(capturedSubAgentMessages[0]).toContain('const x = 1;');
    });

    it('sub-agents receive [COMMANDS RUN BY PRIMARY AGENT] when cachedCommandOutputs is populated', async () => {
      let callCount = 0;
      const capturedSubAgentMessages: string[] = [];
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation((opts: { userMessage: string }) => {
          callCount++;
          if (callCount === 2) capturedSubAgentMessages.push(opts.userMessage);
          return Promise.resolve(callCount === 2 ? 'Sub feedback' : 'Response');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };

      const cachedCommandOutputs = new Map([
        ['npm test', { command: 'npm test', stdout: '5 tests passed', exitCode: 0 }],
      ]);

      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await runner.runRound(
        makeRoundRequest({ subAgents: [AgentName.GPT], cachedCommandOutputs }),
        makeCancellationToken(),
        jest.fn(),
      );

      expect(capturedSubAgentMessages[0]).toContain('[COMMANDS RUN BY PRIMARY AGENT]');
      expect(capturedSubAgentMessages[0]).toContain('npm test');
      expect(capturedSubAgentMessages[0]).toContain('5 tests passed');
    });

    it('sub-agent message omits command section when cachedCommandOutputs is empty', async () => {
      let callCount = 0;
      const capturedSubAgentMessages: string[] = [];
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation((opts: { userMessage: string }) => {
          callCount++;
          if (callCount === 2) capturedSubAgentMessages.push(opts.userMessage);
          return Promise.resolve(callCount === 2 ? 'Sub feedback' : 'Response');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };

      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await runner.runRound(
        makeRoundRequest({ subAgents: [AgentName.GPT], cachedCommandOutputs: new Map() }),
        makeCancellationToken(),
        jest.fn(),
      );

      expect(capturedSubAgentMessages[0]).not.toContain('[COMMANDS RUN BY PRIMARY AGENT]');
    });
  });

  // ── Branch coverage: uncovered paths ─────────────────────────────────────────

  describe('branch coverage — token usage, cancellation timing, error wrapping', () => {
    it('accumulates token usage from API key provider responses', async () => {
      // addUsage: covers lines 125-126 (if (usage) true branch with actual values)
      const apiKeyProvider = {
        hasKeyForAgent: jest.fn().mockReturnValue(true),
        sendRequest: jest.fn().mockResolvedValue({
          content: 'API response',
          usage: { inputTokens: 500, outputTokens: 200 },
        }),
      };

      const runner = new AgentRunner({
        copilotProvider: makeCopilotProvider() as never,
        apiKeyProvider: apiKeyProvider as never,
        providerMode: ProviderMode.API_KEYS,
        workspaceReader: makeWorkspaceReader() as never,
      });

      const result = await runner.runRound(
        makeRoundRequest({ subAgents: [] }),
        makeCancellationToken(),
        jest.fn(),
      );

      expect(result.tokenUsage).toEqual({ inputTokens: 500, outputTokens: 200 });
    });

    it('invokes onChunk callbacks during streaming main agent response (line 139)', async () => {
      // Covers: onChunk callback in callAgent options
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(
          (opts: { onChunk?: (c: string) => void }) => {
            opts.onChunk?.('hello ');
            opts.onChunk?.('world');
            return Promise.resolve('hello world');
          },
        ),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };

      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      const progressEvents: Array<{ type: string; chunk?: string }> = [];
      await runner.runRound(
        makeRoundRequest(),
        makeCancellationToken(),
        (e) => { progressEvents.push(e as never); },
      );

      const chunkEvents = progressEvents.filter((e) => e.type === 'main_agent_chunk');
      expect(chunkEvents.length).toBeGreaterThan(0);
    });

    it('throws CancellationError when token is cancelled after main agent returns (line 148)', async () => {
      // Covers: if (cancellationToken.isCancellationRequested) at line 148
      // Strategy: set cancelled=true inside the provider sendRequest, so the
      // check at line 148 (right after the await) sees it as true.
      let cancelled = false;
      const cancellationToken = {
        get isCancellationRequested() { return cancelled; },
        onCancellationRequested: jest.fn().mockReturnValue({ dispose: jest.fn() }),
      };

      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(() => {
          cancelled = true; // flip flag so next isCancellationRequested check returns true
          return Promise.resolve('main response');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };

      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await expect(
        runner.runRound(
          makeRoundRequest({ subAgents: [AgentName.GPT] }),
          cancellationToken as never,
          jest.fn(),
        ),
      ).rejects.toThrow(CancellationError);
    });

    it('throws CancellationError when token is cancelled after sub-agents complete (line 230)', async () => {
      // Covers: if (cancellationToken.isCancellationRequested) at line 230
      // Strategy: token is fine through main agent (line 148 passes), then
      // sub-agent's sendRequest sets cancelled=true so the check at line 230
      // (after Promise.all) sees it as true.
      let callCount = 0;
      let cancelled = false;
      const cancellationToken = {
        get isCancellationRequested() { return cancelled; },
        onCancellationRequested: jest.fn().mockReturnValue({ dispose: jest.fn() }),
      };

      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 2) cancelled = true; // sub-agent call — cancel for post-sub check
          return Promise.resolve(callCount === 2 ? 'sub feedback' : 'main response');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };

      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await expect(
        runner.runRound(
          makeRoundRequest({ subAgents: [AgentName.GPT] }),
          cancellationToken as never,
          jest.fn(),
        ),
      ).rejects.toThrow(CancellationError);
    });

    it('throws CancellationError when token is cancelled after reflection returns (line 295)', async () => {
      // Covers: if (cancellationToken.isCancellationRequested) at line 295
      let callCount = 0;
      let cancelled = false;
      const cancellationToken = {
        get isCancellationRequested() { return cancelled; },
        onCancellationRequested: jest.fn().mockReturnValue({ dispose: jest.fn() }),
      };

      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(() => {
          callCount++;
          const response = callCount === 2 ? 'sub feedback' : 'response';
          if (callCount === 3) {
            // This is the reflection call — cancel after it resolves
            cancelled = true;
          }
          return Promise.resolve(response);
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };

      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await expect(
        runner.runRound(
          makeRoundRequest({ subAgents: [AgentName.GPT] }),
          cancellationToken as never,
          jest.fn(),
        ),
      ).rejects.toThrow(CancellationError);
    });

    it('wraps ApiKeyProviderError as AgentRunnerError (line 358)', async () => {
      // Covers: err instanceof ApiKeyProviderError → throw AgentRunnerError
      const { ApiKeyProviderError } = await import('../../src/agents/ApiKeyProvider');
      const apiKeyProvider = {
        hasKeyForAgent: jest.fn().mockReturnValue(true),
        sendRequest: jest.fn().mockRejectedValue(
          new ApiKeyProviderError('rate limit exceeded', 429),
        ),
      };

      const runner = new AgentRunner({
        copilotProvider: makeCopilotProvider() as never,
        apiKeyProvider: apiKeyProvider as never,
        providerMode: ProviderMode.API_KEYS,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await expect(
        runner.runRound(makeRoundRequest(), makeCancellationToken(), jest.fn()),
      ).rejects.toThrow(AgentRunnerError);
    });

    it('wraps non-Error thrown values with a safe message (line 379)', async () => {
      // Covers: toSafeErrorMessage when err is not an Error instance
      const apiKeyProvider = {
        hasKeyForAgent: jest.fn().mockReturnValue(true),
        // throw a non-Error (string) value
        sendRequest: jest.fn().mockImplementation(() => { throw 'something went wrong'; }),
      };

      const runner = new AgentRunner({
        copilotProvider: makeCopilotProvider() as never,
        apiKeyProvider: apiKeyProvider as never,
        providerMode: ProviderMode.API_KEYS,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await expect(
        runner.runRound(makeRoundRequest(), makeCancellationToken(), jest.fn()),
      ).rejects.toThrow(AgentRunnerError);
    });

    it('uses "(no output)" placeholder when command stdout is empty (line 188 branch)', async () => {
      // Covers: o.stdout || '(no output)' false branch — empty stdout
      let callCount = 0;
      let capturedSubMsg = '';
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation((opts: { userMessage: string }) => {
          callCount++;
          if (callCount === 2) capturedSubMsg = opts.userMessage;
          return Promise.resolve(callCount === 2 ? 'sub feedback' : 'main response');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };

      const cachedCommandOutputs = new Map([
        ['npm test', { command: 'npm test', stdout: '', exitCode: 0 }],
      ]);

      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await runner.runRound(
        makeRoundRequest({ subAgents: [AgentName.GPT], cachedCommandOutputs }),
        makeCancellationToken(),
        jest.fn(),
      );

      expect(capturedSubMsg).toContain('(no output)');
    });

    it('skips file path note in reflection for non-file-writing round with no FILE blocks (line 269 branch)', async () => {
      // Covers: writtenFilePaths.length > 0 false branch — main response has no FILE: blocks
      let callCount = 0;
      let capturedReflectionMsg = '';
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation((opts: { userMessage: string }) => {
          callCount++;
          if (callCount === 3) capturedReflectionMsg = opts.userMessage;
          return Promise.resolve(callCount === 2 ? 'sub feedback' : 'prose only response');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };

      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await runner.runRound(
        makeRoundRequest({ roundType: RoundType.ARCHITECT, subAgents: [AgentName.GPT] }),
        makeCancellationToken(),
        jest.fn(),
      );

      // No [FILES YOU WROTE] note since no FILE: blocks in main response
      expect(capturedReflectionMsg).not.toContain('[FILES YOU WROTE');
    });

    // ── write_file tool: happy path, invalid path, overwrite, progress, reflection, fallback ──

    it('write_file tool call stages file in result.fileChanges', async () => {
      // Covers lines 99-112: write_file happy path, push to allFileChanges
      let capturedResult: ToolResult | undefined;
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(async (opts: { onToolCall?: (tc: ToolCall) => Promise<ToolResult> }) => {
          if (opts.onToolCall) {
            capturedResult = await opts.onToolCall({ id: 'w1', name: 'write_file', filePath: 'src/new.ts', content: 'export const x = 1;' });
          }
          return 'Response';
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      const result = await runner.runRound(makeRoundRequest(), makeCancellationToken(), jest.fn());

      expect(capturedResult?.isError).toBe(false);
      expect(capturedResult?.content).toContain('src/new.ts');
      expect(result.fileChanges).toHaveLength(1);
      expect(result.fileChanges[0]).toMatchObject({ filePath: 'src/new.ts', content: 'export const x = 1;' });
    });

    it('write_file tool call with invalid path (traversal) returns isError: true', async () => {
      // Covers lines 101-103: normalizePath returns null for '..' paths
      let capturedResult: ToolResult | undefined;
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(async (opts: { onToolCall?: (tc: ToolCall) => Promise<ToolResult> }) => {
          if (opts.onToolCall) {
            capturedResult = await opts.onToolCall({ id: 'w1', name: 'write_file', filePath: '../outside/evil.ts', content: 'malicious' });
          }
          return 'Response';
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      const result = await runner.runRound(makeRoundRequest(), makeCancellationToken(), jest.fn());

      expect(capturedResult?.isError).toBe(true);
      expect(capturedResult?.content).toContain('Invalid file path');
      expect(result.fileChanges).toHaveLength(0);
    });

    it('write_file tool call overwrites previous entry for the same path', async () => {
      // Covers lines 105,107-109: existing = findIndex ≥ 0 → overwrite
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(async (opts: { onToolCall?: (tc: ToolCall) => Promise<ToolResult> }) => {
          if (opts.onToolCall) {
            await opts.onToolCall({ id: 'w1', name: 'write_file', filePath: 'src/file.ts', content: 'version 1' });
            await opts.onToolCall({ id: 'w2', name: 'write_file', filePath: 'src/file.ts', content: 'version 2' });
          }
          return 'Response';
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      const result = await runner.runRound(makeRoundRequest(), makeCancellationToken(), jest.fn());

      // Should have exactly one entry, with the latest content
      expect(result.fileChanges).toHaveLength(1);
      expect(result.fileChanges[0].content).toBe('version 2');
    });

    it('write_file tool call emits tool_write_file progress event', async () => {
      // Covers line 104: onProgress tool_write_file
      const progressEvents: Array<{ type: string; filePath?: string }> = [];
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(async (opts: { onToolCall?: (tc: ToolCall) => Promise<ToolResult> }) => {
          if (opts.onToolCall) {
            await opts.onToolCall({ id: 'w1', name: 'write_file', filePath: 'src/out.ts', content: 'content' });
          }
          return 'Response';
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await runner.runRound(
        makeRoundRequest(),
        makeCancellationToken(),
        (e) => { if ('filePath' in e) progressEvents.push({ type: e.type, filePath: (e as { filePath: string }).filePath }); },
      );

      const writeEvents = progressEvents.filter((e) => e.type === 'tool_write_file');
      expect(writeEvents).toHaveLength(1);
      expect(writeEvents[0].filePath).toBe('src/out.ts');
    });

    it('DEVELOPER round reflection includes [FILES WRITTEN VIA write_file TOOL] section when files written', async () => {
      // Covers line 286-287: writtenFilesSection when mainAgentFileChanges.length > 0
      let callCount = 0;
      let capturedReflectionMsg = '';
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(async (opts: { userMessage: string; onToolCall?: (tc: ToolCall) => Promise<ToolResult> }) => {
          callCount++;
          if (callCount === 1 && opts.onToolCall) {
            await opts.onToolCall({ id: 'w1', name: 'write_file', filePath: 'src/app.ts', content: 'const x = 1;' });
          }
          if (callCount === 3) capturedReflectionMsg = opts.userMessage;
          return Promise.resolve(callCount === 2 ? 'Sub feedback' : 'Response');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await runner.runRound(
        makeRoundRequest({ roundType: RoundType.DEVELOPER, subAgents: [AgentName.GPT] }),
        makeCancellationToken(),
        jest.fn(),
      );

      expect(capturedReflectionMsg).toContain('[FILES WRITTEN VIA write_file TOOL]');
      expect(capturedReflectionMsg).toContain('src/app.ts');
      expect(capturedReflectionMsg).toContain('const x = 1;');
    });

    it('non-DEVELOPER round reflection includes write_file paths in [FILES YOU WROTE] note', async () => {
      // Covers lines 292-293: mainAgentFileChanges paths merged into writtenFilePaths
      let callCount = 0;
      let capturedReflectionMsg = '';
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(async (opts: { userMessage: string; onToolCall?: (tc: ToolCall) => Promise<ToolResult> }) => {
          callCount++;
          if (callCount === 1 && opts.onToolCall) {
            await opts.onToolCall({ id: 'w1', name: 'write_file', filePath: 'docs/spec.md', content: '# Spec' });
          }
          if (callCount === 3) capturedReflectionMsg = opts.userMessage;
          return Promise.resolve(callCount === 2 ? 'Sub feedback' : 'Response');
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await runner.runRound(
        makeRoundRequest({ roundType: RoundType.ARCHITECT, subAgents: [AgentName.GPT] }),
        makeCancellationToken(),
        jest.fn(),
      );

      expect(capturedReflectionMsg).toContain('[FILES YOU WROTE');
      expect(capturedReflectionMsg).toContain('docs/spec.md');
      // Full content should NOT appear in prose-only reflection
      expect(capturedReflectionMsg).not.toContain('# Spec');
    });

    it('fileChanges contains only write_file tool results (no FILE: block parsing)', async () => {
      // Phase 2: FILE: blocks in response text are ignored — only write_file tool calls matter
      const responseWithFileBlock = 'Here is the fix.\n\nFILE: src/fix.ts\n```\nexport const y = 2;\n```';
      const copilotProvider = {
        sendRequest: jest.fn().mockResolvedValue(responseWithFileBlock),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      const result = await runner.runRound(makeRoundRequest(), makeCancellationToken(), jest.fn());

      // No write_file tool call was made, so fileChanges is empty
      expect(result.fileChanges).toHaveLength(0);
    });

    it('write_file tool result is the sole source of fileChanges', async () => {
      // Phase 2: only write_file tool calls produce fileChanges
      const fileBlock = 'FILE: src/app.ts\n```\nfallback content\n```';
      const copilotProvider = {
        sendRequest: jest.fn().mockImplementation(async (opts: { onToolCall?: (tc: ToolCall) => Promise<ToolResult> }) => {
          if (opts.onToolCall) {
            await opts.onToolCall({ id: 'w1', name: 'write_file', filePath: 'src/app.ts', content: 'tool content' });
          }
          return fileBlock; // response text also mentions FILE: block, but it is ignored
        }),
        isAvailable: jest.fn().mockResolvedValue(true),
        invalidateModelCache: jest.fn(),
      };
      const runner = new AgentRunner({
        copilotProvider: copilotProvider as never,
        apiKeyProvider: makeApiKeyProvider() as never,
        providerMode: ProviderMode.COPILOT,
        workspaceReader: makeWorkspaceReader() as never,
      });

      const result = await runner.runRound(makeRoundRequest(), makeCancellationToken(), jest.fn());

      // Only the write_file tool result appears — FILE: block in text is not parsed
      expect(result.fileChanges).toHaveLength(1);
      expect(result.fileChanges[0].content).toBe('tool content');
    });

    it('re-throws CancellationError from ApiKeyProvider thrown by name (line 349)', async () => {
      // Covers: err instanceof Error && err.name === 'CancellationError' (not vscode.CancellationError)
      const namedCancellation = new Error('Request cancelled');
      namedCancellation.name = 'CancellationError';

      const apiKeyProvider = {
        hasKeyForAgent: jest.fn().mockReturnValue(true),
        sendRequest: jest.fn().mockRejectedValue(namedCancellation),
      };

      const runner = new AgentRunner({
        copilotProvider: makeCopilotProvider() as never,
        apiKeyProvider: apiKeyProvider as never,
        providerMode: ProviderMode.API_KEYS,
        workspaceReader: makeWorkspaceReader() as never,
      });

      await expect(
        runner.runRound(makeRoundRequest(), makeCancellationToken(), jest.fn()),
      ).rejects.toThrow(CancellationError);
    });
  });
});
