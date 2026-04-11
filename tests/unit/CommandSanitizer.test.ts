import { sanitizeCommandForWorkspace } from '../../src/workspace/CommandSanitizer';

describe('sanitizeCommandForWorkspace', () => {
  it('passes through normal commands unchanged', () => {
    const result = sanitizeCommandForWorkspace('npm test');
    expect(result).toEqual({
      original: 'npm test',
      effective: 'npm test',
      normalized: false,
      skipped: false,
    });
  });

  it('skips bare cd /workspace as redundant no-op', () => {
    const result = sanitizeCommandForWorkspace('cd /workspace');
    expect(result.normalized).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.effective).toBe('');
    expect(result.note).toContain('Skipped redundant "cd /workspace"');
  });

  it('removes cd /workspace prefix before actual command', () => {
    const result = sanitizeCommandForWorkspace('cd /workspace && npm test -- --listTests');
    expect(result.normalized).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.effective).toBe('npm test -- --listTests');
    expect(result.note).toContain('Removed redundant "cd /workspace" prefix');
  });
});
