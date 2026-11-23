// Run a battery of reflex prompts against the live engine (127.0.0.1:8941),
// the same way the Rust reflex_classify does: POST /complete then POST /reset.
// Records engine replies + gate decisions into scripts/cactus/live-test-results.json
const prompts = [
  // radio
  "play ambient radio", "stop the radio", "play some music", "stop the music",
  "what song is playing", "list radio stations", "play groove salad",
  // settings / theme
  "switch to dark mode", "make the theme amber", "use the nord theme",
  "switch to light mode", "set theme back to default", "change theme to tokyo night",
  // reminders
  "remind me in 15 minutes to stretch", "what reminders do I have",
  "remind me tomorrow at 9am to take out the trash", "cancel my reminders",
  // voice
  "speak replies with the alloy voice", "turn off voice replies",
  // personas
  "switch to the coder persona", "activate the architect agent",
  // preview / sleep
  "open the preview", "preview localhost 5173", "wait 5 seconds",
  // negatives: must fall through
  "fix the race condition in agent.ts", "what is the capital of France",
  "read the file src/main.ts", "play ambient radio and also fix my bug in auth",
];

const GATE = 0.75;

async function classify(prompt) {
  const r = await fetch("http://127.0.0.1:8941/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: prompt }),
  });
  const reply = await r.json();
  await fetch("http://127.0.0.1:8941/reset", { method: "POST" }).catch(() => {});
  return reply;
}

import { writeFileSync } from "node:fs";
const results = [];
let executed = 0, fallthrough = 0, wrongLooks = [];
for (const p of prompts) {
  let reply = null, error = null;
  try { reply = await classify(p); } catch (e) { error = String(e); }
  const calls = (reply?.function_calls ?? []).map(c => c.name);
  const conf = typeof reply?.confidence === "number" ? reply.confidence : 0;
  const decision = !reply ? "no-reply" : conf < GATE ? "low-confidence" : calls.length === 0 ? "empty-calls" : "execute";
  if (decision === "execute") executed++; else fallthrough++;
  results.push({ prompt: p, calls, confidence: conf, decision, reasoning: reply?.reasoning ?? null, error });
  const line = `${decision.padEnd(14)} conf=${conf.toFixed(2)} ${calls.join(",") || "-"} <- "${p}"`;
  console.log(line);
  if (reply?.reasoning) { }
}
const summary = { total: prompts.length, executed, fallthrough, results };
writeFileSync("scripts/cactus/live-test-results.json", JSON.stringify(summary, null, 2));
console.log(`\nexecuted ${executed}/${prompts.length}, fell through ${fallthrough}`);
