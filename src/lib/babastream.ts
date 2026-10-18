/**
 * BabaStream (babastream.top) — 2dhive's OWN DEFAULT streaming server.
 *
 * kaizoku-core's 2dhive adapter deliberately skips BabaStream: its proof-of-
 * work needs `worker_threads`, which Cloudflare Workers cannot use. We run on
 * Node (dev server / Vercel Node runtime), so the constraint does not apply —
 * and Baba is the server 2dhive's own episode page renders by default
 * (`defaultServer: "babastream"`), which is exactly the backend that carries
 * titles megaplay and hianime miss (measured: AiPri ep29, BTTH4 ep62 resolve
 * here while both wired paths report "no stream").
 *
 * Protocol, verified end-to-end against the live embed:
 *
 *  1. GET the embed page — a `var CFG = {sid, pk, cap, …}` island holds the
 *     session id, a base64 AES-256 key, and the Cap (trycap.dev) endpoint.
 *  2. POST `/api/resolve` with `{s: sid, d: AES-GCM(payload)}` (random 12-byte
 *     IV prepended to the ciphertext, base64); the response `d` decrypts with
 *     the same key. A fresh session is usually refused with
 *     `{t:"error", m:"verify"}` — the Cap challenge must run first.
 *  3. Cap flow: POST `<cap>challenge` (no body) → a challenge payload → solve
 *     sha256 hashcash proofs (`sha256(salt + nonce)` must start with `target`;
 *     either an explicit `challenges[]` list or a seeded `{c, s, d}` triple
 *     derived from the challenge token) → POST `<cap>redeem` with
 *     `{token, solutions}` → then tell BabaStream itself via
 *     `/api/cap-verify {ts, token, mode:"invisible"}`.
 *  4. Resolve again: `{t:"direct"|"hls", u: <url>}` is a stream;
 *     `{t:"error", m:"No source found"}` is a DEFINITIVE miss (the title is
 *     absent from Baba's catalogue — even 2dhive's own player errors on it),
 *     so misses are negative-cached while network/protocol failures are not.
 *
 * The `challenge` / `redeem` route names are recovered from the Cap widget
 * bundle at runtime (they appear as template-literal suffixes like
 * `` `${endpoint}challenge` ``), so a widget update that renames them fails
 * loudly instead of posting to a stale path.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { CipherGCMTypes } from "node:crypto";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0";
const REFERER = "https://2dhive.com/";
/** A definitive "no source here" repeats for the whole walk burst — 10 min. */
const MISS_TTL_MS = 10 * 60_000;
const MISS_CACHE_MAX = 500;
const PAGE_TIMEOUT_MS = 15_000;
const API_TIMEOUT_MS = 15_000;

/** episode-keyed negative cache: definitive upstream misses only. */
const missCache = new Map<string, number>();

function missKey(embedUrl: string): string {
  return embedUrl;
}

function isNegativelyCached(embedUrl: string): boolean {
  const key = missKey(embedUrl);
  const until = missCache.get(key);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    missCache.delete(key);
    return false;
  }
  return true;
}

function rememberMiss(embedUrl: string): void {
  if (missCache.size >= MISS_CACHE_MAX) {
    const oldest = missCache.keys().next().value;
    if (oldest !== undefined) missCache.delete(oldest);
  }
  missCache.set(missKey(embedUrl), Date.now() + MISS_TTL_MS);
}

export interface BabaStreamData {
  sources: { url: string; isM3U8: boolean; quality: string }[];
  subtitles: { url: string; lang: string }[];
  headers: Record<string, string>;
}

interface CryptoOptions {
  cipher: string;
  ivLength: number;
  tagLength: number;
}

interface CapRoutes {
  challenge: string;
  redeem: string;
}

function b64d(s: string): Buffer {
  return Buffer.from(s, "base64");
}

function encryptPayload(value: string, key: Buffer, options: CryptoOptions): string {
  const iv = randomBytes(options.ivLength);
  const cipher = createCipheriv(options.cipher as CipherGCMTypes, key, iv, {
    authTagLength: options.tagLength,
  });
  return Buffer.concat([iv, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]).toString(
    "base64"
  );
}

function decryptPayload(value: string, key: Buffer, options: CryptoOptions): string {
  const raw = Buffer.from(value, "base64");
  const tagStart = raw.length - options.tagLength;
  if (tagStart <= options.ivLength) throw new Error("BabaStream encrypted payload is invalid");
  const decipher = createDecipheriv(options.cipher as CipherGCMTypes, key, raw.subarray(0, options.ivLength), {
    authTagLength: options.tagLength,
  });
  decipher.setAuthTag(raw.subarray(tagStart));
  return Buffer.concat([decipher.update(raw.subarray(options.ivLength, tagStart)), decipher.final()]).toString(
    "utf8"
  );
}

/** FNV-style seed → deterministic hex, as the Cap widget derives seeded proofs. */
function seededHex(value: string, length: number): string {
  let state = 2166136261;
  for (let i = 0; i < value.length; i++) {
    state ^= value.charCodeAt(i);
    state += (state << 1) + (state << 4) + (state << 7) + (state << 8) + (state << 24);
  }
  state >>>= 0;
  let output = "";
  while (output.length < length) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    output += state.toString(16).padStart(8, "0");
  }
  return output.slice(0, length);
}

function solveProof(salt: string, target: string): number {
  for (let nonce = 0; ; nonce++) {
    const hash = createHash("sha256")
      .update(`${salt}${nonce}`)
      .digest("hex");
    if (hash.startsWith(target)) return nonce;
  }
}

/**
 * Worker payload for the batch solver. Plain JS on purpose — it is evaluated
 * at runtime (`eval: true`) so no bundler has to discover a worker entry file.
 * The seeded derivation is duplicated here so the worker needs zero closures.
 */
const POW_WORKER_SRC = `
const { createHash } = require("node:crypto");
const { workerData, parentPort } = require("node:worker_threads");
function seededHex(value, length) {
  let state = 2166136261;
  for (let i = 0; i < value.length; i++) {
    state ^= value.charCodeAt(i);
    state += (state << 1) + (state << 4) + (state << 7) + (state << 8) + (state << 24);
  }
  state >>>= 0;
  let output = "";
  while (output.length < length) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    output += state.toString(16).padStart(8, "0");
  }
  return output.slice(0, length);
}
function solveProof(salt, target) {
  for (let nonce = 0; ; nonce++) {
    const hash = createHash("sha256").update(salt + nonce).digest("hex");
    if (hash.startsWith(target)) return nonce;
  }
}
const proofs = workerData.proofs.map((p) => ({
  i: p.i,
  nonce: p.seeded
    ? solveProof(seededHex(p.token + p.counter, p.s), seededHex(p.token + p.counter + "d", p.d))
    : solveProof(p.salt, p.target),
}));
parentPort.postMessage(proofs);
`;

interface ProofJob {
  i: number;
  salt?: string;
  target?: string;
  seeded?: boolean;
  token?: string;
  counter?: number;
  s?: number;
  d?: number;
}

async function solveInline(jobs: ProofJob[]): Promise<number[]> {
  return jobs.map((job) =>
    job.seeded && job.token !== undefined && job.counter !== undefined && job.s !== undefined && job.d !== undefined
      ? solveProof(seededHex(`${job.token}${job.counter}`, job.s), seededHex(`${job.token}${job.counter}d`, job.d))
      : solveProof(job.salt ?? "", job.target ?? "")
  );
}

async function solveProofs(jobs: ProofJob[]): Promise<number[]> {
  if (jobs.length < 2) return solveInline(jobs);
  let workerCount: number;
  try {
    workerCount = Math.min(availableParallelism(), jobs.length);
  } catch {
    workerCount = 1;
  }
  if (workerCount < 2) return solveInline(jobs);
  const batches: ProofJob[][] = Array.from({ length: workerCount }, () => []);
  jobs.forEach((job, index) => batches[index % workerCount].push({ ...job, i: index }));
  try {
    const settled = await Promise.all(
      batches.map(
        (batch) =>
          new Promise<{ i: number; nonce: number }[]>(
            (resolve, reject) => {
              const worker = new Worker(POW_WORKER_SRC, {
                eval: true,
                workerData: { proofs: batch },
                execArgv: [],
              });
              let completed = false;
              worker.once("message", (value: { i: number; nonce: number }[]) => {
                completed = true;
                resolve(value);
              });
              worker.once("error", reject);
              worker.once("exit", (code: number) => {
                if (!completed && code !== 0) reject(new Error(`BabaStream proof worker exited with ${code}`));
              });
            }
          )
      )
    );
    const nonces = new Array<number>(jobs.length);
    for (const entry of settled.flat()) nonces[entry.i] = entry.nonce;
    if (nonces.some((n) => typeof n !== "number")) throw new Error("BabaStream PoW worker returned gaps");
    return nonces;
  } catch (err) {
    console.warn(
      "[baba] proof workers failed, solving inline:",
      err instanceof Error ? err.message : err
    );
    return solveInline(jobs);
  }
}

async function solveChallenge(payload: Record<string, unknown>): Promise<unknown[]> {
  const challenges = payload.challenges;
  if (Array.isArray(challenges)) {
    const jobs: ProofJob[] = challenges.map((challenge, index) => {
      const c = challenge as { protocol?: string; payload?: { salt?: string; target?: string } };
      if (c?.protocol !== "sha256-pow" || !c.payload?.salt || !c.payload?.target) {
        throw new Error(`Unsupported BabaStream challenge protocol: ${c?.protocol}`);
      }
      return { i: index, salt: c.payload.salt, target: c.payload.target };
    });
    const nonces = await solveProofs(jobs);
    return nonces.map((nonce) => ({ nonce }));
  }
  const token = payload.token;
  const challenge = payload.challenge as { c?: number; s?: number; d?: number } | undefined;
  const c = challenge?.c;
  const s = challenge?.s;
  const d = challenge?.d;
  if (
    typeof token !== "string" ||
    typeof c !== "number" ||
    !Number.isInteger(c) ||
    typeof s !== "number" ||
    !Number.isInteger(s) ||
    typeof d !== "number" ||
    !Number.isInteger(d)
  ) {
    throw new Error("BabaStream challenge is invalid");
  }
  const jobs: ProofJob[] = Array.from({ length: c }, (_, index) => ({
    i: index,
    seeded: true,
    token,
    counter: index + 1,
    s,
    d,
  }));
  const nonces = await solveProofs(jobs);
  return nonces;
}

function parseConfig(html: string): { sid: string; pk: string; cap: string } | null {
  for (const match of html.matchAll(/\b(?:var|let|const)\s+\w+\s*=\s*(\{[^;]+\})\s*;/g)) {
    try {
      const config = JSON.parse(match[1]) as { sid?: string; pk?: string; cap?: string };
      if (typeof config.sid === "string" && typeof config.pk === "string" && typeof config.cap === "string") {
        return { sid: config.sid, pk: config.pk, cap: config.cap };
      }
    } catch {
      /* not the config island */
    }
  }
  return null;
}

function getCryptoOptions(html: string, key: Buffer): CryptoOptions | null {
  const algorithm = html.match(/importKey\([^,]+,[^,]+,\s*\{\s*name\s*:\s*["'](AES-[A-Z]+)["']/i)?.[1];
  const ivLength = Number(html.match(/getRandomValues\(new Uint8Array\((\d+)\)\)/)?.[1]);
  const tagLength = Number(html.match(/tagLength\s*:\s*(\d+)/)?.[1]) || 128;
  if (!algorithm || !Number.isInteger(ivLength) || ivLength < 1 || !key.length) return null;
  return {
    cipher: `aes-${key.length * 8}-${algorithm.slice(4).toLowerCase()}`,
    ivLength,
    tagLength: tagLength / 8,
  };
}

/**
 * The embed calls `api("/api/resolve", …)` / `api("/api/cap-verify", …)`.
 * Recover the literals when present (a future rewrite stays self-describing);
 * fall back to the measured defaults otherwise.
 */
function getApiRoutes(html: string): { resolve: string; verify: string } {
  const literals = [...html.matchAll(/\bapi\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const resolve = literals.find((r) => /resolve/i.test(r)) ?? "/api/resolve";
  const verify = literals.find((r) => /verify/i.test(r)) ?? "/api/cap-verify";
  return { resolve, verify };
}

/** String-literal scanner (skips comments/regex) for minified widget code. */
function getScriptStrings(script: string): string[] {
  const strings: string[] = [];
  let index = 0;
  let previous = "";
  while (index < script.length) {
    const char = script[index];
    if (char === "/" && script[index + 1] === "/") {
      index = script.indexOf("\n", index + 2);
      if (index < 0) break;
      continue;
    }
    if (char === "/" && script[index + 1] === "*") {
      index = script.indexOf("*/", index + 2);
      if (index < 0) break;
      index += 2;
      continue;
    }
    if (char === "/" && /[=(:,[!&|?{};]/.test(previous)) {
      index++;
      let inClass = false;
      while (index < script.length) {
        if (script[index] === "\\") {
          index += 2;
          continue;
        }
        if (script[index] === "[") inClass = true;
        if (script[index] === "]") inClass = false;
        if (script[index] === "/" && !inClass) {
          index++;
          while (/[a-z]/i.test(script[index] ?? "")) index++;
          break;
        }
        index++;
      }
      continue;
    }
    if (char !== "'" && char !== '"') {
      if (!/\s/.test(char)) previous = char;
      index++;
      continue;
    }
    const quote = char;
    let value = "";
    index++;
    while (index < script.length && script[index] !== quote) {
      if (script[index] === "\\" && index + 1 < script.length) value += script[index++];
      value += script[index++];
    }
    strings.push(
      value.replace(/\\([\\'"bnfrtv])/g, (_, escaped: string) =>
        ({ b: "\b", n: "\n", f: "\f", r: "\r", t: "\t", v: "\v" })[escaped] ?? escaped
      )
    );
    index++;
  }
  return [...new Set(strings)];
}

async function getCapRoutes(pageUrl: URL, html: string, userAgent: string): Promise<CapRoutes> {
  const capScripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(
    (m) => new URL(m[1], pageUrl).href
  );
  const widget = (
    await Promise.all(
      capScripts.map(async (url) => {
        try {
          const response = await fetch(url, {
            headers: { "User-Agent": userAgent, Referer: pageUrl.href },
            signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
          });
          if (!response.ok) return null;
          return await response.text();
        } catch {
          return null;
        }
      })
    )
  ).find((script) => script && /challenge/i.test(script) && /redeem/i.test(script) && /SHA-256/i.test(script));
  if (!widget) throw new Error("BabaStream challenge client not found");
  const templateSuffixes = [...widget.matchAll(/`[^`]*\$\{[^}]+\}([^`]+)`/g)].map((m) => m[1]);
  const strings = [...getScriptStrings(widget), ...templateSuffixes];
  const challenge = strings.find((value) => value === "challenge");
  const redeem = strings.find((value) => value === "redeem");
  if (!challenge || !redeem) throw new Error("BabaStream challenge routes not found");
  return { challenge, redeem };
}

/**
 * Resolve one embed URL to a playable source.
 *
 * Returns `null` only on a DEFINITIVE upstream miss (cached — repeated walks
 * must not re-pay the proof-of-work), and throws on network/protocol failures
 * so callers can keep those transient.
 */
export async function extractBabaStream(
  embedUrl: string,
  referer: string = REFERER
): Promise<BabaStreamData | null> {
  if (isNegativelyCached(embedUrl)) return null;
  const t0 = Date.now();
  let pageMs = 0;
  let widgetMs = 0;
  let powMs = 0;
  const pageUrl = new URL(embedUrl);
  const pageHeaders = {
    "User-Agent": DEFAULT_UA,
    Accept: "text/html,*/*",
    Referer: referer,
  };
  const pageStart = Date.now();
  const pageResponse = await fetch(pageUrl, {
    headers: pageHeaders,
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  });
  pageMs = Date.now() - pageStart;
  if (!pageResponse.ok) throw new Error(`BabaStream HTTP ${pageResponse.status}: ${embedUrl}`);
  const html = await pageResponse.text();

  const config = parseConfig(html);
  if (!config) throw new Error(`BabaStream config not found: ${embedUrl}`);
  const key = b64d(config.pk);
  const cryptoOptions = getCryptoOptions(html, key);
  if (!cryptoOptions) throw new Error(`BabaStream crypto options not found: ${embedUrl}`);
  const routes = getApiRoutes(html);

  const encryptedRequest = async (
    route: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    const response = await fetch(new URL(route, pageUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": DEFAULT_UA, Referer: pageUrl.href },
      body: JSON.stringify({ s: config.sid, d: encryptPayload(JSON.stringify(body), key, cryptoOptions) }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`BabaStream HTTP ${response.status}: ${route}`);
    const parsed = (await response.json()) as { d?: string };
    if (!parsed.d) throw new Error("BabaStream response is missing encrypted data");
    return JSON.parse(decryptPayload(parsed.d, key, cryptoOptions)) as Record<string, unknown>;
  };

  let resolved = await encryptedRequest(routes.resolve, { ts: Date.now() });
  if (resolved.t === "error" && /verify/i.test(String(resolved.m ?? ""))) {
    const widgetStart = Date.now();
    const capRoutes = await getCapRoutes(pageUrl, html, DEFAULT_UA);
    widgetMs = Date.now() - widgetStart;
    const capHeaders = { "Content-Type": "application/json", "User-Agent": DEFAULT_UA, Referer: pageUrl.href };
    const challengeResponse = await fetch(new URL(capRoutes.challenge, config.cap), {
      method: "POST",
      headers: capHeaders,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!challengeResponse.ok) throw new Error(`BabaStream challenge HTTP ${challengeResponse.status}`);
    const challenge = (await challengeResponse.json()) as Record<string, unknown>;
    const powStart = Date.now();
    const solutions = await solveChallenge(challenge);
    powMs = Date.now() - powStart;
    const redeemResponse = await fetch(new URL(capRoutes.redeem, config.cap), {
      method: "POST",
      headers: capHeaders,
      body: JSON.stringify({ token: challenge.token, solutions }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!redeemResponse.ok) throw new Error(`BabaStream redeem HTTP ${redeemResponse.status}`);
    const redeemed = (await redeemResponse.json()) as { success?: boolean; token?: string };
    if (!redeemed?.success || !redeemed.token) throw new Error("BabaStream challenge verification failed");
    const verified = await encryptedRequest(routes.verify, {
      ts: Date.now(),
      token: redeemed.token,
      mode: "invisible",
    });
    if (verified.t !== "ok") throw new Error("BabaStream cap verification failed");
    resolved = await encryptedRequest(routes.resolve, { ts: Date.now() });
  }

  const url = resolved.u;
  const totalMs = Date.now() - t0;
  if (typeof url !== "string" || !url) {
    // Cap passed and the resolver answered — this is a catalogue miss, not
    // infrastructure failing. Cache it so the rest of the walk (and the next
    // 10 minutes of retries) skip the proof-of-work entirely.
    rememberMiss(embedUrl);
    console.warn(
      `[baba] no source for ${embedUrl} in ${totalMs}ms (page ${pageMs}, widget ${widgetMs}, pow ${powMs}): ${String(resolved.m ?? resolved.t)}`
    );
    return null;
  }
  console.log(
    `[baba] resolved ${embedUrl} in ${totalMs}ms (page ${pageMs}, widget ${widgetMs}, pow ${powMs})`
  );
  const isM3U8 = /\.m3u8(?:$|[?&])/i.test(url);
  return {
    sources: [{ url, isM3U8, quality: "default" }],
    subtitles: [],
    headers: { Referer: `${pageUrl.origin}/` },
  };
}
