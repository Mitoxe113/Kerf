// Colour labels for clips, tracks and media. Muted tones so a labelled clip
// still reads as part of the graphite UI and the Signal accent stays reserved
// for selection and focus.

import type { LabelColor } from "./types";

export const LABEL_COLORS: Record<Exclude<LabelColor, "none">, string> = {
  red: "#b5484c",
  orange: "#b96a3b",
  yellow: "#a89537",
  green: "#3f936c",
  teal: "#2f8b84",
  blue: "#4170b8",
  violet: "#7a62bd",
  pink: "#ad5a8b",
};

export const LABEL_NAMES: Record<LabelColor, string> = {
  none: "Keine",
  red: "Rot",
  orange: "Orange",
  yellow: "Gelb",
  green: "Grün",
  teal: "Türkis",
  blue: "Blau",
  violet: "Violett",
  pink: "Pink",
};

export const LABELS = Object.keys(LABEL_NAMES) as LabelColor[];

export const labelColor = (l: LabelColor | undefined): string | null => (l && l !== "none" ? LABEL_COLORS[l] : null);
