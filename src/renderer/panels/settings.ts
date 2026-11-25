import type { Config, DataDirEntry, DiscoveredDir, StoreSnapshot } from '../../shared/types.js';
import { effectivePrice } from '../../shared/pricing.js';
import { modelShort } from '../components/token-bar.js';
import { escapeHtml } from '../components/html.js';

let visible = false;

const PRICE_FIELDS = [
  { key: 'input', label: 'in' },
  { key: 'output', label: 'out' },
  { key: 'cacheRead', label: 'cache↓' },
  { key: 'cacheWrite', label: 'cache↑' },
] as const;

export function isSettingsVisible(): boolean {
  return visible;
}

export async function renderSettings(container: HTMLElement, config: Config): Promise<void> {
  const existing = document.getElementById('settings-panel');
  if (existing) {
    existing.remove();
  }

  if (!visible) return;

  const panel = document.createElement('div');
  panel.id = 'settings-panel';
  panel.innerHTML = `
    <div class="panel">
      <div class="panel-label">SETTINGS <span class="settings-close" id="settings-close">&times;</span></div>

      <div class="settings-section">
        <div class="settings-section-label">Data Directories</div>
        <div id="dir-list"></div>
        <div id="discovered-list"></div>
        <div class="settings-add-dir">
          <input type="text" id="dir-label-input" placeholder="label" />
          <input type="text" id="dir-input" placeholder="/path/to/projects" />
          <button id="dir-add-btn">Add</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-label">Pricing ($/M tokens)</div>
        <div id="price-list"></div>
        <div class="settings-add-dir">
          <input type="text" id="price-model-input" placeholder="model-id" />
          <button id="price-add-btn">Add</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-label">Progress Endpoint</div>
        <div id="progress-endpoint" class="settings-endpoint">—</div>
      </div>

      <div class="settings-section">
        <div class="settings-section-label">Theme</div>
        <div class="settings-segmented" id="theme-segmented">
          <button data-theme="system">System</button>
          <button data-theme="dark">Dark</button>
          <button data-theme="light">Light</button>
        </div>
      </div>

      <div class="settings-footer">
        <a class="settings-version-link" href="https://github.com/realhidden/llmusage/releases" target="_blank">v—</a>
      </div>
    </div>
  `;

  container.prepend(panel);

  // Progress endpoint: agents push here; show the resolved URL for copy/paste.
  const endpointEl = panel.querySelector('#progress-endpoint')!;
  window.api.invoke('tasks:endpoint').then((info) => {
    if (!info.enabled) {
      endpointEl.textContent = 'disabled';
      return;
    }
    if (!info.url) {
      endpointEl.textContent = 'not listening — check the console for a port conflict';
      return;
    }
    // An unpublished endpoint means another instance owns the discovery file,
    // so agents are pushing there, not here.
    endpointEl.textContent = info.published
      ? `${info.url}/v1/tasks`
      : `${info.url}/v1/tasks — not published: another instance owns the endpoint file`;
  }).catch(() => {
    endpointEl.textContent = 'unavailable';
  });

  // Render directory list
  const dirList = panel.querySelector('#dir-list')!;
  const dirs = config.dataDirs ?? [];
  dirList.innerHTML = dirs.map((dir, i) => {
    const path = typeof dir === 'string' ? dir : dir.path;
    const label = typeof dir === 'string' ? defaultLabel(path) : (dir.label ?? defaultLabel(path));
    const costOn = typeof dir === 'string' ? true : dir.estimateCost !== false;
    return `
    <div class="settings-dir-row">
      <span class="settings-dir-label">${escapeHtml(label)}</span>
      <span class="settings-dir-path">${escapeHtml(path)}</span>
      <label class="settings-dir-cost" title="Show estimated cost ($) for this directory"><input type="checkbox" data-index="${i}" ${costOn ? 'checked' : ''} /> cost</label>
      <button class="settings-dir-remove" data-index="${i}">&times;</button>
    </div>
  `;
  }).join('');

  const theme = config.theme ?? 'system';
  panel.querySelectorAll('#theme-segmented button').forEach(btn => {
    const button = btn as HTMLButtonElement;
    button.classList.toggle('active', button.dataset.theme === theme);
    button.addEventListener('click', async () => {
      const nextTheme = button.dataset.theme as Config['theme'];
      const freshConfig = await window.api.invoke('config:set', { theme: nextTheme });
      document.body.dataset.theme = freshConfig.theme ?? 'system';
      window.__llmusageConfig = freshConfig;
      renderSettings(container, freshConfig);
    });
  });

  // Bind close
  panel.querySelector('#settings-close')!.addEventListener('click', () => {
    visible = false;
    const p = document.getElementById('settings-panel');
    if (p) p.remove();
    document.getElementById('panels')!.style.display = '';
  });

  // Bind add dir
  panel.querySelector('#dir-add-btn')!.addEventListener('click', async () => {
    const input = panel.querySelector('#dir-input') as HTMLInputElement;
    const labelInput = panel.querySelector('#dir-label-input') as HTMLInputElement;
    const val = input.value.trim();
    if (!val) return;
    const label = labelInput.value.trim();
    const current = await window.api.invoke('config:get');
    const entry: DataDirEntry = label ? { path: val, label } : val;
    const dirs = [...(current.dataDirs ?? []), entry];
    const freshConfig = await window.api.invoke('config:set', { dataDirs: dirs });
    input.value = '';
    labelInput.value = '';
    window.__llmusageConfig = freshConfig;
    renderSettings(container, freshConfig);
  });

  // Bind remove dir
  dirList.querySelectorAll('.settings-dir-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt((btn as HTMLElement).dataset.index ?? '0');
      const current = await window.api.invoke('config:get');
      const dirs = [...(current.dataDirs ?? [])];
      dirs.splice(idx, 1);
      const freshConfig = await window.api.invoke('config:set', { dataDirs: dirs });
      window.__llmusageConfig = freshConfig;
      renderSettings(container, freshConfig);
    });
  });

  // Bind per-dir cost toggle (metadata-only — main skips the full rescan)
  dirList.querySelectorAll('.settings-dir-cost input').forEach(chk => {
    chk.addEventListener('change', async () => {
      const idx = parseInt((chk as HTMLInputElement).dataset.index ?? '0');
      const current = await window.api.invoke('config:get');
      const dirs = [...(current.dataDirs ?? [])];
      const entry = dirs[idx];
      if (entry === undefined) return;
      const obj: Extract<DataDirEntry, { path: string }> =
        typeof entry === 'string' ? { path: entry } : { ...entry };
      obj.estimateCost = (chk as HTMLInputElement).checked;
      dirs[idx] = obj;
      const freshConfig = await window.api.invoke('config:set', { dataDirs: dirs });
      window.__llmusageConfig = freshConfig;
      renderSettings(container, freshConfig);
    });
  });

  // Discovered-but-unconfigured agent data dirs (one-click add)
  const discoveredList = panel.querySelector('#discovered-list') as HTMLElement;
  window.api.invoke('discover:dirs').then((candidates: DiscoveredDir[]) => {
    if (!candidates.length || !visible) {
      discoveredList.innerHTML = '';
      return;
    }
    discoveredList.innerHTML = `
      <div class="discovered-header">found on disk — not tracked</div>
      ${candidates.map(c => `
        <div class="settings-dir-row discovered">
          <span class="settings-dir-label">${escapeHtml(defaultLabel(c.path))}</span>
          <span class="settings-dir-path">${escapeHtml(c.path)}</span>
          <button class="settings-discover-add" data-path="${escapeAttr(c.path)}">track</button>
        </div>
      `).join('')}
    `;
    discoveredList.querySelectorAll('.settings-discover-add').forEach(btn => {
      btn.addEventListener('click', async () => {
        const path = (btn as HTMLElement).dataset.path ?? '';
        const current = await window.api.invoke('config:get');
        const dirs = [...(current.dataDirs ?? []), { path }];
        const freshConfig = await window.api.invoke('config:set', { dataDirs: dirs });
        window.__llmusageConfig = freshConfig;
        renderSettings(container, freshConfig);
      });
    });
  });

  // Pricing editor — models seen in data plus any existing overrides
  const priceList = panel.querySelector('#price-list') as HTMLElement;
  const models = new Set<string>(Object.keys(config.priceOverrides ?? {}));
  try {
    const snap = await window.api.invoke('store:snapshot') as StoreSnapshot;
    for (const m of Object.keys(snap.today.byModel)) models.add(m);
    for (const s of [...snap.sessions.active, ...snap.sessions.recent]) {
      for (const m of Object.keys(s.byModel)) models.add(m);
    }
  } catch { /* pricing list stays with override keys only */ }
  const sortedModels = [...models].sort();
  priceList.innerHTML = sortedModels.map(m => `
    <div class="settings-price-row">
      <span class="settings-price-model" title="${escapeAttr(m)}">${escapeHtml(modelShort(m))}</span>
      ${PRICE_FIELDS.map(f => {
        const effective = effectivePrice(m, config.priceOverrides)[f.key];
        const overridden = config.priceOverrides?.[m]?.[f.key];
        return `<label class="settings-price-field" title="$${f.label}/Mtok — built-in ${effective}">
          <input type="number" min="0" step="0.01" inputmode="decimal"
            data-model="${escapeAttr(m)}" data-field="${f.key}"
            value="${overridden ?? ''}" placeholder="${effective}" />${f.label}</label>`;
      }).join('')}
    </div>
  `).join('');
  priceList.querySelectorAll('.settings-price-row input').forEach(inp => {
    inp.addEventListener('change', async () => {
      const el = inp as HTMLInputElement;
      savePriceOverride(el.dataset.model ?? '', el.dataset.field ?? '', el.value);
    });
  });

  const priceAddInput = panel.querySelector('#price-model-input') as HTMLInputElement;
  panel.querySelector('#price-add-btn')!.addEventListener('click', async () => {
    const model = priceAddInput.value.trim();
    if (!model) return;
    const current = await window.api.invoke('config:get');
    const overrides = { ...(current.priceOverrides ?? {}), [model]: {} };
    const freshConfig = await window.api.invoke('config:set', { priceOverrides: overrides });
    window.__llmusageConfig = freshConfig;
    renderSettings(container, freshConfig);
  });

  // Populate version link
  window.api.invoke('app:version').then((v: string) => {
    const link = panel.querySelector('.settings-version-link') as HTMLAnchorElement;
    if (link) link.textContent = `v${v}`;
  });
}

async function savePriceOverride(model: string, field: string, raw: string): Promise<void> {
  if (!model || !field) return;
  const current: Config = await window.api.invoke('config:get');
  const overrides: NonNullable<Config['priceOverrides']> = { ...(current.priceOverrides ?? {}) };
  const entry = { ...overrides[model] };
  const num = parseFloat(raw);
  if (raw.trim() === '' || Number.isNaN(num) || num < 0) {
    delete (entry as Record<string, number | undefined>)[field];
  } else {
    (entry as Record<string, number | undefined>)[field] = num;
  }
  if (Object.keys(entry).length === 0) delete overrides[model];
  else overrides[model] = entry;
  const freshConfig = await window.api.invoke('config:set', { priceOverrides: overrides });
  window.__llmusageConfig = freshConfig;
}

export function toggleSettings(container: HTMLElement): void {
  visible = !visible;
  if (visible) {
    document.getElementById('panels')!.style.display = 'none';
    window.api.invoke('config:get').then((config: Config) => {
      renderSettings(container, config);
    });
  } else {
    const p = document.getElementById('settings-panel');
    if (p) p.remove();
    document.getElementById('panels')!.style.display = '';
  }
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

function defaultLabel(path: string): string {
  if (path.includes('.codex/sessions') || path.includes('.codex\\sessions')) return 'codex';
  const parts = path.split(/[\\/]/).filter(Boolean);
  const parent = parts.at(-2);
  if (parent?.startsWith('.')) return parent.slice(1);
  return parent ?? parts.at(-1) ?? path;
}
