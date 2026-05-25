import { randomUUID } from 'node:crypto';
import type { AgentManager } from './agent-manager.js';
import type { TelegramManager, TelegramCallback, InlineKeyboardMarkup } from './telegram.js';
import type { AgentStore, PendingPromptOption } from './agent-store.js';
import type { AwaitingChoiceInfo } from './pty-state.js';
import { renderScreenPng } from './screenshot.js';

const MAX_OPTION_LABEL = 48;          // Telegram caps button text at ~64 visible chars; keep margin
const MAX_CAPTION_CHARS = 900;        // Telegram photo caption hard limit is 1024; leave headroom

/**
 * Bridges PTY awaiting-choice events to Telegram prompts with inline keyboards,
 * and routes button-tap callbacks back into the originating PTY.
 */
export class PromptRouter {
  /**
   * Last answered prompt per terminal — keyed by terminal id, holds the hash
   * of the question we just answered + when. We use this to suppress duplicate
   * "needs input" messages when Claude redraws the same prompt for a frame or
   * two before advancing. A *different* prompt (e.g. claude was "calling scuba
   * 2 times…" and just got the second permission check) bypasses the cooldown.
   */
  private lastAnswered = new Map<string, { hash: string; at: number }>();
  /**
   * Terminals we're currently posting a prompt for. Claimed synchronously
   * at the top of handleAwaiting, released after the pending row is inserted
   * (or on error). Bridges the race where the PTY emits two awaitingChoice
   * events before the first send → DB write has finished.
   */
  private inFlight = new Set<string>();
  private static readonly ANSWER_COOLDOWN_MS = 4000;

  constructor(
    private readonly agents: AgentManager,
    private readonly telegram: TelegramManager,
    private readonly store: AgentStore,
  ) {}

  start(): void {
    this.agents.on('awaitingChoice', (terminalId, info) => {
      void this.handleAwaiting(terminalId, info).catch((err) => {
        console.error('[prompt-router] handleAwaiting failed:', err);
      });
    });
    this.telegram.on('callback', (evt: TelegramCallback) => {
      void this.handleCallback(evt).catch((err) => {
        console.error('[prompt-router] handleCallback failed:', err);
      });
    });
    this.agents.on('turnEnd', (terminalId) => {
      void this.handleTurnEnd(terminalId).catch((err) => {
        console.error('[prompt-router] handleTurnEnd failed:', err);
      });
    });
  }

  /**
   * End-of-turn: post a screenshot of the reply to the bound chat. Fires for
   * mother (her assigned chat) and adhoc terminals (their picked chat).
   * Workers go through notifyMotherOfIdle instead.
   */
  private async handleTurnEnd(terminalId: string): Promise<void> {
    const t = this.agents.getTerminal(terminalId);
    if (!t) return;
    if (t.record.role !== 'mother' && t.record.role !== 'adhoc') return;
    const chatId = t.record.chatId;
    if (!chatId) return;

    const screen = t.detector.getColoredScreen();
    if (screen.length === 0) return;
    const png = await renderScreenPng(screen);
    const caption = t.record.role === 'mother' ? 'mother replied' : `${t.record.name} replied`;
    await this.telegram.sendMedia(
      chatId,
      'photo',
      png,
      `${t.record.name}.png`,
      'image/png',
      caption,
    );
  }

  private async handleAwaiting(terminalId: string, info: AwaitingChoiceInfo): Promise<void> {
    // Sync gate: drop duplicate fires that arrive while we're still posting
    // the first one (PTY redraws can emit awaitingChoice twice before any
    // async work below completes).
    if (this.inFlight.has(terminalId)) return;

    const t = this.agents.getTerminal(terminalId);
    if (!t) return;
    const chatId = t.record.chatId;
    if (!chatId) {
      console.warn(`[prompt-router] worker ${t.record.name} hit awaiting-choice but has no chatId`);
      return;
    }

    // Suppress only if THIS exact question fired within the cooldown — different
    // prompts (e.g. claude's "2 times…" second permission check) go through.
    const hash = hashAwaiting(info);
    const last = this.lastAnswered.get(terminalId);
    if (last && last.hash === hash && Date.now() - last.at < PromptRouter.ANSWER_COOLDOWN_MS) {
      return;
    }

    // If a pending row already exists: same question → wait for the user to
    // answer it. Different question → the old prompt is obsolete (claude only
    // has one live prompt at a time), so clear it and post the new one.
    // Without this, an unanswered prompt would permanently block the terminal
    // from posting any future prompts.
    const existing = this.store.listPendingPromptsForTerminal(terminalId);
    if (existing.length > 0) {
      const prev = existing[0];
      const prevHash = hashPendingPrompt(prev.question, prev.options);
      if (prevHash === hash) return;
      try {
        await this.telegram.editMessageReplyMarkup(prev.chatId, prev.telegramMessageId, null);
      } catch {}
      this.store.deletePendingPrompt(prev.id);
    }

    this.inFlight.add(terminalId);
    try {
      await this.postAwaiting(terminalId, info, t, chatId);
    } finally {
      this.inFlight.delete(terminalId);
    }
  }

  private async postAwaiting(
    terminalId: string,
    info: AwaitingChoiceInfo,
    t: NonNullable<ReturnType<AgentManager['getTerminal']>>,
    chatId: string,
  ): Promise<void> {
    const promptId = randomUUID();
    const options: PendingPromptOption[] = info.options.map((o) => ({
      num: o.num,
      text: truncate(o.text, MAX_OPTION_LABEL),
    }));

    const replyMarkup = buildKeyboard(promptId, options);
    const caption = truncate(
      `${t.record.name} needs input` + (info.question ? `\n\n${info.question}` : ''),
      MAX_CAPTION_CHARS,
    );

    // Render the worker's current visible screen as a PNG and send as a photo
    // with the inline keyboard. This avoids HTML/Markdown parse fragility entirely.
    const screen = t.detector.getColoredScreen();
    const png = await renderScreenPng(screen);

    const sent = await this.telegram.sendMedia(
      chatId,
      'photo',
      png,
      `${t.record.name}.png`,
      'image/png',
      caption,
      { replyMarkup },
    );

    this.store.insertPendingPrompt({
      id: promptId,
      terminalId,
      chatId,
      telegramMessageId: sent.id,
      question: info.question,
      options,
      createdAt: Date.now(),
    });
  }

  private async handleCallback(evt: TelegramCallback): Promise<void> {
    console.log(`[prompt-router] callback data=${evt.data} chat=${evt.chatId}`);
    const parsed = parseCallbackData(evt.data);
    if (!parsed) {
      await this.telegram.answerCallbackQuery(evt.id, 'invalid callback');
      return;
    }

    const pending = this.store.getPendingPrompt(parsed.promptId);
    if (!pending) {
      await this.telegram.answerCallbackQuery(evt.id, 'already answered');
      // Strip stale buttons.
      if (evt.chatId && evt.messageId) {
        try { await this.telegram.editMessageReplyMarkup(evt.chatId, evt.messageId, null); } catch {}
      }
      return;
    }

    const wrote = this.agents.answerAwaitingChoice(pending.terminalId, parsed.num);
    if (!wrote) {
      await this.telegram.answerCallbackQuery(evt.id, 'worker no longer awaiting');
    } else {
      const chosen = pending.options.find((o) => o.num === parsed.num);
      await this.telegram.answerCallbackQuery(evt.id, chosen ? `→ ${chosen.text}` : `→ ${parsed.num}`);
    }

    // Always strip buttons + record the choice in the chat.
    try {
      await this.telegram.editMessageReplyMarkup(pending.chatId, pending.telegramMessageId, null);
    } catch {}
    this.store.deletePendingPrompt(pending.id);
    this.lastAnswered.set(pending.terminalId, {
      hash: hashPendingPrompt(pending.question, pending.options),
      at: Date.now(),
    });
  }
}

function buildKeyboard(promptId: string, options: PendingPromptOption[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: options.map((o) => [
      { text: `${o.num}. ${o.text}`, callback_data: `${promptId}:${o.num}` },
    ]),
  };
}

function parseCallbackData(data: string): { promptId: string; num: number } | null {
  const m = data.match(/^([0-9a-f-]{36}):(\d{1,3})$/i);
  if (!m) return null;
  const num = parseInt(m[2], 10);
  if (!Number.isFinite(num) || num < 1 || num > 20) return null;
  return { promptId: m[1], num };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function hashAwaiting(info: AwaitingChoiceInfo): string {
  return hashPendingPrompt(info.question, info.options);
}

function hashPendingPrompt(question: string, options: PendingPromptOption[]): string {
  return question + '\n' + options.map((o) => `${o.num}.${o.text}`).join('|');
}
