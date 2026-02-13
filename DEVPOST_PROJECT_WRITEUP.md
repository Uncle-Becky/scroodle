# Scroodle - Devpost Project Writeup

## Inspiration

We wanted to prove that Reddit can host a genuinely fun realtime multiplayer game inside a post, not just a turn-based toy. Drawing and guessing is instantly understandable, social by nature, and perfect for community participation. The idea behind Scroodle was simple: create the first "jump in and play now" draw-and-guess experience that feels native to Reddit communities.

We were also inspired by the constraint itself. Devvit Web does not give us traditional sockets in the way many game stacks do, so building a smooth realtime loop under those constraints felt like a meaningful technical challenge.

## What it does

Scroodle is a realtime multiplayer draw-and-guess game for Reddit:

- 2-4 players are matched into a room per post.
- One player is the drawer each round and gets the secret word.
- Other players guess in chat while watching the canvas update live.
- Correct guesses end the round early and award points.
- After the configured number of rounds, the game ends and shows final rankings.

Key gameplay details:

- Server-authoritative scoring and round progression
- Realtime stroke sync across clients
- Round timer with automatic advancement
- Mobile-friendly UI with tabbed chat/players and persistent guess action

## How I built it

Scroodle is built on Devvit Web (`0.12.12`) with a thin, reliable architecture:

- **Client:** React + TypeScript + Canvas API + perfect-freehand
- **Server:** Express handlers running in Devvit Web server runtime
- **State:** Redis for matchmaking queue, room state, and user-room mapping
- **Realtime:** Devvit realtime channels (`connectRealtime` + `realtime.send`)
- **Contracts:** Shared protocol types in `src/shared/protocol.ts`

Major system design decisions:

1. Keep all authority on the server (scoring, round transitions, role checks).
2. Use typed realtime messages to keep client/server behavior aligned.
3. Treat room lifecycle and matchmaking as transactional operations where possible.
4. Prioritize mobile gameplay ergonomics (canvas real estate, sticky guess action, compact UI).

## Challenges I ran into

1. **Realtime quality across different clients**
   - The drawer's local strokes looked smooth, but remote rendering could look segmented.
   - We solved this with better stroke lifecycle handling (`newStroke`/`endStroke`) and rendering tweaks.

2. **Mobile canvas space**
   - Chat and controls were competing with the canvas on small viewports.
   - We redesigned layout behavior for mobile with tabbed secondary panels, overlay draw tools, and a persistent guess bar.

3. **Concurrency and fairness**
   - Guess and timer-advance events can race in multiplayer games.
   - We hardened critical round-resolution paths with Redis transaction patterns and idempotent checks.

4. **Reconnect behavior**
   - Realtime reconnects need UI and state recovery to avoid stale views.
   - We added reconnect recovery logic and state rehydration for robustness.

## Accomplishments that I'm proud of

- Built a fast, lightweight realtime game that runs directly in Reddit posts.
- Achieved fluid drawing input while keeping network payloads and client overhead low.
- Preserved game fairness with server-authoritative logic and race-condition hardening.
- Delivered a mobile experience that remains playable under tight viewport constraints.
- Kept the codebase organized and type-safe enough to iterate quickly under hackathon pressure.

## What I learned

- Realtime game feel is mostly about edge cases: reconnects, race conditions, and UI pressure on small screens.
- "Simple" games still need serious systems thinking when multiple users interact concurrently.
- Typed protocol contracts save huge amounts of debugging time in fast-moving builds.
- Performance wins often come from small pipeline decisions (throttling, buffering, render strategy), not just big refactors.
- Product polish is as much interaction design as it is technical correctness.

## What's next for Scroodle

- Add persistent/replayable stroke history so reconnecting clients can fully recover canvas state.
- Expand game modes (theme rounds, daily challenges, and optional community word packs).
- Add moderation and anti-abuse tooling around custom content flows.
- Improve observability with richer runtime telemetry and room-level diagnostics.
- Explore lightweight social features (post-round reactions, highlights, and shareable round recaps).

