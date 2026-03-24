import { getClient } from "@/lib/opencode"
import { NextRequest, NextResponse } from "next/server"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const client = getClient()
    const result = await client.session.get({ path: { id } })
    return NextResponse.json(result.data)
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to get session", details: String(error) },
      { status: 500 }
    )
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const client = getClient()
    await client.session.delete({ path: { id } })
    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to delete session", details: String(error) },
      { status: 500 }
    )
  }
}
