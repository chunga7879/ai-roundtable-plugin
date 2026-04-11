import { RoundMetricsLogger, type RoundRunMetricRecord } from '../../src/metrics/RoundMetricsLogger';
import { AgentName, RoundType } from '../../src/types';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000;

describe('RoundMetricsLogger.buildSummary', () => {
  it('builds grouped A/B metrics and ratios', () => {
    const records: RoundRunMetricRecord[] = [
      {
        version: 1,
        timestamp: 1,
        workspaceId: 'ws',
        roundType: RoundType.DEVELOPER,
        mainAgent: AgentName.CLAUDE,
        subAgentsConfigured: 0,
        status: 'success',
        durationMs: 1000,
        inputTokens: 100,
        outputTokens: 50,
        fileChangeCount: 2,
        reflectionUsed: false,
        verifierIssuesTotal: 0,
        consensusIssueCount: 0,
      },
      {
        version: 1,
        timestamp: 2,
        workspaceId: 'ws',
        roundType: RoundType.DEVELOPER,
        mainAgent: AgentName.CLAUDE,
        subAgentsConfigured: 1,
        status: 'success',
        durationMs: 2200,
        inputTokens: 180,
        outputTokens: 90,
        fileChangeCount: 3,
        reflectionUsed: true,
        validSubAgentCount: 1,
        unavailableSubAgentCount: 0,
        verifierIssuesTotal: 2,
        consensusIssueCount: 2,
      },
      {
        version: 1,
        timestamp: 3,
        workspaceId: 'ws',
        roundType: RoundType.REVIEWER,
        mainAgent: AgentName.GPT,
        subAgentsConfigured: 2,
        status: 'cancelled',
        durationMs: 1800,
      },
    ];

    const summary = RoundMetricsLogger.buildSummary(records);

    expect(summary.totalRuns).toBe(3);
    expect(summary.singleAgent.runs).toBe(1);
    expect(summary.withVerifiers.runs).toBe(2);
    expect(summary.oneVerifier.runs).toBe(1);
    expect(summary.twoPlusVerifiers.runs).toBe(1);
    expect(summary.withVerifiers.reflectionRatePct).toBe(100);
    expect(summary.durationRatioWithVerifiersVsSingle).toBeGreaterThan(1);
    expect(summary.tokenRatioWithVerifiersVsSingle).toBeGreaterThan(1);
  });
});

describe('RoundMetricsLogger.formatSummaryMarkdown', () => {
  it('includes section headers and table rows', () => {
    const summary = RoundMetricsLogger.buildSummary([]);
    const markdown = RoundMetricsLogger.formatSummaryMarkdown(summary);
    expect(markdown).toContain('# AI Roundtable A/B Summary');
    expect(markdown).toContain('## Group Metrics');
    expect(markdown).toContain('## Cost Multipliers');
    expect(markdown).toContain('Single agent (0 sub)');
    expect(markdown).toContain('With verifiers (>=1 sub)');
  });
});

describe('RoundMetricsLogger persistence', () => {
  let storageDir: string;

  beforeEach(async () => {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-roundtable-metrics-'));
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  afterEach(async () => {
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it('clears stored metrics for the current workspace', async () => {
    const logger = new RoundMetricsLogger(vscode.Uri.file(storageDir));
    await logger.append({
      roundType: RoundType.DEVELOPER,
      mainAgent: AgentName.CLAUDE,
      subAgentsConfigured: 0,
      status: 'success',
      durationMs: 100,
    });

    const before = await logger.readAll(10);
    expect(before.length).toBeGreaterThan(0);

    await logger.clear();

    const after = await logger.readAll(10);
    expect(after).toHaveLength(0);
  });

  it('prunes records older than retention window when appending', async () => {
    const now = Date.now();
    const logger = new RoundMetricsLogger(vscode.Uri.file(storageDir));
    const metricsFile = metricsFilePath(storageDir);

    await fs.mkdir(path.dirname(metricsFile), { recursive: true });
    await fs.writeFile(
      metricsFile,
      `${JSON.stringify(makeRecord({
        timestamp: now - THIRTY_ONE_DAYS_MS,
        roundType: RoundType.QA,
      }))}\n${JSON.stringify(makeRecord({
        timestamp: now - 1_000,
        roundType: RoundType.DEVELOPER,
      }))}\n`,
      'utf8',
    );

    await logger.append({
      roundType: RoundType.ARCHITECT,
      mainAgent: AgentName.GPT,
      subAgentsConfigured: 1,
      status: 'success',
      durationMs: 250,
    });

    const records = await logger.readAll(10_000);
    const roundTypes = records.map((r) => r.roundType);
    expect(roundTypes).not.toContain(RoundType.QA);
    expect(roundTypes).toContain(RoundType.DEVELOPER);
    expect(roundTypes).toContain(RoundType.ARCHITECT);
  });

  it('keeps at most 2000 records after append', async () => {
    const now = Date.now();
    const logger = new RoundMetricsLogger(vscode.Uri.file(storageDir));
    const metricsFile = metricsFilePath(storageDir);

    const existing = Array.from({ length: 2100 }, (_unused, i) =>
      JSON.stringify(makeRecord({ timestamp: now - 10_000 + i })),
    ).join('\n') + '\n';

    await fs.mkdir(path.dirname(metricsFile), { recursive: true });
    await fs.writeFile(metricsFile, existing, 'utf8');

    await logger.append({
      roundType: RoundType.QA,
      mainAgent: AgentName.CLAUDE,
      subAgentsConfigured: 0,
      status: 'success',
      durationMs: 111,
    });

    const records = await logger.readAll(10_000);
    expect(records.length).toBe(2000);
    expect(records[records.length - 1]?.roundType).toBe(RoundType.QA);
  });
});

function makeRecord(overrides: Partial<RoundRunMetricRecord> = {}): RoundRunMetricRecord {
  return {
    version: 1,
    timestamp: Date.now(),
    workspaceId: workspaceHash(),
    roundType: RoundType.DEVELOPER,
    mainAgent: AgentName.CLAUDE,
    subAgentsConfigured: 0,
    status: 'success',
    durationMs: 100,
    ...overrides,
  };
}

function workspaceHash(): string {
  return crypto.createHash('sha1').update('no-workspace').digest('hex').slice(0, 12);
}

function metricsFilePath(storageDir: string): string {
  return path.join(storageDir, 'metrics', workspaceHash(), 'round-runs.jsonl');
}
