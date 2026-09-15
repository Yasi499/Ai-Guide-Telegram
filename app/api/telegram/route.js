import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

// V7.5.1: FFmpeg is copied during postinstall so Vercel always traces it.
const ffmpegPath = path.join(process.cwd(), "ffmpeg-bin", "ffmpeg");

export const runtime = "nodejs";

// ======================================================
// AI GUIDE V7.5.1
//
// Groq:
// - Text: openai/gpt-oss-120b
// - Text fallback: openai/gpt-oss-20b
// - Vision: qwen/qwen3.8-27b
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
// OpenRouter disabled.
// ======================================================


// ======================================================
// CONFIG
// ======================================================

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN;

const GROQ_API_KEY =
  process.env.GROQ_API_KEY;

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

const WHISPER_MODEL =
  "whisper-large-v3-turbo";

const MAX_HISTORY_MESSAGES = 40;
const MEMORY_SUMMARY_BATCH = 20;
const MAX_VISION_IMAGES = 3;
const MAX_VIDEO_FRAMES = 3;


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

function albumKey(userId, mediaGroupId) {
  return `ai-guide:album:${userId}:${mediaGroupId}`;
}

function albumLockKey(userId, mediaGroupId) {
  return `ai-guide:album-lock:${userId}:${mediaGroupId}`;
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
  for (
    let i = 0;
    i < output.length;
    i += 4000
  ) {
    const part =
      output.slice(i, i + 4000);

    await telegramRequest(
      "sendMessage",
      {
        chat_id: chatId,
        text: part,
      }
    );
  }
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
      console.error(
        `Groq ${model}:`,
        raw
      );

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
        }) + (longMemory ? `\n\nДОЛГОВРЕМЕННАЯ ПАМЯТЬ ИЗ БОЛЕЕ СТАРОГО ДИАЛОГА:\n${longMemory}` : ""),
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
    await requestGroq({
      model: VISION_MODEL,
      messages,
      temperature: 0.1,
      maxTokens: 1300,
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
      await requestGroq({
        model: VISION_MODEL,
        messages,
        temperature: 0.1,
        maxTokens: 900,
      });
  }

  const cleaned =
    cleanAIResponse(result.text);

  if (cleaned) {
    return cleaned;
  }

  if (isRequestTooLarge(result)) {
    return (
      "⚠️ Это изображение слишком большое для Groq Vision. Обрежь нужную часть или отправь скриншот поменьше."
    );
  }

  if (result.status === 429) {
    return (
      "⚠️ Сейчас достигнут лимит Groq Vision. Попробуй немного позже."
    );
  }

  return (
    "⚠️ Groq Vision не смог обработать изображение."
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

    const language =
      detectLanguage(transcription);

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
      });

    await saveExchange(
      userId,
      `[Голосовое]\n${transcription}`,
      answer
    );

    await sendMessage(
      chatId,
      answer
    );

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

    await saveExchange(
      userId,
      caption
        ? `[Фото]\n${caption}`
        : "[Фото]",
      answer
    );

    await sendMessage(
      chatId,
      answer
    );

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
// LIGHTWEIGHT MEDIA VISION V7.4.2
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
  const result = await requestGroq({ model: VISION_MODEL, messages, temperature: 0.65, maxCompletionTokens: 120 });
  if (!result.ok) return null;
  return cleanAIResponse(result.content);
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
// VIDEO V7.5.1
// ======================================================

function videoMimeType(filePath) {
  const lower = String(filePath || "").toLowerCase();
  if (lower.endsWith(".webm")) return { mime: "video/webm", extension: "webm" };
  if (lower.endsWith(".mov")) return { mime: "video/quicktime", extension: "mov" };
  return { mime: "video/mp4", extension: "mp4" };
}

async function transcribeVideoFile(file) {
  if (!file || !GROQ_API_KEY) return null;
  try {
    const { mime, extension } = videoMimeType(file.filePath);
    const form = new FormData();
    form.append("file", new Blob([file.buffer], { type: mime }), `video.${extension}`);
    form.append("model", WHISPER_MODEL);
    form.append("response_format", "json");
    form.append("temperature", "0");
    const response = await fetch(GROQ_TRANSCRIBE_API, {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      body: form,
    });
    const raw = await response.text();
    if (!response.ok) {
      console.error("Video Whisper:", response.status, raw);
      return null;
    }
    const data = JSON.parse(raw);
    return String(data?.text || "").trim() || null;
  } catch (error) {
    console.error("Video Whisper exception:", error);
    return null;
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

    const duration = Number(durationSeconds) || 0;
    let times;
    if (duration >= 3) {
      times = [Math.max(0.2, duration * 0.15), duration * 0.5, Math.max(0.3, duration * 0.85)];
    } else {
      times = [0.1, 0.8, 1.5];
    }

    const frames = [];
    for (let i = 0; i < Math.min(times.length, MAX_VIDEO_FRAMES); i++) {
      const output = path.join(dir, `frame-${i}.jpg`);
      try {
        await execFileAsync(ffmpegPath, [
          "-hide_banner", "-loglevel", "error",
          "-ss", String(times[i]), "-i", input,
          "-frames:v", "1",
          "-vf", "scale='min(720,iw)':-2",
          "-q:v", "4", "-y", output,
        ], { timeout: 15000 });
        const buffer = await readFile(output);
        if (buffer.length) {
          frames.push({
            bytes: buffer.length,
            dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`,
          });
        }
      } catch (e) {
        console.error("Frame extraction:", i, e?.message || e);
      }
    }
    return frames;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function handleVideo({ chatId, userId, video, caption = "", kind = "видео" }) {
  const stop = startThinking(chatId);
  try {
    const file = await getTelegramFile(video.file_id);
    if (!file) {
      await sendMessage(chatId, "Не удалось скачать видео. Возможно, файл слишком большой для Telegram Bot API.");
      return;
    }

    const language = await getConversationLanguage(userId, caption);
    const [frames, transcript] = await Promise.all([
      extractVideoFrames(file, video.duration || 0),
      transcribeVideoFile(file),
    ]);

    if (!frames.length) {
      console.error("Video has no extracted frames; refusing audio-only visual analysis.");
      await sendMessage(chatId, "⚠️ Не удалось получить кадры из видео. Я не буду угадывать содержание только по аудио. Проверь FFmpeg в логах Vercel.");
      return;
    }

    const userInstruction = String(caption || "").trim();
    const visualPrompt = `${languageInstruction(language)}\nПользователь отправил ${kind}. Это кадры из разных моментов одного видео в хронологическом порядке.\n${userInstruction ? `Запрос пользователя: ${userInstruction}` : "Кратко объясни, что происходит на видео."}\n${transcript ? `Распознанная речь/звук:\n${transcript.slice(0, 7000)}` : "Речь не распознана или её нет."}\nОпирайся на реальные кадры и транскрипцию. Не придумывай невидимые события. Если кадры показывают изменение положения/действия, можешь осторожно описать движение.`;

    let answer;
    if (frames.length) {
      answer = await askVisionAI({ images: frames, caption: visualPrompt, userId, language });
    } else {
      answer = await askTextAI({
        userId, language, webContext: null,
        text: `${userInstruction || "Кратко перескажи видео по распознанной речи."}\n\nТранскрипция видео:\n${transcript}`,
      });
    }

    await saveExchange(
      userId,
      userInstruction || `[${kind}${transcript ? `; речь: ${transcript.slice(0, 1200)}` : ""}]`,
      answer
    );
    await sendMessage(chatId, answer);
  } catch (error) {
    console.error("Video handler:", error);
    await sendMessage(chatId, "Не удалось обработать видео. Проверь логи Vercel — возможно, FFmpeg не запустился или файл слишком большой.");
  } finally {
    stop();
  }
}

// ======================================================
// PLAIN EMOJI REACTIONS V7.5.1
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
}) {
  const stop =
    startThinking(chatId);

  try {
    const language =
      await getConversationLanguage(userId, text);

    let webContext = null;

    if (needsInternet(text)) {
      const search =
        await searchWeb(text);

      webContext =
        makeWebContext(search);
    }

    const answer =
      await askTextAI({
        text,
        userId,
        language,
        webContext,
      });

    await saveExchange(
      userId,
      text,
      answer
    );

    await sendMessage(
      chatId,
      answer
    );

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
      "AI-GUIDE-V7.5.1"
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
    // VIDEO / VIDEO NOTE V7.5.1
    // ==================================================

    if (message.video?.file_id) {
      await handleVideo({
        chatId, userId, video: message.video,
        caption: message.caption || "", kind: "обычное видео",
      });
      return Response.json({ ok: true });
    }

    if (message.video_note?.file_id) {
      await handleVideo({
        chatId, userId, video: message.video_note,
        caption: "", kind: "Telegram-кружок",
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
      "AI-GUIDE-V7.5.1",

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
