const FTS5_OPERATOR_PATTERN = /\b(OR|AND|NOT|NEAR)\b/;
const FTS5_TOKEN_PATTERN = /"([^"]*)"|(\S+)/g;
const NATURAL_LANGUAGE_CONNECTORS = new Set(['and', 'or', 'not', 'near']);

/**
 * Normalize natural-language search input into an FTS5 query.
 * Plain terms become individually quoted for implicit AND matching.
 * Explicit quoted phrases are preserved, connector stopwords are ignored in
 * natural-language mode, and raw uppercase FTS5 operators pass through.
 */
export function normalizeFts5Query(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length === 0) return '';

  if (FTS5_OPERATOR_PATTERN.test(trimmed)) {
    return trimmed;
  }

  const normalizedTerms: string[] = [];
  for (const match of trimmed.matchAll(FTS5_TOKEN_PATTERN)) {
    const phrase = match[1];
    const term = match[2];
    if (phrase === undefined && term && NATURAL_LANGUAGE_CONNECTORS.has(term.toLowerCase())) {
      continue;
    }

    const rawValue = phrase ?? term ?? '';
    normalizedTerms.push(`"${rawValue.replace(/"/g, '""')}"`);
  }

  return normalizedTerms.join(' ');
}

export function isFts5QueryError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('fts5') || msg.includes('unterminated string');
}
