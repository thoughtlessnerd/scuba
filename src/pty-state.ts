import { EventEmitter } from 'node:events';
import xtermHeadless from '@xterm/headless';
import type { Terminal as XtermTerminal } from '@xterm/headless';
const { Terminal } = xtermHeadless;

/**
 * - working: process producing output / mid-task
 * - ready: bare prompt visible, can accept input right now
 * - idle: bare prompt visible AND no output for idleMs (task likely complete)
 * - awaiting-choice: numbered-option prompt is up, needs human button-tap
 */
export type PtyState = 'working' | 'ready' | 'idle' | 'awaiting-choice';

export interface AwaitingChoiceInfo {
  question: string;
  options: { num: number; text: string }[];
  rawTail: string;
}

/** A run of consecutive cells on a row sharing the same visual style. */
export interface ScreenRun {
  text: string;
  fg: string | null;   // hex like '#aabbcc', or null = default
  bg: string | null;
  bold: boolean;
}

export type ColoredScreen = ScreenRun[][];

export interface StateTransitionEvent {
  from: PtyState;
  to: PtyState;
  awaiting: AwaitingChoiceInfo | null;
}

export interface PtyStateDetectorOptions {
  idleMs?: number;        // bare-prompt must persist this long to be "idle" (default 60s)
  cols?: number;
  rows?: number;
  scrollback?: number;
}

/**
 * Maintains a real xterm screen buffer for one PTY and classifies its visible
 * state. Three states:
 *   - awaiting-choice: visible screen contains a numbered-option block (instant)
 *   - idle: bottom visible line is a bare `>` / `❯` prompt and no output for idleMs
 *   - working: anything else
 */
export class PtyStateDetector extends EventEmitter {
  private term: XtermTerminal;
  private state: PtyState = 'working';
  private lastOutputAt = Date.now();
  private idleTimer: NodeJS.Timeout | null = null;
  private currentAwaiting: AwaitingChoiceInfo | null = null;

  private readonly idleMs: number;

  constructor(opts: PtyStateDetectorOptions = {}) {
    super();
    this.idleMs = opts.idleMs ?? 60_000;
    this.term = new Terminal({
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 40,
      scrollback: opts.scrollback ?? 1000,
      allowProposedApi: true,
    });
  }

  push(chunk: string): void {
    this.lastOutputAt = Date.now();
    this.term.write(chunk, () => {
      // xterm.write is async; evaluate after the parser has processed the chunk.
      this.evaluate();
      this.scheduleIdleCheck();
    });
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.term.resize(cols, rows);
  }

  getState(): PtyState {
    return this.state;
  }

  getAwaiting(): AwaitingChoiceInfo | null {
    return this.currentAwaiting;
  }

  /** Visible screen as plain text — the "screenshot" payload for Telegram. */
  getScreen(): string {
    return this.readVisibleScreen().join('\n').replace(/\n+$/g, '');
  }

  /**
   * Visible screen with per-cell color/bold attributes, batched into runs.
   * Used by the colored PNG renderer. Trailing all-empty rows are stripped.
   */
  getColoredScreen(): ColoredScreen {
    const buf = this.term.buffer.active;
    const startY = buf.viewportY;
    const endY = startY + this.term.rows;
    const rows: ColoredScreen = [];
    for (let y = startY; y < endY; y++) {
      const line = buf.getLine(y);
      if (!line) { rows.push([]); continue; }
      rows.push(extractRuns(line, this.term.cols));
    }
    // Drop trailing blank rows so the image isn't mostly empty.
    while (rows.length > 0 && rowIsBlank(rows[rows.length - 1])) rows.pop();
    return rows;
  }

  /** Last N non-empty visible lines (post-trim). */
  getTail(maxLines = 30): string {
    const lines = this.readVisibleScreen()
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
    return lines.slice(-maxLines).join('\n');
  }

  destroy(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.term.dispose();
    this.removeAllListeners();
  }

  // ---------- internals ----------

  private scheduleIdleCheck(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.evaluate(), this.idleMs + 100);
    this.idleTimer.unref?.();
  }

  private readVisibleScreen(): string[] {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    const startY = buf.viewportY;
    const endY = startY + this.term.rows;
    for (let y = startY; y < endY; y++) {
      const line = buf.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines;
  }

  private evaluate(): void {
    const screen = this.readVisibleScreen().map((l) => l.trimEnd());
    const nonEmpty = screen.filter((l) => l.length > 0);

    // 1) awaiting-choice — instant, no debounce
    const awaiting = detectAwaiting(nonEmpty);
    if (awaiting) {
      this.currentAwaiting = awaiting;
      this.transition('awaiting-choice');
      return;
    }
    this.currentAwaiting = null;

    // 2/3) ready/idle — Claude Code's TUI doesn't expose a "bare >" line
    // because the input box always renders a placeholder ("Try 'fix lint errors'")
    // after the cursor. Detect via status-line hints + absence of work indicators.
    const lastLine = nonEmpty[nonEmpty.length - 1] ?? '';
    const tail5 = nonEmpty.slice(-5).join('\n');
    const working = WORKING_RE.test(tail5);
    const ready = !working && (BARE_PROMPT_RE.test(lastLine) || READY_HINT_RE.test(tail5));

    if (ready) {
      const sinceOutput = Date.now() - this.lastOutputAt;
      this.transition(sinceOutput >= this.idleMs ? 'idle' : 'ready');
      return;
    }

    // 4) working
    this.transition('working');
  }

  private transition(next: PtyState): void {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    const evt: StateTransitionEvent = { from: prev, to: next, awaiting: this.currentAwaiting };
    this.emit('transition', evt);
  }
}

/**
 * 256-color xterm palette. Index 0-15 are the standard ANSI colors (using the
 * common xterm defaults); 16-231 form a 6x6x6 color cube; 232-255 are a
 * grayscale ramp. Computed once.
 */
const PALETTE_256: string[] = (() => {
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  const arr: string[] = [
    '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
    '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
  ];
  const levels = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        arr.push(`#${hex(levels[r])}${hex(levels[g])}${hex(levels[b])}`);
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    arr.push(`#${hex(v)}${hex(v)}${hex(v)}`);
  }
  return arr;
})();

function colorFromCell(
  isDefault: () => boolean,
  isRGB: () => boolean,
  isPalette: () => boolean,
  getColor: () => number,
): string | null {
  if (isDefault()) return null;
  const c = getColor();
  if (isRGB()) {
    const hex = (n: number) => n.toString(16).padStart(2, '0');
    return `#${hex((c >>> 16) & 0xff)}${hex((c >>> 8) & 0xff)}${hex(c & 0xff)}`;
  }
  if (isPalette()) {
    return PALETTE_256[c] ?? null;
  }
  return null;
}

function extractRuns(line: import('@xterm/headless').IBufferLine, cols: number): ScreenRun[] {
  const runs: ScreenRun[] = [];
  let current: ScreenRun | null = null;
  let trailingSpaces = 0;
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x);
    if (!cell) continue;
    const w = cell.getWidth();
    if (w === 0) continue; // skip combining mark cells (handled by previous wide char)
    const chars = cell.getChars() || ' ';
    const fg = colorFromCell(
      () => Boolean(cell.isFgDefault()),
      () => Boolean(cell.isFgRGB()),
      () => Boolean(cell.isFgPalette()),
      () => cell.getFgColor(),
    );
    const bg = colorFromCell(
      () => Boolean(cell.isBgDefault()),
      () => Boolean(cell.isBgRGB()),
      () => Boolean(cell.isBgPalette()),
      () => cell.getBgColor(),
    );
    const bold = Boolean(cell.isBold());
    const inverse = Boolean(cell.isInverse());
    const effFg = inverse ? (bg ?? '#000000') : fg;
    const effBg = inverse ? (fg ?? '#d8dee9') : bg;

    if (
      !current ||
      current.fg !== effFg ||
      current.bg !== effBg ||
      current.bold !== bold
    ) {
      current = { text: '', fg: effFg, bg: effBg, bold };
      runs.push(current);
    }
    current.text += chars;
    if (chars.trim() === '' && effBg === null) trailingSpaces += chars.length;
    else trailingSpaces = 0;
  }
  // Trim trailing whitespace runs (with no bg) so SVG doesn't waste width.
  if (trailingSpaces > 0 && runs.length > 0) {
    const last = runs[runs.length - 1];
    last.text = last.text.replace(/\s+$/, '');
    if (last.text.length === 0) runs.pop();
  }
  return runs;
}

function rowIsBlank(runs: ScreenRun[]): boolean {
  for (const r of runs) {
    if (r.text.trim().length > 0) return false;
    if (r.bg !== null) return false;
  }
  return true;
}

const BARE_PROMPT_RE = /^[│|\s]*[>❯][\s_▏▎▍▌▋▊▉█]*$/;
const OPTION_RE = /^[\s│|]*(?:[>❯]\s*)?(\d+)\.\s+(.+?)\s*[│|]?\s*$/;

// Claude Code TUI status hints — appear in the last few rows ONLY when at idle.
const READY_HINT_RE =
  /accept edits on|auto-accept edits|plan mode|shift\+tab to cycle|\?\s*for shortcuts|bypass permissions/i;

// Indicators that claude is actively working — must NOT be confused with idle.
const WORKING_RE =
  /esc to interrupt|esc to cancel|crafting|thinking|hatching|cogitating|tokens .* esc/i;

// Anchors that mark an interactive prompt footer. Plain narrative text from the
// model never contains these phrases, so requiring one of them rules out the
// "mother typed a numbered list in her reply" false positive.
const PROMPT_ANCHOR_RE =
  /esc to cancel|esc to back|enter to confirm|enter to select|tab to amend|↑\/↓ to navigate|press\s+\d\s+to\s+/i;

function detectAwaiting(lines: string[]): AwaitingChoiceInfo | null {
  // Find the LAST anchor — there can only be one live prompt at a time, and
  // it's always at the bottom of the visible screen.
  let anchorIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PROMPT_ANCHOR_RE.test(lines[i])) {
      anchorIdx = i;
      break;
    }
  }
  if (anchorIdx === -1) return null;

  // Look for the option block within ~14 lines above the anchor.
  const windowStart = Math.max(0, anchorIdx - 14);
  const window = lines.slice(windowStart, anchorIdx);

  const found: { num: number; text: string; idx: number }[] = [];
  for (let i = 0; i < window.length; i++) {
    const m = window[i].match(OPTION_RE);
    if (m) {
      const num = parseInt(m[1], 10);
      const text = m[2].trim();
      if (text.length > 0 && num >= 1 && num <= 20) {
        found.push({ num, text, idx: i });
      }
    }
  }
  if (found.length < 2) return null;

  // Anchor the block on its "1." — but pick the LAST "1." in the window, so
  // we get the actual prompt instead of a stale block higher up.
  let firstOne = -1;
  for (let i = found.length - 1; i >= 0; i--) {
    if (found[i].num === 1) { firstOne = i; break; }
  }
  if (firstOne === -1) return null;
  const block = found.slice(firstOne);
  if (block.length < 2) return null;
  if (block[1].idx - block[0].idx > 12) return null;

  const startIdx = block[0].idx;
  const before = window.slice(Math.max(0, startIdx - 8), startIdx);
  const question = before
    .map((l) => l.replace(/^[│|]\s?/, '').replace(/\s?[│|]\s*$/, ''))
    .map((l) => l.replace(/^[╭╮╰╯─━]+|[╭╮╰╯─━]+$/g, '').trim())
    .filter((l) => l.length > 0)
    .join(' ')
    .trim();

  return {
    question,
    options: block.map(({ num, text }) => ({ num, text })),
    rawTail: lines.slice(Math.max(0, anchorIdx - 14), anchorIdx + 1).join('\n'),
  };
}
