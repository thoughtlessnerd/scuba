# scuba

Spawn terminals in any folder from your browser.

```
npm install -g scuba
scuba start
```

Opens a local web UI where you can launch terminal sessions in any working
directory. Every keystroke is forwarded straight to a real PTY, so `vim`,
`htop`, tab completion, and arrow-key history all work.

## Flags

```
scuba start --port 4242 --host 127.0.0.1
```

## Dev

```
npm install
npm run dev
```
