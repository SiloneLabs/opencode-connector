import { getClient } from "@/lib/opencode"
import { NextRequest, NextResponse } from "next/server"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const client = getClient()
    const body = await req.json()

    // Fire-and-forget: send prompt and return immediately
    // The frontend will pick up updates via SSE events
    await client.session.promptAsync({
      path: { id },
      body: {
        model: {
          providerID: body.providerID || "opencode",
          modelID: body.modelID || "big-pickle",
        },
        parts: [{ type: "text", text: body.text }],
      },
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to send prompt", details: String(error) },
      { status: 500 }
    )
  }
}
