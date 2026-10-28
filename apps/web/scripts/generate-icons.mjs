// Renders the Hivenod hexagon "H" mark into the PWA icons and iOS splash screens.
// Run with: pnpm --filter @hive/web icons   (outputs are committed; CI does not need sharp)
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const out = fileURLToPath(new URL('../public/', import.meta.url));
const INK = '#15171B';
const AMBER = '#F2B32A';

/** The mark on a 512 canvas. `scale` shrinks it toward the centre (maskable safe zone). */
function mark(scale) {
  const t = `translate(256 256) scale(${scale}) translate(-256 -256)`;
  return `<g transform="${t}" fill="none" stroke="${AMBER}" stroke-linejoin="round" stroke-linecap="round">
    <path d="M256 96l139 80v160L256 416l-139-80V176z" stroke-width="30"/>
    <path d="M206 224v128M306 224v128M206 288h100" stroke-width="30"/>
  </g>`;
}
const icon = ({ rounded, scale }) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" ${
    rounded ? 'rx="112"' : ''
  } fill="${INK}"/>${mark(scale)}</svg>`;

async function png(svg, size, file) {
  await sharp(Buffer.from(svg))
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(out + file);
}

await mkdir(out + 'icons', { recursive: true });
await mkdir(out + 'splash', { recursive: true });
await png(icon({ rounded: true, scale: 1.12 }), 192, 'icons/icon-192.png');
await png(icon({ rounded: true, scale: 1.12 }), 512, 'icons/icon-512.png');
// Maskable: full-bleed ink, mark inside the central 80% safe zone.
await png(icon({ rounded: false, scale: 0.78 }), 512, 'icons/maskable-512.png');
// iOS ignores transparency and rounds the corners itself.
await png(icon({ rounded: false, scale: 0.92 }), 180, 'icons/apple-touch-icon.png');

// iOS splash screens: [css width, css height, pixel ratio]
const devices = [
  [375, 667, 2],
  [390, 844, 3],
  [393, 852, 3],
  [430, 932, 3],
  [820, 1180, 2],
];
const themes = { light: '#F4F5F7', dark: '#0E1013' };
const manifest = [];
for (const [w, h, r] of devices) {
  for (const [theme, bg] of Object.entries(themes)) {
    const W = w * r;
    const H = h * r;
    const s = Math.round(Math.min(W, H) * 0.22);
    const mk = await sharp(Buffer.from(icon({ rounded: true, scale: 1.12 })))
      .resize(s, s)
      .png()
      .toBuffer();
    const file = `splash/${w}x${h}-${theme}.png`;
    await sharp({ create: { width: W, height: H, channels: 3, background: bg } })
      .composite([{ input: mk, gravity: 'center' }])
      .png({ compressionLevel: 9, palette: true })
      .toFile(out + file);
    manifest.push({ w, h, r, theme, file });
  }
}
// The <link> tags for index.html, printed so they can be pasted when the device list changes.
for (const m of manifest) {
  console.log(
    `<link rel="apple-touch-startup-image" href="/${m.file}" media="(device-width: ${m.w}px) and (device-height: ${m.h}px) and (-webkit-device-pixel-ratio: ${m.r}) and (orientation: portrait) and (prefers-color-scheme: ${m.theme})" />`,
  );
}
