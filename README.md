# scuba

A local web UI for spawning real terminal sessions in any folder, organized into
colored groups with tabs/tiled layouts, **plus** a Telegram chat panel that
mirrors any chat the bot has access to, **plus** an agent layer that runs Claude
Code instances bound to Telegram chats — so permission prompts land on your
phone with inline-keyboard buttons and replies are mirrored back.

Every terminal is a real PTY on the host, so `vim`, `htop`, tab completion,
arrow-key history, Ctrl-C, all work as expected.

## Install

scuba isn't on the public npm registry — install from source:

```bash
git clone github.com/thoughtlessnerd/scuba scuba
cd scuba
npm install
npm run build
npm i -g .          # installs the `scuba` binary globally
scuba setup         # interactive prompt for required env vars (~/.scuba/.env)
scuba start         # opens http://127.0.0.1:4242 in your browser
```

`scuba setup` asks for:
- `TELEGRAM_BOT_TOKEN` (required) — from [@BotFather](https://t.me/BotFather)
- `MOTHER_TELEGRAM_CHAT_ID` (required) — the chat mother answers in (your DM with the bot)
- `MOTHER_CWD` (optional) — default `~/.scuba/mother-home`
- `TURN_END_DEBOUNCE_MS` (optional) — default `1500`

Re-run `scuba setup` any time to update values; current values are shown as defaults.

To upgrade after pulling new code:

```bash
git pull
npm run build && npm i -g .
```

To uninstall: `npm uninstall -g scuba`.

---

## Dev loop (from source)

```bash
npm install
npm run dev    # tsx watch server :4242 + Vite UI :5173
# open http://localhost:5173
```

For a production-style local run without global install:

```bash
npm run build
node dist/cli.js start
# → http://127.0.0.1:4242
```

## CLI

```
scuba setup
scuba start [--host 127.0.0.1] [--port 4242] [--no-open] [--dev]
```

- `--host`, `--port` — bind address.
- `--no-open` — don't auto-open the browser.
- `--dev` — serves API only; expects you to run the Vite dev UI on `:5173` yourself.

---

## Three things you can do in the UI

### 1. Spawn terminals

Type a path (`~`, `/some/repo`, etc.) in the sidebar form and hit **New
terminal** — a real shell starts in that directory. Group terminals by clicking
**+ Group**, drag them between groups via the per-row dropdown, toggle layout
between tabs and tiled, and color/rename groups by double-clicking.

### 2. Mirror a Telegram chat

Set up a bot with [@BotFather](https://t.me/BotFather), drop the token in
`.env` as `TELEGRAM_BOT_TOKEN`, and add chats (DMs, groups, supergroups) via
the right-side panel. Messages flow both ways: anything sent to the bot shows
up in the panel; the composer below sends text or files (images, video, audio,
documents) as the bot.

For groups, disable the bot's privacy mode in BotFather (`/setprivacy → Disable`)
so it can see every message, not just commands.

### 3. Run Claude Code agents bound to chats

Three flavors, all running `claude` (the Claude Code CLI) as the PTY shell:

- **Mother** — the orchestrator. Spawns workers, routes their permission
  prompts to chats you choose, and replies to you in her own chat. Lives in
  `~/.scuba/mother-home/` with a `.mcp.json` exposing scuba's tools.
  - Set `MOTHER_TELEGRAM_CHAT_ID` in `.env` to the chat she answers in (usually
    your DM with the bot).
  - Click **Spawn mother** in the sidebar header. Click it again to restart.
- **Worker** — spawned by mother in whatever repo's cwd, no MCP. Her
  permission prompts route to a chat she's bound to (mother picks via
  `ask_human`). When a worker goes idle, scuba pings mother with the tail.
- **Adhoc** — a standalone claude with **no MCP** and no role coupling. Click
  **New claude** in the sidebar, pick the cwd, the Telegram chat to bind to,
  and a name. From then on:
  - Permission prompts (numbered TUI choices) show up as inline-keyboard
    buttons in that chat — tap one to answer.
  - Any text you send in that chat is typed into the terminal's input.
  - When the terminal finishes a turn, a colored screenshot of its reply is
    posted back to the chat.

Adhoc claudes cannot spawn other terminals and cannot be sent to by mother —
they're a parallel layer for one-off interactive sessions.

---

## Environment variables

Prefer `scuba setup` over editing files by hand — it writes `~/.scuba/.env`
with the right perms. For reference:

```bash
# Required.
TELEGRAM_BOT_TOKEN=                  # from @BotFather
MOTHER_TELEGRAM_CHAT_ID=             # the chat mother answers in (your DM)

# Optional.
MOTHER_CWD=                          # default: ~/.scuba/mother-home
TURN_END_DEBOUNCE_MS=                # default: 1500 — how long mother/adhoc must
                                     #   stay idle before posting a "replied"
                                     #   screenshot. Lower = snappier; higher =
                                     #   more accurate "really done" signal.
```

`scuba start` loads env from (in order, first hit wins): `./.env` in your cwd,
`~/.scuba/.env`, then the package root's `.env`. It refuses to start if either
required var is missing — it prints a "run `scuba setup`" hint and exits.

---

## State on disk

Under `~/.scuba/`:

```
agents.db                    # SQLite — agent terminals, groups, pending prompts
telegram/chats.json          # tracked Telegram chats
telegram/messages/*.ndjson   # 7-day rolling message history per chat
mother-home/.mcp.json        # auto-written; tells claude where scuba's MCP is
```

Nothing here is required to keep — delete the file and scuba will rebuild it
the next time it needs it.

---

## Security

Server binds to `127.0.0.1` by default with **no authentication**. Anything
that can reach the port can spawn arbitrary processes as your user, send
messages as your bot, and read message history. Don't bind to `0.0.0.0`
without adding auth + TLS.

---

The Vite dev server proxies `/api` and `/ws` to `:4242` so the UI can talk to
the server while both reload independently.

For a deep dive on architecture, data flow, state machines, and gotchas, see
[HANDOVER.md](./HANDOVER.md).
