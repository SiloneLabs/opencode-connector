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
import { createOpencode } from "@opencode-ai/sdk";

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

// ── OpenCode SDK (embedded server + client) ─────────────────────────────────
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT) || 4096;

let opencodeClient: Awaited<ReturnType<typeof createOpencode>>["client"];
let opencodeServer: Awaited<ReturnType<typeof createOpencode>>["server"];
let opencodeReady: Promise<void>;

opencodeReady = (async () => {
  try {
    console.log(`[opencode] Starting embedded server on port ${OPENCODE_PORT}...`);
    const opencode = await createOpencode({
      port: OPENCODE_PORT,
      hostname: "127.0.0.1",
    });
    opencodeClient = opencode.client;
    opencodeServer = opencode.server;
    console.log(`[opencode] Server running at ${opencode.server.url}`);

    // Start the global SSE event bridge
    startEventBridge();
  } catch (err) {
    console.error("[opencode] Failed to start embedded server:", err);
  }
})();

// ── Session → Socket routing ─────────────────────────────────────────────────
// Maps opencode sessionId → socket id, so SSE events reach the right client
const sessionToSocket = new Map<string, string>();

function startEventBridge() {
  (async () => {
    try {
      const events = await opencodeClient.event.subscribe();
      for await (const event of events.stream) {
        const evt = event as any;
        const type = evt.type;
        const properties = evt.properties ?? evt;

        // Route event to the correct socket using sessionID from properties
        const sessionID =
          properties?.sessionID ||
          properties?.part?.sessionID ||
          properties?.info?.sessionID;

        if (sessionID) {
          const socketId = sessionToSocket.get(sessionID);
          if (socketId) {
            io.to(socketId).emit("opencode:event", {
              type,
              data: { type, properties },
            });
          }
        } else {
          // Broadcast events without a sessionID (server-level events)
          io.emit("opencode:event", {
            type,
            data: { type, properties },
          });
        }
      }
    } catch (err) {
      console.error("[opencode] SSE event bridge error:", err);
      // Retry after a delay
      setTimeout(() => startEventBridge(), 3000);
    }
  })();
}

// ── Per-user state ───────────────────────────────────────────────────────────
const sessions = new Map<
  string,
  {
    shell: ReturnType<typeof Bun.spawn> | null;
    opencodeSessionId: string | null;
  }
>();

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

io.on("connection", async (socket) => {
  const userId = (socket as any).userId as string;
  console.log(`[socket] connected: userId=${userId}`);

  // kill stale session if user reconnects (e.g. page reload)
  if (sessions.has(userId)) {
    const old = sessions.get(userId)!;
    killPty(old.shell);
    // Clean up session→socket mapping
    if (old.opencodeSessionId) {
      sessionToSocket.delete(old.opencodeSessionId);
    }
  }
  sessions.set(userId, { shell: null, opencodeSessionId: null });

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
      session.shell = Bun.spawn(["bash"], {
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
    } catch (e: any) {
      // PTY terminal not supported on this platform (e.g. Windows)
      console.warn("[shell] PTY not supported:", e.message);
    }
  }

  // terminal input
  socket.on("terminal:write:shell", (data: string) => {
    sessions.get(userId)?.shell?.terminal?.write(data);
  });

  // terminal resize — spawn on first resize, then resize after
  socket.on(
    "terminal:resize:shell",
    ({ cols, rows }: { cols: number; rows: number }) => {
      const shell = sessions.get(userId)?.shell;
      if (!shell) {
        spawnShell(cols, rows);
      } else {
        shell.terminal?.resize(cols, rows);
      }
    },
  );

  // ── OpenCode SDK events ──────────────────────────────────────────────────

  socket.on(
    "opencode:session:create",
    async (data: any) => {
      await opencodeReady;
      if (!opencodeClient) {
        socket.emit("opencode:error", { error: "OpenCode not initialized" });
        return;
      }
      try {
        const result = await opencodeClient.session.create({
          body: { title: data?.title || "IDE Session" },
        });
        const session = (result as any).data ?? result;
        const sessionId = session.id;

        // Track this session for the user
        const userSession = sessions.get(userId);
        if (userSession) {
          // Clean up old session mapping
          if (userSession.opencodeSessionId) {
            sessionToSocket.delete(userSession.opencodeSessionId);
          }
          userSession.opencodeSessionId = sessionId;
        }
        sessionToSocket.set(sessionId, socket.id);

        socket.emit("opencode:session:created", {
          id: sessionId,
          title: session.title,
        });
      } catch (err: any) {
        console.error("[opencode] session.create error:", err);
        socket.emit("opencode:error", {
          error: "Failed to create session",
          details: err.message,
        });
      }
    },
  );

  socket.on(
    "opencode:prompt",
    async (data: {
      sessionId: string;
      text: string;
      providerID?: string;
      modelID?: string;
    }) => {
      await opencodeReady;
      if (!opencodeClient) {
        socket.emit("opencode:error", { error: "OpenCode not initialized" });
        return;
      }

      // Ensure the session→socket mapping is current (in case of reconnect)
      sessionToSocket.set(data.sessionId, socket.id);

      try {
        socket.emit("opencode:prompt:sent");

        const body: any = {
          parts: [{ type: "text", text: data.text }],
        };

        if (data.providerID && data.modelID) {
          body.model = {
            providerID: data.providerID,
            modelID: data.modelID,
          };
        }

        const result = await opencodeClient.session.prompt({
          path: { id: data.sessionId },
          body,
        });

        socket.emit("opencode:message:complete", {
          sessionId: data.sessionId,
          result: (result as any).data ?? result,
        });
      } catch (err: any) {
        console.error("[opencode] prompt error:", err);
        socket.emit("opencode:error", {
          error: "Prompt failed",
          details: err.message,
        });
        socket.emit("opencode:message:complete", {
          sessionId: data.sessionId,
          error: err.message,
        });
      }
    },
  );

  socket.on("opencode:abort", async (data: { sessionId: string }) => {
    await opencodeReady;
    if (!opencodeClient) return;
    try {
      await opencodeClient.session.abort({
        path: { id: data.sessionId },
      });
      socket.emit("opencode:aborted");
    } catch (err: any) {
      console.error("[opencode] abort error:", err);
    }
  });

  socket.on("opencode:providers:list", async () => {
    await opencodeReady;
    if (!opencodeClient) {
      socket.emit("opencode:providers:list:result", []);
      return;
    }
    try {
      const result = await opencodeClient.config.providers();
      const raw = (result as any).data ?? result;

      // SDK returns { providers: ProviderInfo[] } — an array, not an object
      const providersList = Array.isArray(raw) ? raw : (raw.providers ?? []);

      // Transform to the format the frontend expects
      const providers = providersList.map((provider: any) => ({
        id: provider.id,
        name: provider.name || provider.id,
        models: provider.models || {},
      }));

      socket.emit("opencode:providers:list:result", providers);
    } catch (err: any) {
      console.error("[opencode] providers.list error:", err);
      socket.emit("opencode:providers:list:result", []);
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
      if (session.opencodeSessionId) {
        sessionToSocket.delete(session.opencodeSessionId);
      }
      sessions.delete(userId);
    }
  });

  // ── All handlers registered — now do async init ────────────────────────────
  // Send initial file tree (must be AFTER handler registration to avoid race)
  try {
    const tree = await generateFileTree(PROJECT_DIR, true);
    socket.emit("file:tree", tree);
  } catch (e: any) {
    console.error("[socket] generateFileTree failed:", e.message);
  }
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

// Initialize OpenCode SDK on startup
// Graceful shutdown — close the embedded opencode server
process.on("SIGINT", () => {
  console.log("[opencode] Shutting down embedded server...");
  opencodeServer?.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  opencodeServer?.close();
  process.exit(0);
});

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
