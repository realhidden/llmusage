import { BrowserWindow, nativeImage } from 'electron';

export type IconState = 'idle' | 'running' | 'waiting';

const SIZE = 22;
const SCALE = 2; // render at 2x for crispness, then resize

// Lucide brain-circuit (ISC / MIT-licensed, same visual style as FA's Pro
// brain-circuit-light). Rendered through Chromium so we avoid bundling a
// hand-rolled rasterizer.
const SVG_PATHS = `
  <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
  <path d="M9 13a4.5 4.5 0 0 0 3-4" />
  <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
  <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
  <path d="M6 18a4 4 0 0 1-1.967-.516" />
  <path d="M12 13h4" />
  <path d="M12 18h6a2 2 0 0 1 2 2v1" />
  <path d="M12 8h8" />
  <path d="M16 8V5a2 2 0 0 1 2-2" />
  <circle cx="16" cy="13" r=".5" />
  <circle cx="18" cy="3" r=".5" />
  <circle cx="20" cy="21" r=".5" />
  <circle cx="20" cy="8" r=".5" />
`;

function svgFor(stroke: string, fillNodes: string = 'none'): string {
  // Stroke-based line art; nodes (small circles) get a solid fill so the
  // dots stay visible at 22px.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE * SCALE}" height="${SIZE * SCALE}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <g>${SVG_PATHS}</g>
    <style>circle { fill: ${fillNodes}; stroke: ${stroke}; }</style>
  </svg>`;
}

const STATE_STYLE: Record<IconState, { stroke: string; nodes: string }> = {
  idle:    { stroke: '#000000', nodes: '#000000' }, // template image — macOS auto-tints
  running: { stroke: '#34c759', nodes: '#34c759' },
  waiting: { stroke: '#ff9f0a', nodes: '#ff9f0a' },
};

const cache = new Map<string, Electron.NativeImage>();

async function rasterize(svg: string): Promise<Electron.NativeImage> {
  const win = new BrowserWindow({
    width: SIZE * SCALE,
    height: SIZE * SCALE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
  });

  try {
    const html = `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent;width:100%;height:100%}body{display:flex;align-items:center;justify-content:center}</style></head><body>${svg}</body></html>`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    // capturePage returns a NativeImage at the renderer's pixel size
    const img = await win.webContents.capturePage();
    return img.resize({ width: SIZE, height: SIZE, quality: 'best' });
  } finally {
    win.destroy();
  }
}

export async function initIcons(): Promise<void> {
  for (const state of Object.keys(STATE_STYLE) as IconState[]) {
    const { stroke, nodes } = STATE_STYLE[state];
    const img = await rasterize(svgFor(stroke, nodes));
    if (state === 'idle') img.setTemplateImage(true);
    cache.set(`${state}:1`, img);

    // Pre-render a dim variant for blink (used by the waiting state)
    if (state === 'waiting') {
      const dimSvg = svgFor('rgba(255,159,10,0.35)', 'rgba(255,159,10,0.35)');
      const dimImg = await rasterize(dimSvg);
      cache.set(`${state}:0.4`, dimImg);
    }
  }
}

export function getIcon(state: IconState, dim: number = 1): Electron.NativeImage {
  const key = `${state}:${dim < 1 ? '0.4' : '1'}`;
  const img = cache.get(key) ?? cache.get(`${state}:1`);
  if (!img) {
    // Should never happen post-initIcons; return an empty image as a safe fallback
    return nativeImage.createEmpty();
  }
  return img;
}
