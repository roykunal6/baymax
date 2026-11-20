// Baymax's avatar: an original soft, round helper — white with an ink outline, small head on a
// big marshmallow body, waving hello, with two plain round eyes. One SVG source is used inline in
// the app and to generate the app icons. (Deliberately not Disney's exact design: no eye line or
// chest port. A user can pick their own picture in Settings; it stays on their device.)
//
// variant 'full' = whole body waving (icons, welcome screen); 'face' = head only (small sizes).

const INK = '#141416';

let n = 0;
export function avatarSVG({ size = 120, cls = '', title = 'Baymax', background = null, padding = 0, variant = 'full' } = {}) {
  const vb = 120 + padding * 2;
  const u = `bmx${++n}`; // unique gradient ids: several avatars can be on the page at once
  const bg = background ? `<rect x="${-padding}" y="${-padding}" width="${vb}" height="${vb}" fill="${background}"/>` : '';
  const fill = `fill="url(#${u}-w)"`;
  const line = `stroke="${INK}" stroke-width="3" stroke-linejoin="round"`;
  const defs = `<defs><linearGradient id="${u}-w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#EEEEF0"/></linearGradient></defs>`;
  // Plain, calm face: two solid round eyes, nothing else.
  const face = (cx, cy, s) => `
    <g class="bmx-eyes">
      <ellipse cx="${cx - 9 * s}" cy="${cy}" rx="${3.6 * s}" ry="${3.9 * s}" fill="${INK}"/>
      <ellipse cx="${cx + 9 * s}" cy="${cy}" rx="${3.6 * s}" ry="${3.9 * s}" fill="${INK}"/>
    </g>`;

  let body;
  if (variant === 'face') {
    body = `<g class="bmx-head"><ellipse cx="60" cy="62" rx="50" ry="38" ${fill} ${line}/>${face(60, 60, 2.1)}</g>`;
  } else {
    body = `
  <g class="bmx-body">
    <ellipse cx="47" cy="106" rx="9.5" ry="10" ${fill} ${line}/>
    <ellipse cx="73" cy="106" rx="9.5" ry="10" ${fill} ${line}/>
    <ellipse cx="29" cy="76" rx="8" ry="18" transform="rotate(14 29 76)" ${fill} ${line}/>
    <path d="M60 36c-19 0-31 17-31 39 0 19 12 31 31 31s31-12 31-31c0-22-12-39-31-39z" ${fill} ${line}/>
  </g>
  <g class="bmx-wave"><ellipse cx="92" cy="34" rx="9" ry="19" transform="rotate(28 92 34)" ${fill} ${line}/></g>
  <g class="bmx-head"><ellipse cx="57" cy="30" rx="21" ry="16" ${fill} ${line}/>${face(57, 29, 0.95)}</g>`;
  }
  return `<svg class="avatar ${cls}" xmlns="http://www.w3.org/2000/svg" viewBox="${-padding} ${-padding} ${vb} ${vb}" width="${size}" height="${size}" role="img" aria-label="${title}">${defs}${bg}${body}</svg>`;
}
