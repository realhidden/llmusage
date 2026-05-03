import { BrowserWindow, nativeImage } from 'electron';

export type IconState = 'idle' | 'running' | 'waiting';

const SIZE = 20;
const SCALE = 2; // render at 2x for crispness, then resize

const VIEWBOX = '-2 -2 28 28';

// Flaticon icons (Free Icon Font – CC BY 4.0, attribution below)
// https://www.flaticon.com/free-icon-font/brain-lightning_16891826
const BRAIN_LIGHTNING_PATH =
  'M15.864,11.249l-4.298,5.751h-1.066l1.056-4h-2.735c-.55,0-.944-.531-.785-1.058l2.139-5.942h3.825l-1.523,4h2.717c.642,0,1.025,.715,.67,1.249Zm7.394,2.424c.482,.748,.742,1.616,.742,2.517,0,1.773-1.033,3.4-2.612,4.179-1.079,2.345-2.979,3.63-5.389,3.63-1.555,0-3.055-.892-4-2.164-.945,1.272-2.445,2.164-4,2.164-2.409,0-4.31-1.285-5.389-3.63C1.032,19.591,0,17.964,0,16.191,0,15.29,.259,14.422,.741,13.674.221,12.868-.052,11.954-.052,11c0-1.085,.379-2.574,2.096-3.747v-.492c0-1.821,1.314-3.209,3.232-3.542C5.647,1.355,7.128,0,8.948,0,10.085,0,11.216,.453,11.997,1.306c.046-.051,.081-.109,.13-.158C12.873,.408,13.912-.002,15.061,0c1.813,.016,3.289,1.37,3.662,3.22,1.919,.333,3.233,1.721,3.233,3.542v.492c1.717,1.172,2.096,2.662,2.096,3.747,0,.954-.272,1.868-.793,2.674Zm-2.714-.064l.873-.794c.415-.537,.634-1.163,.634-1.815,0-.613-.164-1.521-1.586-2.319l-.51-.287v-1.632c0-1.112-1.11-1.619-2.143-1.619h-1v-1c0-1.032-.62-2.134-1.771-2.144-.557,.018-1.138,.203-1.508,.57-.355,.352-.535,.833-.535,1.431h-2c0-1.477-1.105-2-2.052-2-1.145,0-1.762,1.104-1.762,2.143v1h-1c-1.032,0-2.143,.507-2.143,1.619v1.632l-.51,.287c-1.422,.799-1.586,1.707-1.586,2.319,0,.652,.219,1.279,.634,1.815l.873,.794-.709,.741c-.481,.502-.747,1.156-.747,1.841,0,1.112,.679,2.088,1.728,2.485l.41,.155.164,.406c.749,1.859,1.959,2.763,3.699,2.763,1.486,0,3-1.514,3-3h2c0,1.486,1.514,3,3,3,1.74,0,2.95-.904,3.699-2.763l.164-.406.41-.155c1.049-.397,1.728-1.373,1.728-2.485,0-.685-.266-1.338-.747-1.841l-.709-.741Z';

const BRAIN_PATH =
  'M24,11c0-1.57-.75-3.04-2-3.98v-.02c0-1.9-1.33-3.49-3.1-3.9-.41-1.77-2-3.1-3.9-3.1-1.19,0-2.27,.53-3,1.36-.73-.83-1.81-1.36-3-1.36-1.9,0-3.49,1.33-3.9,3.1-1.77,.41-3.1,2-3.1,3.9v.02c-1.25,.94-2,2.41-2,3.98,0,.89,.24,1.74,.69,2.5-.45,.76-.69,1.61-.69,2.5,0,1.69,.86,3.24,2.27,4.17,.72,2.28,2.81,3.83,5.23,3.83,1.86,0,3.5-.93,4.5-2.34,1,1.41,2.64,2.34,4.5,2.34,2.42,0,4.51-1.56,5.23-3.83,1.41-.92,2.27-2.48,2.27-4.17,0-.89-.24-1.74-.69-2.5.45-.76.69-1.61.69-2.5ZM7.5,22c-1.63,0-3.03-1.12-3.4-2.71l-.1-.44-.4-.21c-.98-.53-1.6-1.54-1.6-2.63,0-.67,.23-1.32,.68-1.87l.51-.63-.51-.63c-.44-.55-.68-1.2-.68-1.87,0-1.07,.59-2.07,1.54-2.6l.62-.35s-.16-.93-.16-1.05c0-1.1,.9-2,2-2h1v-1c0-1.1,.9-2,2-2s2,.9,2,2v14.5c0,1.93-1.57,3.5-3.5,3.5Zm13.82-7.87c.44,.55,.68,1.2,.68,1.87,0,1.1-.61,2.1-1.6,2.63l-.4,.21-.1,.44c-.37,1.6-1.77,2.71-3.4,2.71-1.93,0-3.5-1.57-3.5-3.5V4c0-1.1,.9-2,2-2s2,.9,2,2v1h1c1.1,0,2,.9,2,2,0,.12-.16,1.05-.16,1.05l.62,.35c.95,.54,1.54,1.53,1.54,2.6,0,.68-.23,1.32-.68,1.87l-.51,.63.51,.63Z';

function svgFor(path: string, fill: string): string {
  const size = SIZE * SCALE;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${VIEWBOX}"><path d="${path}" fill="${fill}" /></svg>`;
}

const STATE_CONFIG: Record<IconState, { path: string; fill: string }> = {
  idle:    { path: BRAIN_LIGHTNING_PATH, fill: '#000000' },
  running: { path: BRAIN_LIGHTNING_PATH, fill: '#000000' },
  waiting: { path: BRAIN_LIGHTNING_PATH, fill: '#000000' },
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
  for (const state of Object.keys(STATE_CONFIG) as IconState[]) {
    const { path, fill } = STATE_CONFIG[state];
    const img = await rasterize(svgFor(path, fill));
    if (state === 'idle') img.setTemplateImage(true);
    cache.set(`${state}:1`, img);

    if (state === 'waiting') {
      const dimImg = await rasterize(svgFor(path, 'rgba(0,0,0,0.35)'));
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
