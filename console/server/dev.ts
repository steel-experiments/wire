// ABOUTME: Dev orchestrator — runs the Vite frontend and the Hono API together.
// ABOUTME: `bun run dev` boots both; Ctrl-C tears both down.

export {};

const SERVER_PORT = process.env.PORT ?? "3000";

const children = [
  Bun.spawn(["bun", "run", "--watch", "server/index.ts"], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, PORT: SERVER_PORT },
  }),
  Bun.spawn(["bun", "x", "vite"], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env },
  }),
];

function shutdown(): void {
  for (const child of children) child.kill();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.race(children.map((child) => child.exited));
shutdown();
