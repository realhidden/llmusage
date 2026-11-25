import { Store } from '../claude/store.js';
import { Watcher } from '../claude/watcher.js';
import { dirsFromConfig } from '../claude/dirs.js';
import { loadConfig } from '../config.js';
import { formatCompact } from '../../shared/time.js';
import { providerOf } from '../jsonl/parser.js';
import type { SessionState } from '../../shared/types.js';

const args = process.argv.slice(2);
const showResume = args.includes('--resume') || args.includes('--lately');
const asJson = args.includes('--json');

/** The CLI that resumes a session from this dir. */
const RESUME_CLI = { claude: 'claude', codex: 'codex', qwen: 'qwen', zcode: 'zcode' } as const;

function resumeCommand(session: SessionState): string {
  const provider = session.dir.includes('.localqwen') ? 'localqwen' : RESUME_CLI[providerOf(session.dir)];
  const id = session.sessionId || 'unknown';
  return `${provider} --resume ${id}`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const dirs = dirsFromConfig(config).map(d => d.path);

  const store = new Store();
  const watcher = new Watcher(store, {
    dirs,
    onError: (scope, message) => {
      console.error(`[${scope}] ${message}`);
    },
  });

  await watcher.coldScan();

  const snap = store.snapshot();

  if (asJson) {
    // Machine-readable dump of the full snapshot for piping into other tools.
    process.stdout.write(JSON.stringify(snap, null, 2) + '\n');
    return;
  }

  if (showResume) {
    printResume(snap.sessions.active, snap.sessions.recent);
    return;
  }

  console.log(`\n=== TODAY (${snap.generatedAt}) ===`);
  const t = snap.today.tokens;
  console.log(`  input:     ${formatCompact(t.input)}`);
  console.log(`  output:    ${formatCompact(t.output)}`);
  console.log(`  cache↑:    ${formatCompact(t.cacheCreate)}`);
  console.log(`  cache↓:    ${formatCompact(t.cacheRead)}`);
  console.log(`  total:     ${formatCompact(t.input + t.output + t.cacheCreate + t.cacheRead)}`);
  console.log(`  turns:     ${snap.today.assistantTurns}`);

  if (Object.keys(snap.today.byModel).length > 0) {
    console.log('\n  By model:');
    for (const [model, bucket] of Object.entries(snap.today.byModel)) {
      const total = bucket.input + bucket.output + bucket.cacheCreate + bucket.cacheRead;
      console.log(`    ${model}: ${formatCompact(total)}`);
    }
  }

  console.log('\n=== LAST 7 DAYS ===');
  const max7 = Math.max(...snap.last7Days.map(d => {
    const b = d.bucket.tokens;
    return b.input + b.output + b.cacheCreate + b.cacheRead;
  }), 1);
  for (const { day, bucket } of snap.last7Days) {
    const total = bucket.tokens.input + bucket.tokens.output + bucket.tokens.cacheCreate + bucket.tokens.cacheRead;
    const bar = '█'.repeat(Math.min(Math.round((total / max7) * 30), 30));
    console.log(`  ${day}  ${bar}  ${formatCompact(total)}`);
  }

  console.log('\n=== SESSIONS ===');
  const allSessions = [...snap.sessions.active, ...snap.sessions.recent];
  for (const s of allSessions) {
    const name = s.cwd.split('/').pop() ?? s.cwd;
    const total = s.tokens.input + s.tokens.output + s.tokens.cacheCreate + s.tokens.cacheRead;
    const models = s.models.join(', ');
    console.log(`  [${s.state}] ${name} (${s.gitBranch || '-'}) — ${models} — ${formatCompact(total)} tok — ${s.assistantTurns} turns`);
    if (s.lastPrompt) {
      console.log(`    last: "${s.lastPrompt.slice(0, 80)}${s.lastPrompt.length > 80 ? '…' : ''}"`);
    }
  }

  console.log(`\nRolling 5h: ${formatCompact(snap.limits.fiveHourUsed)} tok`);
  console.log(`Rolling 7d: ${formatCompact(snap.limits.weeklyUsed)} tok`);
}

function printResume(active: SessionState[], recent: SessionState[]): void {
  const all = [...active, ...recent];
  if (all.length === 0) {
    console.log('No sessions found.');
    return;
  }

  // Group by cwd (project)
  const byProject = new Map<string, SessionState[]>();
  for (const s of all) {
    const key = s.cwd || '/';
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key)!.push(s);
  }

  // Sort projects by most recent session
  const projects = [...byProject.entries()].sort((a, b) => {
    const lastA = a[1].reduce((m, s) => s.lastTs > m ? s.lastTs : m, '');
    const lastB = b[1].reduce((m, s) => s.lastTs > m ? s.lastTs : m, '');
    return lastB.localeCompare(lastA);
  });

  console.log(`\nWhat we've been up to:\n`);

  for (const [project, sessions] of projects) {
    const projName = project.split('/').filter(Boolean).pop() ?? project;
    // Sort sessions within project by lastTs desc
    sessions.sort((a, b) => b.lastTs.localeCompare(a.lastTs));

    for (const s of sessions) {
      const state = s.state === 'running' ? '● running' : s.state === 'waiting-for-input' ? '○ waiting' : '· done';
      const cmd = resumeCommand(s);
      const prompt = s.lastPrompt
        ? `"${s.lastPrompt.slice(0, 70)}${s.lastPrompt.length > 70 ? '…' : ''}"`
        : '(no prompt)';

      console.log(`${projName}  ${state}  ${timeAgo(s.lastTs)}`);
      console.log(`  last: ${prompt}`);
      console.log(`  $ ${cmd}`);
      console.log('');
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
