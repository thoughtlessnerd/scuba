# scuba

A local web UI for spawning real terminal sessions in any folder, organized into
colored groups with tabs/tiled layouts, **plus** a Telegram chat panel that
mirrors any chat the bot has access to, **plus** an agent layer that runs Claude
Code instances bound to Telegram chats — so permission prompts land on your
phone with inline-keyboard buttons and replies are mirrored back.

Every terminal is a real PTY on the host, so `vim`, `htop`, tab completion,
arrow-key history, Ctrl-C, all work as expected.

## Setup

### Prerequisites

- **Node.js ≥ 20** (`node -v`). On macOS: `brew install node`.
- **Claude Code CLI** on your `PATH` (`claude --version`). Install via
  [claude.ai/code](https://claude.ai/code) and run `claude` once to log in —
  scuba spawns it as the shell for every agent terminal.
- **Build tools** for `node-pty` if no prebuilt binary is available for your
  Node version: Xcode CLT (`xcode-select --install`) on macOS, or `build-essential`
  on Linux.

### 1. Create a Telegram bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram → `/newbot` → follow
   the prompts. Save the **HTTP API token** — this is `TELEGRAM_BOT_TOKEN`.
2. (Optional, but recommended for group chats) `/setprivacy` → pick your bot →
   **Disable**. Without this, the bot only sees commands in groups, not regular
   messages.
3. DM your new bot anything (e.g. "hi") so Telegram creates the chat.

### 2. Find your chat ID

`MOTHER_TELEGRAM_CHAT_ID` is the chat where mother (the orchestrator) listens
and replies. The easiest way to get it:

1. Open [@userinfobot](https://t.me/userinfobot) → it replies with your numeric
   user ID. That's your DM chat ID with any bot.
2. Alternatively, after DMing your bot, fetch:
   `curl "https://api.telegram.org/bot<TOKEN>/getUpdates"` and look for
   `"chat":{"id":…}`.

For a group chat ID, add the bot to the group, send a message, then call
`getUpdates` — group IDs are negative (e.g. `-1003915835945`).

### 3. Install scuba

scuba isn't published to npm — install from source:

```bash
git clone https://github.com/thoughtlessnerd/scuba.git
cd scuba
npm install
npm run build
npm i -g .          # installs `scuba` globally
```

If `npm i -g` fails with EACCES, either fix your npm prefix
(`npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to PATH) or
use `sudo npm i -g .`.

### 4. Configure and start

```bash
scuba setup         # interactive — writes ~/.scuba/.env (0600)
scuba start         # opens http://127.0.0.1:4242
```

`scuba setup` prompts for:

| Var | Required | Default | Notes |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | from @BotFather |
| `MOTHER_TELEGRAM_CHAT_ID` | yes | — | your DM chat ID with the bot |
| `MOTHER_CWD` | no | `~/.scuba/mother-home` | where mother's `.mcp.json` lives. Don't set to `~` or `$HOME` — scuba will refuse |
| `TURN_END_DEBOUNCE_MS` | no | `1500` | how long mother/adhoc must stay idle before scuba posts a "replied" screenshot |

Re-run `scuba setup` any time — current values are shown as defaults; press
Enter to keep each.

### 5. Smoke test

With `scuba start` running:

1. Open `http://127.0.0.1:4242` — you should see the workspace + an empty
   sidebar + the Telegram phone panel on the right.
2. The Telegram panel header should show your bot's username. If not, check
   `scuba start` logs for token errors.
3. Click **Spawn mother** in the sidebar header. A new terminal appears running
   `claude`. Within ~5 seconds you'll get a "mother ready" greeting in your DM.
4. DM the bot something like `list the files in /tmp` — mother should reply
   with a screenshot of her terminal.

If mother prompts you to approve the **scuba MCP server**, tap **Yes** in the
inline keyboard — that's a one-time consent for her to use scuba's
orchestration tools.

### Upgrading

```bash
cd scuba
git pull
npm install
npm run build && npm i -g .
```

Then restart: kill the running `scuba start` and re-run it.

### Uninstall

```bash
npm uninstall -g scuba
rm -rf ~/.scuba           # only if you also want to wipe state (chats, agents, settings)
```

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
scuba start [--host 127.0.0.1] [--port 4242] [--no-open]
            [--no-keep-awake] [--dev]
```

- `--host`, `--port` — bind address.
- `--no-open` — don't auto-open the browser.
- `--no-keep-awake` — on macOS, opt out of the `caffeinate` child that prevents
  idle/display/system sleep while scuba runs. Default is on (no-op on Linux/Windows).
  Lid-close sleep isn't prevented — see HANDOVER.md gotcha #21.
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

### Troubleshooting

- **"TELEGRAM_BOT_TOKEN missing" on start** — run `scuba setup`, or check that
  `~/.scuba/.env` exists and is readable.
- **Mother never greets you** — `claude` may not be on PATH for the spawned
  PTY. Test with `which claude` in your normal shell; if it's there but
  scuba can't find it, your PATH may be set in `.zshrc` (interactive) instead
  of `.zshenv` (non-interactive). Move the relevant `export PATH=…` to `.zshenv`.
- **Bot sees `/cmd` in groups but ignores plain text** — privacy mode is still
  on; revisit BotFather `/setprivacy`.
- **node-pty install fails** — install build tools (see Prerequisites) and run
  `npm rebuild node-pty`.
- **Permission prompt stuck — no buttons appearing in Telegram** — there may
  be a stale pending row blocking new prompts. Inspect with
  `sqlite3 ~/.scuba/agents.db 'SELECT * FROM pending_prompts;'` and delete
  rows whose Telegram message you already dismissed.

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
