// ABOUTME: Tests for the request-origin guard: cross-origin state-changing
// ABOUTME: requests are rejected, reads and same-origin/no-origin requests pass.

import { test, expect } from "bun:test";
import { Hono } from "hono";
import { rejectCrossOriginWrites } from "./security";

const app = new Hono();
app.use("/api/*", rejectCrossOriginWrites);
app.post("/api/runs", (c) => c.json({ ok: true }));
app.get("/api/runs", (c) => c.json({ ok: true }));

test("rejects a POST from a foreign origin", async () => {
  const res = await app.request("/api/runs", {
    method: "POST",
    headers: { origin: "https://evil.example" },
  });
  expect(res.status).toBe(403);
});

test("allows a POST from the dev SPA origin (Vite proxy)", async () => {
  const res = await app.request("/api/runs", {
    method: "POST",
    headers: { origin: "http://localhost:5177" },
  });
  expect(res.status).toBe(200);
});

test("allows a POST from the prod SPA origin", async () => {
  const res = await app.request("/api/runs", {
    method: "POST",
    headers: { origin: "http://127.0.0.1:3000" },
  });
  expect(res.status).toBe(200);
});

test("allows a POST with no Origin header (curl/scripts)", async () => {
  const res = await app.request("/api/runs", { method: "POST" });
  expect(res.status).toBe(200);
});

test("does not gate GET requests on origin", async () => {
  const res = await app.request("/api/runs", {
    method: "GET",
    headers: { origin: "https://evil.example" },
  });
  expect(res.status).toBe(200);
});

test("rejects a prefix-spoofed origin", async () => {
  const res = await app.request("/api/runs", {
    method: "POST",
    headers: { origin: "http://localhost.evil.example" },
  });
  expect(res.status).toBe(403);
});
