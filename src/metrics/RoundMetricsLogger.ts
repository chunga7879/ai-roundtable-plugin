import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentName, ProviderMode, RoundType } from '../types';

const MAX_STORED_RECORDS = 2000;
const MAX_RECORD_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface RoundRunMetricRecord {
  version: 1;
  timestamp: number;
  workspaceId: string;
  roundType: RoundType;
  mainAgent: AgentName;
  subAgentsConfigured: number;
  status: 'success' | 'cancelled' | 'error';
  durationMs: number;
  providerMode?: ProviderMode;
  modelTier?: 'light' | 'heavy';
  inputTokens?: number;
  outputTokens?: number;
  fileChangeCount?: number;
  verifyCommandSuggested?: boolean;
  reflectionUsed?: boolean;
  validSubAgentCount?: number;
  unavailableSubAgentCount?: number;
  verifierIssuesTotal?: number;
  consensusIssueCount?: number;
  errorName?: string;
}

interface GroupStats {
  runs: number;
  success: number;
  cancelled: number;
  error: number;
  avgDurationMs: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgTotalTokens: number;
  avgFileChanges: number;
  reflectionRatePct: number;
  avgVerifierIssues: number;
  consensusHitRatePct: number;
}

export interface AbSummary {
  totalRuns: number;
  singleAgent: GroupStats;
  withVerifiers: GroupStats;
  oneVerifier: GroupStats;
  twoPlusVerifiers: GroupStats;
  durationRatioWithVerifiersVsSingle: number;
  tokenRatioWithVerifiersVsSingle: number;
}

export class RoundMetricsLogger {
  private workspaceHash: string | undefined;

  constructor(private readonly storageUri: vscode.Uri) {}

  async append(record: Omit<RoundRunMetricRecord, 'version' | 'timestamp' | 'workspaceId'>): Promise<void> {
    try {
      const fullRecord: RoundRunMetricRecord = {
        version: 1,
        timestamp: Date.now(),
        workspaceId: this.getWorkspaceHash(),
        ...record,
      };
      const metricsDir = this.metricsDir();
      await fs.mkdir(metricsDir, { recursive: true });
      await fs.appendFile(this.metricsFilePath(), JSON.stringify(fullRecord) + '\n', 'utf8');
      await this.pruneStorage(fullRecord.timestamp);
    } catch {
      // Non-fatal: metrics logging must never block user workflow.
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.rm(this.metricsDir(), { recursive: true, force: true });
    } catch {
      // Non-fatal
    }
  }

  async readAll(limit = MAX_STORED_RECORDS): Promise<RoundRunMetricRecord[]> {
    try {
      const raw = await fs.readFile(this.metricsFilePath(), 'utf8');
      const records = raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => this.safeParseRecord(line))
        .filter((r): r is RoundRunMetricRecord => r !== null);
      if (limit <= 0 || records.length <= limit) {
        return records;
      }
      return records.slice(records.length - limit);
    } catch {
      return [];
    }
  }

  async buildMarkdownReport(limit = MAX_STORED_RECORDS): Promise<{ markdown: string; summary: AbSummary }> {
    const records = await this.readAll(limit);
    const summary = RoundMetricsLogger.buildSummary(records);
    return {
      summary,
      markdown: RoundMetricsLogger.formatSummaryMarkdown(summary),
    };
  }

  static buildSummary(records: RoundRunMetricRecord[]): AbSummary {
    const singleAgent = computeGroupStats(records.filter((r) => r.subAgentsConfigured === 0));
    const withVerifiers = computeGroupStats(records.filter((r) => r.subAgentsConfigured > 0));
    const oneVerifier = computeGroupStats(records.filter((r) => r.subAgentsConfigured === 1));
    const twoPlusVerifiers = computeGroupStats(records.filter((r) => r.subAgentsConfigured >= 2));

    return {
      totalRuns: records.length,
      singleAgent,
      withVerifiers,
      oneVerifier,
      twoPlusVerifiers,
      durationRatioWithVerifiersVsSingle: ratio(withVerifiers.avgDurationMs, singleAgent.avgDurationMs),
      tokenRatioWithVerifiersVsSingle: ratio(withVerifiers.avgTotalTokens, singleAgent.avgTotalTokens),
    };
  }

  static formatSummaryMarkdown(summary: AbSummary): string {
    const formatPct = (value: number): string => `${value.toFixed(1)}%`;
    const formatNum = (value: number): string => value.toFixed(1);
    const formatRatio = (value: number): string => (value > 0 ? `${value.toFixed(2)}x` : 'n/a');

    const rows = [
      ['Single agent (0 sub)', summary.singleAgent],
      ['With verifiers (>=1 sub)', summary.withVerifiers],
      ['Exactly 1 verifier', summary.oneVerifier],
      ['2+ verifiers', summary.twoPlusVerifiers],
    ] as const;

    const tableLines = rows.map(([label, s]) => {
      return `| ${label} | ${s.runs} | ${s.success} | ${s.cancelled} | ${s.error} | ${formatNum(s.avgDurationMs)} | ${formatNum(s.avgTotalTokens)} | ${formatPct(s.reflectionRatePct)} | ${formatNum(s.avgVerifierIssues)} | ${formatPct(s.consensusHitRatePct)} |`;
    }).join('\n');

    const now = new Date().toISOString();

    return [
      '# AI Roundtable A/B Summary',
      '',
      `Generated: ${now}`,
      `Total runs analyzed: ${summary.totalRuns}`,
      '',
      '## Group Metrics',
      '',
      '| Group | Runs | Success | Cancelled | Error | Avg Duration (ms) | Avg Total Tokens | Reflection Rate | Avg Verifier Issues | Consensus Hit Rate |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
      tableLines,
      '',
      '## Cost Multipliers',
      '',
      `- Duration multiplier (with verifiers vs single): **${formatRatio(summary.durationRatioWithVerifiersVsSingle)}**`,
      `- Token multiplier (with verifiers vs single): **${formatRatio(summary.tokenRatioWithVerifiersVsSingle)}**`,
      '',
      '## Interpretation Guide',
      '',
      '- Reflection Rate: percentage of successful runs where verifier feedback triggered reflection.',
      '- Avg Verifier Issues: average number of issues surfaced by verifiers in successful runs.',
      '- Consensus Hit Rate: percentage of successful runs with at least one issue flagged by all valid verifiers.',
    ].join('\n');
  }

  private metricsDir(): string {
    return path.join(this.storageUri.fsPath, 'metrics', this.getWorkspaceHash());
  }

  private metricsFilePath(): string {
    return path.join(this.metricsDir(), 'round-runs.jsonl');
  }

  private getWorkspaceHash(): string {
    if (this.workspaceHash) {
      return this.workspaceHash;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'no-workspace';
    this.workspaceHash = crypto.createHash('sha1').update(root).digest('hex').slice(0, 12);
    return this.workspaceHash;
  }

  private safeParseRecord(line: string): RoundRunMetricRecord | null {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
      }
      const record = parsed as Partial<RoundRunMetricRecord>;
      if (record.version !== 1 || typeof record.timestamp !== 'number' || typeof record.workspaceId !== 'string') {
        return null;
      }
      if (typeof record.subAgentsConfigured !== 'number' || typeof record.durationMs !== 'number') {
        return null;
      }
      if (record.status !== 'success' && record.status !== 'cancelled' && record.status !== 'error') {
        return null;
      }
      if (typeof record.roundType !== 'string' || typeof record.mainAgent !== 'string') {
        return null;
      }
      return record as RoundRunMetricRecord;
    } catch {
      return null;
    }
  }

  private async pruneStorage(nowMs: number): Promise<void> {
    try {
      const raw = await fs.readFile(this.metricsFilePath(), 'utf8');
      const cutoff = nowMs - MAX_RECORD_AGE_MS;
      const kept = raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => this.safeParseRecord(line))
        .filter((r): r is RoundRunMetricRecord => r !== null && r.timestamp >= cutoff)
        .slice(-MAX_STORED_RECORDS);

      if (kept.length === 0) {
        await fs.rm(this.metricsFilePath(), { force: true });
        return;
      }

      const content = kept.map((r) => JSON.stringify(r)).join('\n') + '\n';
      await fs.writeFile(this.metricsFilePath(), content, 'utf8');
    } catch {
      // Non-fatal
    }
  }
}

function computeGroupStats(records: RoundRunMetricRecord[]): GroupStats {
  const runs = records.length;
  const successRecords = records.filter((r) => r.status === 'success');
  const success = successRecords.length;
  const cancelled = records.filter((r) => r.status === 'cancelled').length;
  const error = records.filter((r) => r.status === 'error').length;

  const avgDurationMs = average(records.map((r) => r.durationMs));
  const avgInputTokens = average(successRecords.map((r) => r.inputTokens ?? 0));
  const avgOutputTokens = average(successRecords.map((r) => r.outputTokens ?? 0));
  const avgTotalTokens = avgInputTokens + avgOutputTokens;
  const avgFileChanges = average(successRecords.map((r) => r.fileChangeCount ?? 0));
  const reflectionRatePct = percent(successRecords.filter((r) => r.reflectionUsed === true).length, success);
  const avgVerifierIssues = average(successRecords.map((r) => r.verifierIssuesTotal ?? 0));
  const consensusHitRatePct = percent(successRecords.filter((r) => (r.consensusIssueCount ?? 0) > 0).length, success);

  return {
    runs,
    success,
    cancelled,
    error,
    avgDurationMs,
    avgInputTokens,
    avgOutputTokens,
    avgTotalTokens,
    avgFileChanges,
    reflectionRatePct,
    avgVerifierIssues,
    consensusHitRatePct,
  };
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sum = values.reduce((acc, n) => acc + n, 0);
  return sum / values.length;
}

function percent(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return (numerator / denominator) * 100;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return numerator / denominator;
}
