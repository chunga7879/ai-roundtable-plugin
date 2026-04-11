export interface SanitizedCommand {
  /** Raw command emitted by the model or UI flow. */
  original: string;
  /** Command that should actually be executed. Empty when skipped as no-op. */
  effective: string;
  /** True when command text was rewritten or skipped. */
  normalized: boolean;
  /** True when command is a no-op and should not be executed. */
  skipped: boolean;
  /** Optional human-readable normalization note. */
  note?: string;
}

const CD_WORKSPACE_ONLY_RE = /^\s*cd\s+(["'])?\/workspace\1\s*$/i;
const CD_WORKSPACE_PREFIX_RE = /^\s*cd\s+(["'])?\/workspace\1\s*(?:&&|;)\s*/i;

/**
 * Normalizes model-generated commands that incorrectly assume a Linux container
 * root at /workspace. This extension already executes commands at the workspace
 * root via cwd, so leading "cd /workspace" is redundant and may fail locally.
 */
export function sanitizeCommandForWorkspace(command: string): SanitizedCommand {
  const original = typeof command === 'string' ? command : String(command);
  const trimmed = original.trim();

  if (trimmed.length === 0) {
    return {
      original,
      effective: '',
      normalized: false,
      skipped: true,
      note: 'Skipped empty command.',
    };
  }

  if (CD_WORKSPACE_ONLY_RE.test(trimmed)) {
    return {
      original,
      effective: '',
      normalized: true,
      skipped: true,
      note: 'Skipped redundant "cd /workspace" (commands already run at workspace root).',
    };
  }

  if (CD_WORKSPACE_PREFIX_RE.test(trimmed)) {
    const effective = trimmed.replace(CD_WORKSPACE_PREFIX_RE, '').trim();
    if (effective.length === 0) {
      return {
        original,
        effective: '',
        normalized: true,
        skipped: true,
        note: 'Skipped no-op command after removing redundant "cd /workspace".',
      };
    }
    return {
      original,
      effective,
      normalized: true,
      skipped: false,
      note: 'Removed redundant "cd /workspace" prefix.',
    };
  }

  return {
    original,
    effective: original,
    normalized: false,
    skipped: false,
  };
}
