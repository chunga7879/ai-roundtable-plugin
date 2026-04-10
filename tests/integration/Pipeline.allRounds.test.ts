import * as vscode from 'vscode';
import { AgentRunner } from '../../src/agents/AgentRunner';
import { WorkspaceWriter } from '../../src/workspace/WorkspaceWriter';
import { AgentName, ProviderMode, RoundType } from '../../src/types';
import type { CommandOutput, ConversationTurn, RoundRequest, ToolCall, ToolResult } from '../../src/types';

const ALL_ROUNDS = Object.values(RoundType);

function makeCancellationToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested: jest.fn(),
  };
}

function makeRoundRequest(roundType: RoundType, conversationHistory: ConversationTurn[], cachedFiles: Map<string, string>, cachedCommandOutputs: Map<string, CommandOutput>): RoundRequest {
  return {
    userMessage: `Implement something for ${roundType}`,
    roundType,
    mainAgent: AgentName.CLAUDE,
    subAgents: [AgentName.GPT, AgentName.GEMINI],
    workspaceContext: { files: [] },
    conversationHistory,
    cachedFiles,
    cachedCommandOutputs,
  };
}

function makeRoundAwareCopilotProvider(roundType: RoundType) {
  let turn = 0;

  return {
    sendRequest: jest.fn().mockImplementation(async (opts: {
      userMessage: string;
      onToolCall?: (tc: ToolCall) => Promise<ToolResult>;
    }) => {
      const isReflection = opts.userMessage.includes('You produced the following initial response:');
      const isMain = Boolean(opts.onToolCall) && !isReflection;
      const isSub = !opts.onToolCall;

      if (isMain) {
        turn += 1;
        await opts.onToolCall?.({
          id: `main-write-${turn}`,
          name: 'write_file',
          filePath: `docs/${roundType}-turn-${turn}.md`,
          content: `initial-${roundType}-${turn}`,
        });
        return `Initial response ${turn}`;
      }

      if (isSub) {
        return JSON.stringify({
          issues: [
            {
              title: `Consensus issue ${turn}`,
              detail: `Fix round ${roundType} turn ${turn}`,
            },
          ],
        });
      }

      await opts.onToolCall?.({
        id: `reflect-write-${turn}`,
        name: 'write_file',
        filePath: `docs/${roundType}-turn-${turn}.md`,
        content: `reflected-${roundType}-${turn}`,
      });
      return `Reflected response ${turn}\nVERIFY: npm test`;
    }),
    isAvailable: jest.fn().mockResolvedValue(true),
    invalidateModelCache: jest.fn(),
  };
}

describe('All rounds pipeline: main + sub + multi-turn + apply', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file('/workspace'), name: 'workspace', index: 0 },
    ];
    (vscode.workspace.fs.stat as jest.Mock).mockResolvedValue({ size: 100, type: vscode.FileType.File });
    (vscode.workspace.applyEdit as jest.Mock).mockResolvedValue(true);
  });

  afterEach(() => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  it.each(ALL_ROUNDS)('runs full pipeline and applies reflected changes for %s', async (roundType) => {
    const copilotProvider = makeRoundAwareCopilotProvider(roundType);
    const runner = new AgentRunner({
      copilotProvider: copilotProvider as never,
      apiKeyProvider: {
        sendRequest: jest.fn(),
        hasKeyForAgent: jest.fn().mockReturnValue(true),
      } as never,
      providerMode: ProviderMode.COPILOT,
      workspaceReader: {
        readFileForTool: jest.fn().mockResolvedValue({ content: '', isError: false }),
      } as never,
    });
    const writer = new WorkspaceWriter();

    const cachedFiles = new Map<string, string>();
    const cachedCommandOutputs = new Map<string, CommandOutput>();
    const history: ConversationTurn[] = [];

    const turn1 = await runner.runRound(
      makeRoundRequest(roundType, history, cachedFiles, cachedCommandOutputs),
      makeCancellationToken() as never,
      jest.fn(),
    );
    expect(turn1.subAgentVerifications).toHaveLength(2);
    expect(turn1.mainAgentResponse).toContain('Initial response 1');
    expect(turn1.reflectedResponse).toContain('Reflected response 1');
    expect(turn1.reflectedResponse).not.toContain('VERIFY:');
    expect(turn1.verifyCommand).toBe('npm test');
    expect(turn1.fileChanges.some((f) => f.content.includes(`reflected-${roundType}-1`))).toBe(true);

    const apply1 = await writer.applyChanges(turn1.fileChanges);
    expect(apply1.appliedFiles.length + apply1.newFiles.length + apply1.deletedFiles.length).toBeGreaterThan(0);

    history.push({ role: 'user', content: `Implement something for ${roundType}` });
    history.push({ role: 'assistant', content: turn1.reflectedResponse });

    const turn2 = await runner.runRound(
      makeRoundRequest(roundType, history, cachedFiles, new Map<string, CommandOutput>()),
      makeCancellationToken() as never,
      jest.fn(),
    );
    expect(turn2.subAgentVerifications).toHaveLength(2);
    expect(turn2.mainAgentResponse).toContain('Initial response 2');
    expect(turn2.reflectedResponse).toContain('Reflected response 2');
    expect(turn2.verifyCommand).toBe('npm test');
    expect(turn2.fileChanges.some((f) => f.content.includes(`reflected-${roundType}-2`))).toBe(true);

    const apply2 = await writer.applyChanges(turn2.fileChanges);
    expect(apply2.appliedFiles.length + apply2.newFiles.length + apply2.deletedFiles.length).toBeGreaterThan(0);
  });
});
