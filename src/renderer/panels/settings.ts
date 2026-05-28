import type { Config, DataDirEntry } from '../../shared/types.js';

let visible = false;

export function isSettingsVisible(): boolean {
  return visible;
}

export function renderSettings(container: HTMLElement, config: Config): void {
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
        <div class="settings-add-dir">
          <input type="text" id="dir-label-input" placeholder="label" />
          <input type="text" id="dir-input" placeholder="/path/to/projects" />
          <button id="dir-add-btn">Add</button>
        </div>
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

  // Render directory list
  const dirList = panel.querySelector('#dir-list')!;
  const dirs = config.dataDirs ?? [];
  dirList.innerHTML = dirs.map((dir, i) => {
    const path = typeof dir === 'string' ? dir : dir.path;
    const label = typeof dir === 'string' ? defaultLabel(path) : (dir.label ?? defaultLabel(path));
    return `
    <div class="settings-dir-row">
      <span class="settings-dir-label">${escapeHtml(label)}</span>
      <span class="settings-dir-path">${escapeHtml(path)}</span>
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

  // Populate version link
  window.api.invoke('app:version').then((v: string) => {
    const link = panel.querySelector('.settings-version-link') as HTMLAnchorElement;
    if (link) link.textContent = `v${v}`;
  });
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function defaultLabel(path: string): string {
  if (path.includes('.codex/sessions') || path.includes('.codex\\sessions')) return 'codex';
  const parts = path.split(/[\\/]/).filter(Boolean);
  const parent = parts.at(-2);
  if (parent?.startsWith('.')) return parent.slice(1);
  return parent ?? parts.at(-1) ?? path;
}
