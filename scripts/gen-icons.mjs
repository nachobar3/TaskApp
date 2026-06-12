// Genera los íconos PWA a partir del logo (checklist sobre gradiente).
// Correr una vez (o al cambiar el logo): node scripts/gen-icons.mjs
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "public", "icons");
fs.mkdirSync(outDir, { recursive: true });

// rounded: esquinas redondeadas propias (icono normal). full: cuadrado a
// sangre para maskable/apple (el SO recorta la forma).
// pad: fracción del lado que ocupa el margen alrededor del checklist.
function logoSvg({ size, rounded, pad }) {
  const rx = rounded ? Math.round(size * 0.1875) : 0;
  const inner = size * (1 - pad * 2);
  const scale = inner / 24;
  const offset = size * pad;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6366f1"/>
      <stop offset="1" stop-color="#d946ef"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${rx}" fill="url(#g)"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})"
     fill="none" stroke="#fff" stroke-width="2.5"
     stroke-linecap="round" stroke-linejoin="round">
    <path d="m3 7 2 2 4-4"/>
    <path d="M13 6h8"/>
    <path d="M13 12h8"/>
    <path d="m3 17 2 2 4-4"/>
    <path d="M13 18h8"/>
  </g>
</svg>`;
}

const jobs = [
  { file: "icon-192.png", size: 192, rounded: true, pad: 0.22 },
  { file: "icon-512.png", size: 512, rounded: true, pad: 0.22 },
  // Maskable: zona segura = círculo central del 80%, así que más margen.
  { file: "icon-maskable-512.png", size: 512, rounded: false, pad: 0.3 },
  { file: "apple-touch-icon.png", size: 180, rounded: false, pad: 0.22 },
];

for (const j of jobs) {
  await sharp(Buffer.from(logoSvg(j))).png().toFile(path.join(outDir, j.file));
  console.log(`✓ public/icons/${j.file}`);
}
