# AGENTS.md - Scroodle Engineering Operating System

This document is the source of truth for any human, LLM, or multi-agent team working in this repository.

Goal: ship a polished, stable, realtime multiplayer draw-and-guess game on Reddit Devvit Web with production-grade behavior under hackathon timelines.

---

## 1) Project Identity

- Product name: `Scroodle`
- Platform: Devvit Web `0.12.12`
- Game type: Scribble-style realtime drawing + guessing
- Player model: `2-4` players per room
- Top priority: correctness, fairness, reliability, and "fun per minute"

---

## 2) Non-Negotiable Truths (Devvit 0.12.12)

1. Devvit Web architecture is request/response + realtime pub/sub. No websockets, no streaming endpoints.
2. Client subscribes with `connectRealtime` via `@devvit/web/client`. It returns synchronously (not a Promise). It is a singleton per channel name.
3. Server sends with `realtime.send(channel, msg)` via `@devvit/web/server`.
4. Realtime channel names must contain only letters, numbers, and underscores (validated by SDK).
5. `connectRealtime` has **no built-in reconnection**. Our `src/client/index.ts` wrapper handles reconnection with exponential backoff.
6. Menu/form internal endpoints must return valid `UiResponse` shapes (`showToast`, `navigateTo`, `showForm`, etc.), not arbitrary JSON like `{ ok: true }`.
7. CSP in Reddit webview blocks `unsafe-eval`; never rely on dynamic string eval patterns.
8. Keep all authority on server: scoring, role validation, round transitions, match creation.
9. Redis is the game state backbone; all state mutations should be idempotent and concurrency-aware. Redis supports hashes (`hSet`/`hGet`), sorted sets, and transactions (`watch`/`multi`/`exec`).

---

## 3) Runtime and Build Requirements

- Node: `22.x`
- Install: `npm install`
- Build: `npm run build`
- Upload: `npm run devvit:upload` (builds then uploads)
- Playtest: `npm run devvit:playtest` (builds then starts playtest)
- Preview: `npm run devvit:preview`

Current repository build outputs:

- Client: `dist/client/index.html`
- Server: `dist/server/index.cjs`

The `devvit.json` server config omits `dir` (defaults to `dist/server`) and sets `entry` to `index.cjs`. This is correct per the 0.12.12 schema.

---

## 4) File Responsibilities

- `src/server/index.ts`
  - all HTTP/internal endpoints
  - matchmaking with atomic queue operations (watch/multi/exec)
  - room lifecycle and scoring
  - realtime broadcast
  - Redis state ownership

- `src/client/main.tsx`
  - UI state machine (`init/menu/queue/room/ended`)
  - realtime subscription wiring
  - canvas interaction, chat, local UX
  - queue polling and player interactions
  - ErrorBoundary for crash resilience

- `src/client/index.ts`
  - realtime connection wrapper with auto-reconnection (exponential backoff)
  - wraps `@devvit/web/client` `connectRealtime`/`disconnectRealtime`

- `src/shared/protocol.ts`
  - cross-boundary message and response contracts
  - must be kept aligned with actual server/client behavior

- `src/client/style.css`
  - global styles, button themes, animations
  - responsive layout breakpoints for room view

- `devvit.json`
  - app metadata and deployment contract
  - permissions, menu, forms, cron, triggers, settings

---

## 5) Core Game Invariants

All contributors must preserve these invariants:

1. A user can be in at most one room for a given post.
2. Only the current drawer may draw.
3. Drawer cannot guess.
4. A round can only resolve once.
5. `roundsPerGame` is enforced; game must end.
6. Room state, score, and transitions are server-authoritative.
7. On room end/delete, user-room mappings are cleaned.
8. Matchmaking is per post context.

If a change risks any invariant, stop and redesign before shipping.

---

## 6) Endpoint Contract Rules

### Internal endpoints (`/internal/...`)

- Triggers/menu/forms/cron/settings validators.
- Must return schema-valid internal responses.
- Menu/forms should return `UiResponse` UX actions.

### Public game endpoints (`/api/...`)

- Commands + queries for runtime gameplay.
- Inputs validated server-side.
- Errors should be explicit and consumable by client UX.

Never leak private game data to unauthorized clients (e.g., drawer word).

---

## 7) Realtime Protocol Rules

- Use typed messages from `src/shared/protocol.ts`.
- Broadcast only JSON-safe payloads.
- Treat message handlers as untrusted input on client.
- Keep messages small and frequent (draw points throttled).
- If adding a new message type:
  1) update protocol types
  2) update server emitter
  3) update client handler
  4) add failure-safe default behavior

---

## 8) Production Engineering Standards

### Correctness

- Prefer explicit checks over implicit assumptions.
- Make round transitions idempotent.
- Keep leave/disconnect cleanup robust and repeatable.

### Reliability

- Add logging around key transitions:
  - queue join
  - match created
  - round started/ended
  - room ended/deleted
  - cron sweep/gc actions

### Concurrency

- All read-modify-write state mutations use Redis `watch`/`multi`/`exec` transactions with retry loops.
- Queue, user-room mapping, and ping heartbeat are all atomic.
- Avoid broad refactors near deadline unless they reduce high-severity risk.

### Security

- Never trust client role claims.
- Never allow non-members to mutate room state.
- Never expose secrets or internal salts in logs.

---

## 9) UX and Fun-Factor Standards

Minimum UX bar:

- clear loading states
- visible error/recovery states
- no silent failures
- reconnect-friendly behavior
- queue confidence (`queueSize`, status)
- clear round transitions

Fun-factor expectations:

- frequent positive feedback (chat/system cues, score movement)
- predictable pacing (round timing, queue progression)
- fairness first, spectacle second

Audio direction (stretch goal, not yet implemented):

- lightweight SFX for match found, correct guess, round end
- mute/toggle capability
- never block gameplay if audio fails

---

## 10) "No Placeholder" Rule

Do not ship placeholder stubs for declared capabilities unless explicitly marked as deferred in a release note.

If `devvit.json` declares:

- scheduler tasks,
- forms,
- menu actions,
- triggers,

then endpoints must perform meaningful, safe behavior.

---

## 11) QA/QC Gate Before Upload

Every significant change must pass:

1. `npm run build`
2. playtest with at least two users/browsers
3. menu flow test (create game post)
4. matchmaking test (2 players join and match)
5. role enforcement test:
   - non-drawer draw blocked
   - drawer guess blocked
6. round transition test:
   - timer expiry advance
   - correct guess advance
   - no double score on racey inputs
7. leave/rejoin cleanup test
8. room end test after final round

If any gate fails, block release.

---

## 12) 3-Day Deadline Strategy

Prioritize this order:

1. Integrity and exploit prevention
2. State cleanup and reliability
3. Playtest resilience and observability
4. UX polish and fun boosts
5. Stretch features only after the above are green

Avoid rewriting architecture this late.
Ship targeted, reversible improvements.

---

## 13) Multi-Agent Collaboration Protocol

When multiple agents work in this repo:

1. Read this file first.
2. Read affected files before editing.
3. Produce minimal diffs.
4. Do not revert unrelated changes.
5. Maintain protocol compatibility.
6. Run build checks after edits.
7. Report:
   - what changed
   - why it changed
   - risks
   - manual test steps

---

## 14) Creative Direction for Agents

Agents should demonstrate advanced technical execution and high creativity:

- Design systems that feel delightful, not just functional.
- Propose imaginative but feasible mechanics.
- Balance novelty with reliability.
- Never sacrifice fairness for flashy behavior.
- Treat user trust and gameplay integrity as core product features.

Scroodle should feel like:

- instant to understand,
- hard to put down,
- reliable under stress,
- unmistakably realtime.
