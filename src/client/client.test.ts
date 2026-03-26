import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { Server } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { ConnectorClient, type FileTreeNode } from "./client";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Spin up a real socket.io server on a random port, bypassing auth */
function createTestServer() {
  const server = new Server({ cors: { origin: "*" } });
  // no auth middleware — tests don't need token validation

  return new Promise<{ server: Server; port: number; url: string }>((resolve) => {
    const httpServer = require("http").createServer();
    server.attach(httpServer);
    httpServer.listen(0, () => {
      const port = httpServer.address().port;
      resolve({ server, port, url: `http://localhost:${port}` });
    });
  });
}

/** Create a ConnectorClient pointing at the test server (bypass auth) */
function createTestClient(url: string): ConnectorClient {
  return new ConnectorClient({
    token: "test-token",
    serverUrl: url,
    opencodeApiUrl: "http://localhost:19999", // intentionally wrong — HTTP tests mock fetch
    autoReconnect: false,
  });
}

/** Wait for a socket.io server to receive a connection */
function waitForServerConnection(server: Server): Promise<import("socket.io").Socket> {
  return new Promise((resolve) => server.on("connection", resolve));
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe("ConnectorClient", () => {
  let server: Server;
  let port: number;
  let url: string;
  let client: ConnectorClient;

  beforeEach(async () => {
    const ctx = await createTestServer();
    server = ctx.server;
    port = ctx.port;
    url = ctx.url;
  });

  afterEach(() => {
    client?.disconnect();
    server?.close();
  });

  // ── Connection ───────────────────────────────────────────────────────────

  describe("connection", () => {
    test("connects to server and reports connected", async () => {
      client = createTestClient(url);
      await client.waitForConnection();
      expect(client.connected).toBe(true);
      expect(client.id).toBeDefined();
    });

    test("waitForConnection times out when server is unreachable", async () => {
      client = createTestClient("http://localhost:19998");
      await expect(client.waitForConnection(500)).rejects.toThrow();
    });

    test("emits connect event", async () => {
      client = createTestClient(url);
      const connected = new Promise<void>((resolve) => client.on("connect", resolve));
      await connected;
      expect(client.connected).toBe(true);
    });

    test("disconnect cleans up", async () => {
      client = createTestClient(url);
      await client.waitForConnection();
      client.disconnect();
      expect(client.connected).toBe(false);
    });
  });

  // ── File API ─────────────────────────────────────────────────────────────

  describe("file", () => {
    test("onTree receives file tree on connect", async () => {
      const mockTree: FileTreeNode[] = [
        { name: "client", type: "directory", children: [{ name: "page.tsx", type: "file" }] },
        { name: "README.md", type: "file" },
      ];

      // server sends tree on connection
      server.on("connection", (socket) => {
        socket.emit("file:tree", mockTree);
      });

      client = createTestClient(url);

      const tree = await new Promise<FileTreeNode[]>((resolve) => {
        client.file.onTree(resolve);
      });

      expect(tree).toEqual(mockTree);
      expect(tree[0].name).toBe("client");
      expect(tree[0].children?.length).toBe(1);
    });

    test("read returns file content", async () => {
      server.on("connection", (socket) => {
        socket.on("file:read", (path: string) => {
          socket.emit("file:read:result", { path, content: "hello world" });
        });
      });

      client = createTestClient(url);
      await client.waitForConnection();

      const content = await client.file.read("client/app/page.tsx");
      expect(content).toBe("hello world");
    });

    test("read rejects on server error", async () => {
      server.on("connection", (socket) => {
        socket.on("file:read", (path: string) => {
          socket.emit("file:read:result", { path, error: "ENOENT: file not found" });
        });
      });

      client = createTestClient(url);
      await client.waitForConnection();

      await expect(client.file.read("nonexistent.ts")).rejects.toThrow("ENOENT");
    });

    test("write resolves on success", async () => {
      server.on("connection", (socket) => {
        socket.on("file:write", ({ path, content }: { path: string; content: string }) => {
          expect(content).toBe("new content");
          socket.emit("file:write:result", { path, success: true });
        });
      });

      client = createTestClient(url);
      await client.waitForConnection();

      await client.file.write("test.txt", "new content");
    });

    test("write rejects on server error", async () => {
      server.on("connection", (socket) => {
        socket.on("file:write", ({ path }: { path: string }) => {
          socket.emit("file:write:result", { path, error: "EACCES: permission denied" });
        });
      });

      client = createTestClient(url);
      await client.waitForConnection();

      await expect(client.file.write("readonly.txt", "data")).rejects.toThrow("EACCES");
    });

    test("create file resolves on success", async () => {
      server.on("connection", (socket) => {
        socket.on("file:create", ({ path, type }: { path: string; type: string }) => {
          expect(type).toBe("file");
          socket.emit("file:create:result", { path, success: true });
        });
      });

      client = createTestClient(url);
      await client.waitForConnection();

      await client.file.create("newfile.ts", "file");
    });

    test("create directory resolves on success", async () => {
      server.on("connection", (socket) => {
        socket.on("file:create", ({ path, type }: { path: string; type: string }) => {
          expect(type).toBe("directory");
          socket.emit("file:create:result", { path, success: true });
        });
      });

      client = createTestClient(url);
      await client.waitForConnection();

      await client.file.create("newdir", "directory");
    });

    test("delete resolves on success", async () => {
      server.on("connection", (socket) => {
        socket.on("file:delete", (path: string) => {
          socket.emit("file:delete:result", { path, success: true });
        });
      });

      client = createTestClient(url);
      await client.waitForConnection();

      await client.file.delete("oldfile.ts");
    });

    test("delete rejects on server error", async () => {
      server.on("connection", (socket) => {
        socket.on("file:delete", (path: string) => {
          socket.emit("file:delete:result", { path, error: "ENOENT: no such file" });
        });
      });

      client = createTestClient(url);
      await client.waitForConnection();

      await expect(client.file.delete("ghost.ts")).rejects.toThrow("ENOENT");
    });

    test("rename resolves on success", async () => {
      server.on("connection", (socket) => {
        socket.on("file:rename", ({ oldPath, newPath }: { oldPath: string; newPath: string }) => {
          socket.emit("file:rename:result", { oldPath, newPath, success: true });
        });
      });

      client = createTestClient(url);
      await client.waitForConnection();

      await client.file.rename("old.ts", "new.ts");
    });

    test("expand returns children for lazy directory", async () => {
      const children: FileTreeNode[] = [
        { name: "index.js", type: "file" },
        { name: "utils", type: "directory", children: [], lazy: true },
      ];

      server.on("connection", (socket) => {
        socket.on("file:tree:expand", (dir: string) => {
          socket.emit("file:tree:expand", { dir, tree: children });
        });
      });

      client = createTestClient(url);
      await client.waitForConnection();

      const tree = await client.file.expand("node_modules");
      expect(tree).toEqual(children);
      expect(tree[0].name).toBe("index.js");
    });

    test("onChanged fires on file change notifications", async () => {
      server.on("connection", (socket) => {
        setTimeout(() => socket.emit("file:changed", { path: "client/app/page.tsx" }), 50);
      });

      client = createTestClient(url);
      await client.waitForConnection();

      const changed = await new Promise<{ path: string }>((resolve) => {
        client.file.onChanged(resolve);
      });

      expect(changed.path).toBe("client/app/page.tsx");
    });

    test("onTree unsubscribe stops receiving events", async () => {
      server.on("connection", (socket) => {
        setTimeout(() => socket.emit("file:tree", [{ name: "a.ts", type: "file" }]), 50);
        setTimeout(() => socket.emit("file:tree", [{ name: "b.ts", type: "file" }]), 150);
      });

      client = createTestClient(url);
      await client.waitForConnection();

      const received: FileTreeNode[][] = [];
      const unsub = client.file.onTree((tree) => {
        received.push(tree);
        unsub(); // unsubscribe after first
      });

      await new Promise((r) => setTimeout(r, 300));
      expect(received.length).toBe(1);
      expect(received[0][0].name).toBe("a.ts");
    });
  });

  // ── Terminal API ─────────────────────────────────────────────────────────

  describe("terminal", () => {
    test("resize emits correct event for shell", async () => {
      const dims = new Promise<{ cols: number; rows: number }>((resolve) => {
        server.on("connection", (socket) => {
          socket.on("terminal:resize:shell", resolve);
        });
      });

      client = createTestClient(url);
      await client.waitForConnection();

      client.terminal.resize("shell", { cols: 120, rows: 40 });
      const result = await dims;
      expect(result).toEqual({ cols: 120, rows: 40 });
    });

    test("resize emits correct event for opencode", async () => {
      const dims = new Promise<{ cols: number; rows: number }>((resolve) => {
        server.on("connection", (socket) => {
          socket.on("terminal:resize:opencode", resolve);
        });
      });

      client = createTestClient(url);
      await client.waitForConnection();

      client.terminal.resize("opencode", { cols: 80, rows: 24 });
      const result = await dims;
      expect(result).toEqual({ cols: 80, rows: 24 });
    });

    test("write sends data to shell stdin", async () => {
      const written = new Promise<string>((resolve) => {
        server.on("connection", (socket) => {
          socket.on("terminal:write:shell", resolve);
        });
      });

      client = createTestClient(url);
      await client.waitForConnection();

      client.terminal.write("shell", "ls -la\n");
      expect(await written).toBe("ls -la\n");
    });

    test("write sends data to opencode stdin", async () => {
      const written = new Promise<string>((resolve) => {
        server.on("connection", (socket) => {
          socket.on("terminal:write:opencode", resolve);
        });
      });

      client = createTestClient(url);
      await client.waitForConnection();

      client.terminal.write("opencode", "help\n");
      expect(await written).toBe("help\n");
    });

    test("onData receives shell stdout", async () => {
      server.on("connection", (socket) => {
        setTimeout(() => socket.emit("terminal:data:shell", "drwxr-xr-x 5 user"), 50);
      });

      client = createTestClient(url);
      await client.waitForConnection();

      const data = await new Promise<string>((resolve) => {
        client.terminal.onData("shell", resolve);
      });

      expect(data).toBe("drwxr-xr-x 5 user");
    });

    test("onData receives opencode stdout", async () => {
      server.on("connection", (socket) => {
        setTimeout(() => socket.emit("terminal:data:opencode", "opencode v1.0"), 50);
      });

      client = createTestClient(url);
      await client.waitForConnection();

      const data = await new Promise<string>((resolve) => {
        client.terminal.onData("opencode", resolve);
      });

      expect(data).toBe("opencode v1.0");
    });

    test("onData unsubscribe stops receiving", async () => {
      server.on("connection", (socket) => {
        setTimeout(() => socket.emit("terminal:data:shell", "first"), 50);
        setTimeout(() => socket.emit("terminal:data:shell", "second"), 150);
      });

      client = createTestClient(url);
      await client.waitForConnection();

      const received: string[] = [];
      const unsub = client.terminal.onData("shell", (data) => {
        received.push(data);
        unsub();
      });

      await new Promise((r) => setTimeout(r, 300));
      expect(received).toEqual(["first"]);
    });
  });

  // ── OpenCode HTTP API ────────────────────────────────────────────────────

  describe("opencode", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    function mockFetch(status: number, body: unknown) {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }))
      ) as typeof fetch;
    }

    test("health returns status", async () => {
      mockFetch(200, [{ id: "s1" }]); // health calls /session and checks if array
      client = createTestClient(url);
      const result = await client.opencode.health();
      expect(result.status).toBe("ok");
    });

    test("listSessions returns array", async () => {
      const sessions = [{ id: "s1", title: "Session 1" }];
      mockFetch(200, sessions);
      client = createTestClient(url);
      const result = await client.opencode.listSessions();
      expect(result).toEqual(sessions);
    });

    test("createSession sends title", async () => {
      const session = { id: "s2", title: "My Session" };
      mockFetch(200, session);
      client = createTestClient(url);
      const result = await client.opencode.createSession("My Session");
      expect(result.id).toBe("s2");
      expect(result.title).toBe("My Session");
    });

    test("getSession returns session by id", async () => {
      const session = { id: "s1", title: "Test" };
      mockFetch(200, session);
      client = createTestClient(url);
      const result = await client.opencode.getSession("s1");
      expect(result.id).toBe("s1");
    });

    test("deleteSession completes", async () => {
      mockFetch(200, true);
      client = createTestClient(url);
      const result = await client.opencode.deleteSession("s1");
      expect(result).toBeDefined();
    });

    test("shell returns output", async () => {
      mockFetch(200, { output: "total 32\ndrwxr-xr-x" });
      client = createTestClient(url);
      const result = await client.opencode.shell("s1", "ls -la");
      expect(result.output).toContain("total 32");
    });

    test("prompt returns ok", async () => {
      mockFetch(200, { ok: true });
      client = createTestClient(url);
      const result = await client.opencode.prompt("s1", "explain this code");
      expect(result.ok).toBe(true);
    });

    test("throws on non-ok response", async () => {
      mockFetch(500, { error: "internal error" });
      client = createTestClient(url);
      await expect(client.opencode.health()).rejects.toThrow("OpenCode API 500");
    });

    test("shell passes provider options", async () => {
      let capturedBody: string | null = null;
      globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return Promise.resolve(new Response(JSON.stringify({ output: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }) as typeof fetch;

      client = createTestClient(url);
      await client.opencode.shell("s1", "build", {
        agent: "build",
        providerID: "opencode",
        modelID: "big-pickle",
      });

      const parsed = JSON.parse(capturedBody!);
      expect(parsed.command).toBe("build");
      expect(parsed.agent).toBe("build");
      expect(parsed.model.providerID).toBe("opencode");
      expect(parsed.model.modelID).toBe("big-pickle");
    });
  });
});
