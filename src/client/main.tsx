import type {
  IdentityResponse,
  MatchmakingJoinResponse,
  RealtimeMessage,
  RoomPublicState,
  SessionBootstrapResponse,
} from "@shared/protocol";
import confetti from "canvas-confetti";
import { getStroke } from "perfect-freehand";
import type { ErrorInfo, ReactNode } from "react";
import React, { Component, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { connectChannel, type RealtimeConnection } from "./index";
import "./style.css";

type Connection = RealtimeConnection;

class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Scroodle ErrorBoundary:", error, info.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="p-6 text-center">
          <div className="text-base font-bold mb-3">Something went wrong</div>
          <button
            onClick={() => window.location.reload()}
            className="btn-primary px-5 py-2.5 font-semibold"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function useInterval(cb: () => void, ms: number) {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(() => {
    const id = setInterval(() => cbRef.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

/** Interpolate points when gap exceeds maxGap (normalized 0-1) for smoother rendering. */
function interpolatePoints(
  points: Array<[number, number]>,
  maxGap: number
): Array<[number, number]> {
  if (points.length <= 2) return points;
  const out: Array<[number, number]> = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const dist = Math.hypot(x1 - x0, y1 - y0);
    if (dist > maxGap) {
      const n = Math.ceil(dist / maxGap);
      for (let j = 1; j < n; j++) {
        const t = j / n;
        out.push([x0 + t * (x1 - x0), y0 + t * (y1 - y0)]);
      }
    }
    out.push(points[i]);
  }
  return out;
}

/** Convert perfect-freehand outline points to an SVG-style path and fill on canvas. */
function drawFreehandStroke(
  ctx: CanvasRenderingContext2D,
  points: Array<[number, number]>,
  color: string,
  width: number,
  scaleX: number,
  scaleY: number,
  options?: { taperStart?: boolean; taperEnd?: boolean },
) {
  // Fast path for tiny segments: avoid expensive outline generation per pointer tick.
  if (points.length <= 2) {
    if (points.length < 2) return;
    const [x0, y0] = points[0];
    const [x1, y1] = points[1];
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x0 * scaleX, y0 * scaleY);
    ctx.lineTo(x1 * scaleX, y1 * scaleY);
    ctx.stroke();
    return;
  }

  // perfect-freehand expects [x, y, pressure] — we use 0.5 pressure for consistent look
  const inputPts = points.map(([x, y]) => [x * scaleX, y * scaleY, 0.5] as [number, number, number]);
  const strokeOutline = getStroke(inputPts, {
    size: width * 1.8,
    thinning: 0.5,
    smoothing: 0.5,
    streamline: 0.5,
    start: { taper: options?.taperStart ?? true },
    end: { taper: options?.taperEnd ?? true },
  });
  if (strokeOutline.length < 2) return;

  ctx.fillStyle = color;
  ctx.beginPath();
  const [sx, sy] = strokeOutline[0];
  ctx.moveTo(sx, sy);
  for (let i = 1; i < strokeOutline.length; i++) {
    const [px, py] = strokeOutline[i];
    ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

/** Fire a confetti burst. */
function fireConfetti() {
  confetti({
    particleCount: 80,
    spread: 70,
    origin: { y: 0.6 },
    colors: ["#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#ec4899"],
  });
}

/** Game Over screen — shows final scores, winner highlight, confetti, and play-again CTA. */
function GameOverView({
  roomState,
  onPlayAgain,
}: {
  roomState: RoomPublicState;
  onPlayAgain: () => void;
}) {
  // Fire confetti when the game-over screen mounts
  useEffect(() => {
    fireConfetti();
    const t = setTimeout(() => fireConfetti(), 600);
    return () => clearTimeout(t);
  }, []);

  const sorted = [...(roomState.players ?? [])].sort(
    (a, b) => b.score - a.score,
  );
  const winner = sorted[0];

  return (
    <div className="animate-slide-up flex flex-col items-center gap-4 max-w-[400px] mx-auto p-6">
      <div className="text-4xl">🏆</div>
      <div className="text-xl font-extrabold">Game Over!</div>

      {winner && (
        <div
          className="text-[15px] font-bold"
          style={{ color: "var(--accent)" }}
        >
          {winner.userName} wins with {winner.score} points!
        </div>
      )}

      <div className="card w-full p-3">
        <div className="font-bold mb-2">Final Scores</div>
        <div className="grid gap-1.5">
          {sorted.map((p, i) => (
            <div
              key={p.userId}
              className="flex justify-between items-center text-sm"
              style={{
                fontWeight: i === 0 ? 700 : 400,
                color: i === 0 ? "var(--accent)" : "var(--text-primary)",
              }}
            >
              <span>
                {i === 0 ? "🥇 " : i === 1 ? "🥈 " : i === 2 ? "🥉 " : `${i + 1}. `}
                {p.userName}
              </span>
              <b>{p.score}</b>
            </div>
          ))}
        </div>
      </div>

      <button
        onClick={onPlayAgain}
        className="btn-primary py-3 px-6 font-bold text-base min-w-[160px]"
      >
        Play Again
      </button>
    </div>
  );
}

function App() {
  const [identity, setIdentity] = useState<IdentityResponse | null>(null);
  const [phase, setPhase] = useState<"init" | "menu" | "queue" | "room">(
    "init",
  );
  const [errorText, setErrorText] = useState<string | null>(null);
  const [isJoining, setIsJoining] = useState(false);
  const [queueSize, setQueueSize] = useState<number | null>(null);
  const [isRealtimeConnected, setIsRealtimeConnected] = useState(false);

  const [personalChannel, setPersonalChannel] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [roomChannel, setRoomChannel] = useState<string | null>(null);
  const [roomState, setRoomState] = useState<RoomPublicState | null>(null);
  const lastRoomStateUpdatedAtRef = useRef(0);

  const [chat, setChat] = useState<
    Array<{ from: string; text: string; correct?: boolean }>
  >([]);
  const [guess, setGuess] = useState("");
  const [mobilePanel, setMobilePanel] = useState<"chat" | "players">("chat");

  const personalConnRef = useRef<Connection | null>(null);
  const roomConnRef = useRef<Connection | null>(null);
  const queuePollInFlightRef = useRef(false);
  const queuePollNextAtRef = useRef(0);
  const advanceInFlightRef = useRef(false);

  // Chat auto-scroll
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat.length]);

  // Canvas
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const drawingRef = useRef<{ isDown: boolean; last?: [number, number] }>({
    isDown: false,
  });
  const moveRafRef = useRef<number | null>(null);
  const pendingPointRef = useRef<[number, number] | null>(null);
  const [penWidth, setPenWidth] = useState(4);
  const [penColor, setPenColor] = useState("#111");
  const [tick, setTick] = useState(0);

  const isDrawer = useMemo(() => {
    if (!identity || !roomState) return false;
    return roomState.drawerUserId === identity.userId;
  }, [identity, roomState]);

  const timeLeft = useMemo(() => {
    void tick; // depend on tick to recalculate every second
    if (!roomState?.roundEndsAt) return null;
    return Math.max(0, roomState.roundEndsAt - Date.now());
  }, [roomState?.roundEndsAt, tick]);

  useInterval(() => {
    // tick the timer display every second
    if (phase === "room") setTick((t) => t + 1);
    // heartbeat while on screen
    if (phase === "queue" || phase === "room") {
      fetch("/api/ping", { method: "POST" }).catch(() => {
        setErrorText("Connection issue. Trying to recover...");
      });
    }
    // queue polling allows matchmaking to start without user retries
    if (
      phase === "queue" &&
      !queuePollInFlightRef.current &&
      Date.now() >= queuePollNextAtRef.current
    ) {
      queuePollNextAtRef.current = Date.now() + 3000;
      queuePollInFlightRef.current = true;
      api<MatchmakingJoinResponse>("/api/matchmaking/join", {
        method: "POST",
        body: "{}",
      })
        .then(async (resp) => {
          if (resp.status === "error") {
            setErrorText(resp.message);
            return;
          }
          setPersonalChannel(resp.personalChannel);
          if (resp.status === "queued") setQueueSize(resp.queueSize);
          if (resp.status === "matched") {
            setRoomId(resp.roomId);
            setRoomChannel(resp.roomChannel);
            setPhase("room");
          }
        })
        .catch(() => setErrorText("Failed to poll matchmaking."))
        .finally(() => {
          queuePollInFlightRef.current = false;
        });
    }
    // attempt to advance round if time is up (any client can do this)
    if (
      phase === "room" &&
      roomId &&
      roomState?.status === "playing" &&
      roomState?.roundEndsAt &&
      Date.now() >= roomState.roundEndsAt &&
      !advanceInFlightRef.current
    ) {
      advanceInFlightRef.current = true;
      fetch(`/api/room/${roomId}/advance`, { method: "POST" })
        .then((resp) => {
          if (resp.status === 404) {
            // Room was deleted; go back to menu
            leaveRoom();
          }
        })
        .catch(() => {})
        .finally(() => {
          advanceInFlightRef.current = false;
        });
    }
  }, 1000);

  useEffect(() => {
    (async () => {
      try {
        try {
          const id = await api<IdentityResponse>("/api/identity");
          setIdentity(id);
        } catch {
          // Logged-out users can still render the UI shell.
        }

        const session = await api<SessionBootstrapResponse>("/api/session");
        if (session.status === "matched") {
          setPersonalChannel(session.personalChannel);
          connectPersonal(session.personalChannel);
          setRoomId(session.roomId);
          setRoomChannel(session.roomChannel);
          setPhase("room");
          return;
        }
        if (session.status === "queued") {
          setPersonalChannel(session.personalChannel);
          connectPersonal(session.personalChannel);
          setQueueSize(session.queueSize);
          setPhase("queue");
          return;
        }
        setPhase("menu");
      } catch {
        setPhase("menu");
      }
    })();
  }, []);

  useEffect(() => {
    // keep canvas scaled to device pixel ratio
    const canvas = canvasRef.current;
    if (!canvas) {
      canvasCtxRef.current = null;
      return;
    }
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      canvasCtxRef.current = ctx;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      canvasCtxRef.current = null;
    };
  }, [phase]);

  const drawerLastPointRef = useRef<Record<string, [number, number]>>({});

  function drawStroke(
    points: Array<[number, number]>,
    color: string,
    width: number,
    connectFrom?: [number, number],
    fromUserId?: string,
    options?: { taperStart?: boolean; taperEnd?: boolean },
  ) {
    if (points.length < 2) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvasCtxRef.current;
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width;
    const scaleY = rect.height;

    let pts = points;
    if (connectFrom && pts.length > 0) {
      pts = [connectFrom, ...pts];
    }
    pts = interpolatePoints(pts, 0.015);

    // Use perfect-freehand for beautiful tapered strokes
    drawFreehandStroke(ctx, pts, color, width, scaleX, scaleY, options);

    if (fromUserId && pts.length > 0) {
      drawerLastPointRef.current[fromUserId] = pts[pts.length - 1];
    }
  }

  function connectPersonal(channel: string) {
    if (personalConnRef.current) personalConnRef.current.disconnect();
    const conn = connectChannel({
      channel,
      onConnect: () => {
        setIsRealtimeConnected(true);
        setErrorText(null);
      },
      onDisconnect: () => {
        setIsRealtimeConnected(false);
        setErrorText("Realtime disconnected. Reconnecting...");
      },
      onMessage: (msg: RealtimeMessage) => {
        if (msg?.type === "match-found") {
          setRoomId(msg.roomId);
          setRoomChannel(msg.roomChannel);
          setPhase("room");
        }
      },
    });
    personalConnRef.current = conn;
  }

  async function connectRoom(channel: string, roomId: string) {
    if (roomConnRef.current) roomConnRef.current.disconnect();

    drawerLastPointRef.current = {};
    strokeLastSentRef.current = null;
    strokeIsNewRef.current = true;

    const canvas = canvasRef.current;
    if (canvas && canvasCtxRef.current) {
      canvasCtxRef.current.clearRect(0, 0, canvas.width, canvas.height);
    }
    lastRoomStateUpdatedAtRef.current = 0;
    let hasConnectedOnce = false;
    let drawerStateFetchInFlight = false;

    const applyRoomState = (next: RoomPublicState) => {
      lastRoomStateUpdatedAtRef.current = Math.max(
        lastRoomStateUpdatedAtRef.current,
        next.updatedAt ?? 0,
      );
      setRoomState(next);
    };

    const fetchPersonalizedRoomState = async () => {
      if (drawerStateFetchInFlight) return;
      drawerStateFetchInFlight = true;
      try {
        // Drawer state is viewer-specific (contains secret word), so reconnects must
        // re-fetch from HTTP instead of trusting generic broadcast payloads.
        const st = await api<RoomPublicState>(`/api/room/${roomId}/state`);
        applyRoomState(st);
      } catch {
        // Keep current state on transient fetch issues.
      } finally {
        drawerStateFetchInFlight = false;
      }
    };

    const conn = connectChannel({
      channel,
      onConnect: () => {
        setIsRealtimeConnected(true);
        setErrorText(null);
        // Rehydrate personalized state after reconnect to recover missed events.
        if (hasConnectedOnce) void fetchPersonalizedRoomState();
        hasConnectedOnce = true;
      },
      onDisconnect: () => {
        setIsRealtimeConnected(false);
        setErrorText("Realtime disconnected. Reconnecting...");
      },
      onMessage: async (msg: RealtimeMessage) => {
        if (!msg || typeof msg !== "object") return;

        if (msg.type === "room-state") {
          if ((msg.state.updatedAt ?? 0) <= lastRoomStateUpdatedAtRef.current) {
            return;
          }
          const shouldFetchPersonalizedState =
            !identity || msg.state.drawerUserId === identity.userId;
          if (shouldFetchPersonalizedState) {
            void fetchPersonalizedRoomState();
          } else {
            applyRoomState(msg.state);
          }
        } else if (msg.type === "chat") {
          if (msg.correct) fireConfetti();
          setChat((prev) => [
            ...prev.slice(-50),
            { from: msg.from, text: msg.text, correct: msg.correct },
          ]);
        } else if (msg.type === "system") {
          setChat((prev) => [
            ...prev.slice(-50),
            { from: "system", text: msg.text },
          ]);
        } else if (msg.type === "draw") {
          // Draw packets are streamed chunks. We stitch continuity per sender using
          // their last endpoint so remote strokes look continuous between messages.
          if (msg.newStroke) {
            delete drawerLastPointRef.current[msg.from];
          }
          const connectFrom = msg.newStroke
            ? undefined
            : drawerLastPointRef.current[msg.from];
          drawStroke(msg.points, msg.color, msg.width, connectFrom, msg.from, {
            taperStart: msg.newStroke === true,
            taperEnd: msg.endStroke === true,
          });
          if (msg.endStroke) {
            delete drawerLastPointRef.current[msg.from];
          }
        } else if (msg.type === "canvas-clear") {
          drawerLastPointRef.current = {};
          strokeLastSentRef.current = null;
          strokeIsNewRef.current = true;
          const c = canvasRef.current;
          if (c && canvasCtxRef.current) {
            canvasCtxRef.current.clearRect(0, 0, c.width, c.height);
          }
        } else if (msg.type === "round-ended") {
          drawerLastPointRef.current = {};
          strokeLastSentRef.current = null;
          strokeIsNewRef.current = true;
          const c = canvasRef.current;
          if (c && canvasCtxRef.current) {
            canvasCtxRef.current.clearRect(0, 0, c.width, c.height);
          }
        }
      },
    });

    roomConnRef.current = conn;

    // fetch per-viewer state (drawer gets word)
    try {
      const st = await api<RoomPublicState>(`/api/room/${roomId}/state`);
      applyRoomState(st);
    } catch {
      setErrorText("Failed to load room state.");
    }
  }

  useEffect(() => {
    if (phase === "room" && roomChannel && roomId) {
      connectRoom(roomChannel, roomId).catch(() => {
        setErrorText("Failed to connect to room.");
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, roomChannel, roomId]);

  useEffect(() => {
    return () => {
      personalConnRef.current?.disconnect();
      roomConnRef.current?.disconnect();
      if (moveRafRef.current != null) {
        window.cancelAnimationFrame(moveRafRef.current);
        moveRafRef.current = null;
      }
      if (strokeTimer.current != null) {
        window.clearTimeout(strokeTimer.current);
        strokeTimer.current = null;
      }
    };
  }, []);

  async function quickPlay() {
    if (isJoining) return;
    setIsJoining(true);
    setErrorText(null);
    setChat([]);
    try {
      const resp = await api<MatchmakingJoinResponse>("/api/matchmaking/join", {
        method: "POST",
        body: "{}",
      });
      if (resp.status === "error") {
        setErrorText(resp.message);
        return;
      }
      setPersonalChannel(resp.personalChannel);
      connectPersonal(resp.personalChannel);

      if (resp.status === "matched") {
        setRoomId(resp.roomId);
        setRoomChannel(resp.roomChannel);
        setPhase("room");
      } else {
        setQueueSize(resp.queueSize);
        setPhase("queue");
      }
    } catch {
      setErrorText("Quick Play failed. Please try again.");
    } finally {
      setIsJoining(false);
    }
  }

  function leaveRoom() {
    if (roomId) {
      fetch(`/api/room/${roomId}/leave`, { method: "POST" }).catch(() => {});
    }
    if (roomConnRef.current) roomConnRef.current.disconnect();
    roomConnRef.current = null;
    if (personalConnRef.current) personalConnRef.current.disconnect();
    personalConnRef.current = null;
    setIsRealtimeConnected(false);

    setRoomId(null);
    setRoomChannel(null);
    setRoomState(null);
    lastRoomStateUpdatedAtRef.current = 0;
    if (moveRafRef.current != null) {
      window.cancelAnimationFrame(moveRafRef.current);
      moveRafRef.current = null;
    }
    pendingPointRef.current = null;
    setQueueSize(null);
    setChat([]);
    setPhase("menu");
  }

  function cancelQueue() {
    fetch("/api/matchmaking/leave", { method: "POST" }).catch(() => {});
    if (personalConnRef.current) personalConnRef.current.disconnect();
    personalConnRef.current = null;
    setIsRealtimeConnected(false);
    setQueueSize(null);
    setPhase("menu");
  }

  async function sendGuess() {
    if (!roomId) return;
    const text = guess.trim();
    if (!text) return;
    setGuess("");
    await fetch(`/api/room/${roomId}/guess`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).catch(() => {
      setErrorText("Failed to send guess.");
    });
  }

  function canvasPoint(
    e: React.PointerEvent<HTMLCanvasElement>,
  ): [number, number] {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const x = clamp01((e.clientX - rect.left) / rect.width);
    const y = clamp01((e.clientY - rect.top) / rect.height);
    return [x, y];
  }

  async function sendStroke(
    points: Array<[number, number]>,
    newStroke: boolean,
    endStroke = false,
  ) {
    if (!roomId) return;
    fetch(`/api/room/${roomId}/draw`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points, color: penColor, width: penWidth, newStroke, endStroke }),
    }).catch(() => {
      setErrorText("Draw sync issue.");
    });
  }

  const strokeBuf = useRef<Array<[number, number]>>([]);
  const strokeLastSentRef = useRef<[number, number] | null>(null);
  const strokeIsNewRef = useRef(true);
  const strokeTimer = useRef<number | null>(null);

  const STROKE_BATCH_SIZE = 12;
  const STROKE_FLUSH_MS = 40;

  function flushStrokeBuffer(endStroke = false) {
    const pts = strokeBuf.current.slice();
    strokeBuf.current = [];
    const newStroke = strokeIsNewRef.current;
    const last = strokeLastSentRef.current;
    const toSend = last ? [last, ...pts] : pts;
    const hasStrokePoints = toSend.length >= 2;
    if (!hasStrokePoints && !endStroke) return;
    if (pts.length > 0) {
      strokeLastSentRef.current = pts[pts.length - 1];
      strokeIsNewRef.current = false;
    }
    // `endStroke` is emitted even with no points so receivers can apply stroke-end
    // taper and reset continuity state cleanly.
    sendStroke(hasStrokePoints ? toSend : [], newStroke, endStroke);
  }

  function queueStrokePoint(p: [number, number]) {
    strokeBuf.current.push(p);
    if (strokeBuf.current.length >= STROKE_BATCH_SIZE) {
      flushStrokeBuffer();
    } else if (strokeTimer.current == null) {
      strokeTimer.current = window.setTimeout(() => {
        strokeTimer.current = null;
        flushStrokeBuffer();
      }, STROKE_FLUSH_MS);
    }
  }

  const timerSec = timeLeft != null ? Math.ceil(timeLeft / 1000) : null;
  const timerUrgent = timerSec != null && timerSec <= 10;
  const canGuess = !isDrawer && guess.trim().length > 0;

  const ui = (
    <div className="h-full flex flex-col">
      {/* ── Header ── */}
      <header
        className="flex items-center gap-2.5 px-3 py-2.5"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <div
          className="font-bold text-base tracking-tight"
          style={{ color: "var(--accent)" }}
        >
          ✏️ Scroodle
        </div>
        <div
          className="flex items-center text-xs"
          style={{ color: "var(--text-muted)" }}
        >
          {identity ? `u/${identity.userName}` : "anonymous"}
          {roomState?.roomId ? ` • room ${roomState.roomId}` : ""}
          {(phase === "queue" || phase === "room") && (
            <>
              <span
                className={`connection-dot ${isRealtimeConnected ? "connected" : "disconnected"}`}
                title={isRealtimeConnected ? "Connected" : "Reconnecting…"}
              />
              {isRealtimeConnected ? "Live" : "Reconnecting…"}
            </>
          )}
        </div>
        <div className="ml-auto flex gap-2">
          {phase === "room" && (
            <button onClick={leaveRoom} className="px-2.5 py-1.5 text-xs">
              Leave
            </button>
          )}
        </div>
      </header>

      {/* ── Error Banner ── */}
      {errorText && (
        <div
          className="mx-3 mt-2.5 px-3 py-2 rounded-lg text-xs flex items-center justify-between gap-2 animate-fade-in"
          style={{
            border: "1px solid var(--error-border)",
            background: "var(--error-bg)",
            color: "var(--error-text)",
          }}
        >
          <span>{errorText}</span>
          <button
            onClick={() => setErrorText(null)}
            className="px-2 py-1 text-[11px] border-none bg-transparent shadow-none"
            style={{ color: "var(--error-text)" }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── Loading ── */}
      {phase === "init" && (
        <div
          className="loading-pulse flex items-center gap-3 p-6 text-sm"
          style={{ color: "var(--text-secondary)" }}
        >
          <div className="spinner spinner-sm" />
          Loading game…
        </div>
      )}

      {/* ── Main Menu ── */}
      {phase === "menu" && (
        <div className="animate-fade-in flex flex-col items-center gap-5 p-6 max-w-[360px] mx-auto">
          <div className="text-5xl animate-bounce">✏️</div>
          <div
            className="text-[15px] leading-relaxed text-center"
            style={{ color: "var(--text-secondary)" }}
          >
            Draw and guess with friends. 2–4 players per game.
          </div>
          <button
            onClick={quickPlay}
            disabled={isJoining}
            className="btn-primary py-3 px-6 font-bold text-base min-w-[160px]"
          >
            {isJoining ? (
              <span className="inline-flex items-center gap-2">
                <span className="spinner spinner-sm" style={{ borderColor: "rgba(255,255,255,0.3)", borderTopColor: "#fff" }} />
                Joining…
              </span>
            ) : (
              "Quick Play"
            )}
          </button>
          <div
            className="text-xs text-center"
            style={{ color: "var(--text-muted)" }}
          >
            Tip: open this post in multiple tabs or devices to play with friends.
          </div>
        </div>
      )}

      {/* ── Matchmaking Queue ── */}
      {phase === "queue" && (
        <div className="animate-fade-in flex flex-col items-center gap-4 p-6 text-center">
          <div className="spinner spinner-lg" />
          <div>
            <div className="font-bold text-base mb-1">Finding match…</div>
            <div
              className="text-[13px] mb-2"
              style={{ color: "var(--text-secondary)" }}
            >
              Keep this post open. You'll be matched when enough players join.
            </div>
            <div
              className="text-sm font-semibold"
              style={{ color: "var(--accent)" }}
            >
              {queueSize != null ? `${queueSize} player${queueSize === 1 ? "" : "s"} in queue` : "Connecting…"}
            </div>
          </div>
          <button
            onClick={() => cancelQueue()}
            className="px-4 py-2 w-fit"
          >
            Cancel
          </button>
        </div>
      )}

      {phase === "room" && roomState?.status === "ended" && (
        <GameOverView
          roomState={roomState}
          onPlayAgain={leaveRoom}
        />
      )}

      {/* ── Active Game Room ── */}
      {phase === "room" && roomState?.status !== "ended" && (
        <div className="room-stage animate-fade-in">
          {/* Split layout: scrollable gameplay region + persistent guess action bar. */}
          <div className="room-layout">

            {/* Left Column: Game Area */}
            <div className="room-main flex flex-col min-h-0 gap-2">

            {/* Round Info Bar */}
            <div className="room-round-bar flex items-center gap-2.5">
              <div
                className="text-xs"
                style={{ color: "var(--text-secondary)" }}
              >
                Round {roomState?.roundNumber ?? "–"}
                {roomState?.maxRounds ? `/${roomState.maxRounds}` : ""} • Drawer:{" "}
                <b>
                  {roomState?.players?.find(
                    (p) => p.userId === roomState.drawerUserId,
                  )?.userName ?? "—"}
                </b>
              </div>
              <div className="ml-auto text-xs">
                {timerSec != null ? (
                  <span className={timerUrgent ? "animate-timer-pulse font-bold" : ""}>
                    ⏱ <b>{timerSec}s</b>
                  </span>
                ) : null}
              </div>
            </div>

            {/* Word Display */}
            <div
              className="room-word-card card px-3 py-2 text-sm"
              style={{ background: "var(--bg-secondary)" }}
            >
              {isDrawer ? (
                <div>
                  Your word:{" "}
                  <b
                    className="text-base"
                    style={{ color: "var(--accent)" }}
                  >
                    {roomState?.word ?? "..."}
                  </b>
                </div>
              ) : (
                <div>
                  Guess the word:{" "}
                  <b className="tracking-widest text-base">
                    {roomState?.wordMask ?? "..."}
                  </b>
                </div>
              )}
            </div>

            {/* Canvas */}
            <div className="room-canvas-shell">
              <div
                className="room-canvas-frame rounded-xl overflow-hidden"
                style={{
                  border: "1px solid var(--border)",
                  background: "var(--bg-canvas)",
                  boxShadow: "var(--shadow-sm)",
                }}
              >
                <canvas
                  ref={canvasRef}
                  className="w-full h-full block"
                  style={{ touchAction: "none" }}
                  onPointerDown={(e) => {
                    if (!isDrawer) return;
                    if (moveRafRef.current != null) {
                      window.cancelAnimationFrame(moveRafRef.current);
                      moveRafRef.current = null;
                    }
                    pendingPointRef.current = null;
                    (e.currentTarget as any).setPointerCapture?.(e.pointerId);
                    drawingRef.current.isDown = true;
                    strokeIsNewRef.current = true;
                    strokeLastSentRef.current = null;
                    strokeBuf.current = [];
                    const p = canvasPoint(e);
                    drawingRef.current.last = p;
                    queueStrokePoint(p);
                  }}
                  onPointerMove={(e) => {
                    if (!isDrawer) return;
                    if (!drawingRef.current.isDown) return;
                    pendingPointRef.current = canvasPoint(e);
                    if (moveRafRef.current != null) return;
                    moveRafRef.current = window.requestAnimationFrame(() => {
                      moveRafRef.current = null;
                      const p = pendingPointRef.current;
                      if (!p || !drawingRef.current.isDown) return;
                      pendingPointRef.current = null;
                      const last = drawingRef.current.last ?? p;
                      drawingRef.current.last = p;
                      drawStroke([last, p], penColor, penWidth);
                      queueStrokePoint(p);
                    });
                  }}
                  onPointerUp={() => {
                    if (moveRafRef.current != null) {
                      window.cancelAnimationFrame(moveRafRef.current);
                      moveRafRef.current = null;
                    }
                    pendingPointRef.current = null;
                    if (strokeTimer.current != null) {
                      window.clearTimeout(strokeTimer.current);
                      strokeTimer.current = null;
                    }
                    flushStrokeBuffer(true);
                    drawingRef.current.isDown = false;
                    drawingRef.current.last = undefined;
                    strokeLastSentRef.current = null;
                    strokeIsNewRef.current = true;
                  }}
                  onPointerCancel={() => {
                    if (moveRafRef.current != null) {
                      window.cancelAnimationFrame(moveRafRef.current);
                      moveRafRef.current = null;
                    }
                    pendingPointRef.current = null;
                    if (strokeTimer.current != null) {
                      window.clearTimeout(strokeTimer.current);
                      strokeTimer.current = null;
                    }
                    strokeBuf.current = [];
                    drawingRef.current.isDown = false;
                    drawingRef.current.last = undefined;
                    strokeLastSentRef.current = null;
                    strokeIsNewRef.current = true;
                  }}
                />

                {isDrawer && (
                  <div className="room-draw-tools card">
                    <label
                      className="room-tool-row"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      <span>Width</span>
                      <input
                        className="room-width-slider"
                        type="range"
                        min={2}
                        max={10}
                        value={penWidth}
                        onChange={(e) => setPenWidth(Number(e.target.value))}
                      />
                    </label>
                    <label
                      className="room-tool-row"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      <span>Color</span>
                      <input
                        type="color"
                        value={penColor}
                        onChange={(e) => setPenColor(e.target.value)}
                      />
                    </label>
                    <button
                      onClick={() => {
                        if (!roomId) return;
                        strokeLastSentRef.current = null;
                        strokeIsNewRef.current = true;
                        strokeBuf.current = [];
                        if (strokeTimer.current != null) {
                          window.clearTimeout(strokeTimer.current);
                          strokeTimer.current = null;
                        }
                        const c = canvasRef.current;
                        if (c && canvasCtxRef.current) {
                          canvasCtxRef.current.clearRect(0, 0, c.width, c.height);
                        }
                        fetch(`/api/room/${roomId}/clear`, { method: "POST" }).catch(
                          () => setErrorText("Failed to clear canvas.")
                        );
                      }}
                      className="room-clear-btn"
                    >
                      🗑️ Clear
                    </button>
                  </div>
                )}
              </div>
            </div>

            </div>

            {/* Right Column: Sidebar */}
            <aside className="room-sidebar flex flex-col min-h-0 gap-2.5">
            <div className="room-mobile-tabs">
              <button
                type="button"
                className={`room-mobile-tab ${mobilePanel === "chat" ? "active" : ""}`}
                onClick={() => setMobilePanel("chat")}
              >
                Chat
              </button>
              <button
                type="button"
                className={`room-mobile-tab ${mobilePanel === "players" ? "active" : ""}`}
                onClick={() => setMobilePanel("players")}
              >
                Players
              </button>
            </div>

            {/* Players Card */}
            <div
              className={`card p-2.5 ${mobilePanel !== "players" ? "room-panel-hidden-mobile" : ""}`}
            >
              <div className="font-bold text-xs mb-1.5 uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                Players
              </div>
              <div className="grid gap-1.5">
                {(roomState?.players ?? []).map((p) => (
                  <div
                    key={p.userId}
                    className="flex justify-between items-center text-[13px] px-1.5 py-0.5 rounded"
                    style={{
                      background: p.userId === roomState?.drawerUserId ? "var(--accent-soft)" : undefined,
                    }}
                  >
                    <span className={p.userId === roomState?.drawerUserId ? "font-semibold" : ""}>
                      {p.userId === roomState?.drawerUserId ? "🎨 " : ""}
                      {p.userName}
                    </span>
                    <b style={{ color: "var(--accent)" }}>{p.score}</b>
                  </div>
                ))}
              </div>
            </div>

            {/* Chat Card */}
            <div
              className={`room-chat-card card p-2.5 flex-1 min-h-0 flex flex-col ${mobilePanel !== "chat" ? "room-panel-hidden-mobile" : ""}`}
            >
              <div className="font-bold text-xs mb-1.5 uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                Chat
              </div>
              <div className="room-chat-list overflow-auto flex-1 min-h-0 text-xs grid gap-1">
                {chat.map((m, i) => (
                  <div
                    key={i}
                    className={m.correct ? "correct-guess" : ""}
                    style={{
                      color:
                        m.correct
                          ? undefined
                          : m.from === "system"
                          ? "var(--text-muted)"
                          : "var(--text-primary)",
                    }}
                  >
                    <b>{m.from}:</b> {m.text} {m.correct ? "✅" : ""}
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
            </div>
            </aside>
          </div>

          {!isDrawer && (
            <div className="guess-bar">
              <input
                value={guess}
                onChange={(e) => setGuess(e.target.value)}
                placeholder="Type your guess..."
                className="guess-bar-input"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void sendGuess();
                }}
              />
              <button
                onClick={() => void sendGuess()}
                disabled={!canGuess}
                className="btn-primary guess-bar-btn"
              >
                Guess
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );

  return ui;
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
