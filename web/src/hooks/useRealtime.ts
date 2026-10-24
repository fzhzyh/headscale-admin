/**
 * WebSocket 实时推送 hook。
 *
 * 行为：
 *   - 挂载即连接，断线自动重连（指数退避，上限 30s）
 *   - 收到变更事件时通过回调通知调用方（通常是 invalidate react-query 缓存）
 *   - 心跳保活，避免中间的 Nginx/反代把空闲连接掐掉
 *   - 页面隐藏时不断开（浏览器会自动节流），但要提示连接状态
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import type { WsMessage } from '../api/types';

export type RealtimeStatus = 'connecting' | 'open' | 'closed';

interface Options {
  /** 是否启用（未登录时应关闭） */
  enabled: boolean;
  /** 收到消息时回调 */
  onMessage?: (msg: WsMessage) => void;
}

export interface RealtimeState {
  status: RealtimeStatus;
  lastEventAt: string | null;
  /** 服务端告知的采样间隔（秒），用于 UI 说明数据新鲜度 */
  pollIntervalSec: number | null;
  clientCountHint: number | null;
}

export function useRealtime({ enabled, onMessage }: Options): RealtimeState {
  const [status, setStatus] = useState<RealtimeStatus>('closed');
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const [pollIntervalSec, setPollIntervalSec] = useState<number | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const closedByUsRef = useRef(false);
  // 用 ref 持有回调，避免它变化导致重连
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const connect = useCallback(() => {
    if (!enabled) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // 开发环境走 vite 代理，生产同源
    const url = `${proto}//${window.location.host}/api/ws`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      setStatus('closed');
      return;
    }
    wsRef.current = ws;
    setStatus('connecting');

    ws.onopen = () => {
      retryRef.current = 0;
      setStatus('open');
    };

    ws.onmessage = (ev) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(ev.data as string) as WsMessage;
      } catch {
        return;
      }
      setLastEventAt(msg.ts ?? new Date().toISOString());
      if (msg.type === 'hello') {
        const d = msg.data as { pollIntervalSec?: number } | undefined;
        if (d?.pollIntervalSec) setPollIntervalSec(d.pollIntervalSec);
      }
      onMessageRef.current?.(msg);
    };

    ws.onerror = () => {
      // onerror 后必然触发 onclose，重连逻辑统一放 onclose
    };

    ws.onclose = (ev) => {
      wsRef.current = null;
      setStatus('closed');
      // 4401 = 未认证，重连也没意义，等用户重新登录
      if (closedByUsRef.current || ev.code === 4401) return;
      // 指数退避：1s → 2s → 4s → ... 上限 30s
      const delay = Math.min(1000 * 2 ** retryRef.current, 30_000);
      retryRef.current += 1;
      timerRef.current = window.setTimeout(connect, delay);
    };
  }, [enabled]);

  useEffect(() => {
    closedByUsRef.current = false;
    connect();
    return () => {
      closedByUsRef.current = true;
      if (timerRef.current) window.clearTimeout(timerRef.current);
      wsRef.current?.close(1000, 'unmount');
      wsRef.current = null;
    };
  }, [connect]);

  // 心跳：每 25s 发一次，低于常见反代的 60s 空闲超时
  useEffect(() => {
    if (status !== 'open') return;
    const hb = window.setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send('ping');
    }, 25_000);
    return () => window.clearInterval(hb);
  }, [status]);

  return { status, lastEventAt, pollIntervalSec, clientCountHint: null };
}
