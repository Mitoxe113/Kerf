// Fuzzy matching for the command palette: every query word must appear in
// the text, either as a substring or as an in-order subsequence. Higher
// scores mean better matches (substrings beat scattered letters, word starts
// beat the middle of a word).

const BOUNDARY = /[\s·\-_.,:;/()[\]„“"']/;

const atWordStart = (t: string, i: number) => i === 0 || BOUNDARY.test(t[i - 1]);

function term(q: string, t: string): number | null {
  const idx = t.indexOf(q);
  if (idx >= 0) return 100 + q.length * 4 + (atWordStart(t, idx) ? 60 : 0) - Math.min(idx, 40);
  let from = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, from);
    if (at < 0) return null;
    streak = at === from && from > 0 ? streak + 1 : 0;
    score += 1 + streak * 2 + (atWordStart(t, at) ? 6 : 0);
    from = at + 1;
  }
  return score;
}

/** Score of `text` for `query`, or null when it does not match. Empty queries match everything with 0. */
export function fuzzyScore(query: string, text: string): number | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const t = text.toLowerCase();
  let total = 0;
  for (const w of words) {
    const s = term(w, t);
    if (s === null) return null;
    total += s;
  }
  return total;
}
