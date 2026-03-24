import { getClient } from "@/lib/opencode"
import { NextRequest, NextResponse } from "next/server"

export async function GET() {
  try {
    const client = getClient()
    const result = await client.session.list()
    return NextResponse.json(result.data ?? [])
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to list sessions", details: String(error) },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const client = getClient()
    const body = await req.json()
    const result = await client.session.create({
      body: { title: body.title || "New Session" },
    })
    return NextResponse.json(result.data)
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to create session", details: String(error) },
      { status: 500 }
    )
  }
}
