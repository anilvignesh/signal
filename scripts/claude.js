// scripts/claude.js
// Headless `claude -p <prompt>` gives a real round trip for any agent.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateDebrief } from './state.js';

// A dispatched claude agent isn't one completion — it's a full agentic run over a SKILL.md
// plus a briefing, which can take several turns of tool use before it emits a Debrief. 10
// minutes is generous headroom without leaving a wedged CLI spinning forever. Override with opts.timeout.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 32 * 1024 * 1024;

export function hasClaude(bin = 'claude') {
  try {
    execFileSync('which', [bin], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Run one agent on Claude. Never throws — always returns a result object the caller can
// branch on, so a missing binary or a bad response degrades instead of crashing.
export async function runAgent(agentName, prompt, opts = {}) {
  const bin = opts.bin || 'claude';
  const runDir = opts.runDir || '.pm/runs';
  const isPath = bin.includes('/');

  if (isPath ? !fs.existsSync(bin) : !hasClaude(bin)) {
    return {
      ok: false, engine: 'none', reason: 'claude-missing', errors: [`${bin} not found on PATH`],
      debrief: null, raw: '', logPath: null,
    };
  }

  const logPath = path.join(runDir, `${stamp()}-${agentName}.md`);

  // Best-effort forensic write. The log is valuable but never load-bearing enough to
  // justify letting a filesystem error (unwritable runDir, disk full, etc.) escape
  // runAgent as an uncaught throw — degrade the logPath to null instead.
  const tryWriteLog = (text) => {
    try {
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(logPath, text);
      return logPath;
    } catch {
      return null;
    }
  };

  let raw = '';
  try {
    // Argument array, never a shell string: prompt is untrusted multi-line text (an entire
    // SKILL.md plus a briefing) that must travel as a single argv element, not be parsed by
    // a shell.
    raw = execFileSync(bin, ['-p', prompt], {
      encoding: 'utf8',
      timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      // Lets a live-mode caller confine a real dispatch to a scratch directory instead of
      // the caller's own cwd — irrelevant to any test here (all stubs just echo/cat), but
      // load-bearing for verify-agents.js --live, which passes the fixture run's tmp dir.
      cwd: opts.cwd || process.cwd(),
    });
  } catch (err) {
    raw = String(err.stdout || '') + String(err.stderr || '');
    const writtenPath = tryWriteLog(raw);
    // Node's sync child_process APIs don't set `.killed` on a timeout the way the async
    // API does — the reliable signal is `.code === 'ETIMEDOUT'`, which execFileSync sets
    // specifically when the timeout option expired (verified against Node 24: a SIGTERM
    // from an unrelated cause would carry `.signal` but not this `.code`).
    const timedOut = err.code === 'ETIMEDOUT';
    return {
      ok: false, engine: 'claude', reason: timedOut ? 'timeout' : 'invocation-failed',
      errors: [timedOut ? `timed out after ${opts.timeout ?? DEFAULT_TIMEOUT_MS}ms` : String(err.message)],
      debrief: null, raw, logPath: writtenPath,
    };
  }

  const writtenPath = tryWriteLog(raw);
  const v = validateDebrief(raw);
  return {
    ok: v.ok, engine: 'claude', debrief: v.debrief, errors: v.errors,
    raw, logPath: writtenPath, reason: v.ok ? null : 'invalid-debrief',
  };
}
