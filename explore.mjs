#!/usr/bin/env node
/**
 * The way in.
 *
 *   node explore.mjs        interactive menu
 *   node explore.mjs 2      run one item and exit
 *   node explore.mjs all    run everything, top to bottom
 *
 * Zero dependencies — it needs Node 22 and nothing else, so it works on a bare
 * clone before `npm ci`. Items that need the installed toolchain say so and
 * offer the command instead of failing.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WIDTH = Math.min(process.stdout.columns || 84, 84);
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;

const c = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const cyan = (s) => c("36", s);
const green = (s) => c("32", s);
const red = (s) => c("31", s);

function header(title) {
  console.log("");
  console.log(bold(title));
  console.log(dim("─".repeat(Math.min(title.length, WIDTH))));
}

function rule(label = "") {
  if (!label) return void console.log(dim("─".repeat(WIDTH - 2)));
  console.log(dim(`── ${label} ` + "─".repeat(Math.max(WIDTH - label.length - 6, 2))));
}

function wrap(text, width = WIDTH - 2) {
  const out = [];
  let line = "";
  for (const word of String(text).split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

const note = (t) => wrap(t).forEach((l) => console.log(dim(l)));
const bullet = (t) =>
  wrap(t, WIDTH - 6).forEach((l, i) => console.log(`  ${i === 0 ? "·" : " "} ${l}`));

const installed = () => existsSync(join(HERE, "node_modules"));

function needInstall() {
  if (installed()) return true;
  console.log(red("  the toolchain isn't installed yet."));
  console.log("");
  bullet("npm ci");
  console.log("");
  note("Every other item works from a bare clone — they read committed source.");
  return false;
}

function countFiles(dir, test) {
  const root = join(HERE, dir);
  if (!existsSync(root)) return 0;
  let n = 0;
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    if (statSync(p).isDirectory()) n += countFiles(join(dir, entry), test);
    else if (test(entry)) n += 1;
  }
  return n;
}

// ==========================================================================

const AUTHORITY = [
  [
    "model execution is off until an operator turns it on",
    "src/economics/model-execution-enablement.ts",
    "A durable enablement record has to exist. Absent, malformed, or expired means no model call — not a warning, not a default-on with a flag.",
  ],
  [
    "the gateway refuses a non-loopback bind",
    "src/gateway/server.ts",
    "HOST must resolve to loopback. The process exits rather than starting a listener that anyone else can reach.",
  ],
  [
    "an agent's authority comes from grant rows, not from what it asks for",
    "src/agents/access-control-repository.ts",
    "Each agent has a home scope in the database; tool and memory-sleeve grants are separate rows pinned to a scope version. Authority is looked up, never supplied — and a grant bound to a stale version does not carry forward when the scope changes.",
  ],
  [
    "mainnet settlement needs an approval keyed to its exact parameters",
    "src/task-market/x402-runtime.ts",
    "Testnet accepts one frozen network and facilitator, both literals. Mainnet additionally requires an approval record whose SHA-256 digest covers network, facilitator, payTo, price, and base URL — so approving one configuration approves nothing else, and changing a single field invalidates it.",
  ],
  [
    "every omitted fact is accounted for, not silently dropped",
    "src/knowledge/lexical-retrieval-service.ts",
    "Retrieval returns a reason for each fragment it declined — expired, superseded, not_yet_valid, validity_ended, retrieval_disabled, result_limit. An empty result set is explained rather than indistinguishable from 'nothing matched'.",
  ],
];

function itemOverview() {
  header("What this is");
  note(
    "A fail-closed control plane for a multi-tenant AI automation agency. " +
      "Durable priority queue, tenant-isolated memory, cost-aware model " +
      "routing, and a 45-profile agent catalog — with every outward-facing " +
      "action gated behind an explicit, typed authorization record.",
  );
  console.log("");
  rule("the inversion");
  console.log("");
  note(
    "Most agent frameworks are permissive by default: the agent can act, and " +
      "guardrails are bolted on to stop it. This one inverts that. Authority " +
      "is a typed record that must exist before an action is possible — not a " +
      "prompt instruction, and not a policy check the agent can talk its way " +
      "past.",
  );
  console.log("");
  note(
    "It is easy to make an agent do things. The engineering is in making it " +
      "provably not do things, which is what most of the test suite is about.",
  );
  console.log("");
  rule("scale");
  console.log("");
  const tests = countFiles("tests", (n) => n.endsWith(".test.ts"));
  const src = countFiles("src", (n) => n.endsWith(".ts"));
  console.log(`  ${cyan("2,238")} tests across ${cyan(String(tests))} files`);
  console.log(`  ${cyan(String(src))} TypeScript source files`);
  console.log(`  ${cyan("45")} capability-scoped agent profiles over 9 archetypes`);
  console.log(`  ${cyan("5")} interchangeable memory backends behind one seam`);
  console.log(`  ${cyan("8")} memory architectures ranked under equal token budgets`);
}

function itemAuthority() {
  header("Five things it will not do");
  note(
    "Each of these is enforced in code, not in a prompt. The file is where " +
      "to check the claim.",
  );
  console.log("");
  for (const [claim, path, why] of AUTHORITY) {
    const exists = existsSync(join(HERE, path));
    console.log(`  ${exists ? green("✓") : dim("·")} ${bold(claim)}`);
    wrap(why, WIDTH - 6).forEach((l) => console.log(`    ${dim(l)}`));
    console.log(`    ${dim(path)}`);
    console.log("");
  }
  rule("see it in the suite");
  console.log("");
  note(
    "Authority boundaries, refusal paths, and tenant isolation are covered as " +
      "behaviour rather than as documentation. Item 6 runs the whole suite; " +
      "the fastest targeted look is:",
  );
  console.log("");
  console.log(`  ${dim("npx vitest run tests/agents/access-control-repository.test.ts")}`);
  console.log(`  ${dim("npx vitest run tests/models/model-executor.test.ts")}`);
}

function itemMemory() {
  header("The memory experiment");
  note(
    "Eight memory architectures ranked under enforced-equal token budgets: " +
      "FlatTag, TypedBasic, TypedTemporal, Hierarchical, GraphAssist, " +
      "EpisodeOnly, FactOnly, HybridLedger.",
  );
  console.log("");
  note(
    "Exactly one axis varies per arm — storage representation, retrieval " +
      "policy, consolidation policy, scope policy, forgetting policy. " +
      "Weights, seeds, prompts, tools, the simulated clock, and replay traces " +
      "are frozen across all arms, so an effect can be attributed to the " +
      "representation rather than to an opaque bundle.",
  );
  console.log("");
  rule("the part worth stealing");
  console.log("");
  note(
    "The harness refuses to report a comparison it cannot make fairly. A " +
      "fairness budget checks admissibility before anything is ranked, and an " +
      "inadmissible comparison returns a refusal rather than a number with a " +
      "caveat attached.",
  );
  console.log("");
  const dir = join(HERE, "src/memory/experiment");
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".ts")).sort()) {
      const lines = readFileSync(join(dir, name), "utf8").split("\n").length;
      console.log(`  src/memory/experiment/${name.padEnd(30)} ${dim(`${lines} lines`)}`);
    }
  }
  console.log("");
  note(
    "The flat_untyped arm exists only as a control: it returns superseded and " +
      "expired facts by design, which is how the leak-rate comparison gets an " +
      "honest baseline.",
  );
}

function itemAgents() {
  header("The agent catalog");
  note(
    "45 capability-scoped profiles over 9 archetypes. The tree is an " +
      "organisational convenience: containment grants no tool, memory, " +
      "tenant, or wallet authority. A child agent inherits nothing it was not " +
      "separately granted.",
  );
  console.log("");
  const dir = join(HERE, "src/agents");
  if (existsSync(dir)) {
    const files = readdirSync(dir).filter((n) => n.endsWith(".ts")).sort();
    for (const name of files.slice(0, 14)) {
      console.log(`  src/agents/${name}`);
    }
    if (files.length > 14) console.log(dim(`  … ${files.length - 14} more`));
  }
  console.log("");
  rule("skill routing");
  console.log("");
  note(
    "One always-loaded router dispatches to seven on-demand lane references. " +
      "Only the matching lane enters the context window — the other six cost " +
      "nothing, which is the difference between a skill library and a context " +
      "budget problem.",
  );
  const skills = join(HERE, "skills/jarvis-workflows");
  if (existsSync(skills)) {
    console.log("");
    for (const name of readdirSync(skills).sort().slice(0, 10)) {
      console.log(`  ${dim(`skills/jarvis-workflows/${name}`)}`);
    }
  }
}

function itemDashboard() {
  header("The dashboard");
  note(
    "Runs on deterministic local data with no API keys — model execution is " +
      "off by default. The gateway binds loopback only and refuses to start " +
      "otherwise.",
  );
  console.log("");
  for (const [file, what] of [
    ["docs/assets/jarvis-today-desktop.png", "Today — the operator's command surface"],
    ["docs/assets/agent-workbench-desktop.png", "Agent Workbench"],
    ["docs/assets/memory-graph-desktop.png", "the memory graph"],
    ["docs/assets/jarvis-redesign-mobile.png", "mobile"],
  ]) {
    const mark = existsSync(join(HERE, file)) ? green("✓") : dim("·");
    console.log(`  ${mark} ${file.padEnd(44)} ${dim(what)}`);
  }
  console.log("");
  rule("run it yourself");
  console.log("");
  console.log(`  ${cyan("npm ci && npm run build && npm start")}`);
  console.log(`  ${dim("then open http://127.0.0.1:3000/dashboard")}`);
  console.log("");
  note("On macOS, `open docs/assets` browses the screenshots without building.");
}

function itemTests() {
  header("The suite is the specification");
  note(
    "2,238 tests. Authority boundaries, refusal paths, and tenant isolation " +
      "are covered as behaviour, not as documentation — which is what keeps " +
      "AI-generated code honest in a repository written this fast.",
  );
  if (!needInstall()) return;
  console.log("");
  const r = spawnSync("npm", ["test"], { cwd: HERE, stdio: "inherit" });
  if (r.status !== 0) {
    console.log("");
    note("If the build is stale: npm run build");
  }
}

function itemSource() {
  header("Where everything is");
  console.log("");
  for (const [path, what] of [
    ["src/economics/model-execution-enablement.ts", "deny-by-default model execution"],
    ["src/economics/model-router.ts", "cheapest tier that satisfies the policy"],
    ["src/economics/context-budget.ts", "reserved partitions; safety can't be crowded out"],
    ["src/knowledge/lexical-retrieval-service.ts", "FTS5 BM25 retrieval with abstention"],
    ["src/knowledge/context-compiler.ts", "pre-turn compiler; utility-per-token ranking"],
    ["src/memory/system/", "five swappable backends behind one seam"],
    ["src/memory/experiment/", "the frozen 8-arm experiment table"],
    ["src/agents/", "45 capability-scoped profiles"],
    ["src/models/", "Claude, Codex, Gemini, Ollama behind one interface"],
    ["skills/jarvis-workflows/", "the router and its seven lanes"],
    ["SPEC.md", "the system specification"],
    ["docs/DECISIONS.md", "the decision log, including the reversals"],
    ["docs/VULNERABILITIES.md", "known weaknesses, kept current"],
  ]) {
    const p = join(HERE, path);
    let hint = "";
    if (existsSync(p) && statSync(p).isFile() && path.endsWith(".ts")) {
      hint = `  (${readFileSync(p, "utf8").split("\n").length} lines)`;
    }
    console.log(`  ${path.padEnd(42)} ${dim(what)}${dim(hint)}`);
  }
  console.log("");
  rule("command line");
  console.log("");
  for (const [cmd, what] of [
    ["npm test", "the full suite"],
    ["npm run models:status", "is model execution enabled?"],
    ["npm run memory:demo", "the memory system, interactively"],
    ["npm run memory:graph", "rebuild the memory graph"],
    ["npm start", "the dashboard on 127.0.0.1:3000"],
  ]) {
    console.log(`  ${cmd.padEnd(28)} ${dim(what)}`);
  }
}

// ==========================================================================

const MENU = [
  ["The short version", itemOverview, ""],
  ["Five things it will not do", itemAuthority, ""],
  ["The memory experiment", itemMemory, ""],
  ["The agent catalog and skill routing", itemAgents, ""],
  ["The dashboard", itemDashboard, ""],
  ["Run the suite", itemTests, "2,238 tests"],
  ["Where everything is", itemSource, ""],
];

function showMenu() {
  console.log("");
  console.log(bold("  MYEMPLOYEE AI — Jarvis Control Plane"));
  console.log(dim("  Authority is a typed record that must exist before an action is possible."));
  console.log("");
  MENU.forEach(([label, , tag], i) => {
    console.log(`   ${cyan(String(i + 1))}  ${label}${tag ? dim(`   ${tag}`) : ""}`);
  });
  console.log(`   ${cyan("q")}  quit`);
  console.log("");
}

function run(choice) {
  const pick = String(choice).trim().toLowerCase();
  if (["q", "quit", "exit", "0"].includes(pick)) return false;
  if (pick === "all") {
    for (const [, fn] of MENU) {
      fn();
      console.log("");
    }
    return true;
  }
  const n = Number(pick);
  if (Number.isInteger(n) && n >= 1 && n <= MENU.length) {
    MENU[n - 1][1]();
    return true;
  }
  console.log(dim(`  no item ${JSON.stringify(pick)} — pick 1-${MENU.length} or q`));
  return true;
}

async function main() {
  const arg = process.argv[2];
  if (arg) {
    run(arg);
    return;
  }
  if (!process.stdin.isTTY) {
    showMenu();
    console.log(dim("  not a terminal — run `node explore.mjs <n>` to pick an item"));
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      showMenu();
      const choice = await rl.question("  > ");
      if (!run(choice)) return;
      console.log("");
      await rl.question(dim("  ↵ back to the menu "));
    }
  } finally {
    rl.close();
  }
}

await main();
