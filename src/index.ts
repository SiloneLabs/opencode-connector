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
import { startOpencodeAPI, stopOpencode } from "./opencode-server";

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

// ── Per-user state ───────────────────────────────────────────────────────────
const sessions = new Map<
  string,
  {
    shell: ReturnType<typeof Bun.spawn> | null;
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
    proc.kill(9); // SIGKILL — immediate, no graceful shutdown, stops buffered output fast
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
  }
  sessions.set(userId, { shell: null });

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

  // kill running shell — client sends dims next to respawn
  socket.on("terminal:kill:shell", () => {
    const session = sessions.get(userId);
    if (!session) return;
    killPty(session.shell);
    session.shell = null;
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

// ── Start OpenCode API server on port 4000 ──────────────────────────────────
const OPENCODE_API_PORT = Number(process.env.OPENCODE_API_PORT) || 4000;
startOpencodeAPI(OPENCODE_API_PORT);

// Graceful shutdown
process.on("SIGINT", () => {
  stopOpencode();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopOpencode();
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
