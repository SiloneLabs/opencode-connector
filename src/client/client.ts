import { io, type Socket } from "socket.io-client";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FileTreeNode {
  name: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
  lazy?: boolean;
}

export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export type TerminalTarget = "shell" | "opencode";

interface FileReadResult {
  path: string;
  content?: string;
  error?: string;
}

interface FileWriteResult {
  path: string;
  success?: boolean;
  error?: string;
}

interface FileCreateResult {
  path: string;
  success?: boolean;
  error?: string;
}

interface FileDeleteResult {
  path: string;
  success?: boolean;
  error?: string;
}

interface FileRenameResult {
  oldPath: string;
  newPath: string;
  success?: boolean;
  error?: string;
}

interface TreeExpandResult {
  dir: string;
  tree: FileTreeNode[];
  error?: string;
}

interface OpenCodeSession {
  id: string;
  title?: string;
  [key: string]: unknown;
}

interface ShellResult {
  output: string;
  error?: string;
}

export interface ConnectorClientOptions {
  /** Socket.io server URL (default: http://localhost:9000) */
  serverUrl?: string;
  /** OpenCode API URL (default: http://localhost:4096) */
  opencodeApiUrl?: string;
  /** Auth token for socket.io handshake */
  token: string;
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Reconnection attempts before giving up (default: 5) */
  maxRetries?: number;
}

// ─── Event Emitter ───────────────────────────────────────────────────────────

type EventHandler = (...args: any[]) => void;

class Emitter {
  private handlers = new Map<string, Set<EventHandler>>();

  on(event: string, fn: EventHandler): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn);
    return () => this.handlers.get(event)?.delete(fn);
  }

  emit(event: string, ...args: any[]) {
    this.handlers.get(event)?.forEach((fn) => fn(...args));
  }

  off(event: string, fn?: EventHandler) {
    if (fn) this.handlers.get(event)?.delete(fn);
    else this.handlers.delete(event);
  }

  removeAll() {
    this.handlers.clear();
  }
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class ConnectorClient {
  private socket: Socket;
  private emitter = new Emitter();
  private opencodeApiUrl: string;
  private pendingRequests = new Map<string, { resolve: Function; reject: Function; timer: Timer }>();
  private requestId = 0;

  readonly file: FileAPI;
  readonly terminal: TerminalAPI;
  readonly opencode: OpenCodeAPI;

  constructor(private opts: ConnectorClientOptions) {
    const serverUrl = opts.serverUrl ?? "http://localhost:9000";
    this.opencodeApiUrl = opts.opencodeApiUrl ?? "http://localhost:4096";

    this.socket = io(serverUrl, {
      auth: { token: opts.token },
      transports: ["websocket"],
      reconnection: opts.autoReconnect ?? true,
      reconnectionAttempts: opts.maxRetries ?? 5,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    this.bindSocketEvents();

    this.file = new FileAPI(this.socket, this.emitter);
    this.terminal = new TerminalAPI(this.socket, this.emitter);
    this.opencode = new OpenCodeAPI(this.opencodeApiUrl);
  }

  // ── Connection lifecycle ─────────────────────────────────────────────────

  private bindSocketEvents() {
    this.socket.on("connect", () => this.emitter.emit("connect"));
    this.socket.on("disconnect", (reason) => this.emitter.emit("disconnect", reason));
    this.socket.on("connect_error", (err) => this.emitter.emit("error", err));
  }

  get connected(): boolean {
    return this.socket.connected;
  }

  get id(): string | undefined {
    return this.socket.id;
  }

  on(event: "connect" | "disconnect" | "error", fn: EventHandler): () => void {
    return this.emitter.on(event, fn);
  }

  async waitForConnection(timeoutMs = 10_000): Promise<void> {
    if (this.socket.connected) return;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Connection timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const cleanup = () => {
        this.socket.off("connect", onConnect);
        this.socket.off("connect_error", onError);
        clearTimeout(timer);
      };

      const onConnect = () => { cleanup(); resolve(); };
      const onError = (err: Error) => { cleanup(); reject(err); };

      this.socket.once("connect", onConnect);
      this.socket.once("connect_error", onError);
    });
  }

  disconnect() {
    this.socket.disconnect();
    this.emitter.removeAll();
  }
}

// ─── File API ────────────────────────────────────────────────────────────────

class FileAPI {
  constructor(
    private socket: Socket,
    private emitter: Emitter,
  ) {}

  /** Listen for the full file tree (sent on connect + structural changes) */
  onTree(fn: (tree: FileTreeNode[]) => void): () => void {
    const handler = (tree: FileTreeNode[]) => fn(tree);
    this.socket.on("file:tree", handler);
    return () => this.socket.off("file:tree", handler);
  }

  /** Listen for individual file change notifications */
  onChanged(fn: (info: { path: string }) => void): () => void {
    const handler = (info: { path: string }) => fn(info);
    this.socket.on("file:changed", handler);
    return () => this.socket.off("file:changed", handler);
  }

  /** Expand a lazy-loaded directory */
  expand(dir: string): Promise<FileTreeNode[]> {
    return new Promise((resolve, reject) => {
      const handler = (result: TreeExpandResult) => {
        if (result.dir !== dir) return;
        this.socket.off("file:tree:expand", handler);
        result.error ? reject(new Error(result.error)) : resolve(result.tree);
      };
      this.socket.on("file:tree:expand", handler);
      this.socket.emit("file:tree:expand", dir);
    });
  }

  /** Read file content */
  read(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const handler = (result: FileReadResult) => {
        if (result.path !== path) return;
        this.socket.off("file:read:result", handler);
        result.error ? reject(new Error(result.error)) : resolve(result.content!);
      };
      this.socket.on("file:read:result", handler);
      this.socket.emit("file:read", path);
    });
  }

  /** Write content to a file */
  write(path: string, content: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const handler = (result: FileWriteResult) => {
        if (result.path !== path) return;
        this.socket.off("file:write:result", handler);
        result.error ? reject(new Error(result.error)) : resolve();
      };
      this.socket.on("file:write:result", handler);
      this.socket.emit("file:write", { path, content });
    });
  }

  /** Create a file or directory */
  create(path: string, type: "file" | "directory"): Promise<void> {
    return new Promise((resolve, reject) => {
      const handler = (result: FileCreateResult) => {
        if (result.path !== path) return;
        this.socket.off("file:create:result", handler);
        result.error ? reject(new Error(result.error)) : resolve();
      };
      this.socket.on("file:create:result", handler);
      this.socket.emit("file:create", { path, type });
    });
  }

  /** Delete a file or directory */
  delete(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const handler = (result: FileDeleteResult) => {
        if (result.path !== path) return;
        this.socket.off("file:delete:result", handler);
        result.error ? reject(new Error(result.error)) : resolve();
      };
      this.socket.on("file:delete:result", handler);
      this.socket.emit("file:delete", path);
    });
  }

  /** Rename / move a file or directory */
  rename(oldPath: string, newPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const handler = (result: FileRenameResult) => {
        if (result.oldPath !== oldPath) return;
        this.socket.off("file:rename:result", handler);
        result.error ? reject(new Error(result.error)) : resolve();
      };
      this.socket.on("file:rename:result", handler);
      this.socket.emit("file:rename", { oldPath, newPath });
    });
  }
}

// ─── Terminal API ────────────────────────────────────────────────────────────

class TerminalAPI {
  constructor(
    private socket: Socket,
    private emitter: Emitter,
  ) {}

  /** Start or resize a terminal. First call with dims spawns the PTY on the server. */
  resize(target: TerminalTarget, dims: TerminalDimensions) {
    this.socket.emit(`terminal:resize:${target}`, dims);
  }

  /** Write data (keystrokes) to the terminal stdin */
  write(target: TerminalTarget, data: string) {
    this.socket.emit(`terminal:write:${target}`, data);
  }

  /** Listen for terminal stdout data */
  onData(target: TerminalTarget, fn: (data: string) => void): () => void {
    const event = `terminal:data:${target}`;
    const handler = (data: string) => fn(data);
    this.socket.on(event, handler);
    return () => this.socket.off(event, handler);
  }
}

// ─── OpenCode HTTP API ───────────────────────────────────────────────────────

class OpenCodeAPI {
  constructor(private baseUrl: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenCode API ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  /** Check if the OpenCode server is reachable */
  async health(): Promise<{ status: string }> {
    const sessions = await this.request<unknown[]>("/session");
    return { status: Array.isArray(sessions) ? "ok" : "error" };
  }

  /** List all sessions */
  listSessions(): Promise<OpenCodeSession[]> {
    return this.request("/session");
  }

  /** Create a new session */
  createSession(title = "New Session"): Promise<OpenCodeSession> {
    return this.request("/session", {
      method: "POST",
      body: JSON.stringify({ title }),
    });
  }

  /** Get a session by ID */
  getSession(id: string): Promise<OpenCodeSession> {
    return this.request(`/session/${encodeURIComponent(id)}`);
  }

  /** Delete a session */
  deleteSession(id: string): Promise<unknown> {
    return this.request(`/session/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /** Run a shell command inside a session */
  shell(id: string, command: string, opts?: { agent?: string; providerID?: string; modelID?: string }): Promise<ShellResult> {
    return this.request(`/session/${encodeURIComponent(id)}/shell`, {
      method: "POST",
      body: JSON.stringify({
        command,
        agent: opts?.agent ?? "build",
        model: {
          providerID: opts?.providerID ?? "opencode",
          modelID: opts?.modelID ?? "big-pickle",
        },
      }),
    });
  }

  /** Send a prompt to a session (fire-and-forget, listen via SSE for results) */
  prompt(id: string, text: string, opts?: { providerID?: string; modelID?: string }): Promise<{ ok: boolean }> {
    return this.request(`/session/${encodeURIComponent(id)}/prompt`, {
      method: "POST",
      body: JSON.stringify({
        model: {
          providerID: opts?.providerID ?? "opencode",
          modelID: opts?.modelID ?? "big-pickle",
        },
        parts: [{ type: "text", text }],
      }),
    });
  }

  /** Subscribe to the SSE event stream. Returns an AbortController to stop listening. */
  events(onEvent: (event: string, data: string) => void): AbortController {
    const controller = new AbortController();

    (async () => {
      try {
        const res = await fetch(`${this.baseUrl}/event`, {
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) return;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          let currentEvent = "message";
          for (const line of lines) {
            if (line.startsWith("event:")) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              onEvent(currentEvent, line.slice(5).trim());
              currentEvent = "message";
            }
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name !== "AbortError") throw err;
      }
    })();

    return controller;
  }
}
