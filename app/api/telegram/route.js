import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

// V7.5.2: FFmpeg is copied during postinstall so Vercel always traces it.
const ffmpegPath = path.join(process.cwd(), "ffmpeg-bin", "ffmpeg");

export const runtime = "nodejs";

// ======================================================
// AI GUIDE V7.7.0 CONVERSATION-CONTEXT
//
// Groq:
// - Text: openai/gpt-oss-120b
// - Text fallback: openai/gpt-oss-20b
// - Vision primary: qwen/qwen3.8-27b
// - Vision fallback: Google Gemini 3.8 Flash
// - Voice: whisper-large-v3-turbo
//
// Features:
// - Text
// - Tavily web search
// - Upstash memory
// - Telegram typing
// - Photos
// - Up to 3 photos
// - Reply to old photo
// - Voice / audio
// - Static stickers with Vision
// - Animated / video stickers via Telegram thumbnail + Vision
// - Safe emoji/context fallback when no thumbnail is available
// - Telegram custom emoji
// - Better Telegram-safe math
//
// Ordinary VIDEO + video notes supported via FFmpeg frames + Whisper.
// Gemini is used ONLY as Vision fallback.
// OpenRouter disabled.
// ======================================================


// ======================================================
// CONFIG
// ======================================================

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN;

const GROQ_API_KEY =
  process.env.GROQ_API_KEY;

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY;

const TAVILY_API_KEY =
  process.env.TAVILY_API_KEY;

const UPSTASH_REDIS_REST_URL =
  process.env.UPSTASH_REDIS_REST_URL;

const UPSTASH_REDIS_REST_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN;

const ALLOWED_USER_ID =
  process.env.TELEGRAM_ALLOWED_USER_ID
    ? Number(process.env.TELEGRAM_ALLOWED_USER_ID)
    : null;

const TELEGRAM_API =
  `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

const GROQ_API =
  "https://api.groq.com/openai/v1";

const GROQ_CHAT_API =
  `${GROQ_API}/chat/completions`;

const GROQ_MODELS_API =
  `${GROQ_API}/models`;

const GROQ_TRANSCRIBE_API =
  `${GROQ_API}/audio/transcriptions`;

const TEXT_MODEL =
  "openai/gpt-oss-120b";

const TEXT_FALLBACK_MODEL =
  "openai/gpt-oss-20b";

const VISION_MODEL =
  "qwen/qwen3.8-27b";

const GEMINI_VISION_MODEL =
  "gemini-3.8-flash";

const GEMINI_GENERATE_API =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent`;

const WHISPER_MODEL =
  "whisper-large-v3-turbo";

const MAX_HISTORY_MESSAGES = 40;
const MEMORY_SUMMARY_BATCH = 20;
const MAX_VISION_IMAGES = 3;
const MAX_VIDEO_FRAMES = 3;
const MESSAGE_GRAPH_LIMIT = 50;
const CONTEXT_TTL_SECONDS = 604800;


// ======================================================
// BASIC HELPERS
// ======================================================

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

function memoryKey(userId) {
  return `ai-guide:history:${userId}`;
}

function memorySummaryKey(userId) {
  return `ai-guide:memory-summary:${userId}`;
}

function lastMediaKey(userId) {
  return `ai-guide:last-media:${userId}`;
}

function mediaStackKey(userId) {
  return `ai-guide:media-stack:${userId}`;
}

function albumKey(userId, mediaGroupId) {
  return `ai-guide:album:${userId}:${mediaGroupId}`;
}

function albumLockKey(userId, mediaGroupId) {
  return `ai-guide:album-lock:${userId}:${mediaGroupId}`;
}

function messageGraphKey(userId) {
  return `ai-guide:message-graph:${userId}`;
}

function activeContextKey(userId) {
  return `ai-guide:active-context:${userId}`;
}


// ======================================================
// REDIS
// ======================================================

async function redisCommand(command) {
  if (
    !UPSTASH_REDIS_REST_URL ||
    !UPSTASH_REDIS_REST_TOKEN
  ) {
    return null;
  }

  try {
    const response = await fetch(
      UPSTASH_REDIS_REST_URL,
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
          "Content-Type":
            "application/json",
        },
        body: JSON.stringify(command),
      }
    );

    const raw = await response.text();

    if (!response.ok) {
      console.error("Redis:", raw);
      return null;
    }

    const data = JSON.parse(raw);
    return data.result;

  } catch (error) {
    console.error(
      "Redis exception:",
      error
    );
    return null;
  }
}


async function getHistory(userId) {
  const result = await redisCommand([
    "GET",
    memoryKey(userId),
  ]);

  if (!result) return [];

  try {
    const history = JSON.parse(result);

    return Array.isArray(history)
      ? history
      : [];
  } catch {
    return [];
  }
}


async function saveHistory(userId, history) {
  await redisCommand([
    "SET",
    memoryKey(userId),
    JSON.stringify(history),
  ]);
}

async function getLongMemory(userId) {
  const result = await redisCommand(["GET", memorySummaryKey(userId)]);
  return result ? String(result) : "";
}

async function updateLongMemory(userId, messages) {
  if (!messages?.length) return;
  const previous = await getLongMemory(userId);
  const transcript = messages.map(x =>
    `${x.role === "assistant" ? "AI" : "Пользователь"}: ${String(x.content || "").slice(0, 1800)}`
  ).join("\n");

  const prompt = `Сожми старую часть диалога в долговременную память AI Guide.\nСохрани только полезные факты, решения, предпочтения, проекты, имена, договорённости и важный контекст.\nНе сохраняй случайный мусор и не выдумывай факты. Пиши компактно на русском.\n\nПредыдущая долговременная память:\n${previous || "(пусто)"}\n\nНовые старые сообщения:\n${transcript}`;

  let result = await requestGroq({
    model: TEXT_FALLBACK_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1,
    maxTokens: 900,
  });

  const summary = cleanAIResponse(result.text);
  if (summary) {
    await redisCommand(["SET", memorySummaryKey(userId), summary.slice(0, 12000)]);
  }
}


async function getMediaStack(userId) {
  const raw = await redisCommand(["GET", mediaStackKey(userId)]);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.slice(-5) : [];
  } catch { return []; }
}

async function saveMediaStack(userId, list) {
  const clean = (Array.isArray(list) ? list : []).slice(-5);
  await redisCommand(["SET", mediaStackKey(userId), JSON.stringify(clean), "EX", "604800"]);
}

async function saveLastMedia(userId, media) {
  if (!media?.fileId || !media?.type) return;
  const value = {
    ...media,
    id: media.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    savedAt: Date.now(),
    description: String(media.description || "").slice(0, 6000),
    transcript: String(media.transcript || "").slice(0, 3000),
  };
  await redisCommand(["SET", lastMediaKey(userId), JSON.stringify(value), "EX", "604800"]);
  const stack = await getMediaStack(userId);
  const withoutSame = stack.filter(x => x?.fileId !== value.fileId);
  withoutSame.push(value);
  await saveMediaStack(userId, withoutSame);
  return value;
}

async function updateStoredMedia(userId, media) {
  if (!media?.fileId) return;
  const value = { ...media, savedAt: media.savedAt || Date.now() };
  await redisCommand(["SET", lastMediaKey(userId), JSON.stringify(value), "EX", "604800"]);
  const stack = await getMediaStack(userId);
  const index = stack.findIndex(x => x?.fileId === value.fileId);
  if (index >= 0) stack[index] = value; else stack.push(value);
  await saveMediaStack(userId, stack);
}

async function getLastMedia(userId) {
  const raw = await redisCommand(["GET", lastMediaKey(userId)]);
  if (raw) { try { return JSON.parse(raw); } catch {} }
  const stack = await getMediaStack(userId);
  return stack.at(-1) || null;
}

async function getMessageGraph(userId) {
  const raw = await redisCommand(["GET", messageGraphKey(userId)]);
  if (!raw) return [];
  try {
    const graph = JSON.parse(raw);
    return Array.isArray(graph) ? graph.slice(-MESSAGE_GRAPH_LIMIT) : [];
  } catch {
    return [];
  }
}

async function saveMessageNode(userId, node) {
  if (!node?.messageId) return null;
  const graph = await getMessageGraph(userId);
  const cleanNode = {
    messageId: Number(node.messageId),
    role: node.role === "assistant" ? "assistant" : "user",
    text: String(node.text || "").slice(0, 5000),
    replyToMessageId: node.replyToMessageId ? Number(node.replyToMessageId) : null,
    parentMessageId: node.parentMessageId ? Number(node.parentMessageId) : null,
    sourceMessageId: node.sourceMessageId ? Number(node.sourceMessageId) : null,
    media: node.media?.fileId ? {
      type: node.media.type,
      fileId: node.media.fileId,
      duration: Number(node.media.duration || 0),
      caption: String(node.media.caption || "").slice(0, 1200),
    } : null,
    task: node.task || null,
    createdAt: Date.now(),
  };
  const withoutSame = graph.filter(x => Number(x?.messageId) !== cleanNode.messageId);
  withoutSame.push(cleanNode);
  await redisCommand([
    "SET", messageGraphKey(userId),
    JSON.stringify(withoutSame.slice(-MESSAGE_GRAPH_LIMIT)),
    "EX", String(CONTEXT_TTL_SECONDS),
  ]);
  return cleanNode;
}

async function findMessageNode(userId, messageId) {
  if (!messageId) return null;
  const graph = await getMessageGraph(userId);
  return graph.find(x => Number(x?.messageId) === Number(messageId)) || null;
}

async function traceMessageContext(userId, messageId, maxDepth = 12) {
  const graph = await getMessageGraph(userId);
  const byId = new Map(graph.map(x => [Number(x.messageId), x]));
  const chain = [];
  const seen = new Set();
  let current = byId.get(Number(messageId)) || null;
  while (current && chain.length < maxDepth && !seen.has(Number(current.messageId))) {
    chain.push(current);
    seen.add(Number(current.messageId));
    const nextId = current.parentMessageId || current.replyToMessageId || current.sourceMessageId;
    current = nextId ? byId.get(Number(nextId)) || null : null;
  }
  return chain;
}

async function getActiveContext(userId) {
  const raw = await redisCommand(["GET", activeContextKey(userId)]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function saveActiveContext(userId, context) {
  if (!context) return;
  await redisCommand([
    "SET", activeContextKey(userId),
    JSON.stringify({ ...context, updatedAt: Date.now() }),
    "EX", String(CONTEXT_TTL_SECONDS),
  ]);
}

function extractTaskSelection(text) {
  const t = String(text || "").toLowerCase();
  const match = t.match(/(?:завдан(?:ня|ие|ия)|вправ(?:а|у|ы|и)|пункт(?:ы|и|а)?|номер(?:а|ы)?)?\s*№?\s*(\d+(?:\s*[,іи]\s*\d+){0,8})/i);
  if (!match) return [];
  return [...new Set(match[1].split(/\s*[,іи]\s*/).map(Number).filter(Number.isFinite))];
}

function detectTaskModifiers(text) {
  const t = String(text || "").trim().toLowerCase();
  return {
    length: /(?:ещ[её]\s+)?(?:коротк|кратк|стисл)/i.test(t) ? "short" :
      /(?:подробн|детальн|розгорнут)/i.test(t) ? "detailed" : null,
    all: /^(?:ало[,.!? ]*)?(?:ус[еі]|все)\s+(?:завдан|вправ|пункт)/i.test(t),
    simplify: /(?:простіш|проще|простыми словами)/i.test(t),
  };
}

function isContextModifier(text) {
  const t = String(text || "").trim().toLowerCase();
  return /^(?:ало[,.!? ]*)?(?:ще\s+|ещ[её]\s+)?(?:коротко|короче|стисло|детальніше|подробнее|простіше|проще|ус[еі]\s+завдання|все\s+задания|продовж(?:уй)?|продолж(?:ай)?)[.!? ]*$/i.test(t) ||
    /^(?:завдан(?:ня|ие)\s*)?№?\s*\d+\s+(?:ще\s+|ещ[её]\s+)?(?:коротше|короче|подробнее|детальніше)/i.test(t);
}

async function buildReplyContext(userId, message) {
  const reply = message?.reply_to_message;
  if (!reply?.message_id) return { chain: [], media: null, text: "" };
  const chain = await traceMessageContext(userId, reply.message_id);
  const mediaNode = chain.find(x => x?.media?.fileId) || null;
  const quotedText = String(reply.text || reply.caption || chain[0]?.text || "").slice(0, 4000);
  const chainText = chain.slice(0, 8).map(x =>
    `${x.role === "assistant" ? "AI" : "Пользователь"} #${x.messageId}: ${String(x.text || "").slice(0, 1000)}`
  ).join("\n");
  return {
    chain,
    media: mediaNode?.media || null,
    sourceMessageId: mediaNode?.messageId || chain.at(-1)?.messageId || null,
    text: `Пользователь сделал Telegram Reply на сообщение:\n${quotedText || "(без текста)"}${chainText ? `\n\nСвязанная цепочка:\n${chainText}` : ""}`,
  };
}

function looksLikeMediaFollowup(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;

  // Explicit references to recent media or visual details.
  if (/(?:видео|видос|круж|фото|картин|изображ|кадр|там|тут|на н[её]м|на этом|на первом|на втором|первый|второй|последн|предыдущ|эти два|оба|двух|мыш|клавиат|бренд|марка|логотип|модель|предмет|человек|что это|что за|кто это|покажи|посмотри|рассмотри|увелич|прочитай|надпис|цвет|форм|размер|материал|текстур|слева|справа|фон|video|photo|brand|logo)/i.test(t)) {
    return true;
  }

  // Natural follow-ups after a photo/circle: "а какой она формы?",
  // "а он какого цвета?", "а что рядом?" etc.
  return /^(?:а\s+)?(?:како(?:й|го|му|м)|какая|какую|какие|какого|какой|что|кто|где|есть\s+ли|видно\s+ли)\b.*(?:он|она|оно|они|его|е[её]|их|рядом|сверху|снизу|слева|справа)?/i.test(t);
}

function pickMediaFromStack(stack, text) {
  const list = Array.isArray(stack) ? stack : [];
  if (!list.length) return [];
  const t = String(text || "").toLowerCase();
  if (/(?:оба|эти два|два круж|двух круж|два видео|двух видео)/i.test(t)) return list.slice(-2);
  if (/(?:перв(?:ый|ом|ого)|1(?:-й|й)?)/i.test(t) && list.length >= 2) return [list.at(-2)];
  if (/(?:втор(?:ой|ом|ого)|2(?:-й|й)?)/i.test(t) && list.length >= 2) return [list.at(-1)];
  if (/(?:предыдущ)/i.test(t) && list.length >= 2) return [list.at(-2)];
  return [list.at(-1)];
}

function isVisionFailure(answer) {
  return /^⚠️/.test(String(answer || "").trim());
}

function isProbablyWhisperHallucination(text, duration = 0) {
  const t = String(text || "").trim();
  if (!t) return true;
  if (Number(duration) <= 6 && t.length < 18) return true;
  if (/^(?:thank you|thanks for watching|subscribe|you|hvað er það|adehi apalagi)[.!? ]*$/i.test(t)) return true;
  return false;
}

function isTechnicalMemoryEntry(text) {
  const t = String(text || "").trim();
  return /^\[(?:стикер|анимированный стикер|видеостикер|custom emoji|gif-анимация|обычное видео|telegram-кружок)/i.test(t);
}

async function saveExchange(userId, userText, assistantText) {
  const history = await getHistory(userId);

  // Media reactions should not pollute conversational/long-term memory.
  if (isTechnicalMemoryEntry(userText)) return;

  history.push({ role: "user", content: String(userText).slice(0, 5000) });
  history.push({ role: "assistant", content: String(assistantText).slice(0, 5000) });

  if (history.length > MAX_HISTORY_MESSAGES) {
    const overflow = history.length - MAX_HISTORY_MESSAGES;
    const batchSize = Math.max(MEMORY_SUMMARY_BATCH, overflow);
    const oldMessages = history.splice(0, Math.min(batchSize, history.length - 20));
    try { await updateLongMemory(userId, oldMessages); }
    catch (e) { console.error("Long memory summary:", e); }
  }

  await saveHistory(userId, history);
}


async function clearHistory(userId) {
  await redisCommand(["DEL", memoryKey(userId)]);
  await redisCommand(["DEL", memorySummaryKey(userId)]);
  await redisCommand(["DEL", lastMediaKey(userId)]);
  await redisCommand(["DEL", mediaStackKey(userId)]);
  await redisCommand(["DEL", messageGraphKey(userId)]);
  await redisCommand(["DEL", activeContextKey(userId)]);
}


// ======================================================
// TELEGRAM
// ======================================================

async function telegramRequest(
  method,
  body = {}
) {
  try {
    const response = await fetch(
      `${TELEGRAM_API}/${method}`,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    const raw = await response.text();

    if (!response.ok) {
      console.error(
        `Telegram ${method}:`,
        raw
      );
      return null;
    }

    return JSON.parse(raw);

  } catch (error) {
    console.error(
      `Telegram ${method}:`,
      error
    );
    return null;
  }
}


async function sendMessage(
  chatId,
  text
) {
  let output =
    String(text || "").trim();

  if (!output) {
    output =
      "Не удалось получить ответ.";
  }

  // Telegram message limit safety
  const sent = [];
  for (
    let i = 0;
    i < output.length;
    i += 4000
  ) {
    const part =
      output.slice(i, i + 4000);

    const result = await telegramRequest(
      "sendMessage",
      {
        chat_id: chatId,
        text: part,
      }
    );
    if (result?.ok && result.result) sent.push(result.result);
  }
  return sent;
}

async function sendTrackedMessage(chatId, userId, text, context = {}) {
  const sent = await sendMessage(chatId, text);
  for (const item of sent || []) {
    await saveMessageNode(userId, {
      messageId: item.message_id,
      role: "assistant",
      text: item.text || text,
      parentMessageId: context.parentMessageId || null,
      sourceMessageId: context.sourceMessageId || null,
      media: context.media || null,
      task: context.task || null,
    });
  }
  return sent;
}


async function sendChatAction(
  chatId,
  action = "typing"
) {
  await telegramRequest(
    "sendChatAction",
    {
      chat_id: chatId,
      action,
    }
  );
}


function startThinking(chatId) {
  let stopped = false;

  const run = async () => {
    while (!stopped) {
      await sendChatAction(
        chatId,
        "typing"
      );

      await sleep(4000);
    }
  };

  run().catch(console.error);

  return () => {
    stopped = true;
  };
}


// ======================================================
// TELEGRAM FILE
// ======================================================

async function getTelegramFile(
  fileId
) {
  try {
    const infoResponse =
      await fetch(
        `${TELEGRAM_API}/getFile?file_id=${encodeURIComponent(fileId)}`
      );

    const info =
      await infoResponse.json();

    if (
      !info.ok ||
      !info.result?.file_path
    ) {
      console.error(
        "Telegram getFile:",
        info
      );
      return null;
    }

    const filePath =
      info.result.file_path;

    const response =
      await fetch(
        `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`
      );

    if (!response.ok) {
      console.error(
        "Telegram file:",
        response.status
      );
      return null;
    }

    return {
      filePath,
      buffer: Buffer.from(
        await response.arrayBuffer()
      ),
    };

  } catch (error) {
    console.error(
      "Telegram file exception:",
      error
    );
    return null;
  }
}


// ======================================================
// IMAGE
// ======================================================

function imageMimeType(filePath) {
  const path =
    String(filePath || "")
      .toLowerCase();

  if (path.endsWith(".png")) {
    return "image/png";
  }

  if (path.endsWith(".webp")) {
    return "image/webp";
  }

  return "image/jpeg";
}


async function getTelegramImageData(
  fileId
) {
  const file =
    await getTelegramFile(fileId);

  if (!file) return null;

  const mime =
    imageMimeType(file.filePath);

  const base64 =
    file.buffer.toString("base64");

  console.log(
    "Image:",
    file.filePath,
    "bytes:",
    file.buffer.length
  );

  return {
    bytes: file.buffer.length,
    dataUrl:
      `data:${mime};base64,${base64}`,
  };
}


// ======================================================
// LANGUAGE
// ======================================================

function detectLanguage(text) {
  const source =
    String(text || "").trim();

  if (!source) return "ru";

  if (
    /[іїєґ]/i.test(source) ||
    /\b(що|зроби|виконай|вправу|поясни|відповідь|сьогодні|зараз|будь ласка)\b/i.test(source)
  ) {
    return "uk";
  }

  if (/[а-яё]/i.test(source)) {
    return "ru";
  }

  if (/[a-z]/i.test(source)) {
    return "en";
  }

  // Emoji / numbers / punctuation without letters:
  // default to Russian instead of accidental English.
  return "ru";
}


function languageInstruction(lang) {
  if (lang === "uk") {
    return (
      "Відповідай українською мовою."
    );
  }

  if (lang === "en") {
    return "Answer in English.";
  }

  return (
    "Отвечай на русском языке."
  );
}


// ======================================================
// MATH
// ======================================================

function superscriptNumber(value) {
  const map = {
    "0": "⁰",
    "1": "¹",
    "2": "²",
    "3": "³",
    "4": "⁴",
    "5": "⁵",
    "6": "⁶",
    "7": "⁷",
    "8": "⁸",
    "9": "⁹",
    "-": "⁻",
    "+": "⁺",
    "(": "⁽",
    ")": "⁾",
  };

  return String(value)
    .split("")
    .map(x => map[x] || x)
    .join("");
}


function subscriptNumber(value) {
  const map = {
    "0": "₀",
    "1": "₁",
    "2": "₂",
    "3": "₃",
    "4": "₄",
    "5": "₅",
    "6": "₆",
    "7": "₇",
    "8": "₈",
    "9": "₉",
    "+": "₊",
    "-": "₋",
    "(": "₍",
    ")": "₎",
  };

  return String(value)
    .split("")
    .map(x => map[x] || x)
    .join("");
}


function telegramMathRules() {
  return `
ВАЖНОЕ ПРАВИЛО ФОРМАТИРОВАНИЯ:

Ответ отправляется в Telegram как обычный текст.

НИКОГДА не используй LaTeX или Markdown для математических формул.

Запрещено писать:
$...$
$$...$$
\\[
\\]
\\(
\\)
\\frac
\\cdot
\\times
\\sqrt
^{...}
_{...}

Не оборачивай формулы в символ $.

Не пиши:
$5,4 \\cdot 10^{4}$

Пиши:
5,4 · 10⁴

Не пиши:
10^{-3+1}

Лучше сразу вычисли степень:
10⁻²

Примеры:

R = U / I

S = a · b

5,4 · 10⁴

1,02 · 10⁻²

Q = I² · R · t

h = √(m · n)

x = (-b ± √D) / (2a)

Используй обычные Unicode-символы:
· × ÷ √ ± ≈ ≤ ≥ ² ³ ⁴ ⁵ ⁶ ⁷ ⁸ ⁹
`;
}


// ======================================================
// OUTPUT CLEANER
// ======================================================

function cleanAIResponse(text) {
  if (!text) return "";

  let result = String(text);

  // Groq internal garbage if it appears
  result = result.replace(
    /<\|tool_call_start\|>[\s\S]*?<\|tool_call_end\|>/gi,
    ""
  );

  result = result.replace(
    /<\|tool_call_start\|>[\s\S]*$/gi,
    ""
  );

  result = result.replace(
    /<\|tool_call_end\|>/gi,
    ""
  );

  result = result.replace(
    /^\s*User Safety\s*:\s*safe\s*$/gim,
    ""
  );

  // Remove Markdown bold markers
  result =
    result.replace(/\*\*/g, "");

  // Remove common LaTeX wrappers
  result = result
    .replace(/\\\[/g, "")
    .replace(/\\\]/g, "")
    .replace(/\\\(/g, "")
    .replace(/\\\)/g, "")
    .replace(/\$\$/g, "")
    .replace(/\$/g, "");

  // Common LaTeX commands
  result = result
    .replace(/\\cdot/g, "·")
    .replace(/\\times/g, "×")
    .replace(/\\div/g, "÷")
    .replace(/\\pm/g, "±")
    .replace(/\\approx/g, "≈")
    .replace(/\\neq/g, "≠")
    .replace(/\\leq/g, "≤")
    .replace(/\\geq/g, "≥")
    .replace(/\\alpha/g, "α")
    .replace(/\\beta/g, "β")
    .replace(/\\gamma/g, "γ")
    .replace(/\\Delta/g, "Δ")
    .replace(/\\pi/g, "π")
    .replace(/\\Omega/g, "Ω");

  result = result.replace(
    /\\text\{([^{}]*)\}/g,
    "$1"
  );

  result = result.replace(
    /\\mathrm\{([^{}]*)\}/g,
    "$1"
  );

  result = result.replace(
    /\\sqrt\{([^{}]*)\}/g,
    "√($1)"
  );

  // Fractions
  for (let i = 0; i < 6; i++) {
    result = result.replace(
      /\\frac\{([^{}]+)\}\{([^{}]+)\}/g,
      "($1) / ($2)"
    );
  }

  // 10^{4}
  result = result.replace(
    /10\^\{([+\-]?\d+)\}/g,
    (_, power) =>
      "10" +
      superscriptNumber(power)
  );

  // 10^4
  result = result.replace(
    /10\^([+\-]?\d+)/g,
    (_, power) =>
      "10" +
      superscriptNumber(power)
  );

  // x^{2}
  result = result.replace(
    /([A-Za-zА-Яа-яІіЇїЄєҐґ0-9])\^\{([+\-]?\d+)\}/g,
    (_, base, power) =>
      base +
      superscriptNumber(power)
  );

  // x^2
  result = result.replace(
    /([A-Za-zА-Яа-яІіЇїЄєҐґ])\^([+\-]?\d+)/g,
    (_, base, power) =>
      base +
      superscriptNumber(power)
  );

  // a_{2}
  result = result.replace(
    /_\{([+\-]?\d+)\}/g,
    (_, number) =>
      subscriptNumber(number)
  );

  // Remaining simple ^{...} expressions.
  // Example: ^{-5+9}
  result = result.replace(
    /\^\{([+\-\d()]+)\}/g,
    (_, value) =>
      superscriptNumber(value)
  );

  // Remove leftover LaTeX spacing
  result = result
    .replace(/\\,/g, " ")
    .replace(/\\;/g, " ")
    .replace(/\\!/g, "");

  // Remove some leftover braces around numbers
  result = result.replace(
    /\{([+\-]?\d+)\}/g,
    "$1"
  );

  // Normalize spaces
  result = result.replace(
    /[ \t]+\n/g,
    "\n"
  );

  result = result.replace(
    /\n{3,}/g,
    "\n\n"
  );

  return result.trim();
}


// ======================================================
// INTERNET
// ======================================================

function needsInternet(text) {
  const t =
    String(text || "")
      .toLowerCase();

  if (!t) return false;

  const triggers = [
    "сейчас",
    "сегодня",
    "последн",
    "свеж",
    "новости",
    "погода",
    "курс",
    "доллар",
    "евро",
    "гривн",
    "цена",
    "сколько стоит",
    "обновление",
    "релиз",

    "зараз",
    "сьогодні",
    "останні",
    "свіж",
    "новини",
    "погода",
    "курс",
    "ціна",
    "скільки коштує",
    "оновлення",

    "current",
    "today",
    "latest",
    "news",
    "weather",
    "price",
    "update",
    "release",
  ];

  return triggers.some(
    trigger => t.includes(trigger)
  );
}


// ======================================================
// TAVILY
// ======================================================

async function searchWeb(query) {
  if (!TAVILY_API_KEY) {
    return null;
  }

  try {
    const response = await fetch(
      "https://api.tavily.com/search",
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${TAVILY_API_KEY}`,
          "Content-Type":
            "application/json",
        },
        body: JSON.stringify({
          query,
          search_depth: "basic",
          max_results: 7,
          include_answer: true,
          include_raw_content: false,
        }),
      }
    );

    const raw = await response.text();

    if (!response.ok) {
      console.error(
        "Tavily:",
        raw
      );
      return null;
    }

    return JSON.parse(raw);

  } catch (error) {
    console.error(
      "Tavily exception:",
      error
    );
    return null;
  }
}


function makeWebContext(data) {
  if (!data) return null;

  let output = "";

  if (data.answer) {
    output +=
      `SEARCH SUMMARY:\n${data.answer}\n\n`;
  }

  if (Array.isArray(data.results)) {
    output += data.results
      .slice(0, 7)
      .map(
        (item, index) => `
RESULT ${index + 1}

TITLE:
${item.title || "Unknown"}

CONTENT:
${item.content || "Unknown"}
`
      )
      .join("\n");
  }

  return output.trim() || null;
}


// ======================================================
// SYSTEM PROMPT
// ======================================================

function makeSystemPrompt({
  language,
  webContext = null,
  vision = false,
}) {
  const now =
    new Date().toLocaleString(
      "ru-RU",
      {
        timeZone:
          "Europe/Kyiv",
      }
    );

  let prompt = `
Ты AI Guide — персональный Telegram AI-ассистент.

Текущее время:
${now}

${languageInstruction(language)}

Отвечай естественно и понятно.

Учитывай историю разговора.

СТИЛЬ ОТВЕТОВ:
- Сначала дай прямой ответ или готовый результат.
- Не повторяй вопрос пользователя и не пиши длинное вступление.
- Не добавляй общие советы, предупреждения и варианты, если их не просили.
- По умолчанию отвечай компактно: обычно 1–4 абзаца. Для сложной задачи можно подробнее.
- Если пользователь просит конкретные пункты, выполни все названные пункты и ничего лишнего.
- «коротко», «ещё короче», «подробнее», «проще» относятся ко всему активному ответу, если номер пункта не указан.
- Не говори «я текстовая модель», «я не вижу прошлое медиа» или о внутренних ограничениях. Если анализ временно упал, кратко скажи, что произошла ошибка анализа и предложи/выполни повторную проверку.
- Не придумывай недостающие данные. Если без них нельзя ответить точно, задай один конкретный вопрос.

Если пользователь пишет:
"короче"
"подробнее"
"продолжи"
"почему"
"сделай 3"
"тепер 4"

используй предыдущий контекст.

Для школьных заданий:
1. Внимательно прочитай условие.
2. Не меняй числа и знаки.
3. Не придумывай текст.
4. Выполняй именно тот пункт, который попросили.
5. Проверяй вычисления.
6. Объясняй на уровне школьника.
7. Если пользователь просит решение — показывай ход решения, а не только ответ.

ВАЖНО:

Если на странице написано:
"ВПРАВА №1"

и ниже есть:
1.
2.
3.
4.

а пользователь пишет:
"3 вправу виконай"

то он обычно просит ПУНКТ 3 этой вправы.

Не выполняй всю страницу без просьбы.

Не показывай скрытую цепочку рассуждений.

${telegramMathRules()}
`;

  if (vision) {
    prompt += `

Тебе передано настоящее изображение.

Внимательно прочитай изображение.

Текст пользователя является инструкцией к изображению.

Если это Reply на ранее отправленное фото,
переданное изображение является именно тем фото,
на которое пользователь ответил.

Если пользователь просит пункт 3,
выполни только пункт 3.

Особенно внимательно распознавай:
- цифры;
- десятичные запятые;
- минусы;
- плюсы;
- показатели степеней;
- единицы измерения;
- номера заданий.

ПЕРЕД ОТВЕТОМ внутренне перепроверь
все распознанные числа по изображению.

Не выдумывай то,
что невозможно прочитать.

Не говори,
что не видишь изображение,
если оно передано в запросе.
`;
  }

  if (webContext) {
    prompt += `

АКТУАЛЬНАЯ ИНФОРМАЦИЯ ИЗ WEB SEARCH:

${webContext}

Используй её для ответа.
Не вставляй пользователю длинный список URL.
`;
  }

  return prompt;
}


// ======================================================
// GROQ
// ======================================================

async function requestGroq({
  model,
  messages,
  temperature = 0.4,
  maxTokens = 1800,
  allowVisionFallback = true,
}) {
  if (!GROQ_API_KEY) {
    return {
      ok: false,
      status: 0,
      error:
        "GROQ_API_KEY missing",
      text: null,
    };
  }

  try {
    const response = await fetch(
      GROQ_CHAT_API,
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${GROQ_API_KEY}`,
          "Content-Type":
            "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_completion_tokens:
            maxTokens,
        }),
      }
    );

    const raw = await response.text();

    console.log(
      `Groq ${model}:`,
      response.status
    );

    if (!response.ok) {
      console.error(`Groq ${model}:`, raw);

      // V7.7.0 HARD SAFETY NET:
      // If ANY code path calls Groq Vision directly and it fails,
      // Gemini is invoked right here instead of relying on a caller.
      if (model === VISION_MODEL && allowVisionFallback) {
        console.log("V7.7.0 DEBUG: direct Groq Vision failure -> Gemini safety net");
        const gemini = await requestGeminiVision({ messages, temperature, maxTokens });
        if (gemini.ok && gemini.text) {
          console.log("V7.7.0 DEBUG: Gemini safety net SUCCESS");
          return { ...gemini, provider: "gemini" };
        }
        console.error(`V7.7.0 DEBUG: Gemini safety net FAILED (${gemini.status || "network/config"})`);
      }

      return {
        ok: false,
        status: response.status,
        error: raw,
        text: null,
      };
    }

    const data = JSON.parse(raw);

    return {
      ok: true,
      status: 200,
      error: null,
      text:
        data?.choices?.[0]
          ?.message?.content ||
        null,
    };

  } catch (error) {
    console.error(
      "Groq exception:",
      error
    );

    return {
      ok: false,
      status: 0,
      error: String(error),
      text: null,
    };
  }
}


async function requestGeminiVision({
  messages,
  temperature = 0.2,
  maxTokens = 1200,
}) {
  console.log(`V7.7.0 DEBUG: requestGeminiVision ENTER keyPresent=${Boolean(GEMINI_API_KEY)}`);
  if (!GEMINI_API_KEY) {
    console.error("Gemini Vision: GEMINI_API_KEY missing");
    return { ok: false, status: 0, error: "GEMINI_API_KEY missing", text: null };
  }

  // Convert our OpenAI-style Vision messages into Gemini native parts.
  // This deliberately keeps the request compact: text + actual image bytes only.
  const parts = [];
  for (const message of messages || []) {
    const content = message?.content;
    if (typeof content === "string") {
      const text = content.trim();
      if (text) parts.push({ text });
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const item of content) {
      if (item?.type === "text" && item.text) {
        parts.push({ text: String(item.text) });
        continue;
      }
      if (item?.type === "image_url") {
        const url = String(item?.image_url?.url || "");
        const match = url.match(/^data:([^;,]+);base64,(.+)$/s);
        if (match) {
          parts.push({
            inline_data: {
              mime_type: match[1] || "image/jpeg",
              data: match[2],
            },
          });
        }
      }
    }
  }

  const imageCount = parts.filter(x => x.inline_data).length;
  console.log(`Gemini Vision START ${GEMINI_VISION_MODEL}: ${imageCount} image(s)`);

  if (!imageCount) {
    console.error("Gemini Vision: no image parts found");
    return { ok: false, status: 0, error: "No image parts for Gemini", text: null };
  }

  try {
    const response = await fetch(GEMINI_GENERATE_API, {
      method: "POST",
      headers: {
        "x-goog-api-key": GEMINI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
        },
      }),
    });

    const raw = await response.text();
    console.log(`Gemini Vision ${GEMINI_VISION_MODEL}:`, response.status);

    if (!response.ok) {
      console.error(`Gemini Vision ${GEMINI_VISION_MODEL}:`, raw);
      return { ok: false, status: response.status, error: raw, text: null };
    }

    const data = JSON.parse(raw);
    const text = (data?.candidates?.[0]?.content?.parts || [])
      .map(part => part?.text || "")
      .join("\n")
      .trim();

    if (!text) {
      console.error("Gemini Vision: 200 but empty text response");
      return { ok: false, status: 200, error: "Gemini returned empty text", text: null };
    }

    return { ok: true, status: 200, error: null, text };
  } catch (error) {
    console.error("Gemini Vision exception:", error);
    return { ok: false, status: 0, error: String(error), text: null };
  }
}

async function requestVision({ messages, temperature = 0.1, maxTokens = 1200, preferGemini = false }) {
  console.log(`V7.7.0 DEBUG: requestVision ENTER preferGemini=${preferGemini}`);
  // Follow-up re-analysis: Gemini first, then Groq.
  if (preferGemini) {
    console.log("Vision route: Gemini -> Groq (media follow-up)");
    const gemini = await requestGeminiVision({ messages, temperature, maxTokens });
    if (gemini.ok && gemini.text) return { ...gemini, provider: "gemini" };

    console.log(`Gemini Vision failed (${gemini.status || "network/config"}) -> Groq`);
    const groq = await requestGroq({
      model: VISION_MODEL,
      messages,
      temperature,
      maxTokens,
      allowVisionFallback: false,
    });
    if (groq.ok && groq.text) return { ...groq, provider: "groq" };

    return {
      ok: false,
      status: groq.status || gemini.status || 0,
      error: groq.error || gemini.error || "Both Vision providers failed",
      text: null,
      groqStatus: groq.status,
      groqError: groq.error,
      geminiStatus: gemini.status,
      geminiError: gemini.error,
    };
  }

  // First analysis: Groq first. ANY Groq failure immediately invokes Gemini.
  console.log("Vision route: Groq -> Gemini");
  const groq = await requestGroq({
    model: VISION_MODEL,
    messages,
    temperature,
    maxTokens,
    allowVisionFallback: false,
  });
  if (groq.ok && groq.text) return { ...groq, provider: "groq" };

  console.log(`Groq Vision failed (${groq.status || "network/config"}) -> Gemini NOW`);
  const gemini = await requestGeminiVision({ messages, temperature, maxTokens });
  if (gemini.ok && gemini.text) return { ...gemini, provider: "gemini" };

  return {
    ok: false,
    status: gemini.status || groq.status || 0,
    error: gemini.error || groq.error || "Both Vision providers failed",
    text: null,
    groqStatus: groq.status,
    groqError: groq.error,
    geminiStatus: gemini.status,
    geminiError: gemini.error,
  };
}


function isRequestTooLarge(result) {
  const error =
    String(
      result?.error || ""
    ).toLowerCase();

  return (
    error.includes(
      "request too large"
    ) ||
    error.includes(
      "request_too_large"
    ) ||
    error.includes(
      "too large for model"
    )
  );
}


// ======================================================
// TEXT AI
// ======================================================

async function askTextAI({
  text,
  userId,
  language,
  webContext = null,
  referenceContext = "",
  activeContext = null,
}) {
  const history =
    await getHistory(userId);
  const longMemory = await getLongMemory(userId);

  const messages = [
    {
      role: "system",
      content:
        makeSystemPrompt({
          language,
          webContext,
        }) + (longMemory ? `\n\nДОЛГОВРЕМЕННАЯ ПАМЯТЬ ИЗ БОЛЕЕ СТАРОГО ДИАЛОГА:\n${longMemory}` : "") +
        (referenceContext ? `\n\nТОЧНЫЙ КОНТЕКСТ TELEGRAM REPLY:\n${referenceContext}\nReply имеет приоритет над последней общей темой. Отвечай именно на него.` : "") +
        (activeContext ? `\n\nАКТИВНАЯ ЗАДАЧА:\n${JSON.stringify(activeContext)}\nЕсли новое сообщение — модификатор вроде «коротко» или «все задания», переделай всю активную задачу с этим изменением.` : ""),
    },

    ...history,

    {
      role: "user",
      content: text,
    },
  ];

  let result =
    await requestGroq({
      model: TEXT_MODEL,
      messages,
      temperature: 0.35,
      maxTokens: 1800,
    });

  if (!result.ok) {
    result =
      await requestGroq({
        model:
          TEXT_FALLBACK_MODEL,
        messages,
        temperature: 0.35,
        maxTokens: 1800,
      });
  }

  const cleaned =
    cleanAIResponse(result.text);

  if (cleaned) {
    return cleaned;
  }

  if (result.status === 429) {
    return (
      "⚠️ Сейчас достигнут лимит Groq. Попробуй немного позже."
    );
  }

  return (
    "⚠️ Не удалось получить ответ от Groq. Попробуй ещё раз."
  );
}


// ======================================================
// VISION
// ======================================================

async function askVisionAI({
  images,
  caption,
  userId,
  language,
  preferGemini = false,
}) {
  const history =
    await getHistory(userId);

  // Very small history for Vision
  const tinyHistory =
    history
      .slice(-2)
      .map(item => ({
        role: item.role,
        content:
          String(item.content)
            .slice(0, 600),
      }));

  const userContent = [
    {
      type: "text",
      text:
        caption ||
        "Внимательно проанализируй изображение.",
    },
  ];

  for (
    const image of images.slice(
      0,
      MAX_VISION_IMAGES
    )
  ) {
    userContent.push({
      type: "image_url",
      image_url: {
        url: image.dataUrl,
      },
    });
  }

  let messages = [
    {
      role: "system",
      content:
        makeSystemPrompt({
          language,
          vision: true,
        }),
    },

    ...tinyHistory,

    {
      role: "user",
      content: userContent,
    },
  ];

  let result =
    await requestVision({
      messages,
      temperature: 0.1,
      maxTokens: 1300,
      preferGemini,
    });

  // Retry with minimal prompt
  if (
    !result.ok &&
    isRequestTooLarge(result)
  ) {
    console.log(
      "Vision too large -> minimal retry"
    );

    messages = [
      {
        role: "system",
        content: `
${languageInstruction(language)}

Внимательно прочитай изображение.

Выполни только то,
что попросил пользователь.

Не придумывай нечитаемые числа.

Проверь цифры,
знаки и степени.

Не используй LaTeX.

Пиши:
5,4 · 10⁴
1,02 · 10⁻²
R = U / I
`.trim(),
      },

      {
        role: "user",
        content: userContent,
      },
    ];

    result =
      await requestVision({
        messages,
        temperature: 0.1,
        maxTokens: 900,
        preferGemini,
      });
  }

  const cleaned =
    cleanAIResponse(result.text);

  if (cleaned) {
    return cleaned;
  }

  if (isRequestTooLarge(result)) {
    return (
      "⚠️ Не удалось обработать слишком большое изображение. Обрежь нужную часть или отправь скриншот поменьше."
    );
  }

  if (result.status === 429) {
    return (
      "⚠️ Сейчас Vision временно недоступен. Попробуй немного позже."
    );
  }

  return (
    "⚠️ Vision не смог обработать изображение."
  );
}


// ======================================================
// WHISPER
// ======================================================

async function transcribeTelegramAudio(
  fileId
) {
  const file =
    await getTelegramFile(fileId);

  if (!file) return null;

  try {
    const lower =
      file.filePath.toLowerCase();

    let extension = "ogg";
    let mime = "audio/ogg";

    if (lower.endsWith(".mp3")) {
      extension = "mp3";
      mime = "audio/mpeg";
    }

    if (lower.endsWith(".wav")) {
      extension = "wav";
      mime = "audio/wav";
    }

    if (lower.endsWith(".m4a")) {
      extension = "m4a";
      mime = "audio/mp4";
    }

    if (lower.endsWith(".webm")) {
      extension = "webm";
      mime = "audio/webm";
    }

    const form = new FormData();

    form.append(
      "file",
      new Blob(
        [file.buffer],
        { type: mime }
      ),
      `voice.${extension}`
    );

    form.append(
      "model",
      WHISPER_MODEL
    );

    form.append(
      "response_format",
      "json"
    );

    form.append(
      "temperature",
      "0"
    );

    const response = await fetch(
      GROQ_TRANSCRIBE_API,
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${GROQ_API_KEY}`,
        },
        body: form,
      }
    );

    const raw = await response.text();

    console.log(
      "Whisper:",
      response.status
    );

    if (!response.ok) {
      console.error(
        "Whisper:",
        raw
      );
      return null;
    }

    const data = JSON.parse(raw);

    return (
      data?.text?.trim() ||
      null
    );

  } catch (error) {
    console.error(
      "Whisper exception:",
      error
    );
    return null;
  }
}


// ======================================================
// VOICE
// ======================================================

async function handleVoice({
  chatId,
  userId,
  fileId,
  message = null,
}) {
  const stop =
    startThinking(chatId);

  try {
    const transcription =
      await transcribeTelegramAudio(
        fileId
      );

    if (!transcription) {
      await sendMessage(
        chatId,
        "⚠️ Не удалось распознать голосовое."
      );
      return;
    }

    const replyContext = await buildReplyContext(userId, message);

    // Voice follow-ups must be able to refer to a replied or recent media item.
    if (await tryHandleMediaFollowup({
      chatId,
      userId,
      text: transcription,
      messageId: message?.message_id || null,
      explicitMedia: replyContext.media,
      replyContext,
    })) {
      return;
    }

    const language =
      await getConversationLanguage(userId, transcription);

    let webContext = null;

    if (
      needsInternet(transcription)
    ) {
      webContext =
        makeWebContext(
          await searchWeb(
            transcription
          )
        );
    }

    const answer =
      await askTextAI({
        text: transcription,
        userId,
        language,
        webContext,
        referenceContext: replyContext.text,
        activeContext: await getActiveContext(userId),
      });

    await saveExchange(
      userId,
      `[Голосовое]\n${transcription}`,
      answer
    );

    await sendTrackedMessage(chatId, userId, answer, {
      parentMessageId: message?.message_id || null,
      sourceMessageId: replyContext.sourceMessageId || null,
      media: replyContext.media || null,
    });

  } finally {
    stop();
  }
}


// ======================================================
// VISION PHOTO SIZE V7.5.1
// Prefer a Telegram-compressed size to reduce Groq request-too-large errors.
// ======================================================

function selectVisionPhoto(photos) {
  if (!Array.isArray(photos) || !photos.length) return null;
  const suitable = photos.filter(p => {
    const pixels = Number(p.width || 0) * Number(p.height || 0);
    const size = Number(p.file_size || 0);
    return (!pixels || pixels <= 1600000) && (!size || size <= 700000);
  });
  return (suitable.length ? suitable[suitable.length - 1] : photos[Math.max(0, photos.length - 2)]) || photos[photos.length - 1];
}

// ======================================================
// PHOTO
// ======================================================

async function handleSinglePhoto({
  chatId,
  userId,
  fileId,
  caption,
  messageId = null,
}) {
  const stop =
    startThinking(chatId);

  try {
    const image =
      await getTelegramImageData(
        fileId
      );

    if (!image) {
      await sendMessage(
        chatId,
        "⚠️ Не удалось загрузить изображение."
      );
      return;
    }

    const language =
      detectLanguage(caption);

    const answer =
      await askVisionAI({
        images: [image],
        caption,
        userId,
        language,
      });

    await saveLastMedia(userId, {
      type: "photo",
      fileId,
      description: answer,
      caption: String(caption || "").slice(0, 1200),
    });

    await saveExchange(
      userId,
      caption
        ? `[Фото]\n${caption}`
        : "[Фото]",
      answer
    );

    const photoItems = extractTaskSelection(caption);
    if (photoItems.length || /(?:завдан|задан|вправ|упражнен|виконай|выполни)/i.test(caption)) {
      await saveActiveContext(userId, {
        type: "media_task",
        request: caption || "Выполнить задания с фото",
        selectedItems: photoItems,
        sourceMessageId: messageId,
        media: { type: "photo", fileId, caption },
        lastAnswer: answer.slice(0, 5000),
        modifiers: detectTaskModifiers(caption),
      });
    }

    await sendTrackedMessage(chatId, userId, answer, {
      parentMessageId: messageId,
      sourceMessageId: messageId,
      media: { type: "photo", fileId, caption },
    });

  } finally {
    stop();
  }
}


// ======================================================
// REPLY TO PHOTO
// ======================================================

async function handleReplyToPhoto({
  chatId,
  userId,
  message,
  text,
}) {
  const reply =
    message.reply_to_message;

  if (
    !reply?.photo?.length
  ) {
    return false;
  }

  const photo = selectVisionPhoto(reply.photo);

  const stop =
    startThinking(chatId);

  try {
    const image =
      await getTelegramImageData(
        photo.file_id
      );

    if (!image) {
      await sendMessage(
        chatId,
        "⚠️ Не удалось загрузить фото из Reply."
      );
      return true;
    }

    let instruction =
      text ||
      "Проанализируй это фото.";

    if (reply.caption) {
      instruction +=
        `\n\nИсходная подпись фото: ${reply.caption}`;
    }

    const language =
      detectLanguage(instruction);

    const answer =
      await askVisionAI({
        images: [image],
        caption: instruction,
        userId,
        language,
      });

    await saveExchange(
      userId,
      `[Reply на фото]\n${instruction}`,
      answer
    );

    await sendMessage(
      chatId,
      answer
    );

    return true;

  } finally {
    stop();
  }
}


// ======================================================
// ALBUM
// ======================================================

async function addAlbumPhoto({
  userId,
  mediaGroupId,
  fileId,
  caption,
  messageId,
}) {
  const key =
    albumKey(
      userId,
      mediaGroupId
    );

  await redisCommand([
    "RPUSH",
    key,
    JSON.stringify({
      fileId,
      caption: caption || "",
      messageId: messageId || 0,
    }),
  ]);

  await redisCommand([
    "EXPIRE",
    key,
    "60",
  ]);
}


async function getAlbum(
  userId,
  mediaGroupId
) {
  const result =
    await redisCommand([
      "LRANGE",
      albumKey(
        userId,
        mediaGroupId
      ),
      "0",
      "-1",
    ]);

  if (!Array.isArray(result)) {
    return [];
  }

  const items = [];

  for (const raw of result) {
    try {
      items.push(
        JSON.parse(raw)
      );
    } catch {}
  }

  items.sort(
    (a, b) =>
      (a.messageId || 0) -
      (b.messageId || 0)
  );

  // Dedupe
  return items.filter(
    (item, index, array) =>
      array.findIndex(
        x =>
          x.fileId === item.fileId
      ) === index
  );
}


async function tryAlbumLock(
  userId,
  mediaGroupId
) {
  const result =
    await redisCommand([
      "SET",
      albumLockKey(
        userId,
        mediaGroupId
      ),
      "1",
      "NX",
      "EX",
      "30",
    ]);

  return result === "OK";
}


async function handleAlbum({
  chatId,
  userId,
  mediaGroupId,
  fileId,
  caption,
  messageId,
}) {
  await addAlbumPhoto({
    userId,
    mediaGroupId,
    fileId,
    caption,
    messageId,
  });

  await sleep(1600);

  const lock =
    await tryAlbumLock(
      userId,
      mediaGroupId
    );

  if (!lock) return;

  await sleep(500);

  const album =
    await getAlbum(
      userId,
      mediaGroupId
    );

  if (!album.length) return;

  const stop =
    startThinking(chatId);

  try {
    const images = [];

    for (
      const item of album.slice(
        0,
        MAX_VISION_IMAGES
      )
    ) {
      const image =
        await getTelegramImageData(
          item.fileId
        );

      if (image) {
        images.push(image);
      }
    }

    if (!images.length) {
      await sendMessage(
        chatId,
        "⚠️ Не удалось загрузить фотографии."
      );
      return;
    }

    const albumCaption =
      album
        .map(x => x.caption)
        .find(Boolean) ||
      "";

    const language =
      detectLanguage(
        albumCaption
      );

    const answer =
      await askVisionAI({
        images,
        caption:
          albumCaption ||
          "Проанализируй эти фотографии вместе.",
        userId,
        language,
      });

    await saveExchange(
      userId,
      `[Альбом: ${images.length} фото]${
        albumCaption
          ? `\n${albumCaption}`
          : ""
      }`,
      answer
    );

    await sendMessage(
      chatId,
      answer
    );

  } finally {
    stop();

    await redisCommand([
      "DEL",
      albumKey(
        userId,
        mediaGroupId
      ),
    ]);
  }
}


// ======================================================
// LIGHTWEIGHT MEDIA VISION V7.5.9 — restored single Groq Vision path; sticker response reads result.text
// ======================================================

async function getConversationLanguage(userId, currentText = "") {
  const now = String(currentText || "").trim();
  if (/[а-яёіїєґ]/i.test(now)) return detectLanguage(now);
  const history = await getHistory(userId);
  const last = history.slice().reverse().find(x =>
    x.role === "user" && !String(x.content || "").startsWith("[") && /[а-яёіїєґ]/i.test(String(x.content || ""))
  );
  return last ? detectLanguage(last.content) : "ru";
}

async function askStickerVisionAI({ image, language, kind = "стикер" }) {
  const lang = languageInstruction(language);
  const messages = [{
    role: "user",
    content: [
      { type: "text", text: `${lang}
Это ${kind} из Telegram. Посмотри на реальное изображение. Не описывай его подробно, если пользователь об этом не спрашивал. Отреагируй как живой собеседник: весело, коротко, обычно 2–10 слов, можно 1–2 подходящих emoji. Не начинай с «вижу», «на превью», «на изображении». Не упоминай Telegram/API/файл. Не придумывай движение по одному кадру.` },
      { type: "image_url", image_url: { url: image.dataUrl } }
    ]
  }];
  const result = await requestVision({ messages, temperature: 0.65, maxTokens: 180 });
  if (!result.ok) return null;
  return cleanAIResponse(result.text);
}

// ======================================================
// STICKER
// ======================================================

async function handleSticker({ chatId, userId, sticker }) {
  const stop = startThinking(chatId);
  try {
    const language = await getConversationLanguage(userId);
    const emoji = String(sticker.emoji || "");
    const animated = !!sticker.is_animated;
    const video = !!sticker.is_video;
    const kind = video ? "видеостикер" : animated ? "анимированный стикер" : "стикер";

    let image = null;
    if (!animated && !video && sticker.file_id) {
      image = await getTelegramImageData(sticker.file_id);
    } else {
      const previewId = sticker.thumbnail?.file_id || sticker.thumb?.file_id || null;
      if (previewId) image = await getTelegramImageData(previewId);
    }

    if (image) {
      const answer = await askStickerVisionAI({ image, language, kind });
      if (answer) {
        await saveExchange(userId, `[${kind}${emoji ? ` ${emoji}` : ""}]`, answer);
        await sendMessage(chatId, answer);
        return;
      }
    }

    // Если Vision словил 429 или Telegram не дал preview — не шлём пользователю
    // унылое «Vision перегружен». Реагируем по контексту, не выдумывая картинку.
    const fallback = await askTextAI({
      userId,
      language,
      webContext: null,
      text: `Пользователь отправил ${kind}${emoji ? `, связанный emoji: ${emoji}` : ""}. Реального изображения сейчас нет. Не придумывай, что нарисовано. Просто коротко и весело отреагируй как собеседник на текущий контекст: 2–8 слов, можно emoji. Не объясняй технические ограничения.`
    });
    await saveExchange(userId, `[${kind}${emoji ? ` ${emoji}` : ""}]`, fallback);
    await sendMessage(chatId, fallback);
  } finally {
    stop();
  }
}


// ======================================================
// CUSTOM EMOJI
// ======================================================

function getCustomEmojiIds(
  message
) {
  const entities = [
    ...(message.entities || []),
    ...(message.caption_entities || []),
  ];

  return [
    ...new Set(
      entities
        .filter(
          entity =>
            entity.type ===
              "custom_emoji" &&
            entity.custom_emoji_id
        )
        .map(
          entity =>
            entity.custom_emoji_id
        )
    ),
  ];
}


async function getCustomEmojiStickers(
  ids
) {
  if (!ids.length) return [];

  const result =
    await telegramRequest(
      "getCustomEmojiStickers",
      {
        custom_emoji_ids: ids,
      }
    );

  if (
    !result?.ok ||
    !Array.isArray(result.result)
  ) {
    return [];
  }

  return result.result;
}


async function handleCustomEmoji({
  chatId,
  userId,
  message,
}) {
  const ids =
    getCustomEmojiIds(message);

  if (!ids.length) {
    return false;
  }

  const stop =
    startThinking(chatId);

  try {
    const stickers =
      await getCustomEmojiStickers(
        ids.slice(0, 3)
      );

    if (!stickers.length) {
      return false;
    }

    const history =
      await getHistory(userId);

    const lastUser =
      history
        .slice()
        .reverse()
        .find(
          x => x.role === "user"
        )
        ?.content ||
      "";

    const visibleText =
      message.text ||
      message.caption ||
      "";

    const language =
      await getConversationLanguage(
        userId,
        visibleText || lastUser
      );

    // If custom emoji has a static WebP representation,
    // Vision can actually inspect it.
    const images = [];

    for (
      const sticker of stickers
    ) {
      if (
        !sticker.is_animated &&
        !sticker.is_video &&
        sticker.file_id
      ) {
        const image =
          await getTelegramImageData(
            sticker.file_id
          );

        if (image) {
          images.push(image);
        }
      }

      if (
        images.length >=
        MAX_VISION_IMAGES
      ) {
        break;
      }
    }


    let answer;

    if (images.length) {
      answer = await askStickerVisionAI({
        image: images[0],
        language,
        kind: "custom emoji",
      });

    } else {
      const emojis =
        stickers
          .map(x => x.emoji)
          .filter(Boolean)
          .join(" ");

      answer =
        await askTextAI({
          text: `
Пользователь отправил Telegram custom emoji.

Связанные обычные emoji:
${emojis || "неизвестны"}

Текст сообщения:
${visibleText || "(только emoji)"}

Естественно и коротко отреагируй
на сообщение пользователя.
`,
          userId,
          language,
          webContext: null,
        });
    }

    // Custom emoji is a reaction, not a memory fact.
    await sendMessage(
      chatId,
      answer
    );

    return true;

  } finally {
    stop();
  }
}


// ======================================================
// VIDEO V7.5.4
// ======================================================

function videoMimeType(filePath) {
  const lower = String(filePath || "").toLowerCase();
  if (lower.endsWith(".webm")) return { mime: "video/webm", extension: "webm" };
  if (lower.endsWith(".mov")) return { mime: "video/quicktime", extension: "mov" };
  return { mime: "video/mp4", extension: "mp4" };
}

async function transcribeVideoFile(file) {
  if (!file || !GROQ_API_KEY) return { text: null, reliable: false, meta: null };
  try {
    const { mime, extension } = videoMimeType(file.filePath);
    const form = new FormData();
    form.append("file", new Blob([file.buffer], { type: mime }), `video.${extension}`);
    form.append("model", WHISPER_MODEL);
    // verbose_json gives us confidence/no-speech metadata when Groq exposes it.
    form.append("response_format", "verbose_json");
    form.append("temperature", "0");

    const response = await fetch(GROQ_TRANSCRIBE_API, {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      body: form,
    });

    const raw = await response.text();
    if (!response.ok) {
      console.error("Video Whisper:", response.status, raw);
      return { text: null, reliable: false, meta: null };
    }

    const data = JSON.parse(raw);
    const text = String(data?.text || "").trim() || null;
    const segments = Array.isArray(data?.segments) ? data.segments : [];

    // Prefer real confidence metadata when available.
    const noSpeechValues = segments
      .map(x => Number(x?.no_speech_prob))
      .filter(Number.isFinite);
    const avgLogprobs = segments
      .map(x => Number(x?.avg_logprob))
      .filter(Number.isFinite);

    const maxNoSpeech = noSpeechValues.length ? Math.max(...noSpeechValues) : null;
    const avgLogprob = avgLogprobs.length
      ? avgLogprobs.reduce((a, b) => a + b, 0) / avgLogprobs.length
      : null;

    let reliable = !!text;

    if (maxNoSpeech != null && maxNoSpeech >= 0.75) reliable = false;
    if (avgLogprob != null && avgLogprob < -1.2) reliable = false;

    // Common hallucinations on silence/noise. Keep this conservative so a real
    // short phrase such as "что это?" is NOT discarded just because it is short.
    if (text && /^(?:thank you|thanks for watching|subscribe|you|hvað er það|adehi apalagi)[.!? ]*$/i.test(text)) {
      reliable = false;
    }

    return {
      text: reliable ? text : null,
      reliable,
      meta: { maxNoSpeech, avgLogprob, language: data?.language || null },
    };
  } catch (error) {
    console.error("Video Whisper exception:", error);
    return { text: null, reliable: false, meta: null };
  }
}

async function extractVideoFrames(file, durationSeconds = 0) {
  if (!file) return [];
  try {
    await readFile(ffmpegPath);
  } catch {
    console.error("FFmpeg binary missing:", ffmpegPath);
    return [];
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), "ai-guide-video-"));
  try {
    const ext = path.extname(file.filePath || "") || ".mp4";
    const input = path.join(dir, `input${ext}`);
    await writeFile(input, file.buffer);

    const duration = Math.max(0, Number(durationSeconds) || 0);
    let times;

    if (duration > 0) {
      // Never request a frame at/after EOF. This was the source of the noisy
      // ENOENT logs on very short Telegram circles.
      const endSafe = Math.max(0.05, duration - 0.08);
      times = [duration * 0.12, duration * 0.50, duration * 0.86]
        .map(t => Math.min(endSafe, Math.max(0.03, t)));
      times = [...new Set(times.map(t => t.toFixed(3)))].map(Number);
    } else {
      times = [0.05, 0.5, 1.0];
    }

    const frames = [];
    for (let i = 0; i < Math.min(times.length, MAX_VIDEO_FRAMES); i++) {
      const output = path.join(dir, `frame-${i}.jpg`);
      try {
        await execFileAsync(ffmpegPath, [
          "-hide_banner", "-loglevel", "error",
          "-i", input,
          "-ss", String(times[i]),
          "-frames:v", "1",
          "-vf", "scale='min(720,iw)':-2",
          "-q:v", "4", "-y", output,
        ], { timeout: 15000 });

        // If FFmpeg did not create this particular frame, just skip it.
        // One missing frame must not break the whole circle.
        let buffer = null;
        try { buffer = await readFile(output); } catch { buffer = null; }
        if (buffer?.length) {
          frames.push({
            bytes: buffer.length,
            dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`,
          });
        }
      } catch (e) {
        console.warn("Frame skipped:", i, e?.message || e);
      }
    }

    return frames;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function handleVideo({ chatId, userId, video, caption = "", kind = "видео", messageId = null }) {
  const stop = startThinking(chatId);
  let stored = null;

  try {
    stored = await saveLastMedia(userId, {
      type: kind === "Telegram-кружок" ? "video_note" : "video",
      fileId: video.file_id,
      duration: Number(video.duration || 0),
      description: "",
      transcript: "",
      caption: String(caption || "").slice(0, 1200),
    });

    const file = await getTelegramFile(video.file_id);
    if (!file) {
      await sendMessage(chatId, "Не удалось скачать видео.");
      return;
    }

    const language = await getConversationLanguage(userId, caption);

    // Frames + audio are independent. A Vision limit must never erase speech,
    // and a silent circle must never invent speech from noise.
    const [frames, speech] = await Promise.all([
      extractVideoFrames(file, video.duration || 0),
      transcribeVideoFile(file),
    ]);

    const transcript = speech?.reliable ? speech.text : null;

    await updateStoredMedia(userId, {
      ...stored,
      transcript: transcript || "",
      speechChecked: true,
      speechReliable: !!transcript,
      speechMeta: speech?.meta || null,
    });

    if (!frames.length) {
      await sendMessage(
        chatId,
        transcript
          ? `Не удалось получить кадры, но речь распознана: «${transcript}»`
          : "⚠️ Не удалось получить кадры из кружка. Сам кружок сохранён — можно попробовать позже."
      );
      return;
    }

    const userInstruction = String(caption || "").trim();
    const visualPrompt = `${languageInstruction(language)}
Это ${kind}; переданы кадры из разных моментов в хронологическом порядке.
${userInstruction ? `Вопрос: ${userInstruction}` : "Коротко скажи, что видно и что происходит."}
${transcript ? `Надёжно распознанная речь: ${transcript.slice(0, 1000)}` : "Надёжной речи не обнаружено. Не придумывай слова из шума."}
Ответь кратко и конкретно, обычно 1–2 предложения. Не перечисляй очевидные детали без пользы.`;

    const answer = await askVisionAI({ images: frames, caption: visualPrompt, userId, language });

    await updateStoredMedia(userId, {
      ...stored,
      description: isVisionFailure(answer) ? "" : answer,
      transcript: transcript || "",
      speechChecked: true,
      speechReliable: !!transcript,
      speechMeta: speech?.meta || null,
      caption: userInstruction.slice(0, 1200),
    });

    await saveExchange(userId, userInstruction || `[${kind}]`, answer);
    await sendTrackedMessage(chatId, userId, answer, {
      parentMessageId: messageId,
      sourceMessageId: messageId,
      media: {
        type: kind === "Telegram-кружок" ? "video_note" : "video",
        fileId: video.file_id,
        duration: Number(video.duration || 0),
        caption: userInstruction,
      },
    });
  } catch (error) {
    console.error("Video handler:", error);
    await sendMessage(chatId, "Не удалось обработать кружок, но он сохранён в мультимедиа-памяти.");
  } finally {
    stop();
  }
}

// ======================================================
// MULTIMEDIA MEMORY V7.5.4
// Keeps the last photo/video/video-note file_id for 7 days.
// A follow-up such as "какой бренд мышки?" re-opens the media
// and asks Vision again instead of answering from general knowledge.
// ======================================================

function isMediaAudioQuestion(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  return /(?:что\s*(?:там\s*)?(?:говорят|сказал|сказано)|что\s*(?:я|он|она|они)\s*(?:сказал|сказала|сказали)|что\s*(?:слышно|слышал)|есть\s*(?:ли\s*)?(?:звук|речь|голос)|говорят\s*(?:ли)?|слышно\s*(?:ли)?|аудио|звук|речь|голос)/i.test(t);
}

function isGeneralMediaDescriptionQuestion(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  return /^(?:что\s*(?:там|на\s*(?:кружке|видео|фото)|видно)|что\s*на\s*кружке|что\s*на\s*видео|что\s*было\s*на\s*(?:кружке|видео)|опиши\s*(?:кружок|видео|фото))\??$/i.test(t);
}

async function getOrRefreshMediaTranscript(userId, media) {
  if (!media || !["video", "video_note"].includes(media.type)) {
    return { transcript: null, checked: false };
  }

  if (media.speechChecked) {
    return { transcript: media.transcript || null, checked: true };
  }

  const file = await getTelegramFile(media.fileId);
  if (!file) return { transcript: null, checked: false };

  const speech = await transcribeVideoFile(file);
  const transcript = speech?.reliable ? speech.text : null;

  await updateStoredMedia(userId, {
    ...media,
    transcript: transcript || "",
    speechChecked: true,
    speechReliable: !!transcript,
    speechMeta: speech?.meta || null,
  });

  return { transcript, checked: true };
}

async function tryHandleMediaFollowup({ chatId, userId, text, messageId = null, explicitMedia = null, replyContext = null }) {
  if (!explicitMedia && !looksLikeMediaFollowup(text)) return false;

  let stack = await getMediaStack(userId);
  if (!stack.length) {
    const legacy = await getLastMedia(userId);
    if (legacy?.fileId) stack = [legacy];
  }

  const storedExplicit = explicitMedia?.fileId
    ? stack.find(x => x?.fileId === explicitMedia.fileId)
    : null;
  const selected = explicitMedia?.fileId
    ? [{ ...(storedExplicit || {}), ...explicitMedia }]
    : pickMediaFromStack(stack, text);
  if (!selected.length) return false;

  const stop = startThinking(chatId);
  try {
    const language = await getConversationLanguage(userId, text);

    // IMPORTANT: audio questions about circles do NOT call Vision.
    if (isMediaAudioQuestion(text)) {
      const answers = [];

      for (let i = 0; i < selected.length; i++) {
        const media = selected[i];
        if (!["video", "video_note"].includes(media.type)) {
          answers.push(selected.length > 1 ? `${i + 1}) У этого файла нет аудиодорожки.` : "У этого файла нет аудиодорожки.");
          continue;
        }

        const { transcript, checked } = await getOrRefreshMediaTranscript(userId, media);
        let answer;
        if (!checked) answer = "Не удалось проверить звук в кружке.";
        else if (transcript) answer = `Да: «${transcript}»`;
        else answer = "Нет, разборчивой речи не слышно.";

        answers.push(selected.length > 1 ? `${i + 1}) ${answer}` : answer);
      }

      const finalAnswer = answers.join("\n");
      await saveExchange(userId, text, finalAnswer);
      await sendTrackedMessage(chatId, userId, finalAnswer, {
        parentMessageId: messageId,
        sourceMessageId: replyContext?.sourceMessageId || null,
        media: selected[0] || null,
      });
      return true;
    }

    // If user only asks what was on the circle and we already have a cached
    // description, answer from memory and save a Qwen request.
    if (selected.length === 1 && isGeneralMediaDescriptionQuestion(text)) {
      const media = selected[0];
      if (media.description) {
        const answer = String(media.description).trim();
        await saveExchange(userId, text, answer);
        await sendTrackedMessage(chatId, userId, answer, {
          parentMessageId: messageId,
          sourceMessageId: replyContext?.sourceMessageId || null,
          media,
        });
        return true;
      }
    }

    const answers = [];

    for (let i = 0; i < selected.length; i++) {
      const media = selected[i];
      let images = [];

      if (media.type === "photo") {
        const image = await getTelegramImageData(media.fileId);
        if (image) images = [image];
      } else if (media.type === "video" || media.type === "video_note") {
        const file = await getTelegramFile(media.fileId);
        if (file) images = await extractVideoFrames(file, Number(media.duration || 0));
      }

      if (!images.length) {
        answers.push(selected.length > 1 ? `${i + 1}) Не удалось получить кадры.` : "Не удалось получить кадры.");
        continue;
      }

      const prompt = `${languageInstruction(language)}
Это повторный просмотр ${media.type === "photo" ? "фото" : media.type === "video_note" ? "Telegram-кружка" : "видео"}.
Вопрос пользователя: ${text}
${media.description ? `Ранее было известно: ${String(media.description).slice(0, 1200)}` : "Предыдущего описания нет."}
Ответь только на вопрос, кратко и конкретно. Если нужная деталь (бренд, логотип, надпись) неразличима — прямо скажи это и не перечисляй варианты.`;

      // Follow-up question about saved media: really re-open it and let Gemini
      // inspect the frames first. If Gemini fails, Groq Vision is the fallback.
      const answer = await askVisionAI({
        images,
        caption: prompt,
        userId,
        language,
        preferGemini: true,
      });

      if (!isVisionFailure(answer)) {
        // Do not overwrite a good general description with a narrow answer like
        // "логотип не видно". Keep narrow details in dialogue only.
        if (!media.description) {
          await updateStoredMedia(userId, { ...media, description: answer });
        }
      }

      answers.push(selected.length > 1 ? `${i + 1}) ${answer}` : answer);
    }

    const finalAnswer = answers.join("\n");
    await saveExchange(userId, text, finalAnswer);
    const taskItems = extractTaskSelection(text);
    if (taskItems.length || /(?:завдан|задан|вправ|упражнен|виконай|выполни)/i.test(text)) {
      await saveActiveContext(userId, {
        type: "media_task",
        request: text,
        selectedItems: taskItems,
        sourceMessageId: replyContext?.sourceMessageId || messageId,
        media: selected[0] || null,
        lastAnswer: finalAnswer.slice(0, 5000),
        modifiers: detectTaskModifiers(text),
      });
    }
    await sendTrackedMessage(chatId, userId, finalAnswer, {
      parentMessageId: messageId,
      sourceMessageId: replyContext?.sourceMessageId || null,
      media: selected[0] || null,
    });
    return true;
  } catch (error) {
    console.error("Media followup:", error);
    return false;
  } finally {
    stop();
  }
}

// ======================================================
// PLAIN EMOJI REACTIONS V7.5.4
// ======================================================

function isEmojiOnlyText(text) {
  const t = String(text || "").trim();
  if (!t || /[A-Za-zА-Яа-яЁёІіЇїЄєҐґ0-9]/.test(t)) return false;
  return /[\p{Extended_Pictographic}]/u.test(t);
}

async function handlePlainEmoji({ chatId, userId, text }) {
  const language = await getConversationLanguage(userId);
  const answer = await askTextAI({
    userId, language, webContext: null,
    text: `${languageInstruction(language)}\nПользователь отправил только emoji: ${text}\nОтветь как живой собеседник очень коротко и уместно по контексту: обычно 1–6 слов или несколько emoji. Не начинай новый диалог, не пиши «Чем могу помочь?», «Let me know», «How can I help».`,
  });
  await sendMessage(chatId, answer);
}

// ======================================================
// NORMAL TEXT
// ======================================================

async function handleText({
  chatId,
  userId,
  text,
  message,
}) {
  const stop =
    startThinking(chatId);

  try {
    const messageId = message?.message_id || null;
    const replyContext = await buildReplyContext(userId, message);

    if (await tryHandleMediaFollowup({
      chatId,
      userId,
      text,
      messageId,
      explicitMedia: replyContext.media,
      replyContext,
    })) return;

    const previousActive = await getActiveContext(userId);
    const modifiers = detectTaskModifiers(text);
    const modifierOnly = isContextModifier(text);
    const selectedItems = extractTaskSelection(text);
    let effectiveText = text;
    let activeContext = previousActive;

    if (modifierOnly && previousActive?.request) {
      const targetItems = selectedItems.length ? selectedItems : previousActive.selectedItems || [];
      effectiveText = `Вернись к активной задаче и переделай весь нужный результат.\nИсходная просьба: ${previousActive.request}\n${previousActive.sourceText ? `Текст/условие: ${previousActive.sourceText}\n` : ""}Новая инструкция: ${text}\n${targetItems.length ? `Пункты: ${targetItems.join(", ")}` : ""}`;
      activeContext = {
        ...previousActive,
        selectedItems: targetItems,
        modifiers: { ...(previousActive.modifiers || {}), ...Object.fromEntries(Object.entries(modifiers).filter(([, v]) => v)) },
      };
      await saveActiveContext(userId, activeContext);
    } else if (selectedItems.length || /(?:завдан|задан|вправ|упражнен|виконай|выполни)/i.test(text)) {
      activeContext = {
        type: "task",
        request: text,
        selectedItems,
        sourceMessageId: replyContext.sourceMessageId || messageId,
        sourceText: replyContext.text || "",
        modifiers: Object.fromEntries(Object.entries(modifiers).filter(([, v]) => v)),
      };
      await saveActiveContext(userId, activeContext);
    }

    const language =
      await getConversationLanguage(userId, text);

    let webContext = null;

    if (needsInternet(effectiveText)) {
      const search =
        await searchWeb(effectiveText);

      webContext =
        makeWebContext(search);
    }

    const answer =
      await askTextAI({
        text: effectiveText,
        userId,
        language,
        webContext,
        referenceContext: replyContext.text,
        activeContext,
      });

    await saveExchange(
      userId,
      text,
      answer
    );

    if (activeContext?.request) {
      await saveActiveContext(userId, { ...activeContext, lastAnswer: answer.slice(0, 5000) });
    }

    await sendTrackedMessage(chatId, userId, answer, {
      parentMessageId: messageId,
      sourceMessageId: replyContext.sourceMessageId || activeContext?.sourceMessageId || null,
      media: replyContext.media || null,
      task: activeContext || null,
    });

  } finally {
    stop();
  }
}


// ======================================================
// POST
// ======================================================

export async function POST(
  request
) {
  try {
    console.log(
      "AI GUIDE VERSION: 7.7.0 CONVERSATION-CONTEXT"
    );

    const update =
      await request.json();

    const message =
      update.message;

    if (!message) {
      return Response.json({
        ok: true,
      });
    }

    const chatId =
      message.chat?.id;

    const userId =
      message.from?.id;

    if (!chatId || !userId) {
      return Response.json({
        ok: true,
      });
    }


    // ==================================================
    // PRIVATE MODE
    // ==================================================

    if (
      ALLOWED_USER_ID &&
      userId !== ALLOWED_USER_ID
    ) {
      await sendMessage(
        chatId,
        "⛔ Это приватный бот."
      );

      return Response.json({
        ok: true,
      });
    }


    const text =
      message.text?.trim() ||
      "";

    const incomingMedia = message.photo?.length ? {
      type: "photo",
      fileId: selectVisionPhoto(message.photo)?.file_id,
      caption: message.caption || "",
    } : message.video_note?.file_id ? {
      type: "video_note",
      fileId: message.video_note.file_id,
      duration: message.video_note.duration || 0,
      caption: "",
    } : message.video?.file_id ? {
      type: "video",
      fileId: message.video.file_id,
      duration: message.video.duration || 0,
      caption: message.caption || "",
    } : null;

    await saveMessageNode(userId, {
      messageId: message.message_id,
      role: "user",
      text: text || message.caption || (incomingMedia ? `[${incomingMedia.type}]` : message.sticker ? "[стикер]" : "[медиа]"),
      replyToMessageId: message.reply_to_message?.message_id || null,
      media: incomingMedia,
    });


    // ==================================================
    // COMMANDS
    // ==================================================

    if (
      text.toLowerCase() ===
        "/clear" ||
      text.toLowerCase() ===
        "/reset"
    ) {
      await clearHistory(userId);

      await sendMessage(
        chatId,
        "🧹 История разговора очищена."
      );

      return Response.json({
        ok: true,
      });
    }


    // ==================================================
    // REPLY TO PHOTO
    // Must run BEFORE normal text.
    // ==================================================

    if (
      text &&
      message
        .reply_to_message
        ?.photo
        ?.length
    ) {
      const handled =
        await handleReplyToPhoto({
          chatId,
          userId,
          message,
          text,
        });

      if (handled) {
        return Response.json({
          ok: true,
        });
      }
    }


    // ==================================================
    // VOICE
    // ==================================================

    if (message.voice?.file_id) {
      await handleVoice({
        chatId,
        userId,
        fileId:
          message.voice.file_id,
        message,
      });

      return Response.json({
        ok: true,
      });
    }


    // ==================================================
    // AUDIO
    // ==================================================

    if (message.audio?.file_id) {
      await handleVoice({
        chatId,
        userId,
        fileId:
          message.audio.file_id,
        message,
      });

      return Response.json({
        ok: true,
      });
    }


    // ==================================================
    // PHOTO
    // ==================================================

    if (
      Array.isArray(message.photo) &&
      message.photo.length
    ) {
      const largest = selectVisionPhoto(message.photo);

      const caption =
        message.caption?.trim() ||
        "";

      if (message.media_group_id) {
        await handleAlbum({
          chatId,
          userId,
          mediaGroupId:
            message.media_group_id,
          fileId:
            largest.file_id,
          caption,
          messageId:
            message.message_id,
        });

        return Response.json({
          ok: true,
        });
      }

      await handleSinglePhoto({
        chatId,
        userId,
        fileId:
          largest.file_id,
        caption,
        messageId: message.message_id,
      });

      return Response.json({
        ok: true,
      });
    }


    // ==================================================
    // STICKER
    // ==================================================

    if (message.sticker?.file_id) {
      await handleSticker({
        chatId,
        userId,
        sticker:
          message.sticker,
      });

      return Response.json({
        ok: true,
      });
    }


    // ==================================================
    // CUSTOM EMOJI
    //
    // Check before ordinary text.
    // ==================================================

    const customEmojiIds =
      getCustomEmojiIds(message);

    if (customEmojiIds.length) {
      const handled =
        await handleCustomEmoji({
          chatId,
          userId,
          message,
        });

      if (handled) {
        return Response.json({
          ok: true,
        });
      }
    }


    // ==================================================
    // PLAIN EMOJI
    // ==================================================

    if (text && isEmojiOnlyText(text)) {
      await handlePlainEmoji({ chatId, userId, text });
      return Response.json({ ok: true });
    }

    // ==================================================
    // NORMAL TEXT
    // ==================================================

    if (text) {
      await handleText({
        chatId,
        userId,
        text,
        message,
      });

      return Response.json({
        ok: true,
      });
    }


    // ==================================================
    // GIF / ANIMATION V7.4.2
    // ==================================================

    if (message.animation?.file_id) {
      const stop = startThinking(chatId);
      try {
        const language = await getConversationLanguage(userId, message.caption || "");
        const previewId = message.animation.thumbnail?.file_id || message.animation.thumb?.file_id || null;

        if (previewId) {
          const image = await getTelegramImageData(previewId);
          if (image) {
            const answer = await askStickerVisionAI({ image, language, kind: "GIF-анимация" });
            if (answer) {
              await saveExchange(userId, "[GIF-анимация]", answer);
              await sendMessage(chatId, answer);
              return Response.json({ ok: true });
            }
          }
        }

        const answer = await askTextAI({
          userId,
          language,
          webContext: null,
          text: "Пользователь отправил GIF-анимацию, но кадр сейчас недоступен. Коротко и естественно отреагируй по контексту, не выдумывая содержимое GIF."
        });
        await saveExchange(userId, "[GIF-анимация]", answer);
        await sendMessage(chatId, answer);
        return Response.json({ ok: true });
      } finally {
        stop();
      }
    }


    // ==================================================
    // VIDEO / VIDEO NOTE V7.5.4
    // ==================================================

    if (message.video?.file_id) {
      await handleVideo({
        chatId, userId, video: message.video,
        caption: message.caption || "", kind: "обычное видео",
        messageId: message.message_id,
      });
      return Response.json({ ok: true });
    }

    if (message.video_note?.file_id) {
      await handleVideo({
        chatId, userId, video: message.video_note,
        caption: "", kind: "Telegram-кружок",
        messageId: message.message_id,
      });
      return Response.json({ ok: true });
    }


    // ==================================================
    // OTHER
    // ==================================================

    await sendMessage(
      chatId,
      "Пока я понимаю текст, фото, несколько фото, Reply на фото, голосовые, аудио, стикеры и Telegram custom emoji."
    );

    return Response.json({
      ok: true,
    });

  } catch (error) {
    console.error(
      "BOT ERROR:",
      error
    );

    // Telegram should still get 200
    // so it doesn't endlessly retry update.
    return Response.json({
      ok: true,
    });
  }
}


// ======================================================
// GET
// ======================================================

export async function GET() {
  let availableGroqModels = [];

  if (GROQ_API_KEY) {
    try {
      const response =
        await fetch(
          GROQ_MODELS_API,
          {
            headers: {
              Authorization:
                `Bearer ${GROQ_API_KEY}`,
            },
          }
        );

      if (response.ok) {
        const data =
          await response.json();

        availableGroqModels =
          Array.isArray(data.data)
            ? data.data
                .map(x => x.id)
                .filter(Boolean)
            : [];
      }
    } catch {}
  }

  return Response.json({
    version:
      "AI GUIDE VERSION: 7.7.0 CONVERSATION-CONTEXT",

    status:
      "Bot is running",

    telegram:
      !!TELEGRAM_BOT_TOKEN,

    groq:
      !!GROQ_API_KEY,

    openrouter:
      false,

    tavily:
      !!TAVILY_API_KEY,

    redis:
      !!(
        UPSTASH_REDIS_REST_URL &&
        UPSTASH_REDIS_REST_TOKEN
      ),

    privateMode:
      !!ALLOWED_USER_ID,

    models: {
      text:
        TEXT_MODEL,

      textFallback:
        TEXT_FALLBACK_MODEL,

      vision:
        VISION_MODEL,

      whisper:
        WHISPER_MODEL,
    },

    modelAccess: {
      text:
        availableGroqModels.includes(
          TEXT_MODEL
        ),

      textFallback:
        availableGroqModels.includes(
          TEXT_FALLBACK_MODEL
        ),

      vision:
        availableGroqModels.includes(
          VISION_MODEL
        ),

      whisper:
        availableGroqModels.includes(
          WHISPER_MODEL
        ),
    },

    features: {
      text: true,

      photos: true,

      multiPhoto: true,

      maxVisionImages:
        MAX_VISION_IMAGES,

      replyToPhoto: true,

      voice: true,

      audio: true,

      staticStickers: true,

      animatedStickers:
        "thumbnail Vision + safe context fallback",

      videoStickers:
        "thumbnail Vision + safe context fallback",

      customEmoji: true,

      ordinaryVideo: "FFmpeg frames + Whisper",

      gifAnimation: "thumbnail Vision",

      typingIndicator: true,

      memory:
        "Upstash Redis: 40 recent messages + long-term summary",

      webSearch:
        "Tavily",

      telegramSafeMath:
        "V2",
    },

    availableGroqModels,
  });
}
