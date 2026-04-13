import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentName, ProviderMode, RoundType } from '../types';

const MAX_STORED_RECORDS = 2000;
const MAX_RECORD_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_RUNS_PER_BUCKET_FOR_MULTIPLIER = 3;
const UNKNOWN_BUCKET = 'unknown';
const ROUND_TYPE_DISPLAY_ORDER = [
  'requirements',
  'architect',
  'developer',
  'reviewer',
  'qa',
  'devops',
  'documentation',
  UNKNOWN_BUCKET,
] as const;
const MODEL_TIER_DISPLAY_ORDER = ['light', 'heavy', UNKNOWN_BUCKET] as const;
const MAIN_AGENT_DISPLAY_ORDER = [
  'claude',
  'gpt',
  'gemini',
  'deepseek',
  'copilot',
  UNKNOWN_BUCKET,
] as const;
const ROUND_TYPE_LABELS: Record<string, string> = {
  requirements: 'Requirements',
  architect: 'Architect',
  developer: 'Developer',
  reviewer: 'Reviewer',
  qa: 'QA',
  devops: 'DevOps',
  documentation: 'Documentation',
  [UNKNOWN_BUCKET]: 'Unknown',
};
const MODEL_TIER_LABELS: Record<string, string> = {
  light: 'Light',
  heavy: 'Heavy',
  [UNKNOWN_BUCKET]: 'Unknown',
};
const MAIN_AGENT_LABELS: Record<string, string> = {
  claude: 'Claude',
  gpt: 'GPT',
  gemini: 'Gemini',
  deepseek: 'DeepSeek',
  copilot: 'Copilot',
  [UNKNOWN_BUCKET]: 'Unknown',
};

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

interface BreakdownStats {
  key: string;
  label: string;
  aggregate: GroupStats;
  successRatePct: number;
  durationRatioWithVerifiersVsSingle?: number;
  tokenRatioWithVerifiersVsSingle?: number;
}

export interface AbSummary {
  totalRuns: number;
  singleAgent: GroupStats;
  withVerifiers: GroupStats;
  oneVerifier: GroupStats;
  twoPlusVerifiers: GroupStats;
  durationRatioWithVerifiersVsSingle: number;
  tokenRatioWithVerifiersVsSingle: number;
  byRoundType: BreakdownStats[];
  byModelTier: BreakdownStats[];
  byMainAgent: BreakdownStats[];
}

export class RoundMetricsLogger {
  private workspaceHash: string | undefined;
  private storageMutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly storageUri: vscode.Uri) {}

  async append(record: Omit<RoundRunMetricRecord, 'version' | 'timestamp' | 'workspaceId'>): Promise<void> {
    await this.withStorageMutation(async () => {
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
    });
  }

  async clear(): Promise<void> {
    await this.withStorageMutation(async () => {
      try {
        await fs.rm(this.metricsDir(), { recursive: true, force: true });
      } catch {
        // Non-fatal
      }
    });
  }

  async readAll(limit = MAX_STORED_RECORDS): Promise<RoundRunMetricRecord[]> {
    await this.storageMutationQueue;
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
    const byRoundType = computeBreakdownStats(
      records,
      (record) => normalizeBucketKey(record.roundType),
      ROUND_TYPE_LABELS,
      ROUND_TYPE_DISPLAY_ORDER,
    );
    const byModelTier = computeBreakdownStats(
      records,
      (record) => normalizeModelTierKey(record.modelTier),
      MODEL_TIER_LABELS,
      MODEL_TIER_DISPLAY_ORDER,
    );
    const byMainAgent = computeBreakdownStats(
      records,
      (record) => normalizeBucketKey(record.mainAgent),
      MAIN_AGENT_LABELS,
      MAIN_AGENT_DISPLAY_ORDER,
    );

    return {
      totalRuns: records.length,
      singleAgent,
      withVerifiers,
      oneVerifier,
      twoPlusVerifiers,
      durationRatioWithVerifiersVsSingle: ratio(withVerifiers.avgDurationMs, singleAgent.avgDurationMs),
      tokenRatioWithVerifiersVsSingle: ratio(withVerifiers.avgTotalTokens, singleAgent.avgTotalTokens),
      byRoundType,
      byModelTier,
      byMainAgent,
    };
  }

  static formatSummaryMarkdown(summary: AbSummary): string {
    const formatPct = (value: number): string => `${value.toFixed(1)}%`;
    const formatNum = (value: number): string => value.toFixed(1);
    const formatRatio = (value: number): string => (value > 0 ? `${value.toFixed(2)}x` : 'n/a');
    const formatOptionalRatio = (value?: number): string => (value && value > 0 ? `${value.toFixed(2)}x` : 'n/a');

    const rows = [
      ['Single agent (0 sub)', summary.singleAgent],
      ['With verifiers (>=1 sub)', summary.withVerifiers],
      ['Exactly 1 verifier', summary.oneVerifier],
      ['2+ verifiers', summary.twoPlusVerifiers],
    ] as const;

    const tableLines = rows.map(([label, s]) => {
      return `| ${label} | ${s.runs} | ${s.success} | ${s.cancelled} | ${s.error} | ${formatNum(s.avgDurationMs)} | ${formatNum(s.avgTotalTokens)} | ${formatPct(s.reflectionRatePct)} | ${formatNum(s.avgVerifierIssues)} | ${formatPct(s.consensusHitRatePct)} |`;
    }).join('\n');

    const breakdownSection = (title: string, buckets: BreakdownStats[]): string[] => {
      if (buckets.length === 0) {
        return [title, '', 'No runs in this dataset.', ''];
      }

      const lines = buckets.map((bucket) => {
        const s = bucket.aggregate;
        return `| ${bucket.label} | ${s.runs} | ${formatPct(bucket.successRatePct)} | ${formatNum(s.avgDurationMs)} | ${formatNum(s.avgTotalTokens)} | ${formatPct(s.reflectionRatePct)} | ${formatNum(s.avgVerifierIssues)} | ${formatPct(s.consensusHitRatePct)} | ${formatOptionalRatio(bucket.durationRatioWithVerifiersVsSingle)} | ${formatOptionalRatio(bucket.tokenRatioWithVerifiersVsSingle)} |`;
      });

      return [
        title,
        '',
        '| Segment | Runs | Success Rate | Avg Duration (ms) | Avg Total Tokens | Reflection Rate | Avg Verifier Issues | Consensus Hit Rate | Duration x (verifiers/single) | Tokens x (verifiers/single) |',
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
        ...lines,
        '',
      ];
    };

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
      ...breakdownSection('## Breakdown by Round Type', summary.byRoundType),
      ...breakdownSection('## Breakdown by Model Tier', summary.byModelTier),
      ...breakdownSection('## Breakdown by Main Agent', summary.byMainAgent),
      '## Interpretation Guide',
      '',
      '- Reflection Rate: percentage of successful runs where verifier feedback triggered reflection.',
      '- Avg Verifier Issues: average number of issues surfaced by verifiers in successful runs.',
      '- Consensus Hit Rate: percentage of successful runs with at least one issue flagged by all valid verifiers.',
      '- Per-segment multipliers show verifier vs single-agent cost inside each segment; shown as n/a when either side has fewer than 3 runs.',
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

  private withStorageMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.storageMutationQueue
      .catch((): void => undefined)
      .then(operation);
    this.storageMutationQueue = next.then(
      (): void => undefined,
      (): void => undefined,
    );
    return next;
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

function computeBreakdownStats(
  records: RoundRunMetricRecord[],
  bucketSelector: (record: RoundRunMetricRecord) => string,
  labels: Record<string, string>,
  displayOrder: readonly string[],
): BreakdownStats[] {
  const grouped = new Map<string, RoundRunMetricRecord[]>();
  for (const record of records) {
    const key = bucketSelector(record);
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(record);
    } else {
      grouped.set(key, [record]);
    }
  }

  const orderedIndex = new Map<string, number>(
    displayOrder.map((key, index) => [key, index]),
  );

  const buckets = Array.from(grouped.entries()).map(([key, bucketRecords]) => {
    const aggregate = computeGroupStats(bucketRecords);
    const singleAgent = computeGroupStats(bucketRecords.filter((r) => r.subAgentsConfigured === 0));
    const withVerifiers = computeGroupStats(bucketRecords.filter((r) => r.subAgentsConfigured > 0));
    const successRatePct = percent(aggregate.success, aggregate.runs);

    const durationRatioWithVerifiersVsSingle = computeBucketRatio(
      withVerifiers.avgDurationMs,
      singleAgent.avgDurationMs,
      withVerifiers.runs,
      singleAgent.runs,
    );
    const tokenRatioWithVerifiersVsSingle = computeBucketRatio(
      withVerifiers.avgTotalTokens,
      singleAgent.avgTotalTokens,
      withVerifiers.runs,
      singleAgent.runs,
    );

    return {
      key,
      label: labels[key] ?? humanizeLabel(key),
      aggregate,
      successRatePct,
      durationRatioWithVerifiersVsSingle,
      tokenRatioWithVerifiersVsSingle,
    };
  });

  buckets.sort((a, b) => {
    const aOrder = orderedIndex.get(a.key);
    const bOrder = orderedIndex.get(b.key);
    if (aOrder !== undefined || bOrder !== undefined) {
      if (aOrder === undefined) {
        return 1;
      }
      if (bOrder === undefined) {
        return -1;
      }
      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }
    }
    if (a.aggregate.runs !== b.aggregate.runs) {
      return b.aggregate.runs - a.aggregate.runs;
    }
    return a.label.localeCompare(b.label);
  });

  return buckets;
}

function computeBucketRatio(
  numerator: number,
  denominator: number,
  numeratorRuns: number,
  denominatorRuns: number,
): number | undefined {
  if (
    numeratorRuns < MIN_RUNS_PER_BUCKET_FOR_MULTIPLIER
    || denominatorRuns < MIN_RUNS_PER_BUCKET_FOR_MULTIPLIER
    || denominator <= 0
  ) {
    return undefined;
  }
  return ratio(numerator, denominator);
}

function normalizeBucketKey(value: string | undefined): string {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized.length > 0 ? normalized : UNKNOWN_BUCKET;
}

function normalizeModelTierKey(tier: RoundRunMetricRecord['modelTier']): string {
  if (tier === 'light' || tier === 'heavy') {
    return tier;
  }
  return UNKNOWN_BUCKET;
}

function humanizeLabel(value: string): string {
  return value
    .split(/[_\-\s]+/g)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Unknown';
}
