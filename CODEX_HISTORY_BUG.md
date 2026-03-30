# Codex Terminal History Loss Bug - Investigation & Failed Fixes

## Issue Description

When the Cells app is closed and reopened:
- **Claude terminal windows**: Chat history is preserved and visible ✓
- **Codex terminal windows**: Chat history disappears/is not visible ✗
  - The AI still has context (knows previous conversation)
  - But the terminal display shows blank/no scrollback text
  - Visual history is completely gone even though AI remembers

When switching between projects without closing the app:
- Both Claude and Codex history stays visible ✓

When doing `cmd+r` (page reload):
- History also disappears

## Root Cause Analysis

**Terminal Architecture:**
- Both Claude and Codex run as CLI tools in terminal windows
- Terminals use ghostty-web library for rendering
- PTY daemon (separate process) manages terminal sessions
- Terminal cache keeps sessions alive across project switches
- PTY daemon buffer is cleared when process exits

**Why Claude Works:**
- `claude` command keeps shell running indefinitely
- Shell process stays alive in PTY daemon
- Buffer persists in daemon memory
- On app restart, terminal reattaches to live shell
- `result.reattached=true` means buffer is available

**Why Codex Fails:**
- `codex` command exits when agent finishes
- Process dies → daemon deletes buffer (pty-daemon.ts:145)
- On app restart, `result.reattached=false` (process is dead)
- No buffer to restore
- Fresh shell starts with no history

## Attempted Fixes

### Attempt 1: Persist Terminal Scrollback to Disk

**Approach:**
- Added `scrollback?: string` field to `TerminalNode` type
- Created `terminal:get-all-buffers` IPC handler to fetch buffers before app closes
- Modified `persist()` to save scrollback alongside browser history
- On terminal restore, write scrollback back via `term.write()`

**Implementation:**
- `src/types/index.ts` - Added scrollback field
- `electron/main.ts` - Added `ipcMain.handle('terminal:get-all-buffers')`
- `electron/preload.ts` - Added `getAllBuffers()` to API
- `src/lib/store.ts` - Modified persist to fetch and merge buffers
- `src/components/terminal/cell-terminal.tsx` - Added scrollback restore logic

**Result: FAILED** ✗

**Why it failed:**
1. Writing raw ANSI escape sequences to a fresh shell creates garbled output
2. Old terminal control codes confuse the new shell's renderer
3. On app restart, screenshot showed overlapped/duplicate text rendering
4. Mixing old scrollback (with state machine codes) + new shell initialization = visual corruption

**Evidence:**
- Screenshot showed text doubled/overlapped
- Terminal display was unreadable
- Mixed old codec output with new shell prompt

### Attempt 2: Scroll to Bottom After Restore

**Approach:**
- After writing scrollback, call `term.scrollToBottom()` to ensure viewport shows content
- Force render with `term.renderer.render()`

**Result: FAILED** ✗

**Why it failed:**
- Didn't solve the core problem (garbled content from escape sequences)
- Even if scrolled to bottom, the content itself was corrupted

## Why This is Hard

**Fundamental Challenge:**
Terminal output is not just plain text - it's a sequence of control commands:
- ANSI escape sequences for colors, cursor position, clearing
- State machine for alternate screen mode
- Cursor coordinates, text attributes
- Shell-specific initialization codes

**The Problem with Replaying:**
- Taking raw PTY buffer data = capturing all these escape sequences
- Writing to new shell = replaying all those commands to fresh state
- Fresh shell doesn't have the same state machine context
- Results in undefined/corrupted rendering

**Why Browsers Work (Reference):**
- Browser history stores actual URLs + page state
- Not raw rendering commands
- Reproducible: navigate to URL again, page renders the same way
- Terminal history ≠ Browser history (fundamentally different data)

## Current State

**What Works:**
- Within a session (project switches): history visible for both Claude and Codex ✓
- Claude across restarts: history visible (process stays alive) ✓
- PTY daemon's in-memory buffer: restored when process reattaches ✓

**What Doesn't Work:**
- Codex across app restarts: history lost (process dies, buffer lost) ✗
- Codex on page reload: history lost ✗

**Code Status:**
- All experimental code has been reverted
- `getAllBuffers()` IPC handler still exists but unused
- Terminal cache and restore logic unchanged
- No corrupting writes to recovered shells

## Potential Alternative Approaches (Not Attempted)

### 1. Capture Plain Text Only
Instead of raw buffer, extract just the visible text lines from the buffer:
```
- Pros: No ANSI sequences, would be readable text
- Cons: Loses formatting, colors, links
- Complexity: Would need to parse ghostty-web buffer API properly
- Uncertain: Might still have rendering issues with plain text injection
```

### 2. Store Terminal Screenshots
Save PNG/canvas of terminal state:
```
- Pros: Perfect visual preservation
- Cons: Large file sizes, not searchable/copyable, misleading (not live)
- Feasibility: Low priority vs actual functionality
```

### 3. Extend Codex to Keep Process Alive
Modify codex command wrapper to keep shell alive:
```
- Pros: Mimics Claude behavior, leverages existing working mechanism
- Cons: Out of scope (external tool), requires user/tool changes
- Status: Not applicable - can't change external tools
```

### 4. Use Terminal Recording Format (asciinema)
Record terminal session in asciinema format with timing:
```
- Pros: Standards-compliant, playback is smooth
- Cons: Large file sizes, complex implementation, different UX
- Status: Over-engineered for use case
```

### 5. Keep Process Alive in Background
Don't let Codex process exit - keep shell alive after agent finishes:
```
- Pros: Uses existing working mechanism (like Claude)
- Cons: Codex would need to return control to shell prompt (may not)
- Status: Depends on how codex-cli works
```

## Why This Matters

The user expects history to persist like it does in:
- Browser address bars (URLs persist)
- Chat applications (messages persist)
- Terminal history (readline history persists)

But terminal rendering state is fundamentally different - it's not data, it's rendering commands.

## Recommendation for Next Steps

1. **Accept current limitation**: Codex history doesn't survive app restart (by design - process exits)
2. **Document in UI**: Add a note that Codex sessions don't persist across restarts
3. **Consider UX alternative**:
   - Auto-save user prompts/responses to file (not full terminal state)
   - Or suggest user copies important output before closing
4. **Explore codex-cli behavior**: Check if there's a way to keep codex process alive (like Claude does)

## Files Modified in Failed Attempts

Files reverted:
- `src/types/index.ts` - Removed scrollback field
- `electron/main.ts` - Added getAllBuffers handler (still there, unused)
- `electron/preload.ts` - Added getAllBuffers API (still there, unused)
- `src/lib/store.ts` - Removed scrollback merging logic
- `src/components/terminal/cell-terminal.tsx` - Removed scrollback restore calls

Files that still have remnants:
- `electron/main.ts:427-439` - `terminal:get-all-buffers` handler (benign, not called)
- `src/types/index.ts:161` - `getAllBuffers()` in CellsAPI type (benign, not called)
- `electron/preload.ts:17-18` - `getAllBuffers` in preload (benign, not called)

These don't hurt anything but could be cleaned up if desired.
