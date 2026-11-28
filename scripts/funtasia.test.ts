import { describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { environment, extractionCommand } from "./funtasia";

const repo = resolve(dirname(import.meta.dir));

describe("Funtasia indexing commands", () => {
  test("Markdown uses the scoped runner, not corpus-replacing CLI exclusions", () => {
    const args = extractionCommand("index:docs");
    expect(args.slice(1, 3)).toEqual(["-B", join(repo, "scripts", "index_markdown.py")]);
    expect(args[3]).toBe(resolve("D:/ws/funtasia"));
    expect(args).toContain("--model");
    expect(args).toContain(environment.OLLAMA_MODEL);
    expect(args).not.toContain("extract");
    expect(args).not.toContain("--exclude");
    expect(args).not.toContain("--force");
    expect(extractionCommand("index:docs", true)).toEqual([...args, "--force"]);
  });

  test("existing full-scope extraction keeps explicit local backend and force behavior", () => {
    const args = extractionCommand("index");
    expect(args.slice(1, 5)).toEqual(["-B", "-m", "graphify", "extract"]);
    expect(args[args.indexOf("--backend") + 1]).toBe("ollama");
    expect(args).toContain("--no-cluster");
    expect(args).not.toContain("--force");
    expect(extractionCommand("reindex")).toEqual([...args, "--force"]);
  });

  test("setup and extraction share the fixed local environment", () => {
    expect(environment.UV_PROJECT_ENVIRONMENT).toBe(join(repo, ".venv"));
    expect(environment.PYTHONUNBUFFERED).toBe("1");
    expect(environment.GRAPHIFY_BACKEND).toBe("ollama");
    expect(environment.OLLAMA_HOST).toBe("http://127.0.0.1:11434");
    expect(environment.OLLAMA_BASE_URL).toBe(`${environment.OLLAMA_HOST}/v1`);
    expect(environment.OLLAMA_MODEL).toBe("qwen2.5:14b");
    expect(environment.GRAPHIFY_OUT).toBe(resolve("D:/ws/funtasia/graphify-out"));
    expect(environment.GRAPHIFY_OLLAMA_NUM_CTX).toBe("12288");
    expect(environment.GRAPHIFY_MAX_OUTPUT_TOKENS).toBe("4096");
    expect(environment.GRAPHIFY_LLM_TEMPERATURE).toBe("0");
    expect(environment.GRAPHIFY_OLLAMA_SEED).toBe("42");
  });

  test("ambient provider and uv overrides cannot redirect the runner", () => {
    const child = Bun.spawnSync([process.execPath, "-e",
      "import { environment as e } from './scripts/funtasia.ts'; "
      + "console.log(JSON.stringify([e.GRAPHIFY_BACKEND, e.OLLAMA_HOST, e.OLLAMA_BASE_URL, e.UV_PROJECT_ENVIRONMENT]));"], {
      cwd: repo,
      env: { ...process.env, GRAPHIFY_BACKEND: "openai", OLLAMA_HOST: "http://external.invalid",
        OLLAMA_BASE_URL: "http://external.invalid/v1", UV_PROJECT_ENVIRONMENT: "wrong-environment" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual([
      "ollama", "http://127.0.0.1:11434", "http://127.0.0.1:11434/v1", join(repo, ".venv"),
    ]);
  });

  test("force is accepted only by the scoped Markdown command", () => {
    const child = Bun.spawnSync([process.execPath, "scripts/funtasia.ts", "index", "--force", "--dry-run"], {
      cwd: repo, stdout: "pipe", stderr: "pipe",
    });
    expect(child.exitCode).toBe(1);
    expect(child.stderr.toString()).toContain("--force for index:docs");
    expect(child.stdout.toString()).not.toContain("> ");
  });

  test("package exposes the Markdown command", async () => {
    const pkg = await Bun.file(join(repo, "package.json")).json();
    expect(pkg.scripts["index:docs"]).toBe("bun scripts/funtasia.ts index:docs");
  });
});
