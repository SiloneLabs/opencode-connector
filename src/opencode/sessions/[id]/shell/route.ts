import { getClient } from "@/lib/opencode"
import { NextRequest, NextResponse } from "next/server"

interface ToolPart {
  type: "tool"
  tool?: string
  state?: {
    status?: string
    output?: string
    input?: { command?: string }
    metadata?: { output?: string }
  }
}

function extractShellOutput(parts: unknown[]): string {
  return parts
    .filter((p): p is ToolPart => {
      const part = p as Record<string, unknown>
      return part.type === "tool"
    })
    .map((p) => p.state?.output || p.state?.metadata?.output || "")
    .filter(Boolean)
    .join("\n")
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const client = getClient()
    const body = await req.json()

    const result = await client.session.shell({
      path: { id },
      body: {
        command: body.command,
        agent: body.agent || "build",
        model: {
          providerID: body.providerID || "opencode",
          modelID: body.modelID || "big-pickle",
        },
      },
    })

    // The response has parts with tool state containing output
    const data = result.data as { parts?: unknown[] } | undefined
    const parts = data && "parts" in data ? (data.parts ?? []) : []
    const output = extractShellOutput(parts)

    // If no tool output, fall back to fetching messages
    if (!output) {
      const messagesResult = await client.session.messages({ path: { id } })
      const messages = messagesResult.data
      if (Array.isArray(messages) && messages.length > 0) {
        const lastMsg = messages[messages.length - 1]
        const msgOutput = extractShellOutput(lastMsg.parts ?? [])
        if (msgOutput) {
          return NextResponse.json({ output: msgOutput })
        }
      }
    }

    return NextResponse.json({
      output: output || "(command completed with no output)",
    })
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to run shell command", details: String(error) },
      { status: 500 }
    )
  }
}
