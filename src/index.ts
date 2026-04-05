import { Server } from "socket.io";
import { Server as Engine } from "@socket.io/bun-engine";
import { Hono } from "hono";
import {
  readdir,
  readFile,
  writeFile,
  mkdir,
  rm,
  rename,
  stat,
} from "fs/promises";
import { resolve } from "path";
import { cors } from "hono/cors";
import chokidar from "chokidar";
import { fetchUserIdFromToken } from "./helper";

const io = new Server({ cors: { origin: "*" } });
const engine = new Engine();

io.bind(engine);

io.use(async (socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.query.token;

  if (!token) return next(new Error("missing token"));

  const userId = await fetchUserIdFromToken(token as string);
  if (!userId) {
    return next(new Error("invalid or expired token"));
  }

  (socket as any).userId = userId;
  next();
});

const PROJECT_DIR = "./project";
const PROJECT_DIR_ABS = resolve(PROJECT_DIR);

const OPENCODE_BASE_URL =
  process.env.OPENCODE_BASE_URL || "http://localhost:4096";

interface OpenCodeSession {
  shell: ReturnType<typeof Bun.spawn> | null;
  sseAbort: AbortController | null;
  sessionId: string | null;
}

const sessions = new Map<string, OpenCodeSession>();

/** resolve a user-supplied path safely within the project dir */
function safePath(userPath: string): string {
  const abs = resolve(PROJECT_DIR_ABS, userPath);
  if (!abs.startsWith(PROJECT_DIR_ABS + "/") && abs !== PROJECT_DIR_ABS) {
    throw new Error("path escapes project directory");
  }
  return abs;
}

function killPty(proc: ReturnType<typeof Bun.spawn> | null) {
  if (!proc) return;
  try {
    proc.kill();
    proc.terminal?.close();
  } catch (_) {}
}

/** Subscribe to OpenCode SSE and forward events via Socket.IO */
function startSSEBridge(socket: any, userId: string) {
  const session = sessions.get(userId);
  if (!session) return;

  // Abort any existing SSE connection
  session.sseAbort?.abort();
  const abort = new AbortController();
  session.sseAbort = abort;

  (async () => {
    try {
      const res = await fetch(`${OPENCODE_BASE_URL}/event`, {
        headers: { Accept: "text/event-stream" },
        signal: abort.signal,
      });

      if (!res.ok || !res.body) {
        socket.emit("opencode:error", { error: "Failed to connect to OpenCode event stream" });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";
      let currentData = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            currentData += line.slice(5).trim();
          } else if (line.trim() === "") {
            // Empty line = end of SSE message
            if (currentEvent && currentData) {
              try {
                const parsed = JSON.parse(currentData);
                socket.emit("opencode:event", {
                  type: currentEvent,
                  data: parsed,
                });
              } catch {
                socket.emit("opencode:event", {
                  type: currentEvent,
                  data: currentData,
                });
              }
            } else if (currentData && !currentEvent) {
              try {
                const parsed = JSON.parse(currentData);
                // Try to infer event type from data
                if (parsed.type) {
                  socket.emit("opencode:event", {
                    type: parsed.type,
                    data: parsed,
                  });
                }
              } catch {}
            }
            currentEvent = "";
            currentData = "";
          }
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        console.error("[SSE] error:", err.message);
        socket.emit("opencode:error", { error: "SSE connection lost" });
      }
    }
  })();
}

io.on("connection", async (socket) => {
  const userId = (socket as any).userId as string;

  // kill stale session if user reconnects (e.g. page reload)
  if (sessions.has(userId)) {
    const old = sessions.get(userId)!;
    killPty(old.shell);
    old.sseAbort?.abort();
  }
  sessions.set(userId, { shell: null, sseAbort: null, sessionId: null });

  // send initial file tree
  const tree = await generateFileTree(PROJECT_DIR, true);
  socket.emit("file:tree", tree);

  socket.on("file:tree:expand", async (dir: string) => {
    try {
      const safeDir = safePath(dir);
      const segments = dir.split("/");
      const isInsideLazy = segments.some((s) => LAZY_DIRS.has(s));
      const tree = isInsideLazy
        ? await generateShallowTree(safeDir)
        : await generateFileTree(safeDir);
      socket.emit("file:tree:expand", { dir, tree });
    } catch (e: any) {
      socket.emit("file:tree:expand", { dir, tree: [], error: e.message });
    }
  });

  // deferred terminal spawn — wait for client to send dimensions
  function spawnShell(cols: number, rows: number) {
    const session = sessions.get(userId);
    if (!session) return;

    // kill stale shell before respawn
    killPty(session.shell);

    try {
      session.shell = Bun.spawn(["bash", "--login"], {
        cwd: PROJECT_DIR_ABS,
        env: {
          ...process.env,
          TERM: "xterm-256color",
        },
        terminal: {
          cols,
          rows,
          data(_t: any, d: Uint8Array) {
            socket.emit("terminal:data:shell", Buffer.from(d).toString());
          },
        },
      });
    } catch (err: any) {
      console.warn("[spawnShell] PTY not supported on this platform:", err.message);
      socket.emit("terminal:data:shell", "\r\n[Terminal not available on this platform]\r\n");
    }
  }

  // terminal input (shell only — opencode no longer uses PTY)
  socket.on("terminal:write:shell", (data: string) => {
    sessions.get(userId)?.shell?.terminal?.write(data);
  });

  // terminal resize — shell only
  socket.on(
    "terminal:resize:shell",
    ({ cols, rows }: { cols: number; rows: number }) => {
      const shell = sessions.get(userId)?.shell;
      if (!shell) {
        spawnShell(cols, rows);
      } else {
        try { shell.terminal?.resize(cols, rows); } catch {}
      }
    },
  );

  // ── OpenCode API events ──────────────────────────────────────────

  // Auto-create session + SSE bridge helper
  async function createOpenCodeSession(title: string) {
    try {
      const res = await fetch(`${OPENCODE_BASE_URL}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const session = await res.json();
      const userSession = sessions.get(userId);
      if (userSession) userSession.sessionId = session.id;

      socket.emit("opencode:session:created", session);
      startSSEBridge(socket, userId);
    } catch (err: any) {
      socket.emit("opencode:error", { error: "Failed to create session", details: err.message });
    }
  }

  // Auto-create session on connection
  createOpenCodeSession("IDE Session");

  // Also allow client to request a new session (e.g. "New Chat")
  socket.on("opencode:session:create", async (data?: { title?: string }) => {
    await createOpenCodeSession(data?.title || "New Session");
  });

  // List sessions
  socket.on("opencode:sessions:list", async () => {
    try {
      const res = await fetch(`${OPENCODE_BASE_URL}/session`);
      const data = await res.json();
      socket.emit("opencode:sessions:list:result", data);
    } catch (err: any) {
      socket.emit("opencode:error", { error: "Failed to list sessions", details: err.message });
    }
  });

  // Send prompt
  socket.on(
    "opencode:prompt",
    async (data: { sessionId: string; text: string; providerID?: string; modelID?: string }) => {
      try {
        const res = await fetch(`${OPENCODE_BASE_URL}/session/${data.sessionId}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: {
              providerID: data.providerID || "opencode",
              modelID: data.modelID || "big-pickle",
            },
            parts: [{ type: "text", text: data.text }],
          }),
        });
        if (res.ok) {
          const result = await res.json();
          socket.emit("opencode:message:complete", result);
        }
        socket.emit("opencode:prompt:sent", { ok: true });
      } catch (err: any) {
        socket.emit("opencode:error", { error: "Failed to send prompt", details: err.message });
      }
    },
  );

  // Get messages for a session
  socket.on("opencode:messages:list", async (data: { sessionId: string }) => {
    try {
      const res = await fetch(`${OPENCODE_BASE_URL}/session/${data.sessionId}/message`);
      const messages = await res.json();
      socket.emit("opencode:messages:list:result", messages);
    } catch (err: any) {
      socket.emit("opencode:error", { error: "Failed to list messages", details: err.message });
    }
  });

  // filesystem operations
  socket.on("file:read", async (path: string) => {
    try {
      const abs = safePath(path);
      const content = await readFile(abs, "utf-8");
      socket.emit("file:read:result", { path, content });
    } catch (e: any) {
      socket.emit("file:read:result", { path, error: e.message });
    }
  });

  socket.on(
    "file:write",
    async ({ path, content }: { path: string; content: string }) => {
      try {
        const abs = safePath(path);
        await writeFile(abs, content, "utf-8");
        socket.emit("file:write:result", { path, success: true });
      } catch (e: any) {
        socket.emit("file:write:result", { path, error: e.message });
      }
    },
  );

  socket.on(
    "file:create",
    async ({ path, type }: { path: string; type: "file" | "directory" }) => {
      try {
        const abs = safePath(path);
        if (type === "directory") {
          await mkdir(abs, { recursive: true });
        } else {
          await writeFile(abs, "", "utf-8");
        }
        socket.emit("file:create:result", { path, success: true });
      } catch (e: any) {
        socket.emit("file:create:result", { path, error: e.message });
      }
    },
  );

  socket.on("file:delete", async (path: string) => {
    try {
      const abs = safePath(path);
      const s = await stat(abs);
      await rm(abs, { recursive: s.isDirectory() });
      socket.emit("file:delete:result", { path, success: true });
    } catch (e: any) {
      socket.emit("file:delete:result", { path, error: e.message });
    }
  });

  socket.on(
    "file:rename",
    async ({ oldPath, newPath }: { oldPath: string; newPath: string }) => {
      try {
        const absOld = safePath(oldPath);
        const absNew = safePath(newPath);
        await rename(absOld, absNew);
        socket.emit("file:rename:result", { oldPath, newPath, success: true });
      } catch (e: any) {
        socket.emit("file:rename:result", {
          oldPath,
          newPath,
          error: e.message,
        });
      }
    },
  );

  // cleanup on disconnect
  socket.on("disconnect", () => {
    const session = sessions.get(userId);
    if (session) {
      killPty(session.shell);
      session.sseAbort?.abort();
      sessions.delete(userId);
    }
  });
});

// watch project dir, debounce + push refreshed tree to all clients
let debounceTimer: Timer | null = null;

const watcher = chokidar.watch(PROJECT_DIR_ABS, {
  ignored: [
    "**/node_modules/**",
    "**/target/**",
    "**/.next/**",
    "**/.git/**",
    "**/.soroban/**",
    "**/*.log",
  ],
  ignoreInitial: true,
  persistent: true,
  depth: 10,
  awaitWriteFinish: {
    stabilityThreshold: 200,
    pollInterval: 100,
  },
  usePolling: false,
});

watcher.on("all", (_event, filePath) => {
  const relative = filePath.slice(PROJECT_DIR_ABS.length + 1);
  if (relative) {
    io.emit("file:changed", { path: relative });
  }
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    const tree = await generateFileTree(PROJECT_DIR, true);
    io.emit("file:tree", tree);
  }, 300);
});

const app = new Hono();

app.use(
  cors({
    origin: "*",
  }),
);

const { websocket } = engine.handler();

export default {
  port: 9000,
  idleTimeout: 30,

  async fetch(req: Request, server: any) {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/socket.io")) {
      const res = await engine.handleRequest(req, server);
      if (res) {
        res.headers.set("Access-Control-Allow-Origin", "*");
        res.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        res.headers.set("Access-Control-Allow-Headers", "Content-Type");
      }
      return res;
    } else {
      return app.fetch(req, server);
    }
  },

  websocket,
};

type FileTreeNode = {
  name: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
  lazy?: boolean;
};

const ROOT_ALLOW = new Set(["contract", "client", "README.md"]);
const LAZY_DIRS = new Set(["node_modules", "target", ".next"]);

async function generateShallowTree(dir: string): Promise<FileTreeNode[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.map((entry) => {
    if (entry.isDirectory()) {
      return { name: entry.name, type: "directory", children: [], lazy: true };
    }
    return { name: entry.name, type: "file" };
  });
}

async function generateFileTree(
  dir: string,
  isRoot = false,
): Promise<FileTreeNode[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const tree: FileTreeNode[] = [];

  for (const entry of entries) {
    if (isRoot && !ROOT_ALLOW.has(entry.name)) continue;

    if (entry.isDirectory()) {
      const fullPath = `${dir}/${entry.name}`;
      if (LAZY_DIRS.has(entry.name)) {
        tree.push({
          name: entry.name,
          type: "directory",
          children: await generateShallowTree(fullPath),
          lazy: true,
        });
      } else {
        tree.push({
          name: entry.name,
          type: "directory",
          children: await generateFileTree(fullPath),
        });
      }
    } else {
      tree.push({ name: entry.name, type: "file" });
    }
  }

  return tree;
}
