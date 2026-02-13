# Scroodle — Claude Code Action Plan

## Context for Claude Code

You are working on `K:\scroodle`, a Devvit Web 0.12.12 multiplayer draw-and-guess game (Scribble clone). The architecture is:

- **Server**: Express app (`src/server/index.ts`) bundled to CJS via Vite SSR → `dist/server/index.cjs`
- **Client**: React 19 app (`src/client/main.tsx`) bundled via Vite → `dist/client/index.html`
- **Shared**: Protocol types (`src/shared/protocol.ts`)
- **Realtime**: Devvit pub/sub via `connectRealtime` from `@devvit/web/client`, `realtime.send` from `@devvit/web/server`
- **State**: Redis via `@devvit/web/server`

Read `AGENTS.md` before making any changes. It contains invariants that must never be violated.

---

## PHASE 0: Build Fix (DO THIS FIRST)

### 0.1 — Fix `@shared` path alias in both Vite configs

**Problem**: `tsconfig.json` defines `"@shared/*": ["src/shared/*"]` but neither Vite config has `resolve.alias` or `vite-tsconfig-paths`. Vite does NOT read tsconfig paths by default. If the build currently works, it's by accident (possibly the bundler is falling back). This is fragile and will break.

**Fix** (pick ONE approach):

**Option A — `vite-tsconfig-paths` plugin (recommended, less maintenance):**
```bash
npm install -D vite-tsconfig-paths
```

Then add to BOTH `vite.client.config.ts` and `vite.server.config.ts`:
```ts
import tsconfigPaths from 'vite-tsconfig-paths';
// add to plugins array:
plugins: [tsconfigPaths()]
```

**Option B — Manual `resolve.alias` in both configs:**
```ts
import path from 'node:path';
// add to config:
resolve: {
  alias: {
    '@shared': path.resolve(__dirname, 'src/shared'),
  },
},
```

**Verify**: `npm run build` succeeds cleanly after this change.

---

## PHASE 1: Critical Gameplay Bugs

### 1.1 — Timer countdown doesn't self-update

**Problem**: The timer display in the room view computes remaining time inline:
```tsx
{Math.ceil((roomState.roundEndsAt - Date.now()) / 1000)}s
```
This only re-renders when other state changes trigger re-renders (incidentally via the 1s heartbeat interval). The `timeLeft` useMemo is declared but never actually used in the JSX.

**Fix**: Add a dedicated `[tick, setTick]` state that increments every second to force re-renders:
```tsx
const [tick, setTick] = useState(0);
useEffect(() => {
  if (phase !== 'room' || !roomState?.roundEndsAt) return;
  const id = setInterval(() => setTick(t => t + 1), 1000);
  return () => clearInterval(id);
}, [phase, roomState?.roundEndsAt]);

const secondsLeft = roomState?.roundEndsAt
  ? Math.max(0, Math.ceil((roomState.roundEndsAt - Date.now()) / 1000))
  : null;
```
Then use `secondsLeft` in the JSX. Remove the unused `timeLeft` useMemo.

### 1.2 — Round ends on FIRST correct guess (no multi-guesser scoring)

**Problem**: In `server/index.ts`, the `/api/room/:roomId/guess` endpoint calls `advanceOrEndRound` immediately on the first correct guess. In skribbl.io-style games, ALL non-drawers should get a chance to guess, with faster guessers getting more points.

**Fix**: Instead of ending the round immediately on correct guess:
1. Score based on time remaining (faster = more points). Example: `Math.ceil((roomState.roundEndsAt - Date.now()) / 1000)` as bonus points.
2. Mark the guesser as "correct" and stop accepting their guesses, but keep the round open.
3. End the round when ALL guessers have guessed correctly OR time expires.
4. Broadcast a `correct-guess` message type (not the word itself) so other players see someone guessed it without revealing the answer.

This is a significant game feel improvement. The current behavior means a 4-player game has almost no competitive tension — whoever types fastest wins every round.

**Server changes needed**:
- New message type in `protocol.ts`: `{ type: "correct-guess"; userId: string; userName: string }`
- Modify guess endpoint: don't call `advanceOrEndRound` on first correct. Instead, check if all non-drawer players have guessed correctly.
- Adjust scoring: time-based bonus (e.g., `Math.max(1, Math.ceil(timeLeftSec / 10))` multiplied by base 10)
- Drawer gets points per correct guesser (e.g., +3 per correct guess, not just one flat +3)

**Client changes needed**:
- Handle `correct-guess` message: show green highlight for that player, system message "X guessed the word!"
- Hide the guess input for a player who already guessed correctly
- Show how many players have guessed correctly (e.g., "2/3 guessed")

### 1.3 — No realtime reconnection logic

**Problem**: If the realtime connection drops (common on mobile, tab backgrounding, network blips), the user sees "Realtime disconnected" with no recovery path except leaving and rejoining.

**Fix**: Add exponential backoff reconnection in `connectRoom`:
```ts
async function connectWithRetry(channel: string, roomId: string, attempt = 0) {
  const maxAttempts = 5;
  const delay = Math.min(1000 * 2 ** attempt, 10000);
  try {
    await connectRoom(channel, roomId);
  } catch {
    if (attempt < maxAttempts) {
      setTimeout(() => connectWithRetry(channel, roomId, attempt + 1), delay);
    } else {
      setErrorText("Connection lost. Please leave and rejoin.");
    }
  }
}
```
Also: on `onDisconnect`, auto-attempt reconnect instead of just showing error.

### 1.4 — Canvas not replayed on reconnect/late join

**Problem**: If a player joins mid-round or reconnects, the canvas is blank. All draw strokes are fire-and-forget over realtime — there's no stroke history.

**Fix**: Accept that mid-round joiners see partial canvas for now. This is what skribbl.io actually does. Document full stroke replay as a stretch goal.

---

## PHASE 2: UX / Game Feel (High Impact)

### 2.1 — Progressive word hints

**Problem**: Guessers only see `____` for the entire round. In skribbl.io, letters are progressively revealed (e.g., at 66% time, 33% time).

**Fix**:
- Server: at intervals (e.g., 1/3 and 2/3 through the round), reveal random letters in the mask.
- Broadcast updated `wordMask` via `room-state` messages at those times.
- Or: include `revealedIndices` in room state and let client compute the mask.

**Implementation**: Add a check in the `mm-sweep` cron or the client's advance call:
```ts
function dynamicMask(word: string, roundEndsAt: number, roundDurationMs: number): string {
  const elapsed = roundDurationMs - (roundEndsAt - Date.now());
  const fraction = elapsed / roundDurationMs;
  const lettersToReveal = Math.floor(word.length * fraction * 0.4); // reveal up to 40%
  // deterministically pick which indices to reveal (seeded by word)
  return masked;
}
```

### 2.2 — Mobile layout is broken

**Problem**: The room view uses `gridTemplateColumns: "1fr 260px"` — this will overflow or be unreadable on mobile (Reddit's webview on phones).

**Fix**: 
- Use a responsive layout: stack vertically on screens < 600px wide.
- Canvas should be ~square (aspect-ratio: 1) and take full width on mobile.
- Players panel and chat collapse into a tabbed bottom panel on mobile.
- Use CSS media queries or a `useMediaQuery` hook.

This is CRITICAL for Reddit — most Reddit users are on mobile.

### 2.3 — Color palette instead of color picker

**Problem**: The HTML `<input type="color">` picker is clunky, especially on mobile/in an iframe.

**Fix**: Replace with a row of preset color swatches (8-12 colors typical for drawing games):
```
#000000 #FFFFFF #FF0000 #FF8800 #FFFF00 #00CC00 #0000FF #8800FF #FF69B4 #8B4513 #808080 #00FFFF
```
Clicking a swatch sets `penColor`. Keep the color picker as a "custom" option if desired.

### 2.4 — Brush size presets

**Problem**: The range slider for brush width is functional but slow. Drawing games benefit from quick toggling.

**Fix**: 3-4 preset buttons (Small: 2, Medium: 5, Large: 10, XL: 20) in addition to or replacing the slider.

### 2.5 — Eraser tool

**Problem**: No eraser. The only option is "Clear" which wipes everything.

**Fix**: Add an eraser that draws in white (`#FFFFFF`). Toggle between pen and eraser mode.

### 2.6 — "Game Over" screen with results

**Problem**: When the game ends, `status: "ended"` but there's no distinct game-over UI.

**Fix**: Render a game-over overlay when `roomState.status === "ended"`:
- Final scores with ranking (1st, 2nd, 3rd)
- "Play Again" button → back to matchmaking
- MVP display for top scorer

### 2.7 — Near-miss guess detection

**Problem**: Typing "mountan" when the word is "mountain" gives no feedback.

**Fix**: Server-side Levenshtein distance check. If edit distance ≤ 2 (and word length > 4), send "close guess" system message to that player only via their personal channel.

---

## PHASE 3: Code Quality & Reliability

### 3.1 — Remove dead code

- `setRoomConn()` is a no-op stub — remove it and all calls
- `timeLeft` useMemo is unused — remove (replaced by tick-based timer)

### 3.2 — Server-side round timer enforcement

**Problem**: Round advancement relies on a client calling `/api/room/:roomId/advance`. If all clients disconnect, the round never advances.

**Fix**: The `mm-sweep` cron should also check for rooms with expired `roundEndsAt` and advance them:
```ts
const idx = await loadRoomIndex(postId);
const now = Date.now();
for (const roomId of Object.keys(idx)) {
  const room = await loadRoom(postId, roomId);
  if (!room || room.status !== 'playing') continue;
  if (room.roundEndsAt && now >= room.roundEndsAt && !room.roundResolvedAt) {
    room.roundResolvedAt = now;
    await realtime.send(roomChannel(postId, roomId), { type: 'round-ended', reason: 'time' });
    await advanceOrEndRound(postId, room);
  }
}
```

### 3.3 — Race condition on guess scoring

**Problem**: Two players guessing at nearly the same time could both pass the `roundResolvedAt` check.

**Fix**: Use Redis `watch`/`multi` on the room key for the scoring path, or use `SETNX` with TTL as a lock.

### 3.4 — Decompose the monolithic client (incremental)

Extract one component at a time, build-test between each:
```
src/client/
  components/
    Header.tsx
    MenuScreen.tsx
    QueueScreen.tsx
    RoomView.tsx
    Canvas.tsx
    DrawingTools.tsx
    ChatPanel.tsx
    PlayersPanel.tsx
    GameOverScreen.tsx
    Timer.tsx
  hooks/
    useRealtime.ts
    useGameState.ts
    useDrawing.ts
  lib/
    api.ts
    canvas.ts
```

---

## PHASE 4: Polish & Stretch

### 4.1 — Sound effects
Lightweight SFX for: match found, correct guess, round end, game over. Web Audio API, mute toggle. No `eval()` (CSP).

### 4.2 — Word difficulty categories
Expand word list with easy/medium/hard tiers. Escalate difficulty per round.

### 4.3 — Drawing undo
Store strokes as array, "Undo" removes last stroke and redraws.

### 4.4 — Spectator mode
Users who join a full room can watch but not guess.

---

## Execution Order

```
1.  Phase 0.1  — Fix Vite alias (5 min)
2.  Phase 1.1  — Fix timer display (10 min)
3.  Phase 3.1  — Remove dead code (5 min)
4.  Phase 2.2  — Mobile responsive layout (30 min, CRITICAL)
5.  Phase 2.3  — Color palette (15 min)
6.  Phase 2.4  — Brush size presets (10 min)
7.  Phase 2.5  — Eraser tool (10 min)
8.  Phase 1.2  — Multi-guesser scoring (45 min, biggest gameplay win)
9.  Phase 2.1  — Progressive word hints (30 min)
10. Phase 2.6  — Game over screen (20 min)
11. Phase 2.7  — Near-miss detection (20 min)
12. Phase 3.2  — Server-side round timer (15 min)
13. Phase 3.4  — Component decomposition (60 min, incremental)
14. Phase 1.3  — Reconnection logic (30 min)
15. Phase 3.3  — Race condition fix (20 min)
16. Phase 4.*  — Stretch goals as time permits
```

## Critical Rules

1. **Always `npm run build` after changes.** Fix failures before moving on.
2. **Never change `devvit.json` server.entry or output paths** without playtest verification.
3. **Realtime channel names**: letters, numbers, underscores ONLY.
4. **CSP**: No `eval()`, no `new Function()`, no dynamic string execution.
5. **All game logic is server-authoritative.** Never trust client claims.
6. **Keep `protocol.ts` in sync** with any new message types.
7. **Read `AGENTS.md`** for the full invariant list before touching game logic.
