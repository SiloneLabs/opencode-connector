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
  watch,
} from "fs/promises";
import { resolve } from "path";
import { cors } from "hono/cors";
import { fetchUserIdFromToken } from "./helper";

const io = new Server({ cors: { origin: "*" } });
const engine = new Engine();

io.bind(engine);

io.use(async (socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.query.token;

  if (!token) return next(new Error("missing token"));

  const userId = await fetchUserIdFromToken(token as string);
  if (!userId) {
    console.error("fatal: token validation returned null userId, crashing");
    process.exit(1);
  }

  (socket as any).userId = userId;
  next();
});

const PROJECT_DIR = "./project";
const PROJECT_DIR_ABS = resolve(PROJECT_DIR);

/** resolve a user-supplied path safely within the project dir */
function safePath(userPath: string): string {
  const abs = resolve(PROJECT_DIR_ABS, userPath);
  if (!abs.startsWith(PROJECT_DIR_ABS + "/") && abs !== PROJECT_DIR_ABS) {
    throw new Error("path escapes project directory");
  }
  return abs;
}

io.on("connection", async (socket) => {
  // send initial file tree
  const tree = await generateFileTree(PROJECT_DIR, true);
  socket.emit("file:tree", tree);

  socket.on("file:tree:expand", async (dir: string) => {
    try {
      const safeDir = safePath(dir);
      const tree = await generateFileTree(safeDir);
      socket.emit("file:tree:expand", { dir, tree });
    } catch (e: any) {
      socket.emit("file:tree:expand", { dir, tree: [], error: e.message });
    }
  });

  // deferred terminal spawn — wait for client to send dimensions
  let shell: ReturnType<typeof Bun.spawn> | null = null;
  let opencode: ReturnType<typeof Bun.spawn> | null = null;

  function spawnShell(cols: number, rows: number) {
    if (shell) return;
    shell = Bun.spawn(["bash"], {
      cwd: PROJECT_DIR_ABS,
      env: {
        TERM: "xterm-256color",
        HOME: PROJECT_DIR_ABS,
        PATH: process.env.PATH || "",
      },
      terminal: {
        cols,
        rows,
        data(_t: any, d: Uint8Array) {
          socket.emit("terminal:data:shell", Buffer.from(d).toString());
        },
      },
    });
  }

  function spawnOpencode(cols: number, rows: number) {
    if (opencode) return;
    const userId = (socket as any).userId;
    opencode = Bun.spawn(["opencode"], {
      cwd: PROJECT_DIR_ABS,
      env: {
        TERM: "xterm-256color",
        PATH: process.env.PATH || "",
        ANTHROPIC_API_KEY: userId,
      },
      terminal: {
        cols,
        rows,
        data(_t: any, d: Uint8Array) {
          socket.emit("terminal:data:opencode", Buffer.from(d).toString());
        },
      },
    });
  }

  // terminal input
  socket.on("terminal:write:shell", (data: string) => {
    shell?.terminal?.write(data);
  });
  socket.on("terminal:write:opencode", (data: string) => {
    opencode?.terminal?.write(data);
  });

  // terminal resize — spawn on first resize, then resize after
  socket.on(
    "terminal:resize:shell",
    ({ cols, rows }: { cols: number; rows: number }) => {
      if (!shell) {
        spawnShell(cols, rows);
      } else {
        shell.terminal?.resize(cols, rows);
      }
    },
  );
  socket.on(
    "terminal:resize:opencode",
    ({ cols, rows }: { cols: number; rows: number }) => {
      if (!opencode) {
        spawnOpencode(cols, rows);
      } else {
        opencode.terminal?.resize(cols, rows);
      }
    },
  );

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
    shell?.kill();
    shell?.terminal?.close();
    opencode?.kill();
    opencode?.terminal?.close();
  });
});

// watch project dir, debounce + push refreshed tree to all clients
let debounceTimer: Timer | null = null;

(async () => {
  const watcher = watch(PROJECT_DIR_ABS, { recursive: true });
  for await (const event of watcher) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const tree = await generateFileTree(PROJECT_DIR, true);
      io.emit("file:tree", tree);
    }, 300);
  }
})();

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
const LAZY_DIRS = new Set(["node_modules", "target"]);

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
