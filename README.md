# Scroodle

An actual Realtime multiplayer draw-and-guess game built on Reddit Devvit Web.

Scroodle matches players in a post, assigns a drawer each round, and lets guessers compete in live chat while strokes sync in realtime across clients.

## What It Is

- 2-4 players per room
- Server-authoritative game state and scoring
- Realtime canvas drawing + guessing
- Round timer, score tracking, and game-over leaderboard
- Mobile-friendly expanded post experience

## How To Play

1. Open a post running Scroodle and tap **Play Now**.
2. Select **Quick Play** to enter matchmaking.
3. When matched, one player becomes the drawer.
4. The drawer draws the secret word on the canvas.
5. Other players guess in chat.
6. Correct guess ends the round early and awards points.
7. After configured rounds, the highest score wins.

### Scoring

- Correct guesser: +10 points
- Current drawer: +3 points when someone guesses correctly

## Architecture

- Client: React + canvas rendering (`src/client/main.tsx`)
- Realtime transport: Devvit realtime channels (`src/client/index.ts`, `src/server/index.ts`)
- Server: Express handlers on Devvit Web server runtime (`src/server/index.ts`)
- State backend: Redis for queue, room state, and room/user mappings
- Shared protocol contracts: `src/shared/protocol.ts`

## Local Development

### Requirements

- Node.js 22.x
- npm
- Devvit CLI

### Install

```bash
npm install
```

### Build

```bash
npm run build
```

### Devvit Commands

```bash
npm run devvit:upload
npm run devvit:playtest
npm run devvit:preview
```

## Configuration

Runtime and moderation settings are in `devvit.json`:

- Matchmaking:
  - `maxPlayers`
  - `minPlayersToStart`
- Gameplay:
  - `roundTimeSec`
  - `roundsPerGame`
- Optional word rotation:
  - `wordlistUrl`

## Submission Artifacts

- App link: [Scroodle](https://developers.reddit.com/apps/scroodle-game)
- Test subreddit: [r/scroodle_game_dev](https://developers.reddit.com/apps/scroodle-game)
- Demo post running Scroodle: [post url](https://www.reddit.com/r/scroodle_game_dev/comments/1r3ala8/scroodle_new_match/)
- Optional demo video (< 1 minute): `<video url>`

## Notes

- Realtime channel names are sanitized to letters, numbers, and underscores.
- Room state and scoring are server-authoritative.
- Matchmaking and user-room mapping are scoped per post context.
