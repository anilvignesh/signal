#!/usr/bin/env node
// scripts/lint.js
// Checks a document against a product's .pm/style.json.
// Usage: node scripts/lint.js <file> [--style <path>] [--refs <path>] [--evidence <path>] [--json]
//        node scripts/lint.js --check-evidence <path> [--refs <path>] [--json]
// Exit: 0 clean, 1 findings, 2 bad input.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const STATUS_HEADERS = ['status today', 'status'];
const TOTAL_RE = /^\s*\|?\s*Total\s*\|\s*(\d+)\s*\|?\s*$/i;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s)>\]]+/gi;

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map(c => c.trim());
}

const isSeparator = (line) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
const isTableLine = (line) => /^\s*\|/.test(line) || TOTAL_RE.test(line);

// Pull tables out of the text. Lines inside code fences are ignored.
function findTables(lines) {
  const tables = [];
  let fence = false;
  let cur = null;
  const close = () => { if (cur) { tables.push(cur); cur = null; } };
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; close(); return; }
    if (fence || !isTableLine(line)) { close(); return; }
    if (!cur) cur = { lines: [], totals: [] };
    if (TOTAL_RE.test(line)) cur.totals.push({ line: i + 1, n: Number(line.match(TOTAL_RE)[1]) });
    else cur.lines.push({ line: i + 1, text: line });
  });
  close();
  // A block is a real table only when it has a header and a separator row.
  return tables.map(t => {
    const real = t.lines.length >= 2 && isSeparator(t.lines[1].text);
    if (!real) return { real: false, totals: t.totals, lines: t.lines };
    return {
      real: true,
      totals: t.totals,
      header: { line: t.lines[0].line, cells: splitRow(t.lines[0].text) },
      rows: t.lines.slice(2).map(l => ({ line: l.line, cells: splitRow(l.text) })),
    };
  });
}

const EID = 'E-\\d{3,}[a-z]?';

// Parse evidence blocks: { id: { verdict, searched } }
export function parseEvidence(text) {
  const blocks = {};
  const parts = text.split(/^###\s+(?=E-)/m).slice(1);
  for (const p of parts) {
    const id = (p.match(/^(E-[\w-]+)/) || [])[1];
    if (!id) continue;
    blocks[id] = {
      verdict: ((p.match(/\*\*Verdict:\*\*\s*([^\n]*)/) || [])[1] || '').trim().toUpperCase(),
      searched: ((p.match(/\*\*Searched:\*\*[ \t]*([^\n]*)/) || [])[1] || '').trim(),
    };
  }
  return blocks;
}

export function lintText(text, style = {}, file = '', evidence = null) {
  const findings = [];
  const add = (line, rule, message) => findings.push({ file, line, rule, message });
  const lines = text.split('\n');

  // 1 and 2: banned words (outside URLs) and patterns
  const words = (style.banned_words || []).filter(Boolean);
  const wordRes = words.map(w => ({ w, re: new RegExp(`(?<![\\p{L}\\p{N}_])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'iu') }));
  const patRes = (style.banned_patterns || []).map(p => ({ p, re: new RegExp(p) }));
  lines.forEach((line, i) => {
    const noUrl = line.replace(URL_RE, m => ' '.repeat(m.length));
    for (const { w, re } of wordRes) if (re.test(noUrl)) add(i + 1, 'banned-word', `banned word "${w}"`);
    for (const { p, re } of patRes) {
      const m = noUrl.match(re);
      if (m) add(i + 1, 'banned-pattern', `matches banned pattern /${p}/ ("${m[0]}")`);
    }
  });

  // 3, 4, 7: tables, status column, totals
  const tables = findTables(lines);
  const statusWords = (style.status_words || []).filter(Boolean);
  let prevReal = null;
  for (const t of tables) {
    if (t.real) {
      const n = t.header.cells.length;
      const want = style.table_columns && style.table_columns[t.header.cells[0]];
      if (want != null && n !== want) add(t.header.line, 'table-columns', `table "${t.header.cells[0]}" has ${n} columns, expected ${want}`);
      for (const r of t.rows) {
        if (r.cells.length !== n) add(r.line, 'table-row', `row has ${r.cells.length} cells, header has ${n}`);
      }
      const si = t.header.cells.findIndex(c => STATUS_HEADERS.includes(c.toLowerCase()));
      t.hasStatus = si !== -1;
      if (statusWords.length && si !== -1) {
        for (const r of t.rows) {
          const cell = r.cells[si] ?? '';
          const plain = cell.replace(/[*_`]/g, '').trim().toLowerCase();
          if (!statusWords.some(w => plain.startsWith(w.toLowerCase()))) {
            add(r.line, 'status', `status "${cell}" does not start with one of: ${statusWords.join(', ')}`);
          }
        }
      }
    }
    // A Total line sits in this block (after its rows) or in its own block below the table.
    const target = t.real ? t : prevReal;
    for (const tot of t.totals) {
      if (target && target.hasStatus && target.rows.length !== tot.n) {
        add(tot.line, 'count', `Total says ${tot.n}, table above has ${target.rows.length} rows`);
      }
    }
    if (t.real) prevReal = t;
    else if (t.lines.length || t.totals.length) { /* keep prevReal for a split total block */ }
  }

  // 5: required lines
  for (const req of style.required_lines || []) {
    if (!text.includes(req)) add(0, 'required-line', `missing required line: ${req}`);
  }

  // 6: links
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (fence) return;
    for (const m of line.matchAll(/\[([^\]]*)\]\(([^)]*)\)/g)) {
      const target = m[2].trim().split(/\s+/)[0] || '';
      if (!target) add(i + 1, 'link', `link "${m[1]}" has an empty target`);
      else if (/^[/~]/.test(target) && !target.startsWith('//')) add(i + 1, 'link', `link "${m[1]}" points to an internal file path (${target})`);
    }
  });

  // 8-10: evidence ids
  if (evidence) {
    const idRe = new RegExp(`(?<![\\w-])${EID}(?![\\w-])`, 'g');
    const weak = new Set();
    let fence2 = false;
    lines.forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) { fence2 = !fence2; return; }
      if (fence2) return;
      for (const id of line.match(idRe) || []) {
        const b = evidence[id];
        if (!b) add(i + 1, 'unknown-evidence-id', `${id} is not in the evidence file`);
        else if ((b.verdict === 'NOT FOUND' || b.verdict === 'PARTLY') && !b.searched && !weak.has(id + i)) {
          weak.add(id + i);
          add(i + 1, 'weak-evidence', `${id} is ${b.verdict} but has an empty Searched line`);
        }
      }
    });
    for (const t of tables) {
      if (!t.real) continue;
      const ei = t.header.cells.findIndex(c => c.toLowerCase() === 'evidence');
      if (ei === -1) continue;
      for (const r of t.rows) {
        if (!new RegExp(`(?<![\\w-])${EID}(?![\\w-])`).test(r.cells[ei] ?? '')) {
          add(r.line, 'missing-evidence-id', 'row in an Evidence table cites no evidence id (E-nnn)');
        }
      }
    }
  }

  findings.sort((a, b) => a.line - b.line);
  return findings;
}

const VERDICTS = ['FOUND', 'NOT FOUND', 'PARTLY', 'UNCONFIRMED'];

// Validate the format of an evidence file. Returns findings.
export function checkEvidenceText(text, pinned = null, file = '') {
  const findings = [];
  const add = (line, rule, message) => findings.push({ file, line, rule, message });
  const lines = text.split('\n');
  const starts = [];
  lines.forEach((l, i) => { if (/^###\s+E-\d{3,}[a-z]?\s*$/.test(l)) starts.push(i); });
  if (!starts.length) {
    add(1, 'no-evidence-blocks', 'no "### E-nnn" evidence blocks found; write one block per claim in the format the ground agent defines');
    return findings;
  }
  starts.forEach((st, k) => {
    const body = lines.slice(st + 1, k + 1 < starts.length ? starts[k + 1] : lines.length);
    const id = lines[st].replace(/^###\s+/, '').trim();
    const field = (name) => {
      const re = new RegExp(`^\\*\\*${name}:\\*\\*[ \\t]*(.*)$`);
      for (let j = 0; j < body.length; j++) {
        const m = body[j].match(re);
        if (m) return { line: st + 2 + j, value: m[1].trim() };
      }
      return null;
    };
    const claim = field('Claim');
    if (!claim || !claim.value) add(claim ? claim.line : st + 1, 'empty-claim', `${id} has no Claim text`);
    const v = field('Verdict');
    const verdict = v ? v.value.toUpperCase() : '';
    if (!VERDICTS.includes(verdict)) add(v ? v.line : st + 1, 'bad-verdict', `${id} Verdict must be one of ${VERDICTS.join(', ')}`);
    const se = field('Searched');
    if (!se || !se.value) add(se ? se.line : st + 1, 'missing-searched', `${id} has an empty or missing Searched line`);
    else if (verdict === 'NOT FOUND') {
      const items = se.value.split(',').map(x => x.trim()).filter(Boolean);
      if (items.length < 3) add(se.line, 'thin-searched', `${id} is NOT FOUND but Searched lists ${items.length} item${items.length === 1 ? '' : 's'}; list at least 3, comma-separated`);
    }
    const r = field('Ref');
    const rm = r && r.value.match(/^(\S+)@([0-9a-f]{7,40})$/i);
    if (!rm) add(r ? r.line : st + 1, 'bad-ref', `${id} Ref must look like <ref>@<sha>`);
    else if (pinned) {
      const sha = rm[2].toLowerCase(), pin = String(pinned).toLowerCase();
      if (sha.slice(0, 7) !== pin.slice(0, 7) && !pin.startsWith(sha)) {
        add(r.line, 'ref-mismatch', `${id} Ref sha ${sha} does not match pinned_commit ${pin.slice(0, 7)}`);
      }
    }
  });
  findings.sort((a, b) => a.line - b.line);
  return findings;
}

function readJson(p, label, required) {
  if (!fs.existsSync(p)) {
    if (required) throw new Error(`${label} not found: ${p}`);
    return {};
  }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`${label} is not valid JSON: ${p} (${e.message})`); }
}

export function main(argv, out = console.log, err = console.error) {
  const args = argv.slice();
  let file = null, style = null, refs = null, ev = null, json = false, check = null;
  while (args.length) {
    const a = args.shift();
    if (a === '--style') style = args.shift();
    else if (a === '--refs') refs = args.shift();
    else if (a === '--evidence') ev = args.shift();
    else if (a === '--check-evidence') { check = args.shift(); if (!check) { err('--check-evidence needs a path'); return 2; } }
    else if (a === '--json') json = true;
    else if (!file) file = a;
    else { err(`unexpected argument: ${a}`); return 2; }
  }
  if (check) {
    try {
      if (!fs.existsSync(check)) throw new Error(`file not found: ${check}`);
      const refsPath = refs || path.join(path.dirname(check), 'refs.json');
      const rj = refs ? readJson(refs, 'refs file', true) : (fs.existsSync(refsPath) ? readJson(refsPath, 'refs file', true) : {});
      const findings = checkEvidenceText(fs.readFileSync(check, 'utf8'), rj.pinned_commit || null, check);
      if (json) out(JSON.stringify({ file: check, clean: findings.length === 0, count: findings.length, findings }, null, 2));
      else {
        for (const f of findings) out(`${f.file}:${f.line} ${f.rule} ${f.message}`);
        out(findings.length ? `${findings.length} finding${findings.length === 1 ? '' : 's'} in ${check}` : `clean: ${check}`);
      }
      return findings.length ? 1 : 0;
    } catch (e) { err(e.message); return 2; }
  }
  if (!file) { err('usage: node scripts/lint.js <file> [--style <path>] [--refs <path>] [--evidence <path>] [--json]'); return 2; }
  try {
    if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
    const s = readJson(style || path.join('.pm', 'style.json'), 'style file', !!style);
    if (refs) readJson(refs, 'refs file', true);
    const stylePath = style || path.join('.pm', 'style.json');
    const evPath = ev || path.join(path.dirname(stylePath), 'evidence.md');
    let evidence = null;
    if (ev || fs.existsSync(evPath)) {
      if (!fs.existsSync(evPath)) throw new Error(`evidence file not found: ${evPath}`);
      evidence = parseEvidence(fs.readFileSync(evPath, 'utf8'));
    }
    const findings = lintText(fs.readFileSync(file, 'utf8'), s, file, evidence);
    if (json) out(JSON.stringify({ file, clean: findings.length === 0, count: findings.length, findings }, null, 2));
    else {
      for (const f of findings) out(`${f.file}:${f.line} ${f.rule} ${f.message}`);
      out(findings.length ? `${findings.length} finding${findings.length === 1 ? '' : 's'} in ${file}` : `clean: ${file}`);
    }
    return findings.length ? 1 : 0;
  } catch (e) {
    err(e.message);
    return 2;
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isMainModule()) process.exit(main(process.argv.slice(2)));
