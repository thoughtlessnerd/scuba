import sharp from 'sharp';

const FONT_FAMILY = 'ui-monospace, Menlo, Consolas, monospace';
const FONT_SIZE = 14;
const LINE_HEIGHT = 18;
const CHAR_WIDTH = 8.4;       // approx for the chosen family/size
const PADDING = 12;
const BG = '#0f1117';
const FG = '#d8dee9';

/**
 * Render a block of terminal text (already screen-emulated, ANSI-stripped) into
 * a PNG buffer. No colors / no bold — just legible monospace on dark bg, sized
 * to the longest line and the line count.
 */
export async function renderScreenPng(text: string): Promise<Buffer> {
  const lines = normalize(text);
  const maxLen = Math.max(40, ...lines.map((l) => l.length));
  const width = Math.ceil(maxLen * CHAR_WIDTH) + PADDING * 2;
  const height = lines.length * LINE_HEIGHT + PADDING * 2;

  const tspans = lines
    .map((line, i) => {
      const y = PADDING + (i + 1) * LINE_HEIGHT - 4;
      return `<text x="${PADDING}" y="${y}" font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" fill="${FG}" xml:space="preserve">${escapeXml(line)}</text>`;
    })
    .join('\n');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="${BG}"/>
  ${tspans}
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

function normalize(text: string): string[] {
  // Split, strip trailing empties so the image isn't mostly blank.
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1].length === 0) lines.pop();
  // Also drop any all-blank leading lines.
  while (lines.length > 0 && lines[0].length === 0) lines.shift();
  if (lines.length === 0) return [''];
  return lines;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
