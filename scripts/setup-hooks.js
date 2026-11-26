// scripts/setup-hooks.js — merge Signal's hooks into <project>/.claude/settings.json, or remove them.
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EVENTS = ['PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, 'hook.js');

const quote = (p) => (/\s/.test(p) ? `"${p}"` : p);
const commandFor = (hookPath) => `node ${quote(hookPath)}`;

// Returns { file, changes: [string] }. Throws an Error with a plain message when it must refuse.
export function setupHooks({ cwd = process.cwd(), remove = false, hookPath = HOOK } = {}) {
  const dir = path.join(path.resolve(cwd), '.claude');
  const file = path.join(dir, 'settings.json');
  if (path.resolve(cwd) === os.homedir()) {
    throw new Error('Refusing to edit your user-level ~/.claude settings. Run this inside a project folder.');
  }
  let settings = {};
  if (fs.existsSync(file)) {
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
      throw new Error(`${file} is not valid JSON (${err.message}). Fix it by hand, then run this again. Nothing was changed.`);
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error(`${file} must hold a JSON object. Nothing was changed.`);
    }
  } else if (remove) {
    return { file, changes: [] };
  }
  if (settings.hooks !== undefined && (typeof settings.hooks !== 'object' || settings.hooks === null || Array.isArray(settings.hooks))) {
    throw new Error(`"hooks" in ${file} is not an object. Nothing was changed.`);
  }
  const hooks = settings.hooks || {};
  // Only this install's exact hook counts as ours; a user's own hook is never touched.
  const isOurs = (command) => (h) => h && typeof h.command === 'string' && h.command.trim() === command;
  const changes = [];

  for (const ev of EVENTS) {
    if (hooks[ev] !== undefined && !Array.isArray(hooks[ev])) {
      throw new Error(`hooks.${ev} in ${file} is not a list. Nothing was changed.`);
    }
    const list = hooks[ev] || [];
    const command = commandFor(hookPath);
    if (remove) {
      let removed = false;
      const kept = [];
      for (const entry of list) {
        if (!entry || !Array.isArray(entry.hooks)) { kept.push(entry); continue; }
        const rest = entry.hooks.filter(h => !isOurs(command)(h));
        if (rest.length !== entry.hooks.length) removed = true;
        if (rest.length) kept.push({ ...entry, hooks: rest });
        else if (rest.length === entry.hooks.length) kept.push(entry);
      }
      if (removed) {
        changes.push(`removed ${ev}`);
        if (kept.length) hooks[ev] = kept; else delete hooks[ev];
      }
      continue;
    }
    const ours = list.flatMap(e => (e && Array.isArray(e.hooks) ? e.hooks : [])).filter(isOurs(command));
    if (!ours.length) {
      list.push({ hooks: [{ type: 'command', command }] });
      hooks[ev] = list;
      changes.push(`added ${ev}`);
    }
  }

  if (changes.length) {
    if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
      fs.renameSync(tmp, file);
    } catch (err) { fs.rmSync(tmp, { force: true }); throw err; }
  }
  return { file, changes };
}
