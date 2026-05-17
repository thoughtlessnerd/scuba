import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import type { TelegramChat, TelegramMessage } from './telegram.js';

export const RETENTION_DAYS = 7;
const RETENTION_SECONDS = RETENTION_DAYS * 24 * 60 * 60;

export class TelegramStore {
  readonly dir: string;
  private chatsFile: string;
  private msgDir: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dir?: string) {
    this.dir = dir ?? path.join(os.homedir(), '.scuba', 'telegram');
    this.chatsFile = path.join(this.dir, 'chats.json');
    this.msgDir = path.join(this.dir, 'messages');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.msgDir, { recursive: true });
  }

  async loadChats(): Promise<TelegramChat[]> {
    try {
      const raw = await fs.readFile(this.chatsFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      return [];
    } catch (e: any) {
      if (e.code === 'ENOENT') return [];
      console.error('[telegram-store] loadChats failed:', e.message);
      return [];
    }
  }

  async saveChats(chats: TelegramChat[]): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const tmp = this.chatsFile + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(chats, null, 2));
      await fs.rename(tmp, this.chatsFile);
    }).catch((e) => console.error('[telegram-store] saveChats failed:', e.message));
    return this.writeChain;
  }

  private msgFile(chatId: string): string {
    const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.msgDir, `${safe}.ndjson`);
  }

  async loadMessages(chatId: string): Promise<TelegramMessage[]> {
    const file = this.msgFile(chatId);
    const cutoff = nowSec() - RETENTION_SECONDS;
    const out: TelegramMessage[] = [];
    try {
      const stream = createReadStream(file, { encoding: 'utf8' });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line) as TelegramMessage;
          if (m.date >= cutoff) out.push(m);
        } catch {}
      }
    } catch (e: any) {
      if (e.code !== 'ENOENT') console.error('[telegram-store] loadMessages failed:', e.message);
    }
    return out;
  }

  async appendMessage(msg: TelegramMessage): Promise<void> {
    const file = this.msgFile(msg.chatId);
    const line = JSON.stringify(msg) + '\n';
    this.writeChain = this.writeChain.then(() => fs.appendFile(file, line))
      .catch((e) => console.error('[telegram-store] appendMessage failed:', e.message));
    return this.writeChain;
  }

  async deleteChat(chatId: string): Promise<void> {
    const file = this.msgFile(chatId);
    this.writeChain = this.writeChain.then(async () => {
      try { await fs.unlink(file); } catch {}
    });
    return this.writeChain;
  }

  /** Rewrite each per-chat file dropping messages older than retention. */
  async compactAll(): Promise<void> {
    const cutoff = nowSec() - RETENTION_SECONDS;
    let files: string[];
    try {
      files = await fs.readdir(this.msgDir);
    } catch {
      return;
    }
    for (const name of files) {
      if (!name.endsWith('.ndjson')) continue;
      const file = path.join(this.msgDir, name);
      await this.compactFile(file, cutoff);
    }
  }

  private async compactFile(file: string, cutoff: number): Promise<void> {
    const tmp = file + '.tmp';
    let kept = 0;
    let total = 0;
    await new Promise<void>(async (resolve, reject) => {
      try {
        const out = createWriteStream(tmp, { encoding: 'utf8' });
        const rl = createInterface({
          input: createReadStream(file, { encoding: 'utf8' }),
          crlfDelay: Infinity,
        });
        for await (const line of rl) {
          if (!line.trim()) continue;
          total++;
          try {
            const m = JSON.parse(line) as TelegramMessage;
            if (m.date >= cutoff) {
              out.write(JSON.stringify(m) + '\n');
              kept++;
            }
          } catch {}
        }
        out.end(() => resolve());
        out.on('error', reject);
      } catch (e) {
        reject(e);
      }
    }).catch((e) => console.error('[telegram-store] compact failed:', e.message));
    if (kept === total) {
      try { await fs.unlink(tmp); } catch {}
      return;
    }
    try {
      await fs.rename(tmp, file);
    } catch (e: any) {
      console.error('[telegram-store] rename failed:', e.message);
    }
  }
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}
