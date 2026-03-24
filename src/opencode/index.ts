import { Hono } from "hono";
import { cors } from "hono/cors";

const OPENCODE_BASE_URL =
  process.env.OPENCODE_BASE_URL || "http://localhost:4096";

const app = new Hono();

app.use(cors({ origin: "*" }));

// Health check
app.get("/health", async (c) => {
  try {
    const res = await fetch(`${OPENCODE_BASE_URL}/session`);
    if (res.ok) return c.json({ status: "ok" });
    return c.json({ error: "OpenCode server returned unexpected response" }, 503);
  } catch (error) {
    return c.json({ error: "OpenCode server not reachable", details: String(error) }, 503);
  }
});

// List sessions
app.get("/sessions", async (c) => {
  try {
    const res = await fetch(`${OPENCODE_BASE_URL}/session`);
    const data = await res.json();
    return c.json(data);
  } catch (error) {
    return c.json({ error: "Failed to list sessions", details: String(error) }, 500);
  }
});

// Create session
app.post("/sessions", async (c) => {
  try {
    const body = await c.req.json();
    const res = await fetch(`${OPENCODE_BASE_URL}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: body.title || "New Session" }),
    });
    const data = await res.json();
    return c.json(data);
  } catch (error) {
    return c.json({ error: "Failed to create session", details: String(error) }, 500);
  }
});

// Get session
app.get("/sessions/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const res = await fetch(`${OPENCODE_BASE_URL}/session/${id}`);
    const data = await res.json();
    return c.json(data);
  } catch (error) {
    return c.json({ error: "Failed to get session", details: String(error) }, 500);
  }
});

// Delete session
app.delete("/sessions/:id", async (c) => {
  try {
    const id = c.req.param("id");
    await fetch(`${OPENCODE_BASE_URL}/session/${id}`, { method: "DELETE" });
    return c.json({ success: true });
  } catch (error) {
    return c.json({ error: "Failed to delete session", details: String(error) }, 500);
  }
});

// Run shell command in session
app.post("/sessions/:id/shell", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json();

    const res = await fetch(`${OPENCODE_BASE_URL}/session/${id}/shell`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: body.command,
        agent: body.agent || "build",
        model: {
          providerID: body.providerID || "opencode",
          modelID: body.modelID || "big-pickle",
        },
      }),
    });

    const data = (await res.json()) as { parts?: unknown[] };
    const parts: unknown[] = data?.parts ?? [];

    type ToolPart = {
      type: string;
      state?: { output?: string; metadata?: { output?: string } };
    };

    const output = (parts as ToolPart[])
      .filter((p) => p.type === "tool")
      .map((p) => p.state?.output || p.state?.metadata?.output || "")
      .filter(Boolean)
      .join("\n");

    if (!output) {
      const msgRes = await fetch(`${OPENCODE_BASE_URL}/session/${id}/message`);
      const messages = (await msgRes.json()) as Array<{ parts?: ToolPart[] }>;
      if (Array.isArray(messages) && messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        const msgOutput = (lastMsg.parts ?? [])
          .filter((p) => p.type === "tool")
          .map((p) => p.state?.output || p.state?.metadata?.output || "")
          .filter(Boolean)
          .join("\n");
        if (msgOutput) return c.json({ output: msgOutput });
      }
    }

    return c.json({ output: output || "(command completed with no output)" });
  } catch (error) {
    return c.json({ error: "Failed to run shell command", details: String(error) }, 500);
  }
});

// Send prompt to session (fire-and-forget)
app.post("/sessions/:id/prompt", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json();

    await fetch(`${OPENCODE_BASE_URL}/session/${id}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: {
          providerID: body.providerID || "opencode",
          modelID: body.modelID || "big-pickle",
        },
        parts: [{ type: "text", text: body.text }],
      }),
    });

    return c.json({ ok: true });
  } catch (error) {
    return c.json({ error: "Failed to send prompt", details: String(error) }, 500);
  }
});

// SSE events proxy
app.get("/events", async (c) => {
  try {
    const upstream = await fetch(`${OPENCODE_BASE_URL}/event`, {
      headers: { Accept: "text/event-stream" },
    });

    if (!upstream.ok || !upstream.body) {
      return c.text("Failed to connect to OpenCode event stream", 502);
    }

    return new Response(upstream.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    return c.text(`Failed to connect to OpenCode event stream: ${error}`, 502);
  }
});

const PORT = Number(process.env.OPENCODE_API_PORT) || 4097;

console.log(`OpenCode API server running at http://localhost:${PORT}`);
console.log(`Proxying to OpenCode at ${OPENCODE_BASE_URL}`);

export default {
  port: PORT,
  fetch: app.fetch,
};
