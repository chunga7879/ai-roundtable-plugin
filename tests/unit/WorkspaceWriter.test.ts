import { parseFileChanges } from '../../src/workspace/WorkspaceWriter';

describe('parseFileChanges', () => {
  describe('valid FILE: blocks', () => {
    it('parses a single FILE: block with language specifier', () => {
      const input = `
FILE: src/index.ts
\`\`\`typescript
const x = 1;
\`\`\`
`;
      const result = parseFileChanges(input);
      expect(result).toHaveLength(1);
      expect(result[0].filePath).toBe('src/index.ts');
      expect(result[0].content).toContain('const x = 1;');
      expect(result[0].isNew).toBe(false);
    });

    it('parses a FILE: block without language specifier', () => {
      const input = `FILE: config.json\n\`\`\`\n{"key": "value"}\n\`\`\``;
      const result = parseFileChanges(input);
      expect(result).toHaveLength(1);
      expect(result[0].filePath).toBe('config.json');
    });

    it('parses multiple FILE: blocks from the same response', () => {
      const input = `
FILE: src/a.ts
\`\`\`typescript
export const A = 1;
\`\`\`

FILE: src/b.ts
\`\`\`typescript
export const B = 2;
\`\`\`
`;
      const result = parseFileChanges(input);
      expect(result).toHaveLength(2);
      expect(result[0].filePath).toBe('src/a.ts');
      expect(result[1].filePath).toBe('src/b.ts');
    });

    it('normalizes backslashes to forward slashes', () => {
      const input = `FILE: src\\components\\App.tsx\n\`\`\`tsx\nconst App = () => <div/>\n\`\`\``;
      const result = parseFileChanges(input);
      expect(result).toHaveLength(1);
      expect(result[0].filePath).toBe('src/components/App.tsx');
    });

    it('strips leading ./ from paths', () => {
      const input = `FILE: ./src/main.py\n\`\`\`python\nprint("hello")\n\`\`\``;
      const result = parseFileChanges(input);
      expect(result).toHaveLength(1);
      expect(result[0].filePath).toBe('src/main.py');
    });

    it('strips leading / from paths', () => {
      const input = `FILE: /src/main.go\n\`\`\`go\npackage main\n\`\`\``;
      const result = parseFileChanges(input);
      expect(result).toHaveLength(1);
      expect(result[0].filePath).toBe('src/main.go');
    });
  });

  describe('security: path traversal rejection', () => {
    it('rejects paths containing ..', () => {
      const input = `FILE: ../../etc/passwd\n\`\`\`\nroot:x:0:0\n\`\`\``;
      const result = parseFileChanges(input);
      expect(result).toHaveLength(0);
    });

    it('rejects paths containing .. in the middle', () => {
      const input = `FILE: src/../../../etc/passwd\n\`\`\`\nroot\n\`\`\``;
      const result = parseFileChanges(input);
      expect(result).toHaveLength(0);
    });

    it('rejects paths that are just ..', () => {
      const input = `FILE: ..\n\`\`\`\ncontent\n\`\`\``;
      const result = parseFileChanges(input);
      expect(result).toHaveLength(0);
    });
  });

  describe('deduplication', () => {
    it('returns only the first occurrence of a duplicate path', () => {
      const input = `
FILE: src/index.ts
\`\`\`typescript
const first = 1;
\`\`\`

FILE: src/index.ts
\`\`\`typescript
const second = 2;
\`\`\`
`;
      const result = parseFileChanges(input);
      expect(result).toHaveLength(1);
      expect(result[0].content).toContain('const first = 1;');
    });

    it('handles three duplicate paths by keeping only the first', () => {
      const block = `FILE: foo.ts\n\`\`\`ts\nconst x = 1;\n\`\`\`\n`;
      const input = block + block + block;
      const result = parseFileChanges(input);
      expect(result).toHaveLength(1);
    });
  });

  describe('edge cases', () => {
    it('returns empty array for input with no FILE: blocks', () => {
      const result = parseFileChanges('No file blocks here, just prose.');
      expect(result).toHaveLength(0);
    });

    it('returns empty array for empty string input', () => {
      const result = parseFileChanges('');
      expect(result).toHaveLength(0);
    });

    it('handles FILE: blocks with empty content', () => {
      const input = `FILE: empty.ts\n\`\`\`typescript\n\`\`\``;
      const result = parseFileChanges(input);
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('');
    });

    it('preserves multiline content inside a block', () => {
      const content = 'line1\nline2\nline3\n';
      const input = `FILE: multi.ts\n\`\`\`\n${content}\`\`\``;
      const result = parseFileChanges(input);
      expect(result).toHaveLength(1);
      expect(result[0].content).toContain('line1');
      expect(result[0].content).toContain('line3');
    });

    it('parses FILE: blocks embedded in surrounding prose', () => {
      const input = `
Here is my analysis:

The key issue is the missing error handler.

FILE: src/handler.ts
\`\`\`typescript
export function handle() {}
\`\`\`

Let me know if you want changes.
`;
      const result = parseFileChanges(input);
      expect(result).toHaveLength(1);
      expect(result[0].filePath).toBe('src/handler.ts');
    });

    it('is idempotent when called twice on the same input', () => {
      const input = `FILE: a.ts\n\`\`\`ts\nconst x = 1;\n\`\`\``;
      const r1 = parseFileChanges(input);
      const r2 = parseFileChanges(input);
      expect(r1).toEqual(r2);
    });

    it('stops at 50 file changes (MAX_FILE_CHANGES limit)', () => {
      const blocks = Array.from({ length: 55 }, (_, i) =>
        `FILE: src/file${i}.ts\n\`\`\`ts\nconst x${i} = ${i};\n\`\`\`\n`,
      ).join('\n');
      const result = parseFileChanges(blocks);
      expect(result).toHaveLength(50);
    });
  });

  describe('DELETE: blocks', () => {
    it('parses a single DELETE: line', () => {
      const input = `DELETE: src/old/auth.ts`;
      const result = parseFileChanges(input);
      expect(result).toHaveLength(1);
      expect(result[0].filePath).toBe('src/old/auth.ts');
      expect(result[0].isDelete).toBe(true);
      expect(result[0].content).toBe('');
    });

    it('parses DELETE: alongside FILE: blocks', () => {
      const input = `
FILE: src/new/auth.ts
\`\`\`typescript
export const auth = true;
\`\`\`

DELETE: src/old/auth.ts
`;
      const result = parseFileChanges(input);
      expect(result).toHaveLength(2);
      const fileChange = result.find((r) => !r.isDelete);
      const deleteChange = result.find((r) => r.isDelete);
      expect(fileChange?.filePath).toBe('src/new/auth.ts');
      expect(deleteChange?.filePath).toBe('src/old/auth.ts');
    });

    it('rejects DELETE: paths with directory traversal', () => {
      const input = `DELETE: ../../etc/passwd`;
      const result = parseFileChanges(input);
      expect(result).toHaveLength(0);
    });

    it('rejects DELETE: paths with .. in the middle', () => {
      const input = `DELETE: src/../../../etc/shadow`;
      const result = parseFileChanges(input);
      expect(result).toHaveLength(0);
    });

    it('deduplicates DELETE: and FILE: for the same path', () => {
      const input = `
FILE: src/auth.ts
\`\`\`typescript
const x = 1;
\`\`\`

DELETE: src/auth.ts
`;
      const result = parseFileChanges(input);
      // FILE: wins because it comes first; DELETE: is deduplicated
      expect(result).toHaveLength(1);
      expect(result[0].isDelete).toBeFalsy();
    });

    it('normalizes DELETE: path separators', () => {
      const input = `DELETE: src\\old\\utils.ts`;
      const result = parseFileChanges(input);
      expect(result).toHaveLength(1);
      expect(result[0].filePath).toBe('src/old/utils.ts');
    });

    it('strips leading ./ from DELETE: paths', () => {
      const input = `DELETE: ./src/legacy.ts`;
      const result = parseFileChanges(input);
      expect(result).toHaveLength(1);
      expect(result[0].filePath).toBe('src/legacy.ts');
    });
  });
});
