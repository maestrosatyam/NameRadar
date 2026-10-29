import type { MatchKind } from "./types";

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const LEADING_ARTICLE = /^(the|a|an|le|la|el|los|las|les) /;

function squash(s: string): string {
  return normalize(s).replace(LEADING_ARTICLE, "").replace(/ /g, "");
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Decide whether a Qloo entity name collides with a candidate brand name.
 * Returns null when the entity is just a loose search hit, not a namesake.
 */
export function matchName(candidate: string, entityName: string): { kind: MatchKind; similarity: number } | null {
  const c = normalize(candidate).replace(LEADING_ARTICLE, "");
  const e = normalize(entityName).replace(LEADING_ARTICLE, "");
  if (!c || !e) return null;
  const cs = c.replace(/ /g, "");
  const es = e.replace(/ /g, "");

  if (c === e || cs === es) return { kind: "exact", similarity: 1 };

  const eTokens = e.split(" ");
  const cTokens = c.split(" ");
  // candidate appears as a whole-word run inside the entity name ("Tidal" in "Tidal Wave")
  for (let i = 0; i + cTokens.length <= eTokens.length; i++) {
    if (cTokens.every((t, k) => eTokens[i + k] === t)) {
      const extra = eTokens.length - cTokens.length;
      return { kind: "contains_word", similarity: extra <= 1 ? 0.8 : extra === 2 ? 0.65 : 0.5 };
    }
  }
  // entity name is a whole-word run inside the candidate ("Nova" inside "Nova Labs")
  for (let i = 0; i + eTokens.length <= cTokens.length; i++) {
    if (eTokens.every((t, k) => cTokens[i + k] === t) && es.length >= 4) {
      return { kind: "contains_word", similarity: 0.6 };
    }
  }

  const maxLen = Math.max(cs.length, es.length);
  if (cs.length >= 4 && maxLen > 0) {
    const ratio = 1 - levenshtein(cs, es) / maxLen;
    if (ratio >= 0.75) return { kind: "near_spelling", similarity: Number((ratio * 0.85).toFixed(3)) };
  }
  // candidate embedded inside a single longer token ("Bloom" in "Bloomberg")
  if (cs.length >= 5 && eTokens.some((t) => t.startsWith(cs) && t.length <= cs.length + 5)) {
    return { kind: "inside_word", similarity: 0.4 };
  }
  return null;
}

export { squash };
