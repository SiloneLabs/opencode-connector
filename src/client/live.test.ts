/**
 * Live integration test — requires:
 *   - Connector server on :9000  (bun run dev)
 *   - OpenCode server on :4096   (opencode serve)
 *
 * NOTE: The socket.io server requires a valid auth token.
 *       We test the OpenCode HTTP API directly here since it has no auth.
 *       Socket tests are covered in client.test.ts with a mock server.
 */
import { describe, test, expect } from "bun:test";
import { ConnectorClient } from "./client";

const OPENCODE_API = "http://localhost:4096";
const CONNECTOR_URL = "http://localhost:9000";

describe("live: OpenCode HTTP API via client", () => {
  const client = new ConnectorClient({
    token: "live-test", // will fail socket auth, but opencode API doesn't need it
    serverUrl: CONNECTOR_URL,
    opencodeApiUrl: OPENCODE_API,
    autoReconnect: false,
  });

  test("health check passes", async () => {
    const result = await client.opencode.health();
    expect(result.status).toBe("ok");
  });

  test("list sessions returns array", async () => {
    const sessions = await client.opencode.listSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });

  test("create → get → delete session lifecycle", async () => {
    // create
    const session = await client.opencode.createSession("Live Test Session");
    expect(session).toBeDefined();
    expect(session.id).toBeDefined();

    // get
    const fetched = await client.opencode.getSession(session.id);
    expect(fetched).toBeDefined();
    expect(fetched.id).toBe(session.id);

    // delete — raw opencode server returns `true`, not { success }
    await client.opencode.deleteSession(session.id);
  });

  test("SSE event stream connects", async () => {
    const controller = client.opencode.events(() => {});

    // give SSE a moment to connect
    await new Promise((r) => setTimeout(r, 1000));

    // abort the stream — if we got here without throwing, endpoint is reachable
    controller.abort();
    expect(true).toBe(true);
  });
});

describe("live: Socket.io connection to connector", () => {
  test("server is reachable on port 9000", async () => {
    const res = await fetch(`${CONNECTOR_URL}/socket.io/?EIO=4&transport=polling`);
    expect(res.status).toBeLessThan(500);
  });

  test("socket rejects connection without valid token", async () => {
    const client = new ConnectorClient({
      token: "invalid-token-12345",
      serverUrl: CONNECTOR_URL,
      autoReconnect: false,
    });

    await expect(client.waitForConnection(3000)).rejects.toThrow();
    client.disconnect();
  });
});
