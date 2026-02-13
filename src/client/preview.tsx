import React from "react";
import { createRoot } from "react-dom/client";
import { requestExpandedMode } from "@devvit/web/client";
import "./style.css";

/**
 * Inline preview screen shown in the Reddit feed.
 * Lightweight branded splash with a "Play Now" CTA that
 * transitions to the full game in expanded mode.
 */
function Preview() {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 p-6 text-center animate-fade-in">
      {/* Logo / Title */}
      <div
        className="text-3xl font-extrabold tracking-tight"
        style={{ color: "var(--accent)" }}
      >
        ✏️ Scroodle
      </div>

      {/* Tagline */}
      <div
        className="text-[15px] max-w-[280px] leading-relaxed"
        style={{ color: "var(--text-secondary)" }}
      >
        Draw, guess, and compete with friends.
        <br />
        2–4 players per match.
      </div>

      {/* Play button */}
      <button
        className="btn-primary py-3 px-8 text-lg font-bold min-w-[160px] mt-2"
        onClick={async (e) => {
          try {
            await requestExpandedMode(e.nativeEvent, "game");
          } catch (err) {
            console.error("Failed to enter expanded mode:", err);
          }
        }}
      >
        Play Now
      </button>

      {/* Subtle info */}
      <div
        className="text-xs mt-1"
        style={{ color: "var(--text-muted)" }}
      >
        Opens in fullscreen
      </div>
    </div>
  );
}

createRoot(document.getElementById("preview-root")!).render(<Preview />);
