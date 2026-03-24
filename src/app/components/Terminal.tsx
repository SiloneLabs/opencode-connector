"use client"

import { useCallback, useEffect, useRef, useState } from "react"

interface ToolState {
  status?: string
  input?: Record<string, string>
  output?: string
  title?: string
  metadata?: { output?: string; description?: string }
  time?: { start?: number; end?: number }
}

interface PartData {
  id: string
  sessionID: string
  messageID: string
  type: string
  tool?: string
  text?: string
  reason?: string
  callID?: string
  state?: ToolState
  snapshot?: string
}

interface SessionInfo {
  id: string
  title: string
}

export default function Terminal() {
  const [parts, setParts] = useState<PartData[]>([])
  const [userPrompts, setUserPrompts] = useState<{ text: string; ts: Date }[]>([])
  const [input, setInput] = useState("")
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [connected, setConnected] = useState(false)
  const [showSidebar, setShowSidebar] = useState(false)
  const [collapsedParts, setCollapsedParts] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const eventSourceRef = useRef<EventSource | null>(null)

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [parts, busy, scrollToBottom])

  // Connect SSE on mount
  useEffect(() => {
    checkHealth()
    loadSessions()
    connectSSE()
    return () => eventSourceRef.current?.close()
  }, [])

  // Filter events by active session
  const sessionRef = useRef<SessionInfo | null>(null)
  useEffect(() => {
    sessionRef.current = session
  }, [session])

  function connectSSE() {
    if (eventSourceRef.current) eventSourceRef.current.close()

    const es = new EventSource("/api/opencode/events")
    eventSourceRef.current = es

    es.onopen = () => setConnected(true)
    es.onerror = () => {
      setConnected(false)
      // Reconnect after 3s
      setTimeout(() => connectSSE(), 3000)
    }

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data)
        handleSSEEvent(event)
      } catch {}
    }
  }

  function handleSSEEvent(event: {
    type: string
    properties: Record<string, unknown>
  }) {
    const sid = sessionRef.current?.id
    if (!sid) return

    const { type, properties } = event

    if (type === "message.part.updated") {
      const part = properties.part as PartData
      if (part.sessionID !== sid) return

      setParts((prev) => {
        const idx = prev.findIndex((p) => p.id === part.id)
        if (idx >= 0) {
          const updated = [...prev]
          updated[idx] = part
          return updated
        }
        return [...prev, part]
      })
    }

    if (type === "message.part.delta") {
      const { partID, delta, sessionID } = properties as {
        partID: string
        delta: string
        sessionID: string
      }
      if (sessionID !== sid) return

      setParts((prev) =>
        prev.map((p) =>
          p.id === partID ? { ...p, text: (p.text || "") + delta } : p
        )
      )
    }

    if (type === "session.status") {
      const { sessionID, status } = properties as {
        sessionID: string
        status: { type: string }
      }
      if (sessionID !== sid) return
      setBusy(status.type === "busy")
    }
  }

  async function checkHealth() {
    try {
      const res = await fetch("/api/opencode/health")
      setConnected(res.ok)
    } catch {
      setConnected(false)
    }
  }

  async function loadSessions() {
    try {
      const res = await fetch("/api/opencode/sessions")
      if (res.ok) {
        const data = await res.json()
        setSessions(Array.isArray(data) ? data : [])
      }
    } catch {}
  }

  async function createSession(title?: string) {
    try {
      const res = await fetch("/api/opencode/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title || "Terminal Session" }),
      })
      if (res.ok) {
        const data = await res.json()
        setSession(data)
        setParts([])
        setUserPrompts([])
        loadSessions()
        return data
      }
    } catch {}
    return null
  }

  async function sendPrompt(text: string) {
    if (!text.trim()) return

    if (text.startsWith("/")) {
      const cmd = text.trim().toLowerCase()
      if (cmd === "/new") { await createSession(); return }
      if (cmd === "/clear") { setParts([]); setUserPrompts([]); return }
      if (cmd === "/health") { await checkHealth(); return }
      return
    }

    let currentSession = session
    if (!currentSession) {
      currentSession = await createSession()
      if (!currentSession) return
    }

    setUserPrompts((prev) => [...prev, { text, ts: new Date() }])
    setBusy(true)

    try {
      await fetch(`/api/opencode/sessions/${currentSession.id}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      })
    } catch {}
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    sendPrompt(input)
    setInput("")
  }

  function toggleCollapse(partId: string) {
    setCollapsedParts((prev) => {
      const next = new Set(prev)
      if (next.has(partId)) next.delete(partId)
      else next.add(partId)
      return next
    })
  }

  // Build a timeline: interleave user prompts with agent parts grouped by messageID
  function buildTimeline() {
    const timeline: {
      type: "user" | "step"
      userText?: string
      userTs?: Date
      parts?: PartData[]
    }[] = []

    // Add user prompts
    for (const up of userPrompts) {
      timeline.push({ type: "user", userText: up.text, userTs: up.ts })
    }

    // Group agent parts into steps (between step-start and step-finish)
    let currentStep: PartData[] = []
    for (const part of parts) {
      if (part.type === "step-start") {
        currentStep = [part]
      } else if (part.type === "step-finish") {
        currentStep.push(part)
        // Only add step if it has meaningful content
        const hasMeaningful = currentStep.some(
          (p) => p.type === "reasoning" || p.type === "tool" || p.type === "text"
        )
        if (hasMeaningful) {
          timeline.push({ type: "step", parts: [...currentStep] })
        }
        currentStep = []
      } else {
        currentStep.push(part)
      }
    }
    // Add any in-progress step
    if (currentStep.length > 0) {
      timeline.push({ type: "step", parts: [...currentStep] })
    }

    return timeline
  }

  const OUTPUT_COLLAPSE_LINES = 12

  function renderPart(part: PartData) {
    if (part.type === "step-start" || part.type === "step-finish") return null

    // Reasoning / Thinking
    if (part.type === "reasoning" && part.text) {
      return (
        <div key={part.id} className="my-2">
          <div className="flex items-start gap-2">
            <span className="text-[#d29922] font-semibold text-xs shrink-0">Thinking:</span>
            <p className="text-[#d29922] text-xs opacity-80 leading-relaxed">{part.text}</p>
          </div>
        </div>
      )
    }

    // Tool call
    if (part.type === "tool") {
      const tool = part.tool || "unknown"
      const input = part.state?.input
      const output = part.state?.output || part.state?.metadata?.output || ""
      const status = part.state?.status
      const desc =
        part.state?.title ||
        part.state?.metadata?.description ||
        input?.description ||
        ""
      const isRunning = status === "running" || status === "pending"
      const outputLines = output.split("\n")
      const isLong = outputLines.length > OUTPUT_COLLAPSE_LINES
      const isCollapsed = isLong && !collapsedParts.has(part.id)

      return (
        <div key={part.id} className="my-2 rounded-lg border border-[#30363d] bg-[#161b22] overflow-hidden">
          {/* Header with description */}
          {desc && (
            <div className="px-3 py-2 border-b border-[#21262d] bg-[#1c2128]">
              <span className="text-[#8b949e] text-xs"># {desc}</span>
            </div>
          )}
          {/* Command */}
          {input && (
            <div className="px-3 py-2 border-b border-[#21262d]">
              {tool === "bash" ? (
                <code className="text-[#c9d1d9] text-xs">
                  <span className="text-[#8b949e]">$ </span>
                  {input.command}
                </code>
              ) : tool === "read" ? (
                <code className="text-[#c9d1d9] text-xs">
                  <span className="text-[#8b949e]">% Read </span>
                  {input.filePath}
                </code>
              ) : tool === "write" || tool === "edit" ? (
                <code className="text-[#c9d1d9] text-xs">
                  <span className="text-[#8b949e]">% {tool.charAt(0).toUpperCase() + tool.slice(1)} </span>
                  {input.filePath || input.file_path}
                </code>
              ) : tool === "glob" ? (
                <code className="text-[#c9d1d9] text-xs">
                  <span className="text-[#8b949e]">% Glob </span>
                  {input.pattern}
                </code>
              ) : tool === "grep" ? (
                <code className="text-[#c9d1d9] text-xs">
                  <span className="text-[#8b949e]">% Grep </span>
                  {input.pattern}
                </code>
              ) : tool === "fetch" || tool === "webfetch" ? (
                <code className="text-[#c9d1d9] text-xs">
                  <span className="text-[#8b949e]">% WebFetch </span>
                  {input.url}
                </code>
              ) : (
                <code className="text-[#c9d1d9] text-xs">
                  <span className="text-[#8b949e]">% {tool} </span>
                  {Object.entries(input)
                    .filter(([k]) => k !== "description")
                    .map(([k, v]) => `${k}=${v}`)
                    .join(" ")}
                </code>
              )}
              {isRunning && (
                <span className="ml-2 text-[#d29922] text-xs animate-pulse">running...</span>
              )}
            </div>
          )}
          {/* Output */}
          {output && (
            <div className="px-3 py-2">
              <pre className="text-[#8b949e] text-xs whitespace-pre-wrap break-all leading-relaxed">
                {isCollapsed
                  ? outputLines.slice(0, OUTPUT_COLLAPSE_LINES).join("\n") + "\n..."
                  : output}
              </pre>
              {isLong && (
                <button
                  onClick={() => toggleCollapse(part.id)}
                  className="mt-1 text-[#58a6ff] text-xs hover:underline"
                >
                  {isCollapsed ? "Click to expand" : "Click to collapse"}
                </button>
              )}
            </div>
          )}
          {/* Pending state */}
          {isRunning && !output && (
            <div className="px-3 py-2">
              <span className="text-[#484f58] text-xs animate-pulse">executing...</span>
            </div>
          )}
        </div>
      )
    }

    // Text response
    if (part.type === "text" && part.text) {
      return (
        <div key={part.id} className="my-2">
          <pre className="text-[#c9d1d9] text-sm whitespace-pre-wrap break-words leading-relaxed">
            {part.text}
          </pre>
        </div>
      )
    }

    // Patch (file changes indicator)
    if (part.type === "patch") {
      return null // file changes are shown via tool calls
    }

    return null
  }

  const timeline = buildTimeline()

  return (
    <div className="flex h-screen w-[30vw] ml-auto bg-[#0d1117] text-[#c9d1d9] font-mono text-sm">
      {/* Sidebar */}
      <div
        className={`${showSidebar ? "w-64" : "w-0"} transition-all duration-200 overflow-hidden border-r border-[#30363d] bg-[#161b22] flex flex-col`}
      >
        <div className="p-3 border-b border-[#30363d] flex items-center justify-between">
          <span className="text-[#58a6ff] font-semibold text-xs uppercase tracking-wider">Sessions</span>
          <button onClick={() => createSession()} className="text-[#3fb950] hover:text-[#56d364] text-lg leading-none">+</button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-[#1f2937] ${session?.id === s.id ? "bg-[#1f2937] border-l-2 border-[#58a6ff]" : ""}`}
              onClick={() => { setSession(s); setParts([]); setUserPrompts([]) }}
            >
              <span className="truncate text-xs">{s.title || s.id?.slice(0, 8) || "unnamed"}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  fetch(`/api/opencode/sessions/${s.id}`, { method: "DELETE" }).then(() => {
                    if (session?.id === s.id) { setSession(null); setParts([]); setUserPrompts([]) }
                    loadSessions()
                  })
                }}
                className="text-[#f85149] hover:text-[#ff7b72] text-xs ml-2"
              >×</button>
            </div>
          ))}
        </div>
      </div>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Title bar */}
        <div className="flex items-center justify-between px-4 py-2 bg-[#161b22] border-b border-[#30363d]">
          <div className="flex items-center gap-3">
            <button onClick={() => setShowSidebar(!showSidebar)} className="text-[#484f58] hover:text-[#c9d1d9]">☰</button>
            <div className="flex items-center gap-2">
              <div className="flex gap-1.5">
                <div className="w-3 h-3 rounded-full bg-[#f85149]" />
                <div className="w-3 h-3 rounded-full bg-[#d29922]" />
                <div className="w-3 h-3 rounded-full bg-[#3fb950]" />
              </div>
              <span className="text-[#c9d1d9] text-xs ml-2 font-semibold">opencode</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className={`w-2 h-2 rounded-full ${connected ? "bg-[#3fb950]" : "bg-[#f85149]"}`} />
            <span className="text-[#484f58] text-xs">
              {session?.id ? `session: ${session.id.slice(0, 8)}` : "no session"}
            </span>
          </div>
        </div>

        {/* Content */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
          {timeline.length === 0 && !busy && (
            <div className="text-[#484f58] space-y-2 mt-8">
              <pre className="text-[#58a6ff] text-xs leading-tight">
{`  ___                    ____          _
 / _ \\ _ __   ___ _ __  / ___|___   __| | ___
| | | | '_ \\ / _ \\ '_ \\| |   / _ \\ / _\` |/ _ \\
| |_| | |_) |  __/ | | | |__| (_) | (_| |  __/
 \\___/| .__/ \\___|_| |_|\\____\\___/ \\__,_|\\___|
      |_|                                      `}
              </pre>
              <p className="text-sm mt-4">Give the agent a task and watch it work.</p>
              <p className="text-xs text-[#3fb950]">/new · /clear · /health</p>
            </div>
          )}

          {timeline.map((item, i) => {
            if (item.type === "user") {
              return (
                <div key={`u-${i}`} className="my-4 p-3 rounded-lg bg-[#1c2128] border border-[#30363d]">
                  <p className="text-[#c9d1d9] text-sm whitespace-pre-wrap">{item.userText}</p>
                </div>
              )
            }
            if (item.type === "step" && item.parts) {
              return (
                <div key={`s-${i}`} className="my-1">
                  {item.parts.map(renderPart)}
                </div>
              )
            }
            return null
          })}

          {busy && (
            <div className="flex items-center gap-2 my-3 ml-1">
              <div className="flex gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-[#58a6ff] animate-bounce" style={{ animationDelay: "0ms" }} />
                <div className="w-1.5 h-1.5 rounded-full bg-[#58a6ff] animate-bounce" style={{ animationDelay: "150ms" }} />
                <div className="w-1.5 h-1.5 rounded-full bg-[#58a6ff] animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          )}
        </div>

        {/* Input */}
        <div className="border-t border-[#30363d] bg-[#161b22]">
          <form onSubmit={handleSubmit} className="flex items-center px-4 py-3 gap-2">
            <span className="text-[#3fb950] shrink-0">❯</span>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(e) }
              }}
              placeholder={connected ? "Give the agent a task..." : "Connecting..."}
              disabled={busy}
              className="flex-1 bg-transparent outline-none text-[#c9d1d9] placeholder-[#484f58] font-mono text-sm disabled:opacity-50"
              autoFocus
            />
            {busy && (
              <span className="text-[#484f58] text-xs shrink-0">working...</span>
            )}
          </form>
        </div>
      </div>
    </div>
  )
}
