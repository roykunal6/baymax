// Builds a claude.ai-hostable copy of index.html: the host supplies <html>/<head>/<body>,
// so keep only the title, styles and body content. Usage: node tools/build-artifact.mjs <out.html>
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const title = src.match(/<title>.*?<\/title>/s)[0];
const body = src.match(/<body>(.*)<\/body>/s)[1].trim();
const out = [
  title,
  '<meta name="claude:viewport-fit-sides" content="cover">',
  '<link rel="stylesheet" href="css/app.css">',
  '<link rel="icon" href="icon.svg" type="image/svg+xml">',
  body,
].join('\n');
writeFileSync(process.argv[2] || 'artifact.html', out + '\n');
console.log('wrote', process.argv[2] || 'artifact.html');
