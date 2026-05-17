import sharp from 'sharp';
import type { ColoredScreen, ScreenRun } from './pty-state.js';

const FONT_FAMILY = 'ui-monospace, Menlo, Consolas, monospace';
const FONT_SIZE = 14;
const LINE_HEIGHT = 18;
const CHAR_WIDTH = 8.4;       // approx for the chosen family/size
const PADDING = 12;
const BG = '#0f1117';
const FG = '#d8dee9';

/**
 * Render a colored xterm screen (per-cell fg/bg/bold runs) into a PNG. The
 * output approximates what the user sees in their browser terminal pane: dark
 * background, ANSI-colored runs, bold text. Wide chars and combining marks
 * are flattened into the run text.
 */
export async function renderScreenPng(screen: ColoredScreen | string): Promise<Buffer> {
  // Backwards-compatible: if the caller passes raw text, treat it as a
  // single fg-default run per line.
  const rows: ColoredScreen = typeof screen === 'string'
    ? textToColored(screen)
    : screen;

  const maxCols = rows.reduce((m, row) => Math.max(m, runsLength(row)), 40);
  const width = Math.ceil(maxCols * CHAR_WIDTH) + PADDING * 2;
  const height = rows.length * LINE_HEIGHT + PADDING * 2;

  const rects: string[] = [];
  const texts: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const y = PADDING + (i + 1) * LINE_HEIGHT - 4;
    let col = 0;
    for (const run of rows[i]) {
      const runWidth = run.text.length;
      if (run.bg) {
        const rx = PADDING + col * CHAR_WIDTH;
        const ry = PADDING + i * LINE_HEIGHT;
        const rw = runWidth * CHAR_WIDTH + 0.5;
        const rh = LINE_HEIGHT;
        rects.push(`<rect x="${rx.toFixed(2)}" y="${ry}" width="${rw.toFixed(2)}" height="${rh}" fill="${run.bg}"/>`);
      }
      const tx = PADDING + col * CHAR_WIDTH;
      const fill = run.fg ?? FG;
      const weight = run.bold ? ' font-weight="bold"' : '';
      texts.push(
        `<text x="${tx.toFixed(2)}" y="${y}" font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" fill="${fill}"${weight} xml:space="preserve">${escapeXml(run.text)}</text>`,
      );
      col += runWidth;
    }
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="${BG}"/>
  ${rects.join('\n  ')}
  ${texts.join('\n  ')}
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

function runsLength(row: ScreenRun[]): number {
  let n = 0;
  for (const r of row) n += r.text.length;
  return n;
}

function textToColored(text: string): ColoredScreen {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.map((l) => [{ text: l, fg: null, bg: null, bold: false }]);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
