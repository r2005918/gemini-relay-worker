// Gemini Web batchexecute protocol.
//
// This version targets the newer Gemini Web request format:
//
//   /_/BardChatUi/data/batchexecute
//
// with:
//
//   rpcids=L5adhe
//
// The Gemini Web protocol is reverse-engineered and may change at any time.

export interface Env {
  GEMINI_BL: string;
  DEFAULT_MODEL?: string;
  REQUEST_TIMEOUT_SEC?: string;

  /** Comma-separated API keys. Empty/unset → auth disabled. */
  API_KEYS?: string;

  /** Full Cookie header string. */
  COOKIE?: string;

  /** Explicit SAPISID override; otherwise parsed from COOKIE. */
  SAPISID?: string;

  /** Google account index for /u/<index>/ routing. */
  AUTH_USER?: string;

  /** Page XSRF token, sent as the `at` form field. */
  XSRF_TOKEN?: string;
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

const GEMINI_RPC_ID = "L5adhe";

export function accountPrefix(env: Env): string {
  const u = env.AUTH_USER;

  if (u === undefined || u === null || u === "") {
    return "";
  }

  return `/u/${u}`;
}

function parseSapisid(cookie: string): string | null {
  for (const pair of cookie.split("; ")) {
    const eq = pair.indexOf("=");

    if (eq === -1) {
      continue;
    }

    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);

    if (name === "SAPISID") {
      return value;
    }
  }

  return null;
}

export async function makeSapisidHash(
  sapisid: string,
): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);

  const data = new TextEncoder().encode(
    `${timestamp} ${sapisid} https://gemini.google.com`,
  );

  const digest = await crypto.subtle.digest("SHA-1", data);

  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return `SAPISIDHASH ${timestamp}_${hex}`;
}

async function buildHeaders(
  env: Env,
): Promise<Record<string, string>> {
  const prefix = accountPrefix(env);

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    Origin: "https://gemini.google.com",
    Referer: `https://gemini.google.com${prefix}/app`,
    "X-Same-Domain": "1",
    "User-Agent": USER_AGENT,
  };

  if (prefix) {
    headers["X-Goog-AuthUser"] = String(env.AUTH_USER);
  }

  const cookie = env.COOKIE;

  if (cookie) {
    headers["Cookie"] = cookie;

    const sapisid =
      env.SAPISID || parseSapisid(cookie);

    if (sapisid) {
      headers["Authorization"] =
        await makeSapisidHash(sapisid);
    }
  }

  return headers;
}

function buildPayload(
  prompt: string,
  modeId: number,
  thinkMode: number,
  fileRefs: string[] | null,
  extra: Record<number, unknown> | undefined,
  xsrfToken: string | undefined,
): string {
  /*
   * Gemini Web uses a sparse positional array.
   * The meaning of each index depends on the current
   * Gemini Web frontend implementation.
   */
  const inner: unknown[] = new Array(102).fill(null);

  if (fileRefs && fileRefs.length > 0) {
    const refs = fileRefs.map((ref) => [
      null,
      null,
      ref,
    ]);

    inner[0] = [
      prompt,
      0,
      null,
      refs,
      null,
      null,
      0,
    ];
  } else {
    inner[0] = [
      prompt,
      0,
      null,
      null,
      null,
      null,
      0,
    ];
  }

  inner[1] = ["en"];

  inner[2] = [
    "",
    "",
    "",
    null,
    null,
    null,
    null,
    null,
    null,
    "",
  ];

  inner[6] = [0];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;

  // Thinking depth:
  // 0 = deepest
  // 4 = shallowest
  inner[17] = [[thinkMode]];

  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [2];
  inner[53] = 0;

  // Conversation/request identifier.
  inner[59] = crypto.randomUUID();

  inner[61] = [];
  inner[68] = 1;

  // Model/category selector.
  inner[79] = modeId;

  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      const index = Number(key);

      if (Number.isInteger(index) && index >= 0) {
        inner[index] = value;
      }
    }
  }

  /*
   * New batchexecute request format:
   *
   * [
   *   [
   *     "L5adhe",
   *     "[serialized payload]",
   *     null,
   *     "generic"
   *   ]
   * ]
   */
  const outer = [
    [
      GEMINI_RPC_ID,
      JSON.stringify(inner),
      null,
      "generic",
    ],
  ];

  const params = new URLSearchParams();

  params.set(
    "f.req",
    JSON.stringify(outer),
  );

  if (xsrfToken) {
    params.set("at", xsrfToken);
  }

  return params.toString();
}

function getUrl(env: Env): string {
  const reqid =
    Math.floor(Date.now() / 1000) % 1000000;

  const prefix = accountPrefix(env);

  const params = new URLSearchParams();

  params.set("rpcids", GEMINI_RPC_ID);
  params.set("source-path", "/app");
  params.set("bl", env.GEMINI_BL);
  params.set("hl", "zh-CN");
  params.set("_reqid", String(reqid));
  params.set("rt", "c");

  return (
    `https://gemini.google.com${prefix}` +
    "/_/BardChatUi/data/batchexecute?" +
    params.toString()
  );
}

function cleanText(text: string): string {
  text = text.replace(
    /```(?:python|javascript|text)\\?code_(?:reference|stdout)&code\_event\_index=\d+\n[\s\S]*?```\n?/g,
    "",
  );

  text = text.replace(
    /http:\/\/googleusercontent\.com\/card_content\/\d+\n?/g,
    "",
  );

  return text.trim();
}

/**
 * Parse a single wrb.fr line and return text strings found.
 */
function extractTextsFromLine(
  line: string,
): string[] {
  if (!line.includes('"wrb.fr"')) {
    return [];
  }

  if (line.length < 100) {
    return [];
  }

  try {
    const arr = JSON.parse(line);

    const innerStr = arr?.[0]?.[2];

    if (
      !innerStr ||
      typeof innerStr !== "string" ||
      innerStr.length < 20
    ) {
      return [];
    }

    const inner = JSON.parse(innerStr);

    if (
      !Array.isArray(inner) ||
      inner.length <= 4 ||
      !inner[4]
    ) {
      return [];
    }

    const texts: string[] = [];

    for (const part of inner[4]) {
      if (
        !Array.isArray(part) ||
        part.length <= 1 ||
        !Array.isArray(part[1])
      ) {
        continue;
      }

      for (const value of part[1]) {
        if (
          typeof value === "string" &&
          value.length > 0
        ) {
          texts.push(value);
        }
      }
    }

    return texts;
  } catch {
    return [];
  }
}

/**
 * Parse the complete Gemini response.
 *
 * The newer batchexecute response may contain several
 * wrb.fr records. The longest extracted text is used
 * because intermediate records may contain partial output.
 */
export function extractResponseText(
  raw: string,
): string {
  let longest = "";

  for (const line of raw.split("\n")) {
    const texts = extractTextsFromLine(line);

    for (const text of texts) {
      if (text.length > longest.length) {
        longest = text;
      }
    }
  }

  return cleanText(longest);
}

const sleep = (
  milliseconds: number,
): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

async function postGemini(
  prompt: string,
  modeId: number,
  thinkMode: number,
  fileRefs: string[] | null,
  extra: Record<number, unknown> | undefined,
  env: Env,
): Promise<Response> {
  const body = buildPayload(
    prompt,
    modeId,
    thinkMode,
    fileRefs,
    extra,
    env.XSRF_TOKEN,
  );

  const url = getUrl(env);
  const headers = await buildHeaders(env);

  const timeoutMs =
    (Number(env.REQUEST_TIMEOUT_SEC) || 180) * 1000;

  let lastError: unknown;

  for (
    let attempt = 0;
    attempt < RETRY_ATTEMPTS;
    attempt++
  ) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      /*
       * Do not retry normal HTTP responses here.
       * The caller needs to inspect the response body,
       * especially for Gemini's batchexecute error payload.
       */
      return response;
    } catch (error) {
      lastError = error;

      if (attempt < RETRY_ATTEMPTS - 1) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  throw lastError;
}

/**
 * Non-streaming generation with retry.
 */
export async function generate(
  prompt: string,
  modeId: number,
  thinkMode: number,
  fileRefs: string[] | null,
  extra: Record<number, unknown> | undefined,
  env: Env,
): Promise<string> {
  const response = await postGemini(
    prompt,
    modeId,
    thinkMode,
    fileRefs,
    extra,
    env,
  );

  const raw = await response.text();

  return extractResponseText(raw);
}

/**
 * Streaming generation.
 *
 * The response is processed line by line. Gemini's
 * batchexecute response normally returns wrb.fr records
 * separated by newline characters.
 */
export async function* generateStream(
  prompt: string,
  modeId: number,
  thinkMode: number,
  fileRefs: string[] | null,
  extra: Record<number, unknown> | undefined,
  env: Env,
): AsyncGenerator<string> {
  const response = await postGemini(
    prompt,
    modeId,
    thinkMode,
    fileRefs,
    extra,
    env,
  );

  if (!response.body) {
    const raw = await response.text();
    const text = extractResponseText(raw);

    if (text) {
      yield text;
    }

    return;
  }

  const reader = response.body
    .pipeThrough(new TextDecoderStream())
    .getReader();

  let buffer = "";
  let previousText = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += value;

      let newlineIndex: number;

      while (
        (newlineIndex = buffer.indexOf("\n")) !== -1
      ) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        const texts = extractTextsFromLine(line);

        for (const text of texts) {
          if (text.length <= previousText.length) {
            continue;
          }

          const delta = cleanText(
            text.slice(previousText.length),
          );

          if (delta) {
            yield delta;
          }

          previousText = text;
        }
      }
    }

    /*
     * Process the last incomplete line, if any.
     */
    if (buffer.trim()) {
      const texts = extractTextsFromLine(buffer);

      for (const text of texts) {
        if (text.length <= previousText.length) {
          continue;
        }

        const delta = cleanText(
          text.slice(previousText.length),
        );

        if (delta) {
          yield delta;
        }

        previousText = text;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
