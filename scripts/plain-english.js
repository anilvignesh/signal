#!/usr/bin/env node
// scripts/plain-english.js
// Checks text a person will read for plain English: short sentences, common words.
// Usage: node scripts/plain-english.js <file> [--max-words <n>]      (or text on stdin)
// Flags sentences over 20 words and a list of fancy words with a plainer one. Code blocks, tables and links are skipped.
// Heuristic only: it catches the common cases and does not judge meaning.
// Exit: 0 clean, 1 findings, 2 bad input.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MAX_WORDS = 20;
// fancy word -> plainer word
export const FANCY = {
  utilize: 'use', utilise: 'use', leverage: 'use', facilitate: 'help', commence: 'start', terminate: 'end',
  endeavor: 'try', ascertain: 'find out', subsequently: 'then', additionally: 'also', furthermore: 'also',
  moreover: 'also', "in order to": 'to', "prior to": 'before', "in the event that": 'if', "due to the fact that": 'because',
  "a number of": 'some', "with respect to": 'about', seamless: 'smooth', robust: 'strong', holistic: 'whole',
  synergy: 'teamwork', paradigm: 'model', orchestrate: 'run', operationalize: 'put in use', "going forward": 'from now on',
};

const stripCode = (text) => text
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/`[^`]*`/g, ' ')
  .replace(/^\s*\|.*$/gm, ' ')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/https?:\/\/\S+/g, ' ');

export function check(text, maxWords = MAX_WORDS) {
  const findings = [];
  const clean = stripCode(text).replace(/^[#>*\-\d.\s]+(?=\S)/gm, '');
  for (const raw of clean.split(/(?<=[.!?])\s+|\n+/)) {
    const s = raw.trim();
    if (!s) continue;
    const words = s.split(/\s+/).length;
    if (words > maxWords) findings.push({ kind: 'long sentence', text: s.slice(0, 80) + (s.length > 80 ? '...' : ''), note: `${words} words, limit ${maxWords}` });
  }
  for (const [bad, good] of Object.entries(FANCY)) {
    const m = clean.match(new RegExp(`\\b${bad}\\b`, 'i'));
    if (m) findings.push({ kind: 'fancy word', text: m[0], note: `say "${good}"` });
  }
  return findings;
}

export function main(argv, out = console.log, readStdin = () => fs.readFileSync(0, 'utf8')) {
  const i = argv.indexOf('--max-words');
  const max = i >= 0 ? Number(argv[i + 1]) : MAX_WORDS;
  const file = argv.find((a, k) => !a.startsWith('--') && argv[k - 1] !== '--max-words');
  let text;
  try { text = file ? fs.readFileSync(file, 'utf8') : readStdin(); } catch (e) { out(`cannot read input: ${e.message}`); return 2; }
  const f = check(text, max);
  if (!f.length) { out('ok: plain English'); return 0; }
  for (const x of f) out(`${x.kind}: "${x.text}" (${x.note})`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = main(process.argv.slice(2));
