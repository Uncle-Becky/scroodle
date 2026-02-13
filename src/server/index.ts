import {
    context,
    createServer,
    getServerPort,
    realtime,
    reddit,
    redis,
    settings,
} from "@devvit/web/server";
import type {
    SettingsValidationRequest,
    SettingsValidationResponse,
    UiResponse,
} from "@devvit/web/shared";
import type {
    IdentityResponse,
    MatchmakingJoinResponse,
    RealtimeMessage,
    RoomPublicState,
    SessionBootstrapResponse,
} from "@shared/protocol";
import type { Request, Response } from "express";
import express from "express";

type Player = {
  userId: string;
  userName: string;
  score: number;
  lastSeen: number;
};

type RoomState = {
  roomId: string;
  status: "waiting" | "playing" | "ended";
  createdAt: number;
  updatedAt: number;
  players: Record<string, Player>;
  order: string[];
  roundNumber: number;
  maxRounds: number;
  drawerUserId?: string;
  word?: string;
  roundEndsAt?: number;
  roundResolvedAt?: number;
  guessedCorrectUserIds: string[];
};

type QueueEntry = {
  userId: string;
  userName: string;
  joinedAt: number;
  lastSeen: number;
};

const POSTS_KEY = "scroodle|posts";

const WORDS = [
  "guitar",
  "mountain",
  "river",
  "computer",
  "lantern",
  "nebula",
  "whisper",
  "coffee",
  "dragon",
  "galaxy",
  "pyramid",
  "umbrella",
  "volcano",
  "snowflake",
  "compass",
  "bicycle",
  "backpack",
  "telescope",
  "rainbow",
  "octopus",
  "saxophone",
  "keyboard",
  "sandcastle",
  "waterfall",
  "spaceship",
  "pineapple",
  "sunflower",
  "candle",
  "butterfly",
  "castle",
  "broom",
  "tiger",
  "turtle",
  "lion",
  "elephant",
  "giraffe",
  "zebra",
  "panda",
  "koala",
  "penguin",
  "dolphin",
  "whale",
  "shark",
  "crab",
  "lobster",
  "seahorse",
  "snoo",
  "shoe",
  "sock",
  "glove",
  "hat",
];

// ---------- keying + channels ----------
function safe(s: string): string {
  // Realtime channels allow only letters, numbers, and underscores.
  return s.replace(/[^a-zA-Z0-9_]/g, "_");
}

function k(postId: string, ...parts: string[]): string {
  return ["scroodle", safe(postId), ...parts.map(safe)].join("|");
}

function roomChannel(postId: string, roomId: string): string {
  return safe(`room-${postId}-${roomId}`);
}

function roomStorageKey(postId: string, roomId: string): string {
  // Centralized so transactional and non-transactional code paths reference
  // the exact same Redis key when operating on room state.
  return k(postId, "room", roomId);
}

function userChannel(postId: string, userId: string): string {
  return safe(`u-${postId}-${userId}`);
}

async function getSubredditSettingNumber(
  name: string,
  fallback: number
): Promise<number> {
  const val = await settings.get(name);
  const n = typeof val === "number" ? val : Number(val);
  return Number.isFinite(n) ? n : fallback;
}

// ---------- storage helpers ----------
const MAX_QUEUE_TRANSACTION_RETRIES = 5;

/**
 * Devvit's Redis txn.exec() throws on conflict instead of returning null.
 * This helper catches that and returns null so retry loops work correctly.
 */
async function tryExec(txn: any): Promise<unknown[] | null> {
  try {
    const result = await txn.exec();
    return result;
  } catch (e: any) {
    const msg = e?.details ?? e?.message ?? "";
    if (
      typeof msg === "string" &&
      (msg.includes("transaction failed") || msg.includes("redis: nil"))
    ) {
      return null; // Treat as conflict — caller will retry
    }
    throw e; // Re-throw unexpected errors
  }
}

function parseQueue(raw: string | null | undefined): QueueEntry[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? (data as QueueEntry[]) : [];
  } catch {
    return [];
  }
}

async function loadQueue(postId: string): Promise<QueueEntry[]> {
  const raw = await redis.get(k(postId, "queue"));
  return parseQueue(raw);
}

async function saveQueue(postId: string, queue: QueueEntry[]): Promise<void> {
  await redis.set(k(postId, "queue"), JSON.stringify(queue));
}

/** Atomically upsert user in queue. Retries on conflict. Returns new queue. */
async function queueUpsertAtomic(
  postId: string,
  userId: string,
  userName: string,
  now: number,
  inactiveKickSeconds: number
): Promise<QueueEntry[]> {
  const queueKey = k(postId, "queue");
  const staleCutoff = now - inactiveKickSeconds * 1000;

  for (let attempt = 0; attempt < MAX_QUEUE_TRANSACTION_RETRIES; attempt++) {
    const txn = await redis.watch(queueKey);
    const raw = await redis.get(queueKey);
    let queue = parseQueue(raw).filter((q) => q.lastSeen >= staleCutoff);
    const idx = queue.findIndex((q) => q.userId === userId);
    if (idx >= 0) {
      queue[idx].lastSeen = now;
      queue[idx].userName = userName;
    } else {
      queue.push({ userId, userName, joinedAt: now, lastSeen: now });
    }
    queue.sort((a, b) => a.joinedAt - b.joinedAt);

    await txn.multi();
    await txn.set(queueKey, JSON.stringify(queue));
    const result = await tryExec(txn);
    if (result !== null) return queue;
  }
  // Fallback to non-atomic on retry exhaustion
  let queue = await loadQueue(postId);
  queue = queue.filter((q) => q.lastSeen >= staleCutoff);
  const idx = queue.findIndex((q) => q.userId === userId);
  if (idx >= 0) {
    queue[idx].lastSeen = now;
    queue[idx].userName = userName;
  } else {
    queue.push({ userId, userName, joinedAt: now, lastSeen: now });
  }
  queue.sort((a, b) => a.joinedAt - b.joinedAt);
  await saveQueue(postId, queue);
  return queue;
}

/** Atomically filter stale entries from queue. Returns whether update succeeded. */
async function queueFilterStaleAtomic(
  postId: string,
  staleCutoff: number
): Promise<boolean> {
  const queueKey = k(postId, "queue");
  for (let attempt = 0; attempt < MAX_QUEUE_TRANSACTION_RETRIES; attempt++) {
    const txn = await redis.watch(queueKey);
    const raw = await redis.get(queueKey);
    const queue = parseQueue(raw).filter((q) => q.lastSeen >= staleCutoff);
    await txn.multi();
    await txn.set(queueKey, JSON.stringify(queue));
    const result = await tryExec(txn);
    if (result !== null) return true;
  }
  return false;
}

/** Atomically remove a user from the queue. */
async function queueRemoveUserAtomic(postId: string, userId: string): Promise<void> {
  const queueKey = k(postId, "queue");
  for (let attempt = 0; attempt < MAX_QUEUE_TRANSACTION_RETRIES; attempt++) {
    const txn = await redis.watch(queueKey);
    const raw = await redis.get(queueKey);
    const queue = parseQueue(raw).filter((q) => q.userId !== userId);
    await txn.multi();
    await txn.set(queueKey, JSON.stringify(queue));
    const result = await tryExec(txn);
    if (result !== null) return;
  }
  // Fallback keeps "Cancel" reliable even under heavy contention.
  const queue = (await loadQueue(postId)).filter((q) => q.userId !== userId);
  await saveQueue(postId, queue);
}

/** Atomically pick players and remove from queue if match can start. Returns picked or null. */
async function tryMatchPickAtomic(postId: string): Promise<QueueEntry[] | null> {
  const queueKey = k(postId, "queue");
  const maxPlayers = Math.min(
    4,
    Math.max(2, await getSubredditSettingNumber("maxPlayers", 4))
  );
  const minPlayersToStart = Math.max(
    2,
    await getSubredditSettingNumber("minPlayersToStart", 2)
  );
  const quickStartSeconds = Math.max(
    1,
    await getSubredditSettingNumber("queueQuickStartSeconds", 8)
  );
  const inactiveKickSeconds = Math.max(
    5,
    await getSubredditSettingNumber("inactiveKickSeconds", 20)
  );
  const now = Date.now();
  const staleCutoff = now - inactiveKickSeconds * 1000;

  for (let attempt = 0; attempt < MAX_QUEUE_TRANSACTION_RETRIES; attempt++) {
    const txn = await redis.watch(queueKey);
    const raw = await redis.get(queueKey);
    const queue = parseQueue(raw).filter((q) => q.lastSeen >= staleCutoff);
    if (queue.length < minPlayersToStart) return null;

    const oldestWait = now - queue[0].joinedAt;
    const canStart =
      queue.length >= maxPlayers ||
      (queue.length >= minPlayersToStart &&
        oldestWait >= quickStartSeconds * 1000);
    if (!canStart) return null;

    const picked = queue.slice(0, Math.min(maxPlayers, queue.length));
    const remaining = queue.slice(picked.length);

    await txn.multi();
    await txn.set(queueKey, JSON.stringify(remaining));
    const result = await tryExec(txn);
    if (result !== null) return picked;
  }
  return null;
}

async function loadRoomIndex(postId: string): Promise<Record<string, number>> {
  const raw = await redis.get(k(postId, "rooms"));
  if (!raw) return {};
  try {
    const data = JSON.parse(raw);
    return data && typeof data === "object"
      ? (data as Record<string, number>)
      : {};
  } catch {
    return {};
  }
}

async function saveRoomIndex(
  postId: string,
  idx: Record<string, number>
): Promise<void> {
  await redis.set(k(postId, "rooms"), JSON.stringify(idx));
}

async function loadRoom(
  postId: string,
  roomId: string
): Promise<RoomState | null> {
  const raw = await redis.get(k(postId, "room", roomId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RoomState;
  } catch {
    return null;
  }
}

async function saveRoom(postId: string, room: RoomState): Promise<void> {
  await redis.set(k(postId, "room", room.roomId), JSON.stringify(room));
  const idx = await loadRoomIndex(postId);
  idx[room.roomId] = room.updatedAt;
  await saveRoomIndex(postId, idx);
}

async function deleteRoom(postId: string, roomId: string): Promise<void> {
  await redis.del(k(postId, "room", roomId));
  const idx = await loadRoomIndex(postId);
  delete idx[roomId];
  await saveRoomIndex(postId, idx);
}

async function loadTrackedPosts(): Promise<string[]> {
  const raw = await redis.get(POSTS_KEY);
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

async function saveTrackedPosts(postIds: string[]): Promise<void> {
  await redis.set(POSTS_KEY, JSON.stringify([...new Set(postIds.map(String))]));
}

async function trackPost(postId: string): Promise<void> {
  const posts = await loadTrackedPosts();
  if (!posts.includes(postId)) {
    posts.push(postId);
    await saveTrackedPosts(posts);
  }
}

async function untrackPost(postId: string): Promise<void> {
  const posts = await loadTrackedPosts();
  const next = posts.filter((id) => id !== postId);
  await saveTrackedPosts(next);
}

async function resetLobby(postId: string): Promise<number> {
  const idx = await loadRoomIndex(postId);
  const roomIds = Object.keys(idx);
  await Promise.all(roomIds.map((roomId) => redis.del(k(postId, "room", roomId))));
  await Promise.all([
    redis.del(k(postId, "queue")),
    redis.del(k(postId, "rooms")),
    redis.del(k(postId, "userRooms")),
  ]);
  return roomIds.length;
}

async function setUserRoom(
  postId: string,
  userId: string,
  roomId: string | null
): Promise<void> {
  const key = k(postId, "userRooms");
  for (let attempt = 0; attempt < MAX_QUEUE_TRANSACTION_RETRIES; attempt++) {
    const txn = await redis.watch(key);
    const raw = await redis.get(key);
    let map: Record<string, string> = {};
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object")
          map = parsed as Record<string, string>;
      } catch {}
    }
    if (roomId) map[userId] = roomId;
    else delete map[userId];

    await txn.multi();
    await txn.set(key, JSON.stringify(map));
    const result = await tryExec(txn);
    if (result !== null) return;
  }

  // Fallback when retries are exhausted
  const raw = await redis.get(key);
  let map: Record<string, string> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object")
        map = parsed as Record<string, string>;
    } catch {}
  }
  if (roomId) map[userId] = roomId;
  else delete map[userId];
  await redis.set(key, JSON.stringify(map));
}

async function getUserRoom(
  postId: string,
  userId: string
): Promise<string | null> {
  const raw = await redis.get(k(postId, "userRooms"));
  if (!raw) return null;
  try {
    const map = JSON.parse(raw) as Record<string, string>;
    return map?.[userId] ?? null;
  } catch {
    return null;
  }
}

// ---------- game helpers ----------
async function getWordPool(): Promise<string[]> {
  const raw = await redis.get("scroodle|words|active");
  if (!raw) return WORDS;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return WORDS;
    const words = parsed
      .map((w) => String(w).trim().toLowerCase())
      .filter((w) => w.length >= 3 && w.length <= 24);
    return words.length ? words : WORDS;
  } catch {
    return WORDS;
  }
}

async function pickWord(): Promise<string> {
  const pool = await getWordPool();
  return pool[Math.floor(Math.random() * pool.length)];
}

function maskWord(word: string): string {
  return word.replace(/[A-Za-z]/g, "_");
}

function withRoomDefaults(room: RoomState): RoomState {
  if (!Array.isArray(room.guessedCorrectUserIds)) room.guessedCorrectUserIds = [];
  if (!Number.isFinite(room.maxRounds) || room.maxRounds < 1) room.maxRounds = 3;
  return room;
}

function publicState(room: RoomState, viewerId: string): RoomPublicState {
  const players = Object.values(room.players)
    .sort((a, b) => b.score - a.score)
    .map((p) => ({
      userId: p.userId,
      userName: p.userName,
      score: p.score,
      lastSeen: p.lastSeen,
    }));

  const isDrawer = room.drawerUserId === viewerId;
  const base: RoomPublicState = {
    roomId: room.roomId,
    status: room.status,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    players,
    drawerUserId: room.drawerUserId,
    roundEndsAt: room.roundEndsAt,
    roundNumber: room.roundNumber,
    maxRounds: room.maxRounds,
    wordMask: room.word ? maskWord(room.word) : undefined,
  };

  if (isDrawer) base.word = room.word;
  return base;
}

async function broadcastRoomState(
  postId: string,
  room: RoomState
): Promise<void> {
  const chan = roomChannel(postId, room.roomId);
  // broadcast a generic state without leaking the word (clients can re-fetch if they need the drawer word)
  const msg: RealtimeMessage = {
    type: "room-state",
    state: publicState(room, "not-a-viewer"),
  };
  await realtime.send(chan, msg);
}

function topScores(room: RoomState): string {
  return Object.values(room.players)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((p, i) => `${i + 1}) ${p.userName} ${p.score}`)
    .join(" • ");
}

async function advanceOrEndRound(postId: string, room: RoomState): Promise<void> {
  const chan = roomChannel(postId, room.roomId);
  const now = Date.now();
  if (room.roundNumber >= room.maxRounds) {
    room.status = "ended";
    room.word = undefined;
    room.drawerUserId = undefined;
    room.roundEndsAt = undefined;
    room.roundResolvedAt = now;
    room.updatedAt = now;
    await saveRoom(postId, room);
    await realtime.send(chan, {
      type: "system",
      text: `Game over! ${topScores(room)}`,
    } satisfies RealtimeMessage);
    await broadcastRoomState(postId, room);
    return;
  }

  const roundSeconds = Math.max(
    20,
    await getSubredditSettingNumber("roundTimeSec", 80)
  );
  const idx = room.order.indexOf(room.drawerUserId ?? room.order[0]);
  const nextDrawer = room.order[(idx + 1) % room.order.length];
  room.roundNumber += 1;
  room.drawerUserId = nextDrawer;
  room.word = await pickWord();
  room.roundEndsAt = now + roundSeconds * 1000;
  room.roundResolvedAt = undefined;
  room.guessedCorrectUserIds = [];
  room.updatedAt = now;
  await saveRoom(postId, room);
  await realtime.send(chan, {
    type: "system",
    text: `Round ${room.roundNumber} started.`,
  } satisfies RealtimeMessage);
  await broadcastRoomState(postId, room);
}

async function maybeStartMatchForPost(postId: string): Promise<void> {
  const picked = await tryMatchPickAtomic(postId);
  if (!picked || picked.length === 0) return;
  const now = Date.now();

  const roundSeconds = Math.max(
    20,
    await getSubredditSettingNumber("roundTimeSec", 80)
  );
  const maxRounds = Math.max(
    1,
    await getSubredditSettingNumber("roundsPerGame", 3)
  );
  const roomId = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const order = picked.map((p) => p.userId);
  const room: RoomState = {
    roomId,
    status: "playing",
    createdAt: now,
    updatedAt: now,
    players: Object.fromEntries(
      picked.map((p) => [
        p.userId,
        { userId: p.userId, userName: p.userName, score: 0, lastSeen: p.lastSeen },
      ])
    ),
    order,
    roundNumber: 1,
    maxRounds,
    drawerUserId: order[0],
    word: await pickWord(),
    roundEndsAt: now + roundSeconds * 1000,
    guessedCorrectUserIds: [],
  };

  await saveRoom(postId, room);
  console.log(
    `[match-create] post=${postId} room=${roomId} players=${picked.length} roundTimeSec=${roundSeconds} roundsPerGame=${maxRounds}`
  );
  // Run setUserRoom sequentially to avoid transaction conflicts on the same key
  for (const p of picked) {
    await setUserRoom(postId, p.userId, roomId);
  }
  const chan = roomChannel(postId, roomId);
  await realtime.send(chan, {
    type: "system",
    text: "Match found! Starting round 1.",
  } satisfies RealtimeMessage);
  await broadcastRoomState(postId, room);
  await Promise.all(
    picked.map((p) =>
      realtime.send(userChannel(postId, p.userId), {
        type: "match-found",
        roomId,
        roomChannel: chan,
      } satisfies RealtimeMessage)
    )
  );
}

function ensureContext(): { postId: string; userId: string; userName: string } {
  const postId = context.postId;
  const userId = context.userId;
  const userName = context.username;
  if (!postId)
    throw new Error(
      "Missing postId (request must come from an interactive post)"
    );
  if (!userId) throw new Error("Missing userId (user must be logged in)");
  return { postId, userId, userName: userName ?? userId };
}

// ---------- express app ----------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text());

const router = express.Router();

function ok(res: Response, extra?: Record<string, unknown>) {
  res.json({ ok: true, ...(extra ?? {}) });
}

// ---------- internal endpoints (menu / triggers / scheduler / forms) ----------
router.post("/internal/triggers/post-create", async (_req, res) => {
  if (context.postId) await trackPost(context.postId);
  ok(res);
});
router.post("/internal/triggers/post-delete", async (_req, res) => {
  if (context.postId) {
    await resetLobby(context.postId);
    await untrackPost(context.postId);
  }
  ok(res);
});
router.post("/internal/triggers/app-install", async (_req, res) =>
  ok(res, { installedAt: Date.now() })
);
router.post("/internal/triggers/app-upgrade", async (_req, res) =>
  ok(res, { upgradedAt: Date.now() })
);

router.post(
  "/internal/menu/create-game-post",
  async (_req, res: Response<UiResponse>) => {
    try {
      const subredditName = context.subredditName;
      if (!subredditName) {
        res.json({
          showToast: { text: "Missing subreddit context.", appearance: "neutral" },
        });
        return;
      }

      const post = await reddit.submitCustomPost({
        subredditName,
        title: "Scroodle — New Match",
        entry: "default",
      });

      res.json({
        showToast: { text: "Game post created!" },
        navigateTo: post,
      });
    } catch (e: unknown) {
      console.error("create-game-post failed", e);
      res.json({
        showToast: { text: "Failed to create game post.", appearance: "neutral" },
      });
    }
  }
);

router.post(
  "/internal/menu/reset-lobby",
  async (_req, res: Response<UiResponse>) => {
    try {
      const { postId } = ensureContext();
      const cleared = await resetLobby(postId);
      res.json({
        showToast: {
          text: `Lobby reset. Cleared ${cleared} room(s).`,
          appearance: "success",
        },
      });
    } catch (e: any) {
      res.json({
        showToast: { text: "Failed to reset lobby.", appearance: "neutral" },
      });
    }
  }
);

router.post("/internal/cron/mm-sweep", async (_req, res) => {
  const posts = await loadTrackedPosts();
  const now = Date.now();
  let swept = 0;
  for (const postId of posts) {
    const inactiveKickSeconds = Math.max(
      5,
      await getSubredditSettingNumber("inactiveKickSeconds", 20)
    );
    const staleCutoff = now - inactiveKickSeconds * 1000;
    await queueFilterStaleAtomic(postId, staleCutoff);
    await maybeStartMatchForPost(postId);
    swept += 1;
  }
  ok(res, { sweptPosts: swept });
});

router.post("/internal/cron/room-gc", async (_req, res) => {
  const posts = await loadTrackedPosts();
  let removed = 0;
  const now = Date.now();
  for (const postId of posts) {
    const idx = await loadRoomIndex(postId);
    for (const roomId of Object.keys(idx)) {
      let room = await loadRoom(postId, roomId);
      if (room) room = withRoomDefaults(room);
      if (!room) continue;
      const inactiveForMs = now - room.updatedAt;
      const shouldDelete = room.order.length < 2 || inactiveForMs > 30 * 60 * 1000;
      if (!shouldDelete) continue;
      // Clear user-room mappings sequentially to avoid transaction conflicts
      for (const id of room.order) {
        await setUserRoom(postId, id, null);
      }
      await deleteRoom(postId, roomId);
      removed += 1;
    }
  }
  ok(res, { removedRooms: removed });
});

router.post("/internal/cron/daily-rotate-words", async (_req, res) =>
  (async () => {
    const url = String((await settings.get("wordlistUrl")) ?? "").trim();
    if (!url) {
      ok(res, { rotated: false, source: "default-word-list" });
      return;
    }
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`wordlist fetch ${response.status}`);
      const text = await response.text();
      const words = text
        .split(/\r?\n/)
        .map((w) => w.trim().toLowerCase())
        .filter((w) => /^[a-z][a-z\- ]{2,23}$/.test(w));
      const uniqueWords = [...new Set(words)].slice(0, 5000);
      if (!uniqueWords.length) throw new Error("wordlist empty after filtering");
      await redis.set("scroodle|words|active", JSON.stringify(uniqueWords));
      ok(res, { rotated: true, words: uniqueWords.length });
    } catch (e: any) {
      console.error("daily word rotation failed", e);
      ok(res, { rotated: false, error: String(e?.message ?? "unknown") });
    }
  })()
);

const REPORTS_MAX = 500;

async function appendReport(
  key: string,
  entry: { ts: number; postId?: string; subreddit?: string; [k: string]: unknown }
): Promise<void> {
  const raw = await redis.get(key);
  let list: typeof entry[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    } catch {}
  }
  list.unshift(entry);
  if (list.length > REPORTS_MAX) list = list.slice(0, REPORTS_MAX);
  await redis.set(key, JSON.stringify(list));
}

router.post(
  "/internal/forms/report-word",
  async (req, res: Response<UiResponse>) => {
    try {
      const body = (req.body as Record<string, unknown>) ?? {};
      const word = String(body.word ?? body.value ?? "").trim().slice(0, 80);
      await appendReport("scroodle|reports|words", {
        ts: Date.now(),
        postId: context.postId ?? undefined,
        subreddit: context.subredditName ?? undefined,
        word: word || "(empty)",
        reason: String(body.reason ?? "").slice(0, 200),
      });
      res.json({
        showToast: { text: "Thanks. Word report submitted.", appearance: "success" },
      });
    } catch {
      res.json({
        showToast: { text: "Report failed. Please try again.", appearance: "neutral" },
      });
    }
  }
);
router.post(
  "/internal/forms/report-player",
  async (req, res: Response<UiResponse>) => {
    try {
      const body = (req.body as Record<string, unknown>) ?? {};
      const playerId = String(body.playerId ?? body.player ?? "").trim().slice(0, 64);
      await appendReport("scroodle|reports|players", {
        ts: Date.now(),
        postId: context.postId ?? undefined,
        subreddit: context.subredditName ?? undefined,
        playerId: playerId ? (`t2_${playerId}` as `t2_${string}`) : undefined,
        reason: String(body.reason ?? "").slice(0, 200),
      });
      res.json({
        showToast: { text: "Thanks. Player report submitted.", appearance: "success" },
      });
    } catch {
      res.json({
        showToast: { text: "Report failed. Please try again.", appearance: "neutral" },
      });
    }
  }
);

router.post<
  string,
  never,
  SettingsValidationResponse,
  SettingsValidationRequest<number>
>("/internal/settings/validate-max-players", async (req, res) => {
  const value = Number(req.body?.value);
  if (!Number.isFinite(value)) {
    res.json({
      success: false,
      error: "Value must be a valid number.",
    });
    return;
  }
  if (value < 2 || value > 4) {
    res.json({
      success: false,
      error: "Max players must be between 2 and 4.",
    });
    return;
  }
  res.json({ success: true });
});

router.post<
  string,
  never,
  SettingsValidationResponse,
  SettingsValidationRequest<number>
>("/internal/settings/validate-rounds-per-game", async (req, res) => {
  const value = Number(req.body?.value);
  if (!Number.isFinite(value)) {
    res.json({
      success: false,
      error: "Value must be a valid number.",
    });
    return;
  }
  if (!Number.isInteger(value)) {
    res.json({
      success: false,
      error: "Rounds per game must be a whole number.",
    });
    return;
  }
  if (value < 1 || value > 10) {
    res.json({
      success: false,
      error: "Rounds per game must be between 1 and 10.",
    });
    return;
  }
  res.json({ success: true });
});

// Health / identity
router.get(
  "/api/identity",
  async (_req: Request, res: Response<IdentityResponse>) => {
    try {
      const { postId, userId, userName } = ensureContext();
      res.json({
        postId,
        userId,
        userName,
        subredditName: context.subredditName ?? undefined,
      });
    } catch (e: any) {
      res
        .status(400)
        .json({
          postId: "",
          userId: "",
          userName: "",
          subredditName: undefined,
        } as any);
    }
  }
);

router.get(
  "/api/session",
  async (_req: Request, res: Response<SessionBootstrapResponse>) => {
    const postId = context.postId;
    const userId = context.userId;
    if (!postId || !userId) {
      res.json({ status: "logged-out" });
      return;
    }

    const personalChannel = userChannel(postId, userId);
    const existingRoomId = await getUserRoom(postId, userId);
    if (existingRoomId) {
      let room = await loadRoom(postId, existingRoomId);
      if (room) room = withRoomDefaults(room);
      if (room?.players?.[userId]) {
        res.json({
          status: "matched",
          roomId: existingRoomId,
          roomChannel: roomChannel(postId, existingRoomId),
          personalChannel,
        });
        return;
      }
      // stale mapping from old/deleted room
      await setUserRoom(postId, userId, null);
    }

    const queue = await loadQueue(postId);
    const inQueue = queue.some((q) => q.userId === userId);
    if (inQueue) {
      res.json({
        status: "queued",
        personalChannel,
        queueSize: queue.length,
      });
      return;
    }

    res.json({
      status: "menu",
      personalChannel,
    });
  }
);

// Matchmaking: join queue (one-shot). Client should subscribe to personalChannel.
router.post(
  "/api/matchmaking/join",
  async (_req: Request, res: Response<MatchmakingJoinResponse>) => {
    try {
      const { postId, userId, userName } = ensureContext();

      // If user already in a room, return it.
      const existing = await getUserRoom(postId, userId);
      if (existing) {
        let room = await loadRoom(postId, existing);
        if (room) room = withRoomDefaults(room);
        if (room?.players?.[userId]) {
          res.json({
            status: "matched",
            roomId: existing,
            roomChannel: roomChannel(postId, existing),
            personalChannel: userChannel(postId, userId),
          });
          return;
        }
        await setUserRoom(postId, userId, null);
      }

      await trackPost(postId);
      const now = Date.now();
      const inactiveKickSeconds = Math.max(
        5,
        await getSubredditSettingNumber("inactiveKickSeconds", 20)
      );

      await queueUpsertAtomic(postId, userId, userName, now, inactiveKickSeconds);
      await maybeStartMatchForPost(postId);

      const personalChan = userChannel(postId, userId);

      const updatedRoomId = await getUserRoom(postId, userId);
      if (updatedRoomId) {
        res.json({
          status: "matched",
          roomId: updatedRoomId,
          roomChannel: roomChannel(postId, updatedRoomId),
          personalChannel: personalChan,
        });
      } else {
        res.json({
          status: "queued",
          personalChannel: personalChan,
          queueSize: (await loadQueue(postId)).length,
        });
      }
    } catch (e: any) {
      console.error("matchmaking join failed", e);
      res.status(500).json({ status: "error", message: "Matchmaking failed" } as any);
    }
  }
);

router.post(
  "/api/matchmaking/leave",
  async (_req: Request, res: Response<{ ok: true } | { error: string }>) => {
    try {
      const { postId, userId } = ensureContext();
      await queueRemoveUserAtomic(postId, userId);
      res.json({ ok: true });
    } catch (e: unknown) {
      res.status(400).json({ error: e instanceof Error ? e.message : "Bad request" });
    }
  }
);

// Heartbeat (queued or in-room).
// NOTE: Queue lastSeen is already updated by the matchmaking poll (/api/matchmaking/join).
// We intentionally skip queue key updates here to avoid transaction conflicts.
router.post("/api/ping", async (_req: Request, res: Response<{ ok: true }>) => {
  try {
    const { postId, userId } = ensureContext();
    const now = Date.now();

    // Update room entry if present
    const roomId = await getUserRoom(postId, userId);
    if (roomId) {
      let room = await loadRoom(postId, roomId);
      if (room) room = withRoomDefaults(room);
      if (room?.players?.[userId]) {
        room.players[userId].lastSeen = now;
        room.updatedAt = now;
        await saveRoom(postId, room);
      }
    }
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

// Fetch sanitized room state for this viewer (drawer gets the word)
router.get(
  "/api/room/:roomId/state",
  async (req: Request, res: Response<RoomPublicState | { error: string }>) => {
    try {
      const { postId, userId } = ensureContext();
      const roomId = String(req.params.roomId);
      let room = await loadRoom(postId, roomId);
      if (room) room = withRoomDefaults(room);
      if (!room) {
        res.status(404).json({ error: "Room not found" });
        return;
      }
      if (!room.players[userId]) {
        res.status(403).json({ error: "Not in this room" });
        return;
      }
      res.json(publicState(room, userId));
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Bad request" });
    }
  }
);

// Drawer draws: broadcast to room channel (points normalized 0..1)
router.post(
  "/api/room/:roomId/draw",
  async (req: Request, res: Response<{ ok: true } | { error: string }>) => {
    try {
      const { postId, userId } = ensureContext();
      const roomId = String(req.params.roomId);
      let room = await loadRoom(postId, roomId);
      if (room) room = withRoomDefaults(room);
      if (!room) return res.status(404).json({ error: "Room not found" });
      if (room.drawerUserId !== userId)
        return res.status(403).json({ error: "Not the drawer" });

      const body = req.body as any;
      const points = Array.isArray(body?.points)
        ? (body.points as Array<[number, number]>)
        : [];
      const rawColor = typeof body?.color === "string" ? body.color : "#111";
      const color = /^#[0-9a-fA-F]{3,8}$/.test(rawColor) ? rawColor : "#111";
      const rawWidth = typeof body?.width === "number" ? body.width : 3;
      const width = Math.max(2, Math.min(10, rawWidth));
      const newStroke = body?.newStroke === true;
      const endStroke = body?.endStroke === true;

      // small sanity checks
      const clipped = points
        .slice(0, 64)
        .map(
          ([x, y]) =>
            [
              Math.max(0, Math.min(1, Number(x))),
              Math.max(0, Math.min(1, Number(y))),
            ] as [number, number]
        );

      if (clipped.length >= 2 || endStroke) {
        const msg: RealtimeMessage = {
          type: "draw",
          from: userId,
          points: clipped,
          color,
          width,
          ...(newStroke ? { newStroke: true } : {}),
          ...(endStroke ? { endStroke: true } : {}),
        };
        await realtime.send(roomChannel(postId, roomId), msg);
      }

      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Bad request" });
    }
  }
);

// Drawer clears canvas: broadcast to room channel
router.post(
  "/api/room/:roomId/clear",
  async (req: Request, res: Response<{ ok: true } | { error: string }>) => {
    try {
      const { postId, userId } = ensureContext();
      const roomId = String(req.params.roomId);
      let room = await loadRoom(postId, roomId);
      if (room) room = withRoomDefaults(room);
      if (!room) return res.status(404).json({ error: "Room not found" });
      if (room.drawerUserId !== userId)
        return res.status(403).json({ error: "Not the drawer" });

      await realtime.send(roomChannel(postId, roomId), {
        type: "canvas-clear",
        from: userId,
      } satisfies RealtimeMessage);

      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Bad request" });
    }
  }
);

// Guess: broadcast chat; if correct, score + end round + start next round
router.post(
  "/api/room/:roomId/guess",
  async (req: Request, res: Response<{ ok: true } | { error: string }>) => {
    try {
      const { postId, userId, userName } = ensureContext();
      const roomId = String(req.params.roomId);
      let room = await loadRoom(postId, roomId);
      if (room) room = withRoomDefaults(room);
      if (!room) return res.status(404).json({ error: "Room not found" });
      if (!room.players[userId])
        return res.status(403).json({ error: "Not in this room" });
      if (room.drawerUserId === userId)
        return res.status(403).json({ error: "Drawer cannot guess" });
      if (room.status !== "playing") return res.status(400).json({ error: "Game ended" });

      const textRaw =
        typeof (req.body as any)?.text === "string"
          ? (req.body as any).text
          : "";
      const text = textRaw.trim().slice(0, 80);
      if (!text) return res.json({ ok: true });

      const chan = roomChannel(postId, roomId);

      const isCorrect =
        typeof room.word === "string" && text.toLowerCase() === room.word.toLowerCase()
          ? true
          : false;

      // Ensure the message is pure JSON for realtime.send (avoid undefined values)
      const chatMsg: RealtimeMessage = {
        type: "chat",
        from: userName,
        text,
        ...(isCorrect ? { correct: true } : {}),
      };
      await realtime.send(chan, chatMsg);

      if (!isCorrect) {
        res.json({ ok: true });
        return;
      }
      const key = roomStorageKey(postId, roomId);
      let resolvedRoom: RoomState | null = null;
      for (let attempt = 0; attempt < MAX_QUEUE_TRANSACTION_RETRIES; attempt++) {
        // Optimistic locking ensures only one concurrent request can resolve the
        // round and award points for this room snapshot.
        const txn = await redis.watch(key);
        let latestRoom = await loadRoom(postId, roomId);
        if (latestRoom) latestRoom = withRoomDefaults(latestRoom);
        if (!latestRoom) return res.status(404).json({ error: "Room not found" });
        if (!latestRoom.players[userId])
          return res.status(403).json({ error: "Not in this room" });
        if (latestRoom.drawerUserId === userId)
          return res.status(403).json({ error: "Drawer cannot guess" });
        if (latestRoom.status !== "playing") {
          res.json({ ok: true });
          return;
        }
        if (latestRoom.roundResolvedAt) {
          res.json({ ok: true });
          return;
        }

        if (!latestRoom.guessedCorrectUserIds) latestRoom.guessedCorrectUserIds = [];
        if (latestRoom.guessedCorrectUserIds.includes(userId)) {
          res.json({ ok: true });
          return;
        }

        // Award points to guesser and drawer (simple scoring)
        latestRoom.roundResolvedAt = Date.now();
        latestRoom.updatedAt = latestRoom.roundResolvedAt;
        latestRoom.guessedCorrectUserIds.push(userId);
        latestRoom.players[userId].score += 10;
        if (latestRoom.drawerUserId && latestRoom.players[latestRoom.drawerUserId]) {
          latestRoom.players[latestRoom.drawerUserId].score += 3;
        }

        await txn.multi();
        await txn.set(key, JSON.stringify(latestRoom));
        const result = await tryExec(txn);
        if (result === null) continue;
        resolvedRoom = latestRoom;
        break;
      }

      if (!resolvedRoom) {
        // Conflict-heavy contention path: let next client poll/timer resolve naturally.
        res.json({ ok: true });
        return;
      }

      // End round early and start next.
      await realtime.send(chan, {
        type: "round-ended",
        reason: "guessed",
      } satisfies RealtimeMessage);
      await advanceOrEndRound(postId, resolvedRoom);

      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Bad request" });
    }
  }
);

// Round advance (called by clients when timer expires; server verifies time)
router.post(
  "/api/room/:roomId/advance",
  async (req: Request, res: Response<{ ok: true } | { error: string }>) => {
    try {
      const { postId, userId } = ensureContext();
      const roomId = String(req.params.roomId);
      let room = await loadRoom(postId, roomId);
      if (room) room = withRoomDefaults(room);
      if (!room) return res.status(404).json({ error: "Room not found" });
      if (!room.players[userId])
        return res.status(403).json({ error: "Not in this room" });
      if (room.status !== "playing") return res.json({ ok: true });
      const key = roomStorageKey(postId, roomId);
      let resolvedRoom: RoomState | null = null;
      for (let attempt = 0; attempt < MAX_QUEUE_TRANSACTION_RETRIES; attempt++) {
        // Multiple clients may hit timer expiry simultaneously; transaction retries
        // prevent duplicate round advancement.
        const txn = await redis.watch(key);
        let latestRoom = await loadRoom(postId, roomId);
        if (latestRoom) latestRoom = withRoomDefaults(latestRoom);
        if (!latestRoom) return res.status(404).json({ error: "Room not found" });
        if (!latestRoom.players[userId])
          return res.status(403).json({ error: "Not in this room" });
        if (latestRoom.status !== "playing") {
          res.json({ ok: true });
          return;
        }
        if (latestRoom.roundResolvedAt) {
          res.json({ ok: true });
          return;
        }

        const now = Date.now();
        if (latestRoom.roundEndsAt && now < latestRoom.roundEndsAt) {
          res.json({ ok: true });
          return;
        }

        latestRoom.roundResolvedAt = now;
        latestRoom.updatedAt = now;

        await txn.multi();
        await txn.set(key, JSON.stringify(latestRoom));
        const result = await tryExec(txn);
        if (result === null) continue;
        resolvedRoom = latestRoom;
        break;
      }

      if (!resolvedRoom) {
        res.json({ ok: true });
        return;
      }

      const chan = roomChannel(postId, roomId);
      await realtime.send(chan, {
        type: "round-ended",
        reason: "time",
      } satisfies RealtimeMessage);
      await advanceOrEndRound(postId, resolvedRoom);

      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Bad request" });
    }
  }
);

// Leave room
router.post(
  "/api/room/:roomId/leave",
  async (req: Request, res: Response<{ ok: true } | { error: string }>) => {
    try {
      const { postId, userId, userName } = ensureContext();
      const roomId = String(req.params.roomId);
      let room = await loadRoom(postId, roomId);
      if (room) room = withRoomDefaults(room);
      if (!room) {
        await setUserRoom(postId, userId, null);
        return res.json({ ok: true });
      }

      delete room.players[userId];
      room.order = room.order.filter((id) => id !== userId);
      room.updatedAt = Date.now();

      await setUserRoom(postId, userId, null);

      const chan = roomChannel(postId, roomId);
      await realtime.send(chan, {
        type: "system",
        text: `${userName} left the room.`,
      } satisfies RealtimeMessage);

      if (room.order.length < 2) {
        await realtime.send(chan, {
          type: "round-ended",
          reason: "left",
        } satisfies RealtimeMessage);
        await realtime.send(chan, {
          type: "system",
          text: "Not enough players. Room ended.",
        } satisfies RealtimeMessage);
        // Clear user-room mappings sequentially to avoid transaction conflicts
        for (const id of room.order) {
          await setUserRoom(postId, id, null);
        }
        await deleteRoom(postId, roomId);
      } else {
        if (room.drawerUserId === userId && room.status === "playing") {
          // Drawer left mid-round: end current round and advance properly
          await realtime.send(chan, {
            type: "round-ended",
            reason: "left",
          } satisfies RealtimeMessage);
          room.roundResolvedAt = Date.now();
          await advanceOrEndRound(postId, room);
        } else {
          await saveRoom(postId, room);
          await broadcastRoomState(postId, room);
        }
      }

      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Bad request" });
    }
  }
);

app.use(router);

const port = getServerPort();
const server = createServer(app);
server.on("error", (err) => console.error(`server error; ${err.stack}`));
server.listen(port, () => console.log(`http://localhost:${port}`));
