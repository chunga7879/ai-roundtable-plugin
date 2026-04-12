const ISSUE_NONE_RE = /^(none|n\/a)$/i;
const ISSUE_LIST_ITEM_RE = /^([-*]|\d+\.)\s+/;
const ISSUES_NONE_SECTION_RE = /ISSUES:\s*NONE/i;

export const DEFAULT_MAX_ISSUE_TITLES = 20;

export function parseVerifierIssueTitles(
  feedback: string,
  maxTitles = DEFAULT_MAX_ISSUE_TITLES,
): string[] {
  const jsonIssues = extractIssueTitlesFromJson(feedback, maxTitles);
  if (jsonIssues !== null) {
    return jsonIssues;
  }

  return extractIssueTitlesFromMarkdown(feedback, maxTitles);
}

export function normalizeIssueTitle(issue: string): string {
  return issue
    .toLowerCase()
    .replace(/[`"'()[\]{}]/g, '')
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractIssueTitlesFromParsedJson(
  parsed: unknown,
  maxTitles = DEFAULT_MAX_ISSUE_TITLES,
): string[] | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const payload = parsed as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(payload, 'issues')) {
    return null;
  }

  const issues = payload.issues;
  if (Array.isArray(issues)) {
    const titles = issues
      .map((item) => {
        if (typeof item === 'string') {
          return item.trim();
        }
        if (item && typeof item === 'object') {
          const title = (item as Record<string, unknown>).title;
          if (typeof title === 'string') {
            return title.trim();
          }
        }
        return '';
      })
      .filter((title) => title.length > 0 && !ISSUE_NONE_RE.test(title));
    return Array.from(new Set(titles)).slice(0, maxTitles);
  }

  if (typeof issues === 'string' && ISSUE_NONE_RE.test(issues.trim())) {
    return [];
  }

  return [];
}

export function extractEnclosingJsonObject(text: string, requiredToken: string): string | null {
  const tokenIndex = text.indexOf(requiredToken);
  if (tokenIndex === -1) {
    return null;
  }

  const objectStart = text.lastIndexOf('{', tokenIndex);
  if (objectStart === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = objectStart; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(objectStart, i + 1);
      }
    }
  }

  return null;
}

function extractIssueTitlesFromJson(feedback: string, maxTitles: number): string[] | null {
  const candidates = extractJsonCandidates(feedback);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const titles = extractIssueTitlesFromParsedJson(parsed, maxTitles);
      if (titles !== null) {
        return titles;
      }
    } catch {
      // Ignore malformed JSON candidates and continue with others.
    }
  }
  return null;
}

function extractIssueTitlesFromMarkdown(feedback: string, maxTitles: number): string[] {
  if (ISSUES_NONE_SECTION_RE.test(feedback)) {
    return [];
  }

  const issuesSection = feedback.match(/ISSUES:\s*([\s\S]*?)(?:\nDETAILS:|$)/i)?.[1] ?? feedback;
  const titles = issuesSection
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => ISSUE_LIST_ITEM_RE.test(line))
    .map((line) => line.replace(ISSUE_LIST_ITEM_RE, '').trim())
    .filter((line) => line.length > 0 && !ISSUE_NONE_RE.test(line));

  return Array.from(new Set(titles)).slice(0, maxTitles);
}

function extractJsonCandidates(feedback: string): string[] {
  const candidates: string[] = [];
  const pushUnique = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || candidates.includes(trimmed)) {
      return;
    }
    candidates.push(trimmed);
  };

  const fenced = feedback.match(/```(?:json)?\s*([\s\S]*?)```/gi) ?? [];
  for (const block of fenced) {
    const inner = block.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
    pushUnique(inner);
  }

  const whole = feedback.trim();
  if (whole.length === 0) {
    return candidates;
  }

  const extractedObject = extractEnclosingJsonObject(whole, '"issues"');
  if (extractedObject) {
    pushUnique(extractedObject);
  }
  pushUnique(whole);

  return candidates;
}
