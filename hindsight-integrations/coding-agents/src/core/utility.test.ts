import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractAttributions,
  extractAttributionsFromTurns,
  recordInjected,
  recordUsed,
  computeScores,
  renderUtilityReport,
  utilityFile,
} from "./utility";
import { buildHookOutput } from "./hook";
import { resolveConfig } from "./config";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "utility-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HINDSIGHT_UTILITY_DIR;
});

describe("extractAttributions", () => {
  it("captures the plain and page variants, with continuation lines", () => {
    const text = [
      "Some analysis first.",
      "> 🧠 **From Hindsight memory** — the vchord index rebuild takes ACCESS EXCLUSIVE",
      "> and must run with the service stopped.",
      "More prose.",
      "> 🧠 **From Hindsight memory (Component map)** — the collector fan-out is allowlisted.",
    ].join("\n");
    const out = extractAttributions(text);
    expect(out).toHaveLength(2);
    expect(out[0].page).toBeUndefined();
    expect(out[0].quote).toContain("ACCESS EXCLUSIVE");
    expect(out[0].quote).toContain("service stopped");
    expect(out[1].page).toBe("Component map");
    expect(out[1].quote).toContain("allowlisted");
  });

  it("skips template echoes and empty quotes", () => {
    const text = [
      "> 🧠 **From Hindsight memory** — <the specific facts you drew on>",
      "> 🧠 **From Hindsight memory** —",
      "> 🧠 **From Hindsight memory (<page>)** — <the specific facts you drew on>",
    ].join("\n");
    expect(extractAttributions(text)).toHaveLength(0);
  });

  it("handles nested parens in page titles and ':' separators", () => {
    const out = extractAttributions(
      [
        "> 🧠 **From Hindsight memory (crucible-reth (BSC port))** — roaring bitmaps back the ExEx index",
        "> 🧠 **From Hindsight memory**: colon separator drift still parses",
      ].join("\n")
    );
    expect(out).toHaveLength(2);
    expect(out[0].page).toBe("crucible-reth (BSC port)");
    expect(out[1].quote).toBe("colon separator drift still parses");
  });

  it("DRIFT PIN: an attribution following the taught convention always parses", async () => {
    // Derive the attribution shape from the PRODUCER's own instruction text so a copy-edit
    // to inject.ts breaks this test instead of silently zeroing the used-signal.
    const { buildSystemInjection } = await import("./inject");
    const instruction = buildSystemInjection("MEMORY BODY");
    const taught = instruction.split("\n").find((l) => l.includes("From Hindsight memory"));
    expect(taught).toBeDefined();
    const concrete = taught!.replace(
      "<the specific facts you drew on>",
      "the vchord rebuild needs the service stopped"
    );
    const out = extractAttributions(concrete);
    expect(out).toHaveLength(1);
    expect(out[0].quote).toContain("vchord rebuild");
  });

  it("only reads assistant turns", () => {
    const turns = [
      { role: "user", content: "> 🧠 **From Hindsight memory** — user pasted this quote" },
      {
        role: "assistant",
        content: "> 🧠 **From Hindsight memory** — real agent attribution here",
      },
    ];
    const out = extractAttributionsFromTurns(turns);
    expect(out).toHaveLength(1);
    expect(out[0].quote).toContain("real agent attribution");
  });
});

describe("record + computeScores", () => {
  it("pairs injected sessions with later use, two-level and bank-scoped", () => {
    recordInjected({
      bank: "bank-a",
      harness: "claude-code",
      sessionId: "s1",
      queryHead: "fix the uploader",
      answerChars: 2000,
      memories: [{ id: "mem-1", type: "world", textHead: "uploader retries" }],
      mentalModelIds: ["mm-1"],
      provenanceComplete: true,
      baseDir: dir,
    });
    recordInjected({
      bank: "bank-a",
      harness: "claude-code",
      sessionId: "s2",
      queryHead: "unrelated",
      answerChars: 900,
      memories: [],
      mentalModelIds: ["mm-1"],
      provenanceComplete: false,
      baseDir: dir,
    });
    recordUsed({
      bank: "bank-a",
      harness: "claude-code",
      sessionId: "s1",
      attributions: [{ quote: "uploader retries were capped at 3 in 2025" }],
      baseDir: dir,
    });
    // a DIFFERENT bank must not leak in
    recordInjected({
      bank: "bank-b",
      harness: "qwen-code",
      sessionId: "s9",
      queryHead: "x",
      answerChars: 10,
      memories: [],
      mentalModelIds: [],
      provenanceComplete: false,
      baseDir: dir,
    });

    const s = computeScores("bank-a", dir);
    expect(s.sessionsInjected).toBe(2);
    expect(s.sessionsUsed).toBe(1);
    expect(s.sessionsUnused).toBe(1);
    expect(s.useRate).toBeCloseTo(0.5);
    expect(s.provenanceIncomplete).toBe(1);
    const mem = s.perMemory.find((m) => m.id === "mem-1")!;
    expect(mem.kind).toBe("memory");
    expect(mem.sessionsInjected).toBe(1);
    expect(mem.sessionsUsedAfter).toBe(1);
    const mm = s.perMemory.find((m) => m.id === "mm-1")!;
    expect(mm.kind).toBe("mental-model");
    expect(mm.sessionsInjected).toBe(2);
    expect(mm.sessionsUsedAfter).toBe(1);
    expect(computeScores("bank-b", dir).sessionsInjected).toBe(1);

    const report = renderUtilityReport(s);
    expect(report).toContain("2 injected");
    expect(report).toContain("(50%)");
    expect(report).toContain("mem-1");
  });

  it("dedupes repeated used-quotes across cadenced retains (reader side)", () => {
    // simulate two PROCESSES re-recording the same attribution: write raw lines
    const file = utilityFile("bank-c", dir);
    recordInjected({
      bank: "bank-c",
      harness: "h",
      sessionId: "s1",
      queryHead: "q",
      answerChars: 5,
      memories: [],
      mentalModelIds: [],
      provenanceComplete: false,
      baseDir: dir,
    });
    const used = JSON.stringify({
      ts: Date.now(),
      ev: "used",
      bank: "bank-c",
      sessionId: "s1",
      attributions: [{ quote: "same quote about the retry cap" }],
    });
    appendFileSync(file, used + "\n" + used + "\n");
    const s = computeScores("bank-c", dir);
    expect(s.usedQuotes).toBe(1);
    expect(s.sessionsUsed).toBe(1);
  });

  it("in-process writer dedupes the same attribution for one session", () => {
    const attributions = [{ quote: "writer-side dedupe target quote" }];
    recordUsed({ bank: "bank-d", sessionId: "sX", attributions, baseDir: dir });
    recordUsed({ bank: "bank-d", sessionId: "sX", attributions, baseDir: dir });
    const raw = readFileSync(utilityFile("bank-d", dir), "utf-8").trim().split("\n");
    expect(raw).toHaveLength(1);
  });

  it("cross-process dedupe: an attribution already on disk is not re-appended", () => {
    const file = utilityFile("bank-f", dir);
    const quote = "cross process duplicate guard quote xyz";
    // write the on-disk event as if an earlier PROCESS recorded it (priming call creates the dir)
    recordUsed({
      bank: "bank-f",
      sessionId: "sP",
      attributions: [{ quote: "priming line so file exists" }],
      baseDir: dir,
    });
    appendFileSync(
      file,
      JSON.stringify({
        ts: 1,
        ev: "used",
        bank: "bank-f",
        sessionId: "sQ",
        attributions: [{ quote }],
      }) + "\n"
    );
    // fresh in-memory set has no key for (sQ, quote); the tail scan must block it
    recordUsed({ bank: "bank-f", sessionId: "sQ", attributions: [{ quote }], baseDir: dir });
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    const sQ = lines.filter((l) => l.includes('"sQ"'));
    expect(sQ).toHaveLength(1);
  });

  it("tolerates a torn tail line", () => {
    recordInjected({
      bank: "bank-e",
      harness: "h",
      sessionId: "s1",
      queryHead: "q",
      answerChars: 5,
      memories: [],
      mentalModelIds: [],
      provenanceComplete: true,
      baseDir: dir,
    });
    appendFileSync(utilityFile("bank-e", dir), '{"ts": 1, "ev": "inj');
    expect(computeScores("bank-e", dir).sessionsInjected).toBe(1);
  });
});

describe("hook integration", () => {
  it("records an injected event with provenance when reflect runs", async () => {
    process.env.HINDSIGHT_UTILITY_DIR = dir;
    const cfg = resolveConfig({});
    const client = {
      reflectWithProvenance: vi.fn(async () => ({
        text: "SYNTHESIS",
        memories: [{ id: "mem-9", type: "world" as const, textHead: "a fact" }],
        mentalModelIds: ["mm-9"],
      })),
      listPages: vi.fn(async () => ({ items: [] })),
    };
    await buildHookOutput({
      harness: "claude-code",
      prompt: "investigate the flaky uploader test failures",
      cfg,
      client,
      cacheFile: join(dir, "cache.json"),
      bankId: "bank-hook",
      sessionId: "sess-hook",
    });
    const raw = readFileSync(utilityFile("bank-hook", dir), "utf-8");
    const ev = JSON.parse(raw.trim());
    expect(ev.ev).toBe("injected");
    expect(ev.sessionId).toBe("sess-hook");
    expect(ev.memories[0].id).toBe("mem-9");
    expect(ev.mentalModelIds).toEqual(["mm-9"]);
    expect(ev.provenanceComplete).toBe(true);
    expect(ev.answerChars).toBe("SYNTHESIS".length);
  });

  it("records nothing without bank/session identity", async () => {
    process.env.HINDSIGHT_UTILITY_DIR = dir;
    const cfg = resolveConfig({});
    const client = {
      reflectWithProvenance: vi.fn(async () => ({
        text: "SYNTHESIS",
        memories: [],
        mentalModelIds: [],
      })),
      listPages: vi.fn(async () => ({ items: [] })),
    };
    await buildHookOutput({
      harness: "claude-code",
      prompt: "investigate the flaky uploader test failures",
      cfg,
      client,
      cacheFile: join(dir, "cache2.json"),
    });
    expect(() => readFileSync(utilityFile("bank-hook2", dir), "utf-8")).toThrow();
  });
});
