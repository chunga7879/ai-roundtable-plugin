import { AgentRunner, AgentRunnerError } from '../../src/agents/AgentRunner';
import { AgentName, ProviderMode, RoundType } from '../../src/types';
import type { RoundRequest } from '../../src/types';
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
});
