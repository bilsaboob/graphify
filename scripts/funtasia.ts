// Convenience wrappers around Graphify and its scoped Markdown runner.
// Run from the repository: bun run setup | index | index:docs | reindex | queries | reset
// Add --dry-run to preview. Reset requires --yes. No model is downloaded here.
import { existsSync } from "node:fs";
import { lstat, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// Edit these defaults if your local installation or preferences change.
const PROJECT = resolve("D:/ws/funtasia");
const MODEL = "qwen2.5:14b";
const OLLAMA_URL = "http://127.0.0.1:11434";
const RESOLUTION = 1.0;          // Higher: more/smaller communities.
const MIN_COMMUNITY_SIZE = 3;   // Report filter, not a partition-size constraint.
const VIZ_NODE_LIMIT = 5000;
// Graphify's existing Leiden implementation uses fixed seed 42.

const REPO = resolve(dirname(import.meta.dir));
const PYTHON = join(REPO, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const OUTPUT = join(PROJECT, "graphify-out");
const GRAPH = join(OUTPUT, "graph.json");
const command = process.argv[2] ?? "help";
const flags = process.argv.slice(3).filter((value) => value !== "--");
const dryRun = flags.includes("--dry-run");

export const environment = {
  ...process.env,
  UV_PROJECT_ENVIRONMENT: join(REPO, ".venv"),
  PYTHONUNBUFFERED: "1",
  GRAPHIFY_OUT: OUTPUT,
  GRAPHIFY_BACKEND: "ollama",
  OLLAMA_HOST: OLLAMA_URL,
  OLLAMA_BASE_URL: `${OLLAMA_URL}/v1`,
  OLLAMA_MODEL: MODEL,
  OLLAMA_API_KEY: "ollama", // Local placeholder; no real API key is needed.
  GRAPHIFY_OLLAMA_NUM_CTX: "12288",
  GRAPHIFY_MAX_OUTPUT_TOKENS: "4096",
  GRAPHIFY_LLM_TEMPERATURE: "0",
  GRAPHIFY_OLLAMA_SEED: "42",
  GRAPHIFY_OLLAMA_KEEP_ALIVE: "5m",
  GRAPHIFY_AMBIGUOUS_SCALE: "0.5",
  GRAPHIFY_VIZ_NODE_LIMIT: String(VIZ_NODE_LIMIT),
};

export function extractionCommand(command: "index" | "reindex" | "index:docs", force = false): string[] {
  if (command === "index:docs") {
    return [PYTHON, "-B", join(REPO, "scripts", "index_markdown.py"), PROJECT,
      "--model", MODEL, "--token-budget", "8000", "--api-timeout", "600",
      ...(force ? ["--force"] : [])];
  }
  return [PYTHON, "-B", "-m", "graphify", "extract", PROJECT,
    "--backend", "ollama", "--model", MODEL,
    "--max-workers", "4", "--max-concurrency", "1", "--token-budget", "8000",
    "--api-timeout", "600", "--no-cluster", ...(command === "reindex" ? ["--force"] : [])];
}

const DEFAULT_IGNORE = `# Source, documentation and resolution metadata.
*
!*/
!*.ts
!*.tsx
!*.md
!package.json
!tsconfig*.json
!jsconfig.json
node_modules/
dist/
build/
coverage/
.zen/
.zenai/
.agents/
zen/
tmp/
src/libs/
src/packages/fst-solid-icons/bundles/
src/packages/fst-solid-icons/src/icons/
src/packages/fst-solid-icons/src/catalog/
plans/
*.plan.*.md
docs/concepts/fst-db-implementation-plan.md
AGENTS.md
SKILL.md
`;

async function run(args: string[], capture = false, allowed = [0], noModel = false): Promise<string> {
  console.log(`> ${args.map((value) => JSON.stringify(value)).join(" ")}`);
  if (dryRun) return "";
  const child = Bun.spawn(args, {
    cwd: REPO,
    env: noModel ? { ...environment, GRAPHIFY_BACKEND: "none" } : environment,
    stdin: "inherit",
    stdout: capture ? "pipe" : "inherit",
    stderr: "inherit",
  });
  const output = capture ? await new Response(child.stdout).text() : "";
  const exitCode = await child.exited;
  if (!allowed.includes(exitCode)) throw new Error(`Command failed with exit code ${exitCode}.`);
  return output;
}

function graphify(args: string[], capture = false, allowed = [0], noModel = false) {
  return run([PYTHON, "-B", "-m", "graphify", ...args], capture, allowed, noModel);
}

async function createIfMissing(path: string, contents: string) {
  if (existsSync(path)) {
    console.log(`Keeping existing ${path}`);
    return;
  }
  console.log(`${dryRun ? "Would create" : "Creating"} ${path}`);
  if (!dryRun) await writeFile(path, contents, { encoding: "utf8", flag: "wx" });
}

async function checkOutputDirectory() {
  if (!existsSync(OUTPUT)) return;
  const stat = await lstat(OUTPUT);
  const actual = await realpath(OUTPUT);
  const expected = join(await realpath(PROJECT), "graphify-out");
  const same = process.platform === "win32"
    ? actual.toLowerCase() === expected.toLowerCase()
    : actual === expected;
  if (!stat.isDirectory() || stat.isSymbolicLink() || !same) {
    throw new Error(`Refusing to use a redirected or non-directory output: ${OUTPUT}`);
  }
}

async function main() {
  if (command === "help" || flags.includes("--help")) {
    console.log(`Funtasia: ${PROJECT}\nOutput: ${OUTPUT}\nModel: local Ollama ${MODEL}

bun run setup                 Install local dependencies and create missing project config
bun run index                 Incremental code + Markdown extraction, then cluster/report
bun run index:docs            Index admitted .md files only with local Ollama; preserve indexed code
bun run index:docs -- --force Re-extract Markdown without reusing its semantic cache
bun run reindex               Force extraction again, then cluster/report (not a cache purge)
bun run queries               Run graph search, semantic search, then inspect a returned reference
bun run reset -- --yes        Delete ONLY Funtasia's graphify-out directory

Append --dry-run to preview any command. Setup preserves existing .graphifyignore/.graphifyrc.
Markdown indexing excludes src/libs and generated output, and honors the other project ignore rules.
It adds/refreshes documents; use the full index command to reconcile deleted files.
Run one indexing/reset command at a time.
Requires uv, Bun, and Ollama at ${OLLAMA_URL}; setup checks the model but never downloads it.
Code annotations run natively with the structural extractor; no Node analyzer build is needed.
Leiden: resolution ${RESOLUTION}, fixed seed 42; report minimum ${MIN_COMMUNITY_SIZE}.
Graphify retains its existing Leiden-preferred/Louvain-fallback behavior.
After changing model/decoding settings, use index:docs -- --force to refresh Markdown.
Reset clears the entire output, including indexed code, for a clean full rebuild.
`);
    return;
  }
  if (!["setup", "index", "index:docs", "reindex", "queries", "reset"].includes(command)) {
    throw new Error(`Unknown command: ${command}. Run bun scripts/funtasia.ts help.`);
  }
  if (flags.some((flag) => flag !== "--dry-run"
    && !(command === "reset" && flag === "--yes")
    && !(command === "index:docs" && flag === "--force"))) {
    throw new Error("Supported flags: --dry-run, --force for index:docs, and --yes for reset.");
  }
  if (!existsSync(PROJECT) || !(await lstat(PROJECT)).isDirectory()) {
    throw new Error(`Project directory does not exist: ${PROJECT}`);
  }
  await checkOutputDirectory();
  console.log(`Project: ${PROJECT}\nOutput: ${OUTPUT}`);
  if (dryRun) console.log("Dry run: no commands will execute and no files will change.");

  if (command === "reset") {
    if (!dryRun && !flags.includes("--yes")) {
      throw new Error(`Reset deletes ${OUTPUT}. Confirm with: bun run reset -- --yes`);
    }
    console.log(`${dryRun ? "Would delete" : "Deleting"} ${OUTPUT}; project source/configuration are kept.`);
    if (!dryRun) await rm(OUTPUT, { recursive: true, force: true });
    return;
  }

  if (command === "setup") {
    await run(["uv", "sync", "--frozen", "--inexact", "--extra", "ollama", "--extra", "mcp", "--extra", "leiden"], false, [0], true);
    await createIfMissing(join(PROJECT, ".graphifyignore"), DEFAULT_IGNORE);
    await createIfMissing(join(PROJECT, ".graphifyrc"),
      "# Query defaults. The Bun runner supplies model and clustering options.\nquery_budget=3000\nquery_depth=2\nviz_node_limit=5000\n");
    console.log(`Checking local Ollama at ${OLLAMA_URL}, model ${MODEL}. No model download or generation is started.`);
    try {
      await run(["ollama", "show", MODEL], false, [0], true);
    } catch (error) {
      throw new Error(`Ollama model check failed at ${OLLAMA_URL}: ${error instanceof Error ? error.message : error}\n`
        + `Ensure Ollama is installed and running. If the model is missing, set OLLAMA_HOST=${OLLAMA_URL} and run: ollama pull ${MODEL}`);
    }
    console.log(dryRun ? "Setup plan complete." : "Setup complete. Run bun run index:docs for Markdown, or bun run index for code + Markdown.");
    return;
  }

  if (!dryRun && !existsSync(PYTHON)) throw new Error("Local Python environment is missing. Run bun run setup first.");
  if (command === "index" || command === "reindex" || command === "index:docs") {
    console.log(`Local Ollama: ${OLLAMA_URL}; model: ${MODEL}`);
    if (command === "index:docs") {
      console.log("Markdown only; src/libs excluded; existing code and project ignore settings are preserved.");
    }
    await run(extractionCommand(command, flags.includes("--force")));
    if (command === "index:docs" && !dryRun && !existsSync(GRAPH)) {
      console.log("No Markdown graph was produced; skipping clustering.");
      return;
    }
    // The existing partition cache does not identify its algorithm. Recompute
    // after setup installs Leiden rather than reuse an earlier Louvain result.
    console.log(`${dryRun ? "Would clear" : "Clearing"} the generated partition cache before clustering.`);
    if (!dryRun) await rm(join(OUTPUT, ".graphify_partition_cache.json"), { force: true });
    await graphify([
      "cluster-only", PROJECT, "--graph", GRAPH, "--resolution", String(RESOLUTION),
      `--min-community-size=${MIN_COMMUNITY_SIZE}`, "--no-label",
    ], false, [0], true);
    console.log(dryRun ? "Index plan complete." : `Finished. Review extraction warnings and ${join(OUTPUT, "GRAPH_REPORT.md")}.`);
    return;
  }

  if (!dryRun && !existsSync(GRAPH)) throw new Error("No index found. Run bun run index first.");
  await graphify(["query", "authentication login session", "--graph", GRAPH,
    "--budget", "3000", "--depth", "2", "--no-doc-demotion"], false, [0], true);
  const output = await graphify(["semantic-search", "--symbol", "AuthoringAuthState",
    "--graph", GRAPH, "--limit", "3", "--max-bytes", "16384"], true, [0, 4], true);
  if (dryRun) {
    await graphify(["semantic-inspect", "<reference returned by semantic-search>",
      "--graph", GRAPH, "--max-bytes", "32768", "--excerpt-bytes", "4096"], false, [0, 4], true);
    return;
  }
  const result = JSON.parse(output);
  console.log(JSON.stringify(result, null, 2));
  const reference = result.matches?.[0]?.reference;
  if (result.status === "ok" && typeof reference === "string") {
    await graphify(["semantic-inspect", reference, "--graph", GRAPH,
      "--max-bytes", "32768", "--excerpt-bytes", "4096"], false, [0, 4], true);
  } else {
    console.log("No matching framework evidence to inspect. Reindex with this branch if the graph is older.");
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
