// Variation battery for Run #4 mining: same live-engine protocol as
// live-reflex-test.mjs, but focused on VARIATIONS of the weak spots found
// in the first live test (low-confidence fallthroughs + the drift cases).
import { writeFileSync } from "node:fs";

const prompts = [
  // ── "play ambient radio" was unstable (0.49 -> 0.92): probe the ambient/music family
  "play ambient music", "put on some ambient", "start the radio",
  "play some chill music", "turn on the radio", "radio on",
  "play the downtempo station", "put on groove salad",
  // ── song info / stations: low conf last time
  "what's playing", "what is playing on the radio", "now playing",
  "show me the radio stations", "what stations are there",
  "which stations can I pick from", "whats playing right now",
  // ── color mode: "switch to dark mode" was 0.71, just under the gate
  "dark mode please", "turn on dark mode", "go dark",
  "dark theme", "light mode", "turn off dark mode",
  "make it dark", "enable dark mode", "night mode",
  // ── personas: never crossed the gate
  "use the coder agent", "become a coder", "switch persona to writer",
  "I want the architect persona", "turn on the reviewer",
  // ── reminder phrasing variations
  "in 10 minutes remind me to check the oven", "set a timer for 5 minutes",
  "ping me in an hour", "remind me at 6pm to leave",
  "what are my reminders", "show my reminders",
  "remind me to call mom tomorrow morning", "set a reminder for 30 minutes from now",
  // ── voice
  "read your answers out loud", "mute the voice", "use the nova voice",
  "speak with echo voice", "stop speaking replies", "turn on voice replies",
  // ── preview
  "open the preview for port 3000", "show me localhost 3000",
  "preview localhost 8080", "show the dev server page",
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

const results = [];
let executed = 0;
for (const p of prompts) {
  let reply = null;
  try { reply = await classify(p); } catch { /* engine down */ }
  const calls = (reply?.function_calls ?? []).map(c => c.name);
  const conf = typeof reply?.confidence === "number" ? reply.confidence : 0;
  const decision = !reply ? "no-reply" : conf < GATE ? "low-confidence" : calls.length === 0 ? "empty-calls" : "execute";
  if (decision === "execute") executed++;
  results.push({ prompt: p, calls, confidence: conf, decision, reasoning: reply?.reasoning ?? null });
  console.log(`${decision.padEnd(14)} conf=${conf.toFixed(2)} ${calls.join(",") || "-"} <- "${p}"`);
}
writeFileSync("scripts/cactus/live-test-variations.json",
  JSON.stringify({ total: prompts.length, executed, results }, null, 2));
console.log(`\nexecuted ${executed}/${prompts.length}`);
