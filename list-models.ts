import { io } from "socket.io-client";

const socket = io("http://localhost:9000", {
  auth: { token: "dev-token" },
  transports: ["websocket"],
});

socket.on("connect", () => {
  socket.emit("opencode:providers:list");
});

socket.on("opencode:providers:list:result", (providers: any[]) => {
  for (const p of providers) {
    console.log(`\n=== ${p.id} (${p.name}) ===`);
    for (const [id, model] of Object.entries(p.models || {}) as any) {
      console.log(`  ${id}: ${model.name}`);
    }
  }
  socket.disconnect();
  process.exit(0);
});

socket.on("opencode:error", (err: any) => {
  console.error("[error]", err);
  socket.disconnect();
  process.exit(1);
});

setTimeout(() => { socket.disconnect(); process.exit(1); }, 15000);
