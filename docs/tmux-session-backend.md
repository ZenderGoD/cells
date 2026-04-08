# tmux Session Backend

Cells runs tmux as a private app-owned backend. It does not join or mutate the user's global tmux server.

## Private Server Scope

- One tmux server exists per Cells state directory.
- The server uses a private socket at `<stateDir>/tmux.sock`.
- The server uses an app-owned config at `<stateDir>/tmux.conf`.
- Cells compiles a private terminfo tree at `<stateDir>/terminfo` when `tic` is available.
- If private terminfo compilation fails, Cells falls back to `tmux-256color`.
- The private config sets `exit-empty off` so `tmux start-server` leaves the server reachable even before any project session exists.

## Naming

- Project sessions: `cp_<base64url(projectId)>`
- Terminal windows inside a project session: `cw_<base64url(termId)>`
- Viewer sessions: `cv_<base64url(termId)>`

Project sessions are the canonical backend state. Viewer sessions are disposable attach helpers only.

## Lifecycle

1. App startup starts the PTY daemon before windows are created.
2. When the selected backend is `tmux`, the daemon constructs `TmuxSessionManager`.
3. `TmuxSessionManager` writes the private config, prepares private terminfo, and runs `tmux start-server` against the private socket.
4. Startup does not create any per-project tmux sessions.
5. The first terminal attach or spawn for a project lazily creates that project's tmux session and first window.
6. Additional terminals for the same project create more windows in the same project session.
7. Each visible Cells terminal gets its own viewer session so separate canvas terminals can attach independently without competing over the project's current window.
8. Renderer detach, daemon shutdown, and daemon restart only remove viewer sessions and client PTYs. They do not kill the private tmux server or project sessions.
9. A restarted daemon reuses the same private socket, rediscovers existing project windows, and reattaches on demand.
10. If the last terminal window in a project is closed, Cells removes that final tmux window and then removes the now-empty project session.

## Diagnostics

`window.cells.daemon.getStatus()` exposes `backendDetails` for tmux with:

- resolved tmux binary path and version
- minimum supported tmux version
- private socket and config paths
- private terminfo directory and whether compilation succeeded
- whether the private tmux server is currently reachable
- project session count
- viewer session count
- per-project session/window topology

Those diagnostics reflect the real tmux state on the private socket instead of inferring lifecycle behavior from renderer attachments.
