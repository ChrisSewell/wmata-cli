#!/usr/bin/env node
// Simulator review-loop driver. Talks to a running `evenhub-simulator
// --automation-port` instance (default 9898). The simulator renders the REAL
// SDK containers, so its screenshots are the highest-fidelity check short of
// hardware. Assumes `npm run dev` (port 5273) and the simulator are already up
// (see `npm run simulate`); this script does NOT own their lifecycle.
//
// Commands:
//   node scripts/sim.mjs ping
//   node scripts/sim.mjs ready [marker]        poll console until marker seen
//   node scripts/sim.mjs console [--since N] [--clear]
//   node scripts/sim.mjs input <up|down|click|double_click>
//   node scripts/sim.mjs shot <name>           save .sim-shots/<name>.png
//   node scripts/sim.mjs steps <name>:<input>,...   shot, then per step input+shot
//
// Env: SIM_PORT (default 9898).

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.env.SIM_PORT ?? "9898";
const BASE = `http://localhost:${PORT}/api`;
const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, "..", ".sim-shots");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ping(retries = 20) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`${BASE}/ping`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`simulator automation API not reachable on :${PORT}`);
}

async function consoleEntries(since) {
  const url = since != null ? `${BASE}/console?since_id=${since}` : `${BASE}/console`;
  const r = await fetch(url);
  const j = await r.json();
  return j.entries ?? [];
}

async function clearConsole() {
  await fetch(`${BASE}/console`, { method: "DELETE" });
}

async function waitForMarker(marker, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await consoleEntries();
    if (entries.some((e) => String(e.message).includes(marker))) return entries;
    await sleep(300);
  }
  throw new Error(`marker not seen within ${timeoutMs}ms: ${marker}`);
}

async function input(action) {
  const r = await fetch(`${BASE}/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (!r.ok) throw new Error(`input ${action} failed: HTTP ${r.status}`);
  await sleep(350); // honor the ~300ms swipe cooldown + let the render settle
}

async function shot(name) {
  await mkdir(SHOTS, { recursive: true });
  const r = await fetch(`${BASE}/screenshot/glasses`);
  if (!r.ok) throw new Error(`screenshot failed: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const path = resolve(SHOTS, `${name}.png`);
  await writeFile(path, buf);
  console.log(`shot ${name} -> ${path} (${buf.length} bytes)`);
  return path;
}

function reportErrors(entries) {
  const errs = entries.filter((e) => e.level === "error");
  if (errs.length) {
    console.error(`!! ${errs.length} console error(s):`);
    for (const e of errs) console.error(`   ${e.message}`);
    return false;
  }
  return true;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "ping":
      await ping();
      console.log("pong");
      break;
    case "ready": {
      await ping();
      const entries = await waitForMarker(rest[0] ?? "card");
      console.log(`ready (${entries.length} console lines)`);
      reportErrors(entries);
      break;
    }
    case "console": {
      const clear = rest.includes("--clear");
      const si = rest.indexOf("--since");
      const since = si >= 0 ? Number(rest[si + 1]) : undefined;
      if (clear) {
        await clearConsole();
        console.log("console cleared");
      } else {
        const entries = await consoleEntries(since);
        for (const e of entries) console.log(`[${e.id}] ${e.level}: ${e.message}`);
      }
      break;
    }
    case "input":
      await ping();
      await input(rest[0]);
      console.log(`input ${rest[0]} sent`);
      break;
    case "shot":
      await ping();
      await shot(rest[0] ?? "shot");
      break;
    case "steps": {
      // "name0:none,name1:down,name2:click" — shot name0 first (no input),
      // then for each subsequent: send its input, then shot.
      await ping();
      const steps = (rest[0] ?? "").split(",").filter(Boolean).map((s) => {
        const [name, action] = s.split(":");
        return { name, action };
      });
      let first = true;
      for (const { name, action } of steps) {
        if (!first && action && action !== "none") await input(action);
        await shot(name);
        first = false;
      }
      break;
    }
    default:
      console.error("usage: sim.mjs <ping|ready|console|input|shot|steps> ...");
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(String(e.message ?? e));
  process.exit(1);
});
