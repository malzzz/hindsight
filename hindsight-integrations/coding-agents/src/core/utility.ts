/**
 * The memory-utility flywheel (agentctl PLAN.md §2.6): persist the two signals
 * the pipeline previously computed and threw away, as bank-scoped JSONL under
 * `~/.hindsight/utility/<bank>.jsonl`:
 *
 *  - `injected` — a session's automatic reflect ran and its synthesis entered
 *    context. Carries reflect's retrieval provenance (based_on) when the
 *    server supplies it. TWO-LEVEL DISCIPLINE: this is what the synthesis was
 *    built FROM, never evidence the agent used it.
 *  - `used` — the agent visibly attributed part of its answer to memory (the
 *    "🧠 From Hindsight memory" blockquote convention), parsed out of the
 *    retained transcript. This is the usage signal; it is textual, not
 *    id-linked — per-memory linkage stays coarse until provenance is rich.
 *
 * Server reality (probed 2026-08-24 against the deployed 0.8.4 API):
 * `include.facts` returns mental_models reliably; based_on.memories is
 * QUERY-DEPENDENT — empty when reflect ends via forced synthesis (the done
 * tool never reports memory_ids), populated when the done path is reached
 * (observed live: 6 memory ids on a merge-history query, 0 on two others).
 * Events record `provenanceComplete: false` for the empty case so score
 * consumers can tell "nothing injected" from "server did not say".
 * Session-level inject→used pairing (the when-to-inject dataset) works in
 * every case.
 *
 * Recording is synchronous and fail-open (a utility write must never break a
 * hook), with lazy mkdir. Readers are parse-tolerant and dedupe used-quotes
 * per (session, quote) so cadenced re-retains cannot inflate usage.
 */
import { appendFileSync, mkdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readJsonlTail } from "./jsonl";

export interface AttributionQuote {
  /** Page title when the "(page)" variant was used */
  page?: string;
  quote: string;
}

export interface InjectedMemoryRef {
  id: string | null;
  type?: string;
  textHead?: string;
}

export interface UtilityScores {
  bank: string;
  sessionsInjected: number;
  sessionsUsed: number;
  sessionsUnused: number;
  /** sessionsUsed / sessionsInjected; NaN-free (0 when nothing injected) */
  useRate: number;
  usedQuotes: number;
  /** Sessions where reflect provenance was incomplete (server gave no memory ids) */
  provenanceIncomplete: number;
  perMemory: Array<{
    id: string;
    kind: "memory" | "mental-model";
    textHead?: string;
    injectedCount: number;
    sessionsInjected: number;
    /** injected sessions that later showed ANY attribution — coarse until ids link */
    sessionsUsedAfter: number;
  }>;
  recentUsed: Array<{ sessionId: string; page?: string; quoteHead: string }>;
}

export function utilityFile(bank: string, baseDir?: string): string {
  const root =
    baseDir ?? process.env.HINDSIGHT_UTILITY_DIR ?? join(homedir(), ".hindsight", "utility");
  return join(root, `${encodeURIComponent(bank)}.jsonl`);
}

function appendEvent(bank: string, record: Record<string, unknown>, baseDir?: string): void {
  try {
    const file = utilityFile(bank, baseDir);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ ts: Date.now(), ...record }) + "\n");
  } catch {
    /* fail-open: utility accounting must never break a hook */
  }
}

export function recordInjected(opts: {
  bank: string;
  harness: string;
  sessionId: string;
  queryHead: string;
  answerChars: number;
  memories: InjectedMemoryRef[];
  mentalModelIds: string[];
  provenanceComplete: boolean;
  baseDir?: string;
}): void {
  const { baseDir, ...rest } = opts;
  appendEvent(opts.bank, { ev: "injected", ...rest }, baseDir);
}

// In-process guard: cadenced live-retains re-send the same turns many times per
// session. Cross-PROCESS duplicates (every Stop-hook run re-reads the full
// transcript) are filtered by scanning the file's tail before appending, and
// deduped once more at read time as the last line of defense.
const seenUsed = new Set<string>();

const WRITE_DEDUPE_TAIL_BYTES = 64 * 1024;

function tailRecordedKeys(file: string, sessionId: string): Set<string> {
  const keys = new Set<string>();
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - WRITE_DEDUPE_TAIL_BYTES);
    const fd = openSync(file, "r");
    let raw: string;
    try {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      raw = buf.toString("utf-8");
    } finally {
      closeSync(fd);
    }
    for (const line of raw.split("\n")) {
      if (!line.includes('"used"') || !line.includes(sessionId)) continue;
      try {
        const r = JSON.parse(line);
        if (r.ev !== "used" || r.sessionId !== sessionId) continue;
        for (const a of r.attributions ?? []) {
          if (a?.quote) keys.add(String(a.quote).slice(0, 120));
        }
      } catch {
        /* torn line */
      }
    }
  } catch {
    /* no file yet */
  }
  return keys;
}

export function recordUsed(opts: {
  bank: string;
  harness?: string;
  sessionId: string;
  attributions: AttributionQuote[];
  baseDir?: string;
}): void {
  if (!opts.bank) return; // a bank-less client (test fake) must not write to 'undefined.jsonl'
  const onDisk = tailRecordedKeys(utilityFile(opts.bank, opts.baseDir), opts.sessionId);
  const fresh = opts.attributions.filter((a) => {
    const quoteKey = a.quote.slice(0, 120);
    const key = `${opts.bank}\u0000${opts.sessionId}\u0000${quoteKey}`;
    if (seenUsed.has(key) || onDisk.has(quoteKey)) return false;
    seenUsed.add(key);
    return true;
  });
  if (fresh.length === 0) return;
  appendEvent(
    opts.bank,
    {
      ev: "used",
      bank: opts.bank,
      harness: opts.harness,
      sessionId: opts.sessionId,
      attributions: fresh.map((a) => ({
        ...(a.page ? { page: a.page } : {}),
        quote: a.quote.slice(0, 300),
      })),
    },
    opts.baseDir
  );
}

// Greedy page capture so a title containing ')' — "(crucible-reth (BSC port))" — reaches the
// closing ')**'; separator accepts an em/en dash, hyphen, or ':' (observed drift in the wild).
// DRIFT PIN: utility.test.ts derives an attribution from buildSystemInjection's own taught
// wording and asserts this regex parses it — edit the producer strings and that test fails.
const ATTRIBUTION_RE =
  /^\s*>\s*🧠\s*\*\*From Hindsight memory(?:\s*\((.*)\))?\*\*\s*[:—–-]?\s*(.*)$/u;

/**
 * Extract attribution blockquotes from one text. The injected-instruction
 * blocks that TEACH the convention are stripped upstream (transcript readers
 * remove <hindsight_memory>/<hindsight_knowledge*>), and template echoes are
 * skipped here as a second line of defense.
 */
export function extractAttributions(text: string): AttributionQuote[] {
  const out: AttributionQuote[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ATTRIBUTION_RE);
    if (!m) continue;
    let quote = (m[2] ?? "").trim();
    // blockquote continuation lines belong to the same attribution
    while (
      i + 1 < lines.length &&
      /^\s*>\s?/.test(lines[i + 1]) &&
      !ATTRIBUTION_RE.test(lines[i + 1])
    ) {
      i++;
      quote += (quote ? " " : "") + lines[i].replace(/^\s*>\s?/, "").trim();
    }
    // template echo, not a real attribution ("<the specific facts you drew on>")
    if (quote.startsWith("<") || quote.length === 0) continue;
    out.push({ ...(m[1]?.trim() ? { page: m[1].trim() } : {}), quote });
  }
  return out;
}

/** Assistant turns only: the attribution is agent output; user echoes don't count. */
export function extractAttributionsFromTurns(
  turns: Array<{ role: string; content: string }>
): AttributionQuote[] {
  const out: AttributionQuote[] = [];
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    out.push(...extractAttributions(turn.content));
  }
  return out;
}

export function computeScores(bank: string, baseDir?: string): UtilityScores {
  // Bounded tail read (jsonl.ts exists for exactly this — #3292's ERR_STRING_TOO_LONG):
  // nothing rotates this file, so never assume it fits in one string.
  const tail = readJsonlTail(utilityFile(bank, baseDir), {
    scope: "utility",
    maxBytes: 32 * 1024 * 1024,
  });
  interface SessionAgg {
    injected: boolean;
    provenanceComplete: boolean;
    memoryIds: Array<{ id: string; kind: "memory" | "mental-model"; textHead?: string }>;
    quotes: Map<string, { page?: string; quoteHead: string }>;
  }
  const sessions = new Map<string, SessionAgg>();
  const order: Array<{ sessionId: string; page?: string; quoteHead: string }> = [];

  for (const line of tail.lines) {
    if (!line.trim()) continue;
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // torn tail line
    }
    const sid = String(r.sessionId ?? "");
    const agg =
      sessions.get(sid) ??
      sessions
        .set(sid, { injected: false, provenanceComplete: true, memoryIds: [], quotes: new Map() })
        .get(sid)!;
    if (r.ev === "injected") {
      agg.injected = true;
      if (r.provenanceComplete === false) agg.provenanceComplete = false;
      for (const m of r.memories ?? []) {
        if (m?.id) agg.memoryIds.push({ id: String(m.id), kind: "memory", textHead: m.textHead });
      }
      for (const id of r.mentalModelIds ?? []) {
        if (id) agg.memoryIds.push({ id: String(id), kind: "mental-model" });
      }
    } else if (r.ev === "used") {
      for (const a of r.attributions ?? []) {
        const quote = String(a?.quote ?? "");
        if (!quote) continue;
        const key = quote.slice(0, 120);
        if (!agg.quotes.has(key)) {
          agg.quotes.set(key, {
            ...(a.page ? { page: String(a.page) } : {}),
            quoteHead: quote.slice(0, 160),
          });
          order.push({
            sessionId: sid,
            ...(a.page ? { page: String(a.page) } : {}),
            quoteHead: quote.slice(0, 160),
          });
        }
      }
    }
  }

  const perMemory = new Map<string, UtilityScores["perMemory"][number]>();
  let sessionsInjected = 0;
  let sessionsUsed = 0;
  let usedQuotes = 0;
  let provenanceIncomplete = 0;
  for (const agg of sessions.values()) {
    usedQuotes += agg.quotes.size;
    if (!agg.injected) continue;
    sessionsInjected++;
    if (!agg.provenanceComplete) provenanceIncomplete++;
    const used = agg.quotes.size > 0;
    if (used) sessionsUsed++;
    const seenThisSession = new Set<string>();
    for (const m of agg.memoryIds) {
      const row =
        perMemory.get(m.id) ??
        perMemory
          .set(m.id, {
            id: m.id,
            kind: m.kind,
            textHead: m.textHead,
            injectedCount: 0,
            sessionsInjected: 0,
            sessionsUsedAfter: 0,
          })
          .get(m.id)!;
      row.injectedCount++;
      if (!seenThisSession.has(m.id)) {
        seenThisSession.add(m.id);
        row.sessionsInjected++;
        if (used) row.sessionsUsedAfter++;
      }
      if (row.textHead === undefined && m.textHead !== undefined) row.textHead = m.textHead;
    }
  }

  return {
    bank,
    sessionsInjected,
    sessionsUsed,
    sessionsUnused: sessionsInjected - sessionsUsed,
    useRate: sessionsInjected > 0 ? sessionsUsed / sessionsInjected : 0,
    usedQuotes,
    provenanceIncomplete,
    perMemory: [...perMemory.values()].sort(
      (a, b) => b.sessionsUsedAfter - a.sessionsUsedAfter || b.sessionsInjected - a.sessionsInjected
    ),
    recentUsed: order.slice(-20),
  };
}

export function renderUtilityReport(s: UtilityScores): string {
  const lines: string[] = [];
  lines.push(`memory-utility report — bank ${s.bank}`);
  lines.push(
    `sessions: ${s.sessionsInjected} injected · ${s.sessionsUsed} showed use (${Math.round(s.useRate * 100)}%) · ${s.sessionsUnused} unused · ${s.usedQuotes} attributions total`
  );
  if (s.provenanceIncomplete > 0) {
    lines.push(
      `note: ${s.provenanceIncomplete} session(s) with incomplete reflect provenance (server returned no memory ids — expected on 0.8.4; per-memory rows below are partial)`
    );
  }
  if (s.perMemory.length > 0) {
    lines.push("", "per-memory (injected -> session later showed ANY use; coarse until ids link):");
    for (const m of s.perMemory.slice(0, 25)) {
      lines.push(
        `  [${m.kind}] ${m.id}  injected ${m.sessionsInjected}x  used-after ${m.sessionsUsedAfter}x${m.textHead ? `  ${m.textHead.slice(0, 60)}` : ""}`
      );
    }
  }
  if (s.recentUsed.length > 0) {
    lines.push("", "recent attributions:");
    for (const u of s.recentUsed.slice(-10)) {
      lines.push(`  [${u.sessionId.slice(0, 8)}]${u.page ? ` (${u.page})` : ""} ${u.quoteHead}`);
    }
  }
  if (s.sessionsInjected === 0 && s.usedQuotes === 0) {
    lines.push(
      "no utility events recorded yet — they accumulate as sessions run with the updated hooks"
    );
  }
  return lines.join("\n");
}
