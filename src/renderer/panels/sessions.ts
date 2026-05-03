import type { StoreSnapshot, SessionState } from '../../shared/types.js';
import { formatCompact, bucketTotal, timeAgo, modelColor, modelShort } from '../components/token-bar.js';

let expandedSessionId: string | null = null;

export function renderSessions(container: HTMLElement, snapshot: StoreSnapshot): void {
  const listEl = container.querySelector('#sessions-list') as HTMLElement;
  if (!listEl) return;

  const active = snapshot.sessions.active;
  const recent = snapshot.sessions.recent;

  let html = '';

  if (active.length > 0) {
    html += '<div class="session-section-label">ACTIVE</div>';
    for (const s of active) {
      html += renderSessionRow(s);
    }
  }

  if (recent.length > 0) {
    html += '<div class="session-section-label">RECENT</div>';
    for (const s of recent) {
      html += renderSessionRow(s);
    }
  }

  if (active.length === 0 && recent.length === 0) {
    html = '<div class="empty-state">No sessions found</div>';
  }

  listEl.innerHTML = html;

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

function renderSessionRow(s: SessionState): string {
  const name = s.cwd.split('/').pop() ?? s.cwd;
  const total = bucketTotal(s.tokens);
  const models = s.models.map(m => modelShort(m)).join(', ');
  const stateLabel = s.state === 'waiting-for-input' ? 'waiting' : s.state;

  const isExpanded = expandedSessionId === s.sessionId;

  let html = `<div class="session-row" data-session-id="${s.sessionId}">
    <div class="session-header">
      <span class="session-dot ${s.state}"></span>
      <span class="session-name">${escapeHtml(name)}</span>
      <span class="session-branch">${escapeHtml(s.gitBranch || '—')}</span>
      <span class="session-badge ${s.state}">${stateLabel}</span>
    </div>
    <div class="session-meta">${models} · ${s.assistantTurns} turns · ${formatCompact(total)} tok</div>`;

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
  const rows = [
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
