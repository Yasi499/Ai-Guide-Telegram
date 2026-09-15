export const runtime = "nodejs";

// ======================================================
// AI GUIDE V7.3
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
// - Animated / video stickers via emoji/context
// - Telegram custom emoji
// - Better Telegram-safe math
//
// Ordinary VIDEO intentionally disabled for now.
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

const MAX_HISTORY_MESSAGES = 20;
const MAX_VISION_IMAGES = 3;


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


async function saveHistory(
  userId,
  history
) {
  await redisCommand([
    "SET",
    memoryKey(userId),
    JSON.stringify(
      history.slice(
        -MAX_HISTORY_MESSAGES
      )
    ),
  ]);
}


async function saveExchange(
  userId,
  userText,
  assistantText
) {
  const history =
    await getHistory(userId);

  history.push({
    role: "user",
    content:
      String(userText).slice(0, 5000),
  });

  history.push({
    role: "assistant",
    content:
      String(assistantText).slice(0, 5000),
  });

  await saveHistory(
    userId,
    history
  );
}


async function clearHistory(userId) {
  await redisCommand([
    "DEL",
    memoryKey(userId),
  ]);
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

  return "en";
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

  const messages = [
    {
      role: "system",
      content:
        makeSystemPrompt({
          language,
          webContext,
        }),
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

  const photo =
    reply.photo[
      reply.photo.length - 1
    ];

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
// STICKER
// ======================================================

async function handleSticker({
  chatId,
  userId,
  sticker,
}) {
  const stop =
    startThinking(chatId);

  try {
    const history =
      await getHistory(userId);

    const lastText =
      history
        .slice()
        .reverse()
        .find(
          x =>
            x.role === "user" &&
            x.content
        )
        ?.content ||
      "";

    const language =
      detectLanguage(lastText);

    const emoji =
      sticker.emoji || "стикер";


    // --------------------------------------------------
    // STATIC STICKER
    // --------------------------------------------------

    if (
      !sticker.is_animated &&
      !sticker.is_video
    ) {
      const image =
        await getTelegramImageData(
          sticker.file_id
        );

      if (image) {
        const answer =
          await askVisionAI({
            images: [image],

            caption: `
Пользователь отправил Telegram-стикер.

Связанный emoji:
${emoji}

Коротко и естественно отреагируй на стикер как собеседник.

Не описывай технические детали файла.
Не говори "это изображение".
Отвечай на языке текущего разговора.
`,

            userId,
            language,
          });

        await saveExchange(
          userId,
          `[Стикер ${emoji}]`,
          answer
        );

        await sendMessage(
          chatId,
          answer
        );

        return;
      }
    }


    // --------------------------------------------------
    // ANIMATED / VIDEO STICKER
    //
    // Без FFmpeg/Lottie пока не анализируем движение.
    // Но бот понимает emoji + тип + контекст.
    // --------------------------------------------------

    const stickerType =
      sticker.is_animated
        ? "анимированный Telegram-стикер"
        : sticker.is_video
          ? "видеостикер Telegram"
          : "Telegram-стикер";

    const prompt = `
Пользователь только что отправил ${stickerType}.

Связанный emoji:
${emoji}

Это эмоциональная реакция пользователя.

Ответь естественно как собеседник.

Не объясняй технически,
что такое стикер.

Не говори,
что ты не можешь его посмотреть.

Не утверждай конкретные визуальные детали,
которых ты не знаешь.

Учитывай предыдущий разговор.

Ответ должен быть коротким и уместным.
`;

    const answer =
      await askTextAI({
        text: prompt,
        userId,
        language,
        webContext: null,
      });

    await saveExchange(
      userId,
      `[${stickerType}: ${emoji}]`,
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
      detectLanguage(
        visibleText ||
        lastUser
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
      answer =
        await askVisionAI({
          images,

          caption: `
Пользователь отправил Telegram custom emoji.

Текст сообщения:
${visibleText || "(только emoji)"}

Пойми эмоциональный смысл emoji
и естественно отреагируй.

Ответь коротко.
Не описывай API Telegram.
`,

          userId,
          language,
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

    await saveExchange(
      userId,
      `[Custom emoji] ${visibleText}`,
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
      detectLanguage(text);

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
      "AI-GUIDE-V7.3"
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
      const largest =
        message.photo[
          message.photo.length - 1
        ];

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
    // ORDINARY VIDEO
    // intentionally disabled
    // ==================================================

    if (
      message.video ||
      message.video_note
    ) {
      await sendMessage(
        chatId,
        "🎬 Видео пока не анализирую. Фото, несколько фото, Reply на фото, голосовые, аудио, стикеры и custom emoji уже поддерживаются."
      );

      return Response.json({
        ok: true,
      });
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
      "AI-GUIDE-V7.3",

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
        "emoji/context",

      videoStickers:
        "emoji/context",

      customEmoji: true,

      ordinaryVideo: false,

      typingIndicator: true,

      memory:
        "Upstash Redis",

      webSearch:
        "Tavily",

      telegramSafeMath:
        "V2",
    },

    availableGroqModels,
  });
}
