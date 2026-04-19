import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";

type OpencodeClient = Awaited<ReturnType<typeof createOpencode>>["client"];
type SSEWriter = {
  write: (event: string, data: string) => Promise<void>;
  closed: boolean;
};

// Config 
const HEARTBEAT_INTERVAL_MS = 5_000; // 5s — keeps proxies from killing SSE

// State 
let client: OpencodeClient;
let server: { url: string; close(): void } | null = null;
let ready = false;
let initError: string | null = null;

// Maps sessionId → set of active SSE writers for event routing
const sessionWriters = new Map<string, Set<SSEWriter>>();

// Initialization
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT) || 4096;
const OPENCODE_URL = process.env.OPENCODE_SERVER_URL;

const initPromise = (async () => {
  try {
    if (OPENCODE_URL) {
      console.log(`[opencode-api] Connecting to existing server at ${OPENCODE_URL}...`);
      client = createOpencodeClient({ baseUrl: OPENCODE_URL });
      console.log("[opencode-api] Client connected");
    } else {
      console.log(`[opencode-api] Starting embedded server on port ${OPENCODE_PORT}...`);
      const opencode = await createOpencode({
        port: OPENCODE_PORT,
        hostname: "127.0.0.1",
        timeout: 30000,
      });
      client = opencode.client;
      server = opencode.server;
      console.log(`[opencode-api] Embedded server running at ${opencode.server.url}`);
    }
    ready = true;
    startEventBridge();
  } catch (err: any) {
    initError = err.message;
    console.error("[opencode-api] Failed to initialize:", err.message);
  }
})();

// Helpers 

/** Clean up a writer from the session map */
function removeWriter(sessionId: string, writer: SSEWriter) {
  writer.closed = true;
  sessionWriters.get(sessionId)?.delete(writer);
  if (sessionWriters.get(sessionId)?.size === 0) {
    sessionWriters.delete(sessionId);
  }
}

// Global SSE event bridge 
function startEventBridge() {
  (async () => {
    try {
      const events = await client.event.subscribe();
      for await (const event of events.stream) {
        const evt = event as any;
        const type: string = evt.type;
        const properties = evt.properties ?? evt;

        const sessionID =
          properties?.sessionID ||
          properties?.part?.sessionID ||
          properties?.info?.sessionID;

        if (sessionID) {
          const writers = sessionWriters.get(sessionID);
          if (writers) {
            const payload = JSON.stringify({ type, properties });
            writers.forEach((w) => {
              if (!w.closed) {
                w.write(type, payload).catch(() => {
                  w.closed = true;
                });
              }
            });
          }
        }
      }
    } catch (err) {
      console.error("[opencode-api] Event bridge error, retrying in 3s:", err);
      setTimeout(() => startEventBridge(), 3000);
    }
  })();
}

// Hono app 
const app = new Hono();

app.use(cors({ origin: "*" }));

// Readiness gate
app.use("*", async (c, next) => {
  if (c.req.path === "/health") return next();
  if (!ready) await initPromise;
  if (!ready) {
    return c.json({ error: "OpenCode not initialized", details: initError }, 503);
  }
  return next();
});

// Routes 

app.get("/health", (c) => {
  return c.json({ ready, error: initError });
});

// List providers & models
app.get("/providers", async (c) => {
  try {
    const result = await client.config.providers();
    const raw = (result as any).data ?? result;
    const providersList = Array.isArray(raw) ? raw : (raw.providers ?? []);
    const providers = providersList.map((p: any) => ({
      id: p.id,
      name: p.name || p.id,
      models: p.models || {},
    }));
    return c.json({ providers });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Create a session
app.post("/sessions", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const result = await client.session.create({
      body: { title: body.title || "IDE Session" },
    });
    const session = (result as any).data ?? result;
    return c.json({ id: session.id, title: session.title });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Send a prompt — returns an SSE stream of events until completion
app.post("/sessions/:id/prompt", async (c) => {
  const sessionId = c.req.param("id");
  const body = await c.req.json();

  return streamSSE(c, async (stream) => {
    const writer: SSEWriter = {
      closed: false,
      write: async (event, data) => {
        if (writer.closed) return;
        await stream.writeSSE({ event, data });
      },
    };

    // Register writer
    if (!sessionWriters.has(sessionId)) {
      sessionWriters.set(sessionId, new Set());
    }
    sessionWriters.get(sessionId)!.add(writer);

    // Clean up on client disconnect
    stream.onAbort(() => {
      removeWriter(sessionId, writer);
    });

    // Heartbeat send a ping comment every 15s to keep the connection alive
    const heartbeat = setInterval(async () => {
      if (writer.closed) {
        clearInterval(heartbeat);
        return;
      }
      try {
        await stream.writeSSE({ event: "ping", data: "" });
      } catch {
        clearInterval(heartbeat);
        removeWriter(sessionId, writer);
      }
    }, HEARTBEAT_INTERVAL_MS);

    try {
      const promptBody: any = {
        parts: [{ type: "text", text: body.text }],
      };
      if (body.providerID && body.modelID) {
        promptBody.model = {
          providerID: body.providerID,
          modelID: body.modelID,
        };
      }

      const result = await client.session.prompt({
        path: { id: sessionId },
        body: promptBody,
      });

      if (!writer.closed) {
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({
            sessionId,
            result: (result as any).data ?? result,
          }),
        });
      }
    } catch (err: any) {
      if (!writer.closed) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            sessionId,
            error: err.message,
          }),
        });
      }
    } finally {
      clearInterval(heartbeat);
      removeWriter(sessionId, writer);
    }
  });
});

// Abort a running prompt
app.post("/sessions/:id/abort", async (c) => {
  const sessionId = c.req.param("id");
  try {
    await client.session.abort({ path: { id: sessionId } });
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Get session messages history
app.get("/sessions/:id/messages", async (c) => {
  const sessionId = c.req.param("id");
  try {
    const result = await client.session.messages({ path: { id: sessionId } });
    return c.json((result as any).data ?? result);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Delete a session
app.delete("/sessions/:id", async (c) => {
  const sessionId = c.req.param("id");
  try {
    await client.session.delete({ path: { id: sessionId } });
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Export & start

export { app as opencodeApp, initPromise as opencodeReady };

export function startOpencodeAPI(port = 4000) {
  const srv = Bun.serve({
    port,
    fetch: app.fetch,
  });
  console.log(`[opencode-api] HTTP+SSE server listening on http://localhost:${port}`);
  return srv;
}

export function stopOpencode() {
  server?.close();
}
