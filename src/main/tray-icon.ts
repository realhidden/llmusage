import { nativeImage } from 'electron';

export type IconState = 'idle' | 'running' | 'waiting';

const SIZE = 22;

// Two-lobe brain silhouette: union of two ellipses, shaved at the top
// to suggest the central sulcus. Coordinates are normalized to [-1, 1].
function brainSDF(nx: number, ny: number): { inside: boolean; edge: number; fissure: number; wrinkle: number } {
  // Ellipse parameters (slightly wider than tall, biased downward)
  const ay = ny + 0.05;
  const rxL = 0.78, ryL = 0.92, cxL = -0.18;
  const rxR = 0.78, ryR = 0.92, cxR = 0.18;

  const dxL = (nx - cxL) / rxL;
  const dxR = (nx - cxR) / rxR;
  const dyN = ay / ryL;

  const rL = Math.sqrt(dxL * dxL + dyN * dyN);
  const rR = Math.sqrt(dxR * dxR + dyN * dyN);

  // Top dip: a small concave region at the very top center to hint at the sulcus.
  const topDip = ay < -0.55 && Math.abs(nx) < 0.12 ? 1 : 0;

  const inside = !topDip && (rL < 1 || rR < 1);
  const minR = Math.min(rL, rR);
  // Edge thickness: distance from outer boundary, sharper near 1.0
  const edgeWidth = 0.16;
  const edge = inside ? Math.max(0, 1 - (1 - minR) / edgeWidth) : 0;

  // Center fissure: a thin vertical line through the middle, dimming inside both lobes
  const fissure = inside && Math.abs(nx) < 0.07 && Math.abs(ay) < 0.7 ? 1 : 0;

  // Wrinkle hints: two small horizontal arcs per hemisphere
  const wrinkle = (() => {
    if (!inside) return 0;
    // Left lobe wrinkles
    const wL1 = Math.abs(ay + 0.2) < 0.05 && nx > -0.6 && nx < -0.2 ? 1 : 0;
    const wL2 = Math.abs(ay - 0.25) < 0.05 && nx > -0.55 && nx < -0.15 ? 1 : 0;
    const wR1 = Math.abs(ay + 0.2) < 0.05 && nx > 0.2 && nx < 0.6 ? 1 : 0;
    const wR2 = Math.abs(ay - 0.25) < 0.05 && nx > 0.15 && nx < 0.55 ? 1 : 0;
    return Math.max(wL1, wL2, wR1, wR2);
  })();

  return { inside, edge, fissure, wrinkle };
}

type RGB = { r: number; g: number; b: number };

const COLORS: Record<IconState, { stroke: RGB; fill: RGB | null; fillAlpha: number; strokeAlpha: number }> = {
  // Template-friendly black; macOS will auto-tint in dark/light mode
  idle:    { stroke: { r: 0, g: 0, b: 0 }, fill: null,                            fillAlpha: 0,    strokeAlpha: 230 },
  running: { stroke: { r: 0x1f, g: 0x6f, b: 0x33 }, fill: { r: 0x34, g: 0xc7, b: 0x59 }, fillAlpha: 110,  strokeAlpha: 240 },
  waiting: { stroke: { r: 0x8a, g: 0x53, b: 0x00 }, fill: { r: 0xff, g: 0x9f, b: 0x0a }, fillAlpha: 130,  strokeAlpha: 240 },
};

function renderBrain(state: IconState, dim: number = 1): Buffer {
  const rgba = Buffer.alloc(SIZE * SIZE * 4, 0);
  const palette = COLORS[state];
  const cx = SIZE / 2 - 0.5;
  const cy = SIZE / 2 - 0.5;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const nx = (x - cx) / (SIZE / 2 - 1);
      const ny = (y - cy) / (SIZE / 2 - 1);
      const sdf = brainSDF(nx, ny);

      if (!sdf.inside) continue;

      let r = 0, g = 0, b = 0, a = 0;

      // Fill (only for non-idle, semi-transparent)
      if (palette.fill && sdf.edge < 1) {
        const fillStrength = 1 - sdf.edge * 0.4;
        r = palette.fill.r;
        g = palette.fill.g;
        b = palette.fill.b;
        a = Math.round(palette.fillAlpha * fillStrength * dim);
      }

      // Outline / fissure / wrinkles (stroke color, more opaque)
      const strokeMask = Math.max(sdf.edge, sdf.fissure * 0.85, sdf.wrinkle * 0.85);
      if (strokeMask > 0.05) {
        const sa = Math.round(palette.strokeAlpha * strokeMask * dim);
        if (sa > a) {
          r = palette.stroke.r;
          g = palette.stroke.g;
          b = palette.stroke.b;
          a = sa;
        } else {
          // Blend
          const blend = sa / 255;
          r = Math.round(r * (1 - blend) + palette.stroke.r * blend);
          g = Math.round(g * (1 - blend) + palette.stroke.g * blend);
          b = Math.round(b * (1 - blend) + palette.stroke.b * blend);
          a = Math.max(a, sa);
        }
      }

      const i = (y * SIZE + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = a;
    }
  }

  return rgba;
}

export function makeIcon(state: IconState, dim: number = 1): Electron.NativeImage {
  const buf = renderBrain(state, dim);
  return nativeImage.createFromBuffer(buf, { width: SIZE, height: SIZE });
}

// Pre-render a small cache; idle uses template flag for macOS auto-tint
const cache = new Map<string, Electron.NativeImage>();

export function getIcon(state: IconState, dim: number = 1): Electron.NativeImage {
  const key = `${state}:${dim}`;
  let img = cache.get(key);
  if (!img) {
    img = makeIcon(state, dim);
    if (state === 'idle') img.setTemplateImage(true);
    cache.set(key, img);
  }
  return img;
}
