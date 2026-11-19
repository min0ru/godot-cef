// A/B benchmark of two complete addon builds. Runs run.ts's bench scenario for
// each build in alternation and prints the medians over all rounds side by side.
// Run with the repository's Node 26; see README.md "Comparing two builds".
import { spawnSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  godot: { type: "string" }, baseline: { type: "string" }, candidate: { type: "string" },
  rounds: { type: "string", default: "3" }, output: { type: "string" },
  sizes: { type: "string", default: "1280x720,1920x1080,3840x2160" },
  mode: { type: "string", default: "accelerated" },
} });
if (!values.godot || !values.baseline || !values.candidate) {
  throw new Error("Pass --godot <Godot executable>, --baseline <addon> and --candidate <addon>");
}
const rounds = Number(values.rounds);
if (!Number.isInteger(rounds) || rounds < 1) throw new Error("--rounds must be a positive integer");
// run.ts reports one static and one animated row per size.
const expectedRows = values.sizes.split(",").length * 2;
const sides = ["baseline", "candidate"] as const;
const root = resolve(values.output ?? join(fileURLToPath(new URL("../../", import.meta.url)),
  "target/rendering-bench", String(Date.now())));
type Row = Record<string, number | string>;
const runs: Record<string, Row[][]> = { baseline: [], candidate: [] };

// Alternating the builds spreads thermal and background-load drift over both.
for (let round = 0; round < rounds; round++) for (const side of sides) {
  const output = join(root, `${side}-${round}`);
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("./run.ts", import.meta.url)),
    "--godot", values.godot, "--addon", values[side]!, "--output", output, "--scenario", "bench",
    "--bench-sizes", values.sizes, "--mode", values.mode, "--class", "CefTexture", "--thread-model", "0",
  ], { stdio: ["ignore", "ignore", "inherit"] });
  if (run.error) throw new Error(`${side} round ${round}: could not start run.ts: ${run.error.message}`);
  // run.ts also exits 1 for a case that delivered its samples, so its summary
  // decides; no evidence directory means it stopped before staging a project.
  const [evidence] = await readdir(output).catch(() => []);
  if (!evidence) throw new Error(`${side} round ${round}: run.ts wrote no evidence (exit ${run.status})`);
  const summary = JSON.parse(await readFile(join(output, evidence, "summary.json"), "utf8"));
  const result = summary.results?.[0];
  if (!Array.isArray(result?.bench) || result.bench.length !== expectedRows) {
    throw new Error(`${side} round ${round} produced ${result?.bench?.length ?? 0} of ${expectedRows} rows: ${summary.fatal ?? result?.reasons}; see ${output}`);
  }
  runs[side].push(result.bench);
  // A build can deliver its samples and still fail the harness (an exit crash).
  console.error(`${side} round ${round}: ${result.passed ? "passed" : "FAILED: " + result.reasons.join("; ")}`);
}
const metrics = ["pump_ms_med", "pump_ms_p99", "frame_ms_med", "frame_ms_p99", "page_fps", "imports"];
const table = runs.baseline[0].map((first, index) => {
  const row: Row = { size: first.size, load: first.load };
  for (const metric of metrics) for (const side of sides) {
    // Median over the rounds of this build; the mean of the middle pair when even.
    const sorted = runs[side].map(run => Number(run[index][metric])).toSorted((a, b) => a - b);
    row[`${metric}_${side}`] = Math.round(500 * (sorted[Math.floor((rounds - 1) / 2)] + sorted[Math.floor(rounds / 2)])) / 1000;
  }
  return row;
});
await writeFile(join(root, "bench.json"), JSON.stringify({ rounds, sizes: values.sizes, mode: values.mode,
  baseline: values.baseline, candidate: values.candidate, table, runs }, null, 2));

console.log(`| size | load | ${metrics.map(metric => `${metric} base → cand`).join(" | ")} |`);
console.log(`|---|---|${metrics.map(() => "---").join("|")}|`);
for (const row of table) {
  console.log(`| ${row.size} | ${row.load} | ${metrics.map(metric =>
    `${row[`${metric}_baseline`]} → ${row[`${metric}_candidate`]}`).join(" | ")} |`);
}
console.log(`\nMedians of ${rounds} round(s); every round's rows: ${join(root, "bench.json")}`);
