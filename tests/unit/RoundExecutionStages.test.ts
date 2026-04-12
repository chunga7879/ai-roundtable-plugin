import { RoundExecutionStages } from '../../src/agents/RoundExecutionStages';
import { AgentName, type CommandOutput, type ToolResult } from '../../src/types';

function createStages() {
  return new RoundExecutionStages({
    workspaceReader: {
      readFileForTool: jest.fn().mockResolvedValue({ content: 'file', isError: false }),
    } as never,
    callAgent: jest.fn(async () => ({ content: 'ok' })),
    shouldRetryMissingToolWrites: jest.fn().mockReturnValue(false),
    buildMissingToolWriteRecoveryPrompt: jest.fn().mockReturnValue('recover'),
    toSafeErrorMessage: jest.fn().mockReturnValue('error'),
    extractConsensusIssues: jest.fn().mockReturnValue([]),
    awaitWithCancellation: async <T>(promise: Promise<T>) => promise,
  });
}

function createHandlers() {
  const stages = createStages();
  const progressEvents: Array<{ type: string; filePath?: string }> = [];
  const handlers = stages.createRoundToolHandlers({
    mainAgent: AgentName.CLAUDE,
    onProgress: (event) => {
      if ('filePath' in event) {
        progressEvents.push({ type: event.type, filePath: event.filePath });
        return;
      }
      progressEvents.push({ type: event.type });
    },
    onRunCommand: async (command: string): Promise<CommandOutput> => ({
      command,
      stdout: 'ok',
      exitCode: 0,
    }),
    cachedFiles: new Map<string, string>(),
    cachedCommandOutputs: new Map<string, CommandOutput>(),
  });
  return { handlers, progressEvents };
}

describe('RoundExecutionStages tool handlers', () => {
  it('stages delete_file from main handler', async () => {
    const { handlers, progressEvents } = createHandlers();

    const result = await handlers.main({ id: 'd1', name: 'delete_file', filePath: 'src/remove.ts' });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Staged delete of src/remove.ts');
    expect(handlers.getAllFileChanges()).toEqual([
      { filePath: 'src/remove.ts', content: '', isNew: false, isDeleted: true },
    ]);
    expect(progressEvents).toContainEqual({
      type: 'tool_delete_file',
      filePath: 'src/remove.ts',
    });
  });

  it('rejects invalid delete_file path from main handler', async () => {
    const { handlers } = createHandlers();

    const result = await handlers.main({ id: 'd1', name: 'delete_file', filePath: '../outside.ts' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid file path');
    expect(handlers.getAllFileChanges()).toHaveLength(0);
  });

  it('enforces reflection write limit after 20 writes', async () => {
    const { handlers } = createHandlers();
    handlers.setAllowedReflectionFilePaths(['src/file.ts']);

    let finalResult: ToolResult | undefined;
    for (let i = 0; i <= 20; i++) {
      finalResult = await handlers.reflection({
        id: `r-${i}`,
        name: 'write_file',
        filePath: 'src/file.ts',
        content: `v${i}`,
      });
    }

    expect(finalResult).toBeDefined();
    expect(finalResult?.isError).toBe(true);
    expect(finalResult?.content).toContain('Reflection write limit (20) reached');
  });

  it('rejects reflection write_file and delete_file for invalid or disallowed paths', async () => {
    const { handlers } = createHandlers();
    handlers.setAllowedReflectionFilePaths(['src/allowed.ts']);

    const invalidPath = await handlers.reflection({
      id: 'w-invalid',
      name: 'write_file',
      filePath: '../outside.ts',
      content: 'x',
    });
    const blockedDelete = await handlers.reflection({
      id: 'd-blocked',
      name: 'delete_file',
      filePath: 'src/not-allowed.ts',
    });

    expect(invalidPath.isError).toBe(true);
    expect(invalidPath.content).toContain('Invalid file path');
    expect(blockedDelete.isError).toBe(true);
    expect(blockedDelete.content).toContain('Reflection may only modify files written in the initial response');
  });

  it('allows reflection delete_file for allowed paths', async () => {
    const { handlers, progressEvents } = createHandlers();
    handlers.setAllowedReflectionFilePaths(['src/allowed.ts']);

    const result = await handlers.reflection({
      id: 'd-ok',
      name: 'delete_file',
      filePath: 'src/allowed.ts',
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Staged delete of src/allowed.ts');
    expect(handlers.getAllFileChanges()).toEqual([
      { filePath: 'src/allowed.ts', content: '', isNew: false, isDeleted: true },
    ]);
    expect(progressEvents).toContainEqual({
      type: 'tool_delete_file',
      filePath: 'src/allowed.ts',
    });
  });

  it('blocks run_command and read_file during reflection', async () => {
    const { handlers } = createHandlers();

    const runCommandResult = await handlers.reflection({
      id: 'run-1',
      name: 'run_command',
      command: 'npm test',
    });
    const readFileResult = await handlers.reflection({
      id: 'read-1',
      name: 'read_file',
      filePath: 'src/index.ts',
    });

    expect(runCommandResult.isError).toBe(true);
    expect(runCommandResult.content).toContain('run_command is not available during reflection');
    expect(readFileResult.isError).toBe(true);
    expect(readFileResult.content).toContain('read_file is not available during reflection');
  });
});
