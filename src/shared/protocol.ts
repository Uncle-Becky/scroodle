export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export type MatchmakingJoinResponse =
  | {
      status: "matched";
      roomId: string;
      roomChannel: string;
      personalChannel: string;
    }
  | { status: "queued"; personalChannel: string; queueSize: number }
  | { status: "error"; message: string };

export type IdentityResponse = {
  userId: string;
  userName: string;
  postId: string;
  subredditName?: string;
};

export type SessionBootstrapResponse =
  | {
      status: "logged-out";
      personalChannel?: string;
    }
  | {
      status: "menu";
      personalChannel: string;
    }
  | {
      status: "queued";
      personalChannel: string;
      queueSize: number;
    }
  | {
      status: "matched";
      roomId: string;
      roomChannel: string;
      personalChannel: string;
    };

export type RoomPublicState = {
  roomId: string;
  status: "waiting" | "playing" | "ended";
  createdAt: number;
  updatedAt: number;
  players: Array<{
    userId: string;
    userName: string;
    score: number;
    lastSeen: number;
  }>;
  drawerUserId?: string;
  roundEndsAt?: number;
  roundNumber?: number;
  maxRounds?: number;
  wordMask?: string; // for guessers
  // for drawer only:
  word?: string;
};

export type RealtimeMessage =
  | { type: "room-state"; state: RoomPublicState }
  | { type: "system"; text: string }
  | { type: "chat"; from: string; text: string; correct?: boolean }
  | {
      type: "draw";
      from: string;
      points: Array<[number, number]>;
      color: string;
      width: number;
      newStroke?: boolean;
      endStroke?: boolean;
    }
  | { type: "canvas-clear"; from: string }
  | { type: "round-ended"; reason: "time" | "guessed" | "left" }
  | { type: "match-found"; roomId: string; roomChannel: string };
