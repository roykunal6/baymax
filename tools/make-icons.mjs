// Renders the app icons from js/avatar.js. Usage: node tools/make-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { avatarSVG } from '../js/avatar.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BG = '#141416'; // ink background, white character

mkdirSync('icons', { recursive: true });
// Plain icon (browser tab, Android "any"): robot with a little breathing room.
const plain = avatarSVG({ size: 512, background: BG, padding: 10 });
// Maskable icon: extra padding so Android's circle/squircle masks never clip the robot.
const maskable = avatarSVG({ size: 512, background: BG, padding: 30 });
writeFileSync('icon.svg', plain.replace(' class="avatar "', ''));

const browser = await chromium.launch();
const page = await browser.newPage();
async function png(svg, size, file) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0">${svg.replace(/width="512" height="512"/, `width="${size}" height="${size}"`)}</body></html>`);
  await page.screenshot({ path: file, omitBackground: false, clip: { x: 0, y: 0, width: size, height: size } });
}
await png(plain, 180, 'icons/apple-touch-icon.png');
await png(plain, 192, 'icons/icon-192.png');
await png(plain, 512, 'icons/icon-512.png');
await png(maskable, 512, 'icons/icon-maskable-512.png');
await png(plain, 32, 'icons/favicon-32.png');
await browser.close();
console.log('icons written');
