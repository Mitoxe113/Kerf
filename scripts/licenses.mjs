// Writes docs/LICENSES.md: every Rust crate in the app's dependency graph
// (normal dependencies, all platforms) and every npm package bundled into the
// page, with the licence its manifest declares. Run: node scripts/licenses.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const meta = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--locked"], { maxBuffer: 1 << 28 }).toString());
const byId = new Map(meta.packages.map((p) => [p.id, p]));
const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
const root = meta.packages.find((p) => p.name === "kerf").id;
// Walk normal (non-dev, non-build) dependencies from the app crate.
const seen = new Set();
const stack = [root];
while (stack.length) {
  const id = stack.pop();
  if (seen.has(id)) continue;
  seen.add(id);
  for (const d of nodes.get(id)?.deps ?? []) if (d.dep_kinds.some((k) => k.kind === null)) stack.push(d.pkg);
}
const crates = [...seen].map((id) => byId.get(id)).filter((p) => p.source).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const npm = [];
const visit = (name) => {
  if (npm.some((p) => p.name === name)) return;
  const file = join("node_modules", name, "package.json");
  if (!existsSync(file)) return;
  const p = JSON.parse(readFileSync(file, "utf8"));
  npm.push({ name, version: p.version, license: typeof p.license === "string" ? p.license : p.license?.type ?? "(nicht angegeben)" });
  for (const d of Object.keys(p.dependencies ?? {})) visit(d);
};
Object.keys(pkg.dependencies).forEach(visit);
npm.sort((a, b) => a.name.localeCompare(b.name));

const tally = (list) => {
  const m = new Map();
  for (const p of list) m.set(p.license ?? "(nicht angegeben)", (m.get(p.license ?? "(nicht angegeben)") ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};
const lines = [
  "# Lizenzübersicht der Abhängigkeiten",
  "",
  "Erzeugt mit `node scripts/licenses.mjs` aus `Cargo.lock` (`cargo metadata`, normale Abhängigkeiten der App für alle Zielplattformen, ohne Test- und Build-Werkzeuge) und `node_modules` (Pakete, die in die Oberfläche gebündelt werden). Angegeben ist die Lizenz, die das jeweilige Paket in seinem Manifest erklärt; sie wurde nicht gegen die Lizenzdateien jedes Pakets geprüft. Hinweise zu FFmpeg, Schriften und portiertem Code stehen in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).",
  "",
  `## Rust-Crates (${crates.length})`,
  "",
  "| Lizenz | Anzahl |",
  "| --- | --- |",
  ...tally(crates).map(([l, n]) => `| ${l} | ${n} |`),
  "",
  "| Crate | Version | Lizenz |",
  "| --- | --- | --- |",
  ...crates.map((p) => `| ${p.name} | ${p.version} | ${p.license ?? "(nicht angegeben)"} |`),
  "",
  `## npm-Pakete in der Oberfläche (${npm.length})`,
  "",
  "| Paket | Version | Lizenz |",
  "| --- | --- | --- |",
  ...npm.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`),
  "",
];
writeFileSync("docs/LICENSES.md", lines.join("\n"));
console.log(`${crates.length} crates, ${npm.length} npm packages`);
for (const [l, n] of tally(crates)) console.log(`${n}\t${l}`);
console.log("npm:", tally(npm).map(([l, n]) => `${l}=${n}`).join(", "));
