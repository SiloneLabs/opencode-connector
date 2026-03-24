import { getClient } from "@/lib/opencode"
import { NextResponse } from "next/server"

export async function GET() {
  try {
    const client = getClient()
    const result = await client.session.list()
    if (result.data) {
      return NextResponse.json({ status: "ok" })
    }
    return NextResponse.json(
      { error: "OpenCode server returned unexpected response" },
      { status: 503 }
    )
  } catch (error) {
    return NextResponse.json(
      { error: "OpenCode server not reachable", details: String(error) },
      { status: 503 }
    )
  }
}
