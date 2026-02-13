import { connectRealtime, disconnectRealtime } from "@devvit/web/client";
import type { RealtimeMessage } from "@shared/protocol";

export type RealtimeConnection = {
  disconnect(): void;
};

type ConnectArgs = {
  channel: string;
  onMessage: (msg: RealtimeMessage) => void;
  onConnect?: (channel: string) => void;
  onDisconnect?: (channel: string) => void;
};

const BASE_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 15000;

export function connectChannel({
  channel,
  onMessage,
  onConnect,
  onDisconnect,
}: ConnectArgs): RealtimeConnection {
  let disposed = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function doConnect(): void {
    if (disposed) return;
    try {
      disconnectRealtime(channel);
    } catch {
      // may fail if not connected yet
    }
    connectRealtime({
      channel,
      onMessage,
      onConnect: (ch: string) => {
        reconnectAttempts = 0;
        onConnect?.(ch);
      },
      onDisconnect: (ch: string) => {
        onDisconnect?.(ch);
        if (!disposed) {
          const delay = Math.min(
            MAX_RECONNECT_DELAY_MS,
            BASE_DELAY_MS * Math.pow(2, reconnectAttempts),
          );
          reconnectAttempts++;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            doConnect();
          }, delay);
        }
      },
    });
  }

  doConnect();

  return {
    disconnect() {
      disposed = true;
      if (reconnectTimer != null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        disconnectRealtime(channel);
      } catch {
        // already disconnected
      }
    },
  };
}
