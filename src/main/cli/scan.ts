import { Store } from '../claude/store.js';
import { Watcher } from '../claude/watcher.js';
import { dirsFromConfig } from '../claude/dirs.js';
import { loadConfig } from '../config.js';
import { formatCompact } from '../../shared/time.js';

async function main(): Promise<void> {
  const config = await loadConfig();
  const dirs = dirsFromConfig(config).map(d => d.path);

  console.log(`Scanning ${dirs.length} director${dirs.length === 1 ? 'y' : 'ies'}:`);
  for (const d of dirs) console.log(`  ${d}`);

  const store = new Store();
  const watcher = new Watcher(store, {
    dirs,
    onError: (scope, message) => {
      console.error(`[${scope}] ${message}`);
    },
  });

  await watcher.coldScan();

  const snap = store.snapshot();

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
