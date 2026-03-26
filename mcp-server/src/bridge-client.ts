/**
 * Bridge Client — connects to the Cells MCP bridge Unix socket.
 *
 * Protocol: newline-delimited JSON.
 *   Request:  { id, method, params }
 *   Response: { id, ok, data?, error? }
 */

import net from "net";

const REQUEST_TIMEOUT = 10_000;

export class BridgeClient {
  private socket: net.Socket | null = null;
  private requestId = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: any) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private lineBuffer = "";
  private _connected = false;

  async connect(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath, () => {
        this._connected = true;
        resolve();
      });

      socket.on("error", (err) => {
        if (!this._connected) {
          reject(err);
          return;
        }
        this._connected = false;
        this.rejectAllPending("Bridge connection lost");
      });

      socket.on("close", () => {
        this._connected = false;
        this.rejectAllPending("Bridge connection closed");
      });

      socket.on("data", (chunk) => {
        this.lineBuffer += chunk.toString();
        let idx: number;
        while ((idx = this.lineBuffer.indexOf("\n")) !== -1) {
          const line = this.lineBuffer.slice(0, idx);
          this.lineBuffer = this.lineBuffer.slice(idx + 1);
          if (!line.trim()) continue;
          try {
            this.handleMessage(JSON.parse(line));
          } catch {}
        }
      });

      this.socket = socket;
    });
  }

  disconnect(): void {
    this._connected = false;
    this.rejectAllPending("Client disconnecting");
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  isConnected(): boolean {
    return this._connected;
  }

  async request(method: string, params: object = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this._connected || !this.socket) {
        reject(new Error("Not connected to bridge"));
        return;
      }
      const id = ++this.requestId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Bridge request '${method}' timed out`));
      }, REQUEST_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.write(JSON.stringify({ id, method, params }) + "\n");
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  private handleMessage(msg: any) {
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(msg.id);
    if (msg.ok) {
      entry.resolve(msg.data);
    } else {
      entry.reject(new Error(msg.error || "Bridge request failed"));
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
