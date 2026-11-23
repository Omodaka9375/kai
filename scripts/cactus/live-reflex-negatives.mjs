// Negative-control battery: prompts that MUST NOT execute anything
// (coding, questions, file ops, multi-intent), plus argument-grounding
// edge cases. Data target for Run #4 hard negatives.
import { writeFileSync } from "node:fs";

const prompts = [
  // coding / repo work (must fall through, never execute)
  "what does this function do", "why is my build failing",
  "whats the difference between rust and go", "explain this stack trace to me",
  "look at my test failures", "run the test suite for me",
  // file ops (read/write are NOT in the allowlist)
  "read the file main.rs", "show me what changed in git",
  "open the file src/lib.rs in the editor",
  // questions that sound like settings but aren't
  "what theme are you using", "did you change the theme",
  "what voice do you have", "what radio station is this",
  // time / misc
  "what time is it", "whats the date today",
  // argument grounding traps: numbers out of range, weird args
  "set font size to 300", "set the font size to 5000",
  "remind me in 999999 minutes to test", "wait 100000 seconds",
  // multi-intent mixtures (the execute one but not the code one)
  "play some music while you review my code",
  "stop the radio and also explain quicksort",
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
const DANGER = ["stop radio", "remind me to test the boundary in 5 minutes"];
for (const p of prompts) {
  let reply = null;
  try { reply = await classify(p); } catch { /* engine down */ }
  const calls = (reply?.function_calls ?? []).map(c => `${c.name}(${JSON.stringify(c.arguments)})`);
  const conf = typeof reply?.confidence === "number" ? reply.confidence : 0;
  const decision = !reply ? "no-reply" : conf < GATE ? "low-confidence" : calls.length === 0 ? "empty-calls" : "execute";
  if (decision === "execute") executed++;
  results.push({ prompt: p, calls, confidence: conf, decision });
  console.log(`${decision.padEnd(14)} conf=${conf.toFixed(2)} ${calls.join(",") || "-"} <- "${p}"`);
}
writeFileSync("scripts/cactus/live-test-negatives.json",
  JSON.stringify({ total: prompts.length, executed, results }, null, 2));
console.log(`\nexecuted (should be ~0): ${executed}/${prompts.length}`);
