#!/usr/bin/env node
// Summarise a V8 .cpuprofile: top functions by self time and by file.
// Usage: node profile-summary.mjs <file.cpuprofile> [topN]
import { readFileSync } from 'node:fs';

const [file, topArg] = process.argv.slice(2);
const top = Number(topArg ?? 25);
const prof = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const self = new Map(); // node id -> microseconds
for (let i = 0; i < prof.samples.length; i++) {
  self.set(prof.samples[i], (self.get(prof.samples[i]) ?? 0) + (prof.timeDeltas[i] ?? 0));
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
const fnAgg = new Map();
const fileAgg = new Map();
for (const [id, us] of self) {
  const { callFrame: c } = byId.get(id);
  const url = c.url.replace(/^file:\/\//, '').replace(/^.*\/app\//, '') || '(native)';
  const key = `${c.functionName || '(anonymous)'}  ${url}:${c.lineNumber + 1}`;
  fnAgg.set(key, (fnAgg.get(key) ?? 0) + us);
  const fkey = url.includes('node_modules/')
    ? `node_modules/${url
        .split('node_modules/')[1]
        .split('/')
        .slice(0, url.split('node_modules/')[1].startsWith('@') ? 2 : 1)
        .join('/')}`
    : url;
  fileAgg.set(fkey, (fileAgg.get(fkey) ?? 0) + us);
}
const fmt = (m) =>
  [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(
      ([k, us]) =>
        `${((us / total) * 100).toFixed(1).padStart(5)}%  ${(us / 1000).toFixed(0).padStart(7)} ms  ${k}`,
    )
    .join('\n');
console.log(
  `total sampled: ${(total / 1000).toFixed(0)} ms over ${prof.samples.length} samples\n\n== top functions (self time) ==\n${fmt(fnAgg)}\n\n== top files/packages ==\n${fmt(fileAgg)}`,
);
