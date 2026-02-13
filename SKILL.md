---
name: devvit-debug

description: >
  Activates when the user wants to launch a Devvit playtest, debug a Devvit app,
  stream playtest logs, open a Reddit post playtest in the browser, or use Devvit
  dev tools. Triggers on phrases like "launch a playtest", "debug the app",
  "start devvit", "run playtest", "utilize dev tools", "stream logs", "devvit CLI",
  "test my app on Reddit", or any mention of Devvit development workflows.
  Manages the full lifecycle: CLI startup → log streaming → browser launch →
  Reddit post navigation → Chrome DevTools inspection → markdown report generation.
---

# DevBug — Devvit Playtest Debug Skill

## Purpose

Guide the complete Devvit CLI 0.12.12 playtest workflow from a clean start to a
full diagnostic report. This skill is **state-aware**: it never assumes a step is
complete unless it has been confirmed. At every stage, determine what has been
done, what is currently possible, and what must happen next before proceeding.

---

## Core Principle: State Awareness Before Action

Before executing any step, always answer three questions internally:

1. **What has already been confirmed complete?** (Do not repeat completed steps.)
2. **What is the current blocking condition?** (What must be true before the next step?)
3. **What is the next atomic action available right now?**

Never skip ahead. Never assume the CLI is running, the user is logged in, or the
browser has loaded unless those states have been explicitly verified in this session.

---

## Prerequisites Checklist (Verify Before Starting)

Confirm the following before initiating the playtest sequence. Ask the user or
check via terminal if unclear:

- Devvit CLI version 0.12.12 is installed (`devvit --version`)
- The user is inside a valid Devvit project directory (check for `devvit.yaml`)
- Node.js and npm/yarn dependencies are installed
- The user has a Reddit account capable of running playtests
- A target subreddit for playtest posting is identified
- Chrome is available for browser launch
- Chrome DevTools MCP is accessible
- Devvit MCP is accessible

If any prerequisite is unmet, surface the gap immediately and pause until resolved.

---

## Phase 1: Authentication & Environment Validation

**Goal**: Confirm the user is logged into Devvit CLI and the environment is ready.

### Step 1.1 — Check Login State

```bash
devvit whoami
```

- If the command returns a username → user is logged in. Record username. Proceed to Step 1.2.
- If the command returns an error or "not logged in" → trigger login flow:

```bash
devvit login
```

Wait for the CLI to open a browser OAuth window. Instruct the user:

> "A browser window will open for Reddit OAuth. Log in with your Reddit credentials
> and authorize the Devvit CLI. Return here when complete."

Do not proceed to Phase 2 until `devvit whoami` returns a valid username.

### Step 1.2 — Validate Project Directory

```bash
ls devvit.yaml
```

- If `devvit.yaml` exists → valid project. Record the `name` field from the file.
- If missing → halt and inform the user they are not in a Devvit project root.

### Step 1.3 — Confirm Subreddit Target

Ask the user if not already provided:

> "Which subreddit should the playtest post be created in? (Must be a subreddit
> where you have post permissions.)"

Store the subreddit name for use in Phase 2.

---

## Phase 2: Launch the Devvit Playtest CLI

**Goal**: Start `devvit playtest` for CLI version 0.12.12 with log streaming active.

### Step 2.1 — Start Playtest

```bash
devvit playtest <subreddit-name>
```

Replace `<subreddit-name>` with the confirmed subreddit from Phase 1.

Expected CLI output pattern:

```
✓ Building app...
✓ Uploading to playtest environment...
✓ Playtest post created: https://www.reddit.com/r/<subreddit>/comments/<post-id>/
Streaming logs... (Ctrl+C to stop)
```

**State check**: The playtest is considered active only when:

- The build and upload steps show success checkmarks
- A Reddit post URL is printed to the terminal
- Log streaming has begun (lines continue to appear)

If the build fails, capture the error output verbatim and jump to the
Error Triage Protocol before retrying.

### Step 2.2 — Capture the Playtest URL

Extract the Reddit post URL from the terminal output. This URL is required for
Phase 3. Format: `https://www.reddit.com/r/<subreddit>/comments/<post-id>/`

Store this URL. Do not proceed to Phase 3 without it.

### Step 2.3 — Stream and Monitor Logs

While the playtest runs, monitor terminal output continuously. Log entries to watch for:

- `[ERROR]` or `[WARN]` prefixed lines → capture for the final report
- Unhandled exception stack traces → capture verbatim
- `[INFO]` lifecycle events (mount, render, user interaction) → record for context
- Network request failures → note endpoint and status code

---

## Phase 3: Browser Launch & Reddit Post Navigation

**Goal**: Open the playtest URL in Chrome and verify the app loads correctly.

### Step 3.1 — Launch Chrome to Playtest URL

Use the available browser MCP or bash to open Chrome:

```bash
open -a "Google Chrome" "<playtest-url>"
```

Or via Chrome DevTools MCP — navigate to the playtest URL directly.

**State check**: Browser is considered ready when:

- Chrome has opened (or was already open)
- The Reddit post URL is loaded in the active tab
- The page has finished initial load (no spinner)

### Step 3.2 — User Login on Reddit (if required)

If the Reddit page prompts for login:

> "The Reddit page is requesting a login. Please log into Reddit in the browser
> using the account associated with your Devvit playtest permissions."

Wait for user confirmation before proceeding. Do not assume login is complete.

### Step 3.3 — Verify App Renders in Post

Visually or via DevTools MCP confirm:

- The Reddit post is visible
- The Devvit app iframe or embedded component has loaded inside the post
- No "App failed to load" or error banners are visible on the page

If the app fails to render, note the visible error and cross-reference with the
terminal logs captured in Phase 2.

---

## Phase 4: Chrome DevTools Inspection

**Goal**: Use Chrome DevTools MCP to inspect runtime behavior, console errors,
and network activity.

### Step 4.1 — Open DevTools Console

Via Chrome DevTools MCP, connect to the active Chrome tab and:

- Open the Console panel
- Filter for `errors` and `warnings`
- Capture all console output since page load

### Step 4.2 — Inspect Network Requests

In the Network panel:

- Filter for failed requests (status 4xx, 5xx, or blocked)
- Note any requests to `reddit.com` or Devvit API endpoints that fail
- Record request URL, method, status code, and response body if available

### Step 4.3 — Inspect the Devvit iframe (if applicable)

If the app renders inside an iframe:

- Switch DevTools context to the iframe's origin
- Repeat console and network capture for that frame
- Note any cross-origin errors or blocked resources

### Step 4.4 — Source Map / Runtime Errors

If JavaScript errors appear:

- Capture the full stack trace
- Note whether source maps are available
- Record the file name, line number, and error message

---

## Phase 5: Synthesis & Report Generation

**Goal**: Compile all findings into a structured markdown report.

Only begin this phase when:

- The playtest session has been stopped or the user requests a summary
- Enough data has been collected to make the report meaningful
- All active errors have been investigated (not necessarily resolved)

Generate the report using the template below.

---

## Output Format: Markdown Diagnostic Report

```markdown
# DevBug Playtest Report

**Date**: <timestamp>
**Project**: <devvit.yaml app name>
**Subreddit**: <target subreddit>
**Playtest URL**: <reddit post url>
**Devvit CLI Version**: 0.12.12
**Session Duration**: <start → end time if known>

---

## Authentication & Environment

- CLI Login: ✅ / ❌ — <username or error>
- Project Valid: ✅ / ❌
- Dependencies: ✅ / ❌ — <notes>

---

## Playtest Launch

- Build Status: ✅ Success / ❌ Failed
- Upload Status: ✅ Success / ❌ Failed
- Log Streaming: ✅ Active / ❌ Not Started
- Post URL Generated: ✅ / ❌

**Build/Upload Errors** (if any):
\`\`\`
<error output verbatim>
\`\`\`

---

## Terminal Log Summary

**Errors Captured**:
| Timestamp | Level | Message |
|-----------|-------|---------|
| <time> | ERROR | <message> |

**Warnings Captured**:
| Timestamp | Level | Message |
|-----------|-------|---------|

**Notable Info Events**:

- <event>

---

## Browser & App Rendering

- Chrome Opened: ✅ / ❌
- Reddit Post Loaded: ✅ / ❌
- App Rendered in Post: ✅ / ❌
- User Login Required: Yes / No

**Rendering Issues**:
<description or "None observed">

---

## Chrome DevTools Findings

**Console Errors**:
| Source | Error Message | Stack Trace Snippet |
|--------|--------------|---------------------|
| <file:line> | <message> | <snippet> |

**Failed Network Requests**:
| URL | Method | Status | Notes |
|-----|--------|--------|-------|

**iframe Context Issues**:
<description or "None">

---

## Actions Taken

1. <action> — <outcome>
2. <action> — <outcome>

---

## Problems Resolved

- <problem> → <fix applied> → <verification>

---

## Outstanding Issues

- <issue> — <severity: High/Medium/Low> — <recommended next step>

---

## Future Advice

- <actionable recommendation>
- <actionable recommendation>

---

## Raw Log Dump (if requested)

\`\`\`
<full terminal log>
\`\`\`
```

---

## Error Triage Protocol

When any phase encounters an error, apply this process before moving on:

1. **Capture** the exact error message and context (phase, command run, output).
2. **Classify** the error: build failure, auth failure, network error, runtime crash, rendering bug.
3. **Check** known Devvit 0.12.12 issues:
   - Build failures often relate to TypeScript errors or missing `devvit.yaml` fields.
   - Auth failures may require `devvit logout` then `devvit login` to reset tokens.
   - Reddit post not loading can indicate the playtest session timed out (sessions expire).
   - iframe rendering failures may indicate a CSP or cross-origin issue in the Reddit post environment.
4. **Attempt a fix** if a clear resolution exists. Document the fix taken.
5. **Re-verify** the phase condition before continuing.
6. **Escalate** to the report's "Outstanding Issues" section if unresolvable in session.

---

## State Machine Summary

```
[START]
  → Phase 1: Auth & Environment
      → whoami check
      → login if needed (WAIT for user)
      → project dir check
      → subreddit confirmation (WAIT for user)
  → Phase 2: CLI Playtest Launch
      → run devvit playtest
      → wait for build + upload success
      → capture post URL
      → begin log streaming
  → Phase 3: Browser & Reddit
      → launch Chrome with post URL
      → wait for page load
      → user login if needed (WAIT for user)
      → verify app renders
  → Phase 4: DevTools Inspection
      → console errors
      → network failures
      → iframe context
  → Phase 5: Report
      → synthesize all findings
      → generate markdown report
[END]
```

At any point, if the user says "stop", "pause", or "what's the status", summarize
the current phase, what has been confirmed, and what the next step would be.
Never auto-advance through a WAIT state.

---

## Dependencies

This skill requires access to the following tools and MCPs. Verify availability
at skill start and note any that are unavailable in the report:

- **Devvit MCP** — for CLI command execution and log capture
- **Chrome DevTools MCP** — for browser inspection and console/network analysis
- **Bash / Terminal** — for direct CLI commands (`devvit`, `ls`, `open`, etc.)
- **File Read** — to inspect `devvit.yaml` and source files
- **Devvit CLI 0.12.12** — must be installed in the user's environment
