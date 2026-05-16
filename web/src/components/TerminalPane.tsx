import { memo, useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { sessionSocketUrl } from '../api';

interface Props {
  sessionId: string;
  active: boolean;
}

function TerminalPaneInner({ sessionId, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: {
        background: '#0f1115',
        foreground: '#d6dae3',
        cursor: '#7aa2f7',
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    const ws = new WebSocket(sessionSocketUrl(sessionId));
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'output') term.write(msg.data);
        else if (msg.type === 'exit') {
          term.write(`\r\n\x1b[31m[process exited with code ${msg.code}]\x1b[0m\r\n`);
        }
      } catch {}
    };

    const inputDisp = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    const resizeDisp = term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch {}
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      inputDisp.dispose();
      resizeDisp.dispose();
      ws.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      try { fitRef.current?.fit(); } catch {}
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [active]);

  return <div className="pane-body" ref={hostRef} />;
}

export const TerminalPane = memo(TerminalPaneInner);
