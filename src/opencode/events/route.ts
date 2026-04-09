const OPENCODE_BASE_URL = process.env.OPENCODE_BASE_URL || "http://127.0.0.1:4096"

export async function GET() {
  // Proxy the raw SSE stream from OpenCode server
  const upstream = await fetch(`${OPENCODE_BASE_URL}/event`, {
    headers: { Accept: "text/event-stream" },
  })

  if (!upstream.ok || !upstream.body) {
    return new Response("Failed to connect to OpenCode event stream", { status: 502 })
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
}
