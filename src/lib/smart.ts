// Smart bins: which media match the rules of a bin (kerf_core::model::SmartRules).

import type { Bin, MediaAsset, Project, SmartKind, SmartRules, Uuid } from "./types";

export const EMPTY_RULES: SmartRules = { kinds: [], text: "", tags: [], labels: [], favorites: false, usage: "any", missing: false };

/** Media placed in a sequence or used as a multicam angle (as kerf_core counts uses). */
export function usedMedia(p: Pick<Project, "sequences" | "multicams">): Set<Uuid> {
  const out = new Set<Uuid>();
  for (const s of p.sequences) for (const t of s.tracks) for (const c of t.clips) out.add(c.mediaId);
  for (const m of p.multicams ?? []) for (const a of m.angles) out.add(a.media);
  return out;
}

export const smartKindOf = (m: MediaAsset): SmartKind => (m.title ? "title" : m.kind);

/** True when the name, the note or a tag contains `q` (already lower case). */
export function textMatch(m: MediaAsset, q: string): boolean {
  if (!q) return true;
  return m.name.toLowerCase().includes(q) || m.note.toLowerCase().includes(q) || m.tags.some((t) => t.toLowerCase().includes(q));
}

/** True when `m` meets every rule. `used` comes from usedMedia. */
export function smartMatch(r: SmartRules, m: MediaAsset, used: Set<Uuid>): boolean {
  if (r.kinds.length && !r.kinds.includes(smartKindOf(m))) return false;
  if (!textMatch(m, r.text.trim().toLowerCase())) return false;
  if (r.tags.length) {
    const have = new Set(m.tags.map((t) => t.toLowerCase()));
    if (!r.tags.every((t) => have.has(t.trim().toLowerCase()))) return false;
  }
  if (r.labels.length && !r.labels.includes(m.label)) return false;
  if (r.favorites && !m.favorite) return false;
  if (r.usage === "used" && !used.has(m.id)) return false;
  if (r.usage === "unused" && used.has(m.id)) return false;
  if (r.missing && m.status.state !== "missing") return false;
  return true;
}

/** The bin new media and bins go to while `current` is open (a smart bin holds none). */
export function holdingBin(bins: Bin[], current: Uuid | null): Uuid | null {
  const b = current ? bins.find((x) => x.id === current) : undefined;
  if (!b) return null;
  return b.smart ? holdingBin(bins, b.parent) : b.id;
}

/** Short German summary of the rules, for tooltips. */
export function describeRules(r: SmartRules): string {
  const kinds: Record<SmartKind, string> = { video: "Video", audio: "Audio", image: "Bilder", title: "Titel" };
  const parts: string[] = [];
  if (r.kinds.length) parts.push(r.kinds.map((k) => kinds[k]).join(" oder "));
  if (r.text.trim()) parts.push(`enthält „${r.text.trim()}“`);
  if (r.tags.length) parts.push(`Tags: ${r.tags.join(", ")}`);
  if (r.labels.length) parts.push(`${r.labels.length === 1 ? "1 Farbe" : `${r.labels.length} Farben`}`);
  if (r.favorites) parts.push("Favoriten");
  if (r.usage === "used") parts.push("verwendet");
  if (r.usage === "unused") parts.push("nicht verwendet");
  if (r.missing) parts.push("offline");
  return parts.length ? parts.join(" · ") : "Alle Medien";
}
