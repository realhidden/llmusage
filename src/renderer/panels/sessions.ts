import type { StoreSnapshot, SessionState } from '../../shared/types.js';
import { formatCompact, bucketTotal, timeAgo, modelColor, modelShort } from '../components/token-bar.js';

let expandedSessionId: string | null = null;
let expandedProject: string | null = null;

export function renderSessions(container: HTMLElement, snapshot: StoreSnapshot): void {
  const listEl = container.querySelector('#sessions-list') as HTMLElement;
  if (!listEl) return;

  const all = [...snapshot.sessions.active, ...snapshot.sessions.recent];

  let html = '';

  if (all.length > 0) {
    html = groupSessions(all).map(renderProjectGroup).join('');
  } else {
    html = '<div class="empty-state">No sessions found</div>';
  }

  listEl.innerHTML = html;

  listEl.querySelectorAll('.project-row').forEach(row => {
    row.addEventListener('click', () => {
      const project = (row as HTMLElement).dataset.project;
      if (!project) return;
      expandedProject = expandedProject === project ? null : project;
      renderSessions(container, snapshot);
    });
  });

  // Bind click handlers for expand/collapse
  listEl.querySelectorAll('.session-row').forEach(row => {
    row.addEventListener('click', () => {
      const sid = (row as HTMLElement).dataset.sessionId;
      if (sid) {
        expandedSessionId = expandedSessionId === sid ? null : sid;
        renderSessions(container, snapshot);
      }
    });
  });

  // Bind detail actions
  listEl.querySelectorAll('.session-detail-actions button').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = (btn as HTMLElement).dataset.action;
      const cwd = (btn as HTMLElement).dataset.cwd;
      const sid = (btn as HTMLElement).dataset.sessionId;
      if (action === 'open' && cwd) {
        window.api.invoke('app:openProject', { cwd });
      } else if (action === 'copy' && sid) {
        navigator.clipboard.writeText(sid);
      }
    });
  });
}

type ProjectGroup = {
  key: string;
  name: string;
  state: SessionState['state'];
  sessions: SessionState[];
  tokens: number;
  turns: number;
  models: string[];
};

function groupSessions(sessions: SessionState[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const s of sessions) {
    const key = s.cwd || s.filePath;
    const group = groups.get(key) ?? {
      key,
      name: s.cwd.split('/').pop() || 'unknown',
      state: s.state,
      sessions: [],
      tokens: 0,
      turns: 0,
      models: [],
    };
    group.sessions.push(s);
    group.tokens += bucketTotal(s.tokens);
    group.turns += s.assistantTurns;
    group.state = strongestState(group.state, s.state);
    for (const model of s.models) {
      if (!group.models.includes(model)) group.models.push(model);
    }
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => {
    const rank = stateRank(b.state) - stateRank(a.state);
    if (rank !== 0) return rank;
    return b.sessions[0]!.lastTs.localeCompare(a.sessions[0]!.lastTs);
  });
}

function renderProjectGroup(group: ProjectGroup): string {
  const waiting = group.sessions.filter(s => s.state === 'waiting-for-input').length;
  const active = group.sessions.filter(s => s.state === 'running' || s.state === 'waiting-for-input').length;
  const agents = renderAgentSprites(group);
  const status = waiting > 0 ? `${waiting} waiting` : active > 0 ? `${active} active` : `${group.sessions.length} recent`;
  const isExpanded = expandedProject === group.key;
  const details = isExpanded
    ? `<div class="project-sessions">${group.sessions.map(renderSessionRow).join('')}</div>`
    : '';

  return `
    <div class="project-group">
      <div class="project-row" data-project="${escapeHtml(group.key)}">
        <div class="project-main">
          <div class="project-name-line">
            <span class="project-name">${escapeHtml(group.name)}</span>
            <span class="project-agents">${agents}</span>
            <span class="project-status ${group.state}">${status}</span>
          </div>
          <div class="project-meta"><span>${group.turns} turns</span><span>${formatCompact(group.tokens)} tok</span></div>
        </div>
        <span class="project-caret">${isExpanded ? '▾' : '▸'}</span>
      </div>
      ${details}
    </div>`;
}

function strongestState(a: SessionState['state'], b: SessionState['state']): SessionState['state'] {
  return stateRank(b) > stateRank(a) ? b : a;
}

function stateRank(state: SessionState['state']): number {
  if (state === 'waiting-for-input') return 4;
  if (state === 'running') return 3;
  if (state === 'idle') return 2;
  return 1;
}

function renderAgentSprites(group: ProjectGroup): string {
  return group.sessions
    .slice(0, 6)
    .map((session) => {
      const model = dominantModel(session);
      const title = `${model} · ${session.state} · ${timeAgo(session.lastTs)}`;
      return renderAgentSprite(variantForModel(model), session.state, title);
    })
    .join('');
}

function renderAgentSprite(variant: number, state: SessionState['state'], title: string): string {
  return `<span class="agent-sprite ${state} variant-${variant}" title="${escapeHtml(title)}"></span>`;
}

function dominantModel(session: SessionState): string {
  const [model] = Object.entries(session.byModel)
    .sort((a, b) => bucketTotal(b[1]) - bucketTotal(a[1]))[0] ?? [];
  return model ?? session.models[0] ?? 'unknown';
}

function variantForModel(model: string): number {
  if (model.includes('opus')) return 0;
  if (model.includes('sonnet')) return 1;
  if (model.includes('haiku')) return 2;
  if (model.includes('glm-5.1')) return 5;
  if (model.includes('glm-5-turbo')) return 6;
  if (model.includes('glm-4.5')) return 4;
  if (model.includes('gpt')) return 3;
  return stableVariant(model);
}

function stableVariant(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return hash % 8;
}

function renderSessionRow(s: SessionState): string {
  const name = s.cwd.split('/').pop() ?? s.cwd;
  const total = bucketTotal(s.tokens);
  const stateLabel = s.state === 'waiting-for-input' ? 'waiting' : s.state;

  const isExpanded = expandedSessionId === s.sessionId;

  // Sort models by token usage desc so the dominant one shows first
  const modelEntries = Object.entries(s.byModel)
    .sort((a, b) => bucketTotal(b[1]) - bucketTotal(a[1]));
  const modelChips = modelEntries.length > 0
    ? modelEntries.map(([m]) =>
        `<span class="session-model"><span class="model-dot" style="background:${modelColor(m)}"></span>${escapeHtml(modelShort(m))}</span>`
      ).join('')
    : (s.models.length > 0 ? `<span class="session-model">${escapeHtml(s.models.map(m => modelShort(m)).join(', '))}</span>` : '');

  let html = `<div class="session-row compact" data-session-id="${s.sessionId}">
    <div class="session-header">
      <span class="session-dot ${s.state}"></span>
      <span class="session-name">${escapeHtml(name)}</span>
      <span class="session-branch">${escapeHtml(s.gitBranch || '—')}</span>
      <span class="session-badge ${s.state}">${stateLabel}</span>
    </div>
    <div class="session-meta">${modelChips}<span class="session-meta-stat">${s.assistantTurns} turns · ${formatCompact(total)} tok</span></div>`;

  if (s.lastPrompt) {
    const truncated = s.lastPrompt.length > 60 ? s.lastPrompt.slice(0, 60) + '…' : s.lastPrompt;
    html += `<div class="session-prompt">last: "${escapeHtml(truncated)}"</div>`;
  }

  if (isExpanded) {
    html += renderSessionDetail(s);
  }

  html += '</div>';
  return html;
}

function renderSessionDetail(s: SessionState): string {
  const rows: Array<[string, string]> = [
    ['cwd', s.cwd],
    ['started', new Date(s.firstTs).toLocaleString()],
    ['last activity', `${new Date(s.lastTs).toLocaleTimeString()} (${timeAgo(s.lastTs)})`],
  ];

  let html = '<div class="session-detail">';

  for (const [label, value] of rows) {
    html += `<div class="session-detail-row">
      <span class="session-detail-label">${label}</span>
      <span>${escapeHtml(value)}</span>
    </div>`;
  }

  html += '<div style="margin-top:6px;font-weight:500">Tokens</div>';
  const tk = s.tokens;
  for (const [label, val] of [['input', tk.input], ['output', tk.output], ['cache create', tk.cacheCreate], ['cache read', tk.cacheRead]]) {
    html += `<div class="session-detail-row">
      <span class="session-detail-label">${label}</span>
      <span>${formatCompact(val as number)}</span>
    </div>`;
  }

  if (Object.keys(s.byModel).length > 0) {
    html += '<div style="margin-top:6px;font-weight:500">Models</div>';
    for (const [model, bucket] of Object.entries(s.byModel)) {
      const color = modelColor(model);
      const total = bucketTotal(bucket);
      html += `<div class="session-detail-row">
        <span style="display:flex;align-items:center;gap:4px">
          <span class="model-dot" style="background:${color};width:6px;height:6px;border-radius:50%;display:inline-block"></span>
          ${modelShort(model)}
        </span>
        <span>${formatCompact(total)}</span>
      </div>`;
    }
  }

  html += `<div class="session-detail-actions">
    <button data-action="open" data-cwd="${escapeHtml(s.cwd)}">Open in Finder</button>
    <button data-action="copy" data-session-id="${s.sessionId}">Copy session id</button>
  </div>`;

  html += '</div>';
  return html;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
