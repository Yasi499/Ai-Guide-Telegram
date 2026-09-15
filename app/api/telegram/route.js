export const runtime = "nodejs";

// ======================================================
// AI GUIDE V7.
// Telegram + Groq + Tavily + Upstash
//
// Поддержка:
// - текст
// - 1 фото
// - альбом до 5 фото
// - голосовые
// - audio
// - статичные WEBP-стикеры
// - "печатает..." во время ожидания
// - постоянная память
// - интернет через Tavily
// - Telegram-safe математика
//
// OpenRouter НЕ используется.
// ======================================================


// ======================================================
// CONFIG
// ======================================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

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

const GROQ_CHAT_API =
  "https://api.groq.com/openai/v1/chat/completions";

const GROQ_TRANSCRIBE_API =
  "https://api.groq.com/openai/v1/audio/transcriptions";

const AI_MODEL = "qwen/qwen3.6-27b";
const WHISPER_MODEL = "whisper-large-v3-turbo";

const MAX_HISTORY_MESSAGES = 20;
const MAX_IMAGES = 5;


// ======================================================
// SMALL HELPERS
// ======================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function memoryKey(userId) {
  return `ai-guide:history:${userId}`;
}

function albumKey(userId, mediaGroupId) {
  return `ai-guide:album:${userId}:${mediaGroupId}`;
}


// ======================================================
// REDIS
// ======================================================

async function redisCommand(command) {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    console.error("Redis not configured");
    return null;
  }

  try {
    const response = await fetch(UPSTASH_REDIS_REST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });

    const raw = await response.text();

    if (!response.ok) {
      console.error("Redis error:", raw);
      return null;
    }

    const data = JSON.parse(raw);
    return data.result;
  } catch (error) {
    console.error("Redis exception:", error);
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
    return Array.isArray(history) ? history : [];
  } catch {
    return [];
  }
}

async function saveHistory(userId, history) {
  const trimmed = history.slice(-MAX_HISTORY_MESSAGES);

  await redisCommand([
    "SET",
    memoryKey(userId),
    JSON.stringify(trimmed),
  ]);
}

async function saveExchange(userId, userText, assistantText) {
  const history = await getHistory(userId);

  history.push({
    role: "user",
    content: String(userText).slice(0, 5000),
  });

  history.push({
    role: "assistant",
    content: String(assistantText).slice(0, 5000),
  });

  await saveHistory(userId, history);
}

async function clearHistory(userId) {
  await redisCommand([
    "DEL",
    memoryKey(userId),
  ]);
}


// ======================================================
// TELEGRAM SEND MESSAGE
// ======================================================

async function sendMessage(chatId, text) {
  if (!text) {
    text = "Не удалось получить ответ.";
  }

  for (let i = 0; i < text.length; i += 4000) {
    const part = text.slice(i, i + 4000);

    const response = await fetch(
      `${TELEGRAM_API}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: part,
        }),
      }
    );

    if (!response.ok) {
      console.error(
        "Telegram sendMessage:",
        await response.text()
      );
    }
  }
}


// ======================================================
// "ПЕЧАТАЕТ..."
// ======================================================

async function sendChatAction(chatId, action = "typing") {
  try {
    await fetch(`${TELEGRAM_API}/sendChatAction`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        action,
      }),
    });
  } catch (error) {
    console.error("ChatAction:", error);
  }
}

function startThinking(chatId, action = "typing") {
  let stopped = false;

  const run = async () => {
    while (!stopped) {
      await sendChatAction(chatId, action);

      // Telegram chat action живёт недолго,
      // поэтому обновляем её.
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

async function getTelegramFile(fileId) {
  try {
    const response = await fetch(
      `${TELEGRAM_API}/getFile?file_id=${encodeURIComponent(fileId)}`
    );

    const data = await response.json();

    if (!data.ok || !data.result?.file_path) {
      console.error("Telegram getFile:", data);
      return null;
    }

    const filePath = data.result.file_path;

    const fileResponse = await fetch(
      `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`
    );

    if (!fileResponse.ok) {
      console.error(
        "Telegram file download:",
        fileResponse.status
      );

      return null;
    }

    const arrayBuffer =
      await fileResponse.arrayBuffer();

    return {
      buffer: Buffer.from(arrayBuffer),
      filePath,
    };
  } catch (error) {
    console.error("Telegram file exception:", error);
    return null;
  }
}


// ======================================================
// IMAGE -> DATA URL
// ======================================================

function imageMimeType(filePath) {
  const lower = String(filePath).toLowerCase();

  if (lower.endsWith(".png")) {
    return "image/png";
  }

  if (lower.endsWith(".webp")) {
    return "image/webp";
  }

  if (lower.endsWith(".gif")) {
    return "image/gif";
  }

  return "image/jpeg";
}

async function getTelegramImageData(fileId) {
  const file = await getTelegramFile(fileId);

  if (!file) return null;

  const mimeType =
    imageMimeType(file.filePath);

  const base64 =
    file.buffer.toString("base64");

  return (
    `data:${mimeType};base64,${base64}`
  );
}


// ======================================================
// LANGUAGE
// ======================================================

function detectLanguage(text) {
  const source =
    String(text || "").trim();

  const lower =
    source.toLowerCase();

  if (!source) {
    return "ru";
  }

  if (
    /[іїєґ]/i.test(source) ||
    /\b(що|цей|ця|зараз|сьогодні|поясни|виконай|зроби|скороти|новини|свіжі|останні)\b/i.test(lower)
  ) {
    return "uk";
  }

  if (/[а-яё]/i.test(source)) {
    return "ru";
  }

  return "en";
}

function languageInstruction(language) {
  if (language === "uk") {
    return "Відповідай українською мовою.";
  }

  if (language === "en") {
    return "Answer in English.";
  }

  return "Отвечай на русском языке.";
}


// ======================================================
// TELEGRAM MATH
// ======================================================

function telegramFormattingRules() {
  return `
ВАЖНО ДЛЯ TELEGRAM:

Telegram здесь показывает обычный текст.
Не используй LaTeX.

НИКОГДА не используй:
\\[
\\]
\\(
\\)
\\frac
\\cdot
\\times
\\text
\\mathrm
\\begin
\\end
\\boxed

Не используй $...$ или $$...$$.

Пиши:

5,4 · 10⁴
1,02 · 10⁻²
R = U / I
Q = I² · R · t
h = √(m · n)
x = (-b ± √D) / (2a)

Используй:
· или × для умножения
/ или : для деления
√ для корня
² ³ ⁴ и Unicode-степени, когда возможно.

Ответ должен нормально читаться
прямо в Telegram.
`;
}


// ======================================================
// CLEAN RESPONSE
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
  };

  return String(value)
    .split("")
    .map((char) => map[char] || char)
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
    "-": "₋",
    "+": "₊",
  };

  return String(value)
    .split("")
    .map((char) => map[char] || char)
    .join("");
}

function cleanAIResponse(text) {
  if (!text) return "";

  let result = String(text);

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
    /<\|tool_call[^>]*\|>/gi,
    ""
  );

  result = result.replace(
    /^\s*User Safety\s*:\s*safe\s*$/gim,
    ""
  );

  result = result.replace(
    /^\s*Response Safety\s*:\s*safe\s*$/gim,
    ""
  );

  result = result.replace(
    /^\s*Safety\s*:\s*safe\s*$/gim,
    ""
  );

  // LaTeX wrappers

  result = result
    .replace(/\\\[/g, "")
    .replace(/\\\]/g, "")
    .replace(/\\\(/g, "")
    .replace(/\\\)/g, "")
    .replace(/\$\$/g, "");

  // LaTeX operators

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

  // Text commands

  result = result.replace(
    /\\text\{([^{}]*)\}/g,
    "$1"
  );

  result = result.replace(
    /\\mathrm\{([^{}]*)\}/g,
    "$1"
  );

  // Square roots

  result = result.replace(
    /\\sqrt\{([^{}]*)\}/g,
    "√($1)"
  );

  // Simple fractions

  for (let i = 0; i < 5; i++) {
    result = result.replace(
      /\\frac\{([^{}]+)\}\{([^{}]+)\}/g,
      "($1) / ($2)"
    );
  }

  // Decimal comma from LaTeX

  result = result.replace(
    /\{,\}/g,
    ","
  );

  // Powers

  result = result.replace(
    /10\^\{([+\-]?\d+)\}/g,
    (_, power) =>
      "10" + superscriptNumber(power)
  );

  result = result.replace(
    /10\^([+\-]?\d+)/g,
    (_, power) =>
      "10" + superscriptNumber(power)
  );

  result = result.replace(
    /([A-Za-zА-Яа-яІіЇїЄєҐґ0-9])\^\{([+\-]?\d+)\}/g,
    (_, base, power) =>
      base + superscriptNumber(power)
  );

  // Subscripts

  result = result.replace(
    /_\{([+\-]?\d+)\}/g,
    (_, number) =>
      subscriptNumber(number)
  );

  result = result.replace(
    /_([0-9])/g,
    (_, number) =>
      subscriptNumber(number)
  );

  result = result
    .replace(/\\,/g, " ")
    .replace(/\\;/g, " ")
    .replace(/\\!/g, "");

  result = result.replace(
    /\n{3,}/g,
    "\n\n"
  );

  return result.trim();
}


// ======================================================
// INTERNET DETECTION
// ======================================================

function needsInternet(text) {
  if (!text) return false;

  const t =
    text.toLowerCase();

  const triggers = [
    "сейчас",
    "сегодня",
    "вчера",
    "завтра",
    "свеж",
    "актуаль",
    "последн",
    "недавно",
    "новости",
    "что нового",
    "что произошло",
    "что случилось",
    "погода",
    "температура",
    "дождь",
    "снег",
    "курс",
    "доллар",
    "долара",
    "евро",
    "гривн",
    "usd",
    "uah",
    "eur",
    "цена",
    "сколько стоит",
    "обновление",
    "обнова",
    "патч",
    "релиз",
    "утечк",
    "слив",
    "инсайдер",

    "зараз",
    "сьогодні",
    "свіж",
    "останні",
    "новини",
    "ціна",
    "скільки коштує",
    "оновлення",
    "витік",

    "today",
    "current",
    "latest",
    "recent",
    "news",
    "weather",
    "price",
    "update",
    "release",
    "leak",
  ];

  return triggers.some(
    (trigger) =>
      t.includes(trigger)
  );
}


// ======================================================
// CONTEXT FOLLOW-UP
// ======================================================

function isContextFollowUp(text) {
  if (!text) return false;

  const t =
    text.toLowerCase().trim();

  const patterns = [
    "по этому",
    "про это",
    "об этом",
    "про него",
    "про неё",
    "про них",
    "а сейчас",
    "а сегодня",
    "а что нового",
    "дай свеж",
    "подробнее",
    "что с ним",
    "что с ней",

    "про це",
    "по цьому",
    "про нього",
    "що нового",
    "свіжі новини",

    "about it",
    "about this",
    "latest on this",
  ];

  return patterns.some(
    (pattern) =>
      t.includes(pattern)
  );
}

async function getConversationContext(userId) {
  const history =
    await getHistory(userId);

  return history
    .slice(-8)
    .map((item) => {
      const speaker =
        item.role === "user"
          ? "User"
          : "Assistant";

      return (
        `${speaker}: ` +
        String(item.content).slice(0, 1200)
      );
    })
    .join("\n");
}


// ======================================================
// SEARCH QUERY
// ======================================================

async function buildSearchQuery(
  text,
  userId,
  language
) {
  const t =
    text.toLowerCase();

  const genericDollar =
    t.includes("курс доллара") ||
    t.includes("курс долара");

  const anotherCurrency =
    t.includes("руб") ||
    t.includes("rub") ||
    t.includes("евро") ||
    t.includes("eur") ||
    t.includes("злот") ||
    t.includes("pln");

  if (
    genericDollar &&
    !anotherCurrency
  ) {
    if (language === "uk") {
      return (
        "актуальний курс долара США " +
        "до української гривні USD UAH сьогодні Україна"
      );
    }

    return (
      "актуальный курс доллара США " +
      "к украинской гривне USD UAH сегодня Украина"
    );
  }

  if (isContextFollowUp(text)) {
    const context =
      await getConversationContext(userId);

    if (context) {
      return `
Найди свежую информацию по теме разговора.

КОНТЕКСТ:
${context}

ВОПРОС:
${text}

Определи конкретную тему из контекста.
`.trim();
    }
  }

  return text;
}


// ======================================================
// TAVILY
// ======================================================

async function searchWeb(query) {
  if (!TAVILY_API_KEY) {
    console.error("Tavily not configured");
    return null;
  }

  try {
    const response = await fetch(
      "https://api.tavily.com/search",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${TAVILY_API_KEY}`,
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

    const raw =
      await response.text();

    if (!response.ok) {
      console.error("Tavily:", raw);
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

  let result = "";

  if (data.answer) {
    result +=
      `SEARCH SUMMARY:\n${data.answer}\n\n`;
  }

  if (Array.isArray(data.results)) {
    result += data.results
      .slice(0, 7)
      .map(
        (item, index) => `
RESULT ${index + 1}

TITLE:
${item.title || "Unknown"}

CONTENT:
${item.content || "Unknown"}

URL:
${item.url || "Unknown"}
`
      )
      .join("\n");
  }

  return result.trim() || null;
}


// ======================================================
// GROQ CHAT / VISION
// ======================================================

async function requestGroq(
  messages,
  options = {}
) {
  if (!GROQ_API_KEY) {
    console.error("GROQ_API_KEY missing");
    return null;
  }

  try {
    const response = await fetch(
      GROQ_CHAT_API,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${GROQ_API_KEY}`,
        },

        body: JSON.stringify({
          model: AI_MODEL,
          messages,

          temperature:
            options.temperature ?? 0.4,

          max_completion_tokens:
            options.maxTokens ?? 1800,

          // Не позволяем модели самой
          // вызывать инструменты.
          tool_choice: "none",
        }),
      }
    );

    const raw =
      await response.text();

    console.log(
      "Groq:",
      response.status
    );

    if (!response.ok) {
      console.error(
        "Groq error:",
        raw
      );

      return null;
    }

    const data =
      JSON.parse(raw);

    return (
      data?.choices?.[0]?.message?.content ||
      null
    );
  } catch (error) {
    console.error(
      "Groq exception:",
      error
    );

    return null;
  }
}


// ======================================================
// SYSTEM PROMPT
// ======================================================

function makeSystemPrompt({
  language,
  webContext,
  vision = false,
}) {
  const currentTime =
    new Date().toLocaleString(
      "ru-RU",
      {
        timeZone:
          "Europe/Kyiv",
      }
    );

  let prompt = `
Ты AI Guide — персональный Telegram AI-ассистент.

Текущая дата и время:
${currentTime}

${languageInstruction(language)}

Учитывай историю разговора.

Если пользователь пишет:
"сделай короче",
"подробнее",
"а почему?",
"продолжи",
"сделай №3",
то учитывай предыдущие сообщения.

Не придумывай факты.

Если не уверен — скажи об этом.

Для школьных заданий:
- внимательно читай условие;
- не меняй числа;
- не придумывай текст;
- проверяй вычисления;
- если попросили конкретный пункт, выполняй только его.

Если на странице написано "Вправа №1",
а внутри есть пункты 1, 2, 3...
и пользователь пишет "виконай вправу 3",
обычно имеется в виду пункт 3.
Не решай всю страницу без просьбы.

Не показывай внутренние рассуждения модели.
Давай только полезный итог и нужное объяснение.

Не вызывай самостоятельно Google,
browser, search или другие инструменты.

${telegramFormattingRules()}
`;

  if (vision) {
    prompt += `

Пользователь прислал одно или несколько изображений.

Реально изучи каждое изображение.

Если это:
- школьное задание — прочитай и выполни просьбу;
- скриншот ошибки — прочитай ошибку и объясни решение;
- интерфейс — объясни, что видно;
- текст — прочитай его;
- обычное фото — ответь на вопрос об изображении.

Если изображений несколько,
учитывай их как части одного запроса.

Не придумывай мелкие или нечитаемые детали.
Если важный текст не читается,
скажи, что именно не удалось прочитать.
`;
  }

  if (webContext) {
    prompt += `

WEB DATA:
${webContext}

Это свежие результаты поиска Tavily.

Используй их для актуального вопроса.
Проверяй даты.
Не показывай сырые URL,
если пользователь не попросил ссылки.
`;
  }

  return prompt;
}


// ======================================================
// ASK TEXT
// ======================================================

async function askTextAI({
  text,
  userId,
  language,
  webContext,
}) {
  const history =
    await getHistory(userId);

  const messages = [
    {
      role: "system",
      content: makeSystemPrompt({
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

  const answer =
    await requestGroq(messages);

  const cleaned =
    cleanAIResponse(answer);

  return (
    cleaned ||
    "⚠️ Не удалось получить ответ от Groq. Попробуй ещё раз."
  );
}


// ======================================================
// ASK VISION
// ======================================================

async function askVisionAI({
  images,
  caption,
  userId,
  language,
}) {
  const history =
    await getHistory(userId);

  const safeHistory =
    history.slice(-10);

  const userContent = [
    {
      type: "text",
      text:
        caption ||
        (
          images.length > 1
            ? "Проанализируй все эти изображения вместе. Если на них есть задания или текст, помоги с ними."
            : "Внимательно проанализируй изображение и помоги с тем, что на нём."
        ),
    },
  ];

  for (
    const imageData of images.slice(0, MAX_IMAGES)
  ) {
    userContent.push({
      type: "image_url",
      image_url: {
        url: imageData,
      },
    });
  }

  const messages = [
    {
      role: "system",
      content: makeSystemPrompt({
        language,
        vision: true,
      }),
    },

    ...safeHistory,

    {
      role: "user",
      content: userContent,
    },
  ];

  const answer =
    await requestGroq(
      messages,
      {
        temperature: 0.2,
        maxTokens: 2400,
      }
    );

  const cleaned =
    cleanAIResponse(answer);

  return (
    cleaned ||
    "⚠️ Не удалось проанализировать изображение. Попробуй ещё раз."
  );
}


// ======================================================
// GROQ WHISPER
// ======================================================

async function transcribeTelegramAudio(fileId) {
  if (!GROQ_API_KEY) {
    return null;
  }

  const file =
    await getTelegramFile(fileId);

  if (!file) {
    return null;
  }

  try {
    const form =
      new FormData();

    let extension = "ogg";

    const lower =
      String(file.filePath).toLowerCase();

    if (lower.endsWith(".mp3")) {
      extension = "mp3";
    } else if (lower.endsWith(".wav")) {
      extension = "wav";
    } else if (lower.endsWith(".m4a")) {
      extension = "m4a";
    } else if (lower.endsWith(".webm")) {
      extension = "webm";
    } else if (lower.endsWith(".mp4")) {
      extension = "mp4";
    }

    const blob =
      new Blob(
        [file.buffer],
        {
          type:
            extension === "ogg"
              ? "audio/ogg"
              : `audio/${extension}`,
        }
      );

    form.append(
      "file",
      blob,
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

    const response =
      await fetch(
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

    const raw =
      await response.text();

    console.log(
      "Whisper:",
      response.status
    );

    if (!response.ok) {
      console.error(
        "Whisper error:",
        raw
      );

      return null;
    }

    const data =
      JSON.parse(raw);

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
// HANDLE VOICE
// ======================================================

async function handleVoice({
  chatId,
  userId,
  fileId,
}) {
  const stopThinking =
    startThinking(
      chatId,
      "typing"
    );

  try {
    const transcription =
      await transcribeTelegramAudio(
        fileId
      );

    if (!transcription) {
      await sendMessage(
        chatId,
        "⚠️ Не удалось распознать голосовое сообщение."
      );

      return;
    }

    console.log(
      "Voice transcription:",
      transcription
    );

    const language =
      detectLanguage(
        transcription
      );

    let webContext = null;

    if (
      needsInternet(
        transcription
      )
    ) {
      const query =
        await buildSearchQuery(
          transcription,
          userId,
          language
        );

      const webData =
        await searchWeb(query);

      webContext =
        makeWebContext(
          webData
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
      `[Голосовое сообщение]\n${transcription}`,
      answer
    );

    await sendMessage(
      chatId,
      answer
    );
  } finally {
    stopThinking();
  }
}


// ======================================================
// ALBUM
// Telegram отправляет каждое фото отдельно.
// Собираем file_id в Redis.
// ======================================================

async function addAlbumPhoto({
  userId,
  mediaGroupId,
  fileId,
  caption,
}) {
  const key =
    albumKey(
      userId,
      mediaGroupId
    );

  const raw =
    await redisCommand([
      "GET",
      key,
    ]);

  let album = {
    photos: [],
    caption: "",
  };

  if (raw) {
    try {
      album =
        JSON.parse(raw);
    } catch {
      // ignore
    }
  }

  if (
    !album.photos.includes(fileId)
  ) {
    album.photos.push(fileId);
  }

  if (caption) {
    album.caption = caption;
  }

  album.photos =
    album.photos.slice(
      0,
      MAX_IMAGES
    );

  await redisCommand([
    "SET",
    key,
    JSON.stringify(album),
    "EX",
    "60",
  ]);

  return album;
}

async function getAlbum(
  userId,
  mediaGroupId
) {
  const key =
    albumKey(
      userId,
      mediaGroupId
    );

  const raw =
    await redisCommand([
      "GET",
      key,
    ]);

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function deleteAlbum(
  userId,
  mediaGroupId
) {
  await redisCommand([
    "DEL",
    albumKey(
      userId,
      mediaGroupId
    ),
  ]);
}


// ======================================================
// ALBUM LOCK
// Нужен, чтобы несколько webhook-запросов
// не ответили на один альбом одновременно.
// ======================================================

function albumLockKey(
  userId,
  mediaGroupId
) {
  return (
    `ai-guide:album-lock:` +
    `${userId}:${mediaGroupId}`
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


// ======================================================
// HANDLE ALBUM
// ======================================================

async function handleAlbum({
  chatId,
  userId,
  mediaGroupId,
  fileId,
  caption,
}) {
  await addAlbumPhoto({
    userId,
    mediaGroupId,
    fileId,
    caption,
  });

  // Даём Telegram время прислать
  // остальные фото альбома.
  await sleep(1800);

  const gotLock =
    await tryAlbumLock(
      userId,
      mediaGroupId
    );

  // Другой webhook уже занимается
  // этим альбомом.
  if (!gotLock) {
    return;
  }

  // Ещё немного ждём поздние фото.
  await sleep(700);

  const album =
    await getAlbum(
      userId,
      mediaGroupId
    );

  if (
    !album ||
    !Array.isArray(album.photos) ||
    album.photos.length === 0
  ) {
    return;
  }

  const stopThinking =
    startThinking(
      chatId,
      "typing"
    );

  try {
    const images = [];

    for (
      const albumFileId of
      album.photos.slice(
        0,
        MAX_IMAGES
      )
    ) {
      const imageData =
        await getTelegramImageData(
          albumFileId
        );

      if (imageData) {
        images.push(
          imageData
        );
      }
    }

    if (!images.length) {
      await sendMessage(
        chatId,
        "⚠️ Не удалось скачать фотографии."
      );

      return;
    }

    const finalCaption =
      album.caption || "";

    const language =
      detectLanguage(
        finalCaption
      );

    const answer =
      await askVisionAI({
        images,
        caption: finalCaption,
        userId,
        language,
      });

    await saveExchange(
      userId,
      (
        `[Пользователь отправил альбом: ` +
        `${images.length} фото]` +
        (
          finalCaption
            ? `\nПодпись: ${finalCaption}`
            : ""
        )
      ),
      answer
    );

    await sendMessage(
      chatId,
      answer
    );
  } finally {
    stopThinking();

    await deleteAlbum(
      userId,
      mediaGroupId
    );
  }
}


// ======================================================
// SINGLE PHOTO
// ======================================================

async function handleSinglePhoto({
  chatId,
  userId,
  fileId,
  caption,
}) {
  const stopThinking =
    startThinking(
      chatId,
      "typing"
    );

  try {
    const imageData =
      await getTelegramImageData(
        fileId
      );

    if (!imageData) {
      await sendMessage(
        chatId,
        "⚠️ Не удалось скачать изображение."
      );

      return;
    }

    const language =
      detectLanguage(
        caption
      );

    const answer =
      await askVisionAI({
        images: [
          imageData,
        ],
        caption,
        userId,
        language,
      });

    await saveExchange(
      userId,
      (
        "[Пользователь отправил изображение]" +
        (
          caption
            ? `\nПодпись: ${caption}`
            : ""
        )
      ),
      answer
    );

    await sendMessage(
      chatId,
      answer
    );
  } finally {
    stopThinking();
  }
}


// ======================================================
// STATIC STICKER
// ======================================================

async function handleSticker({
  chatId,
  userId,
  sticker,
}) {
  // animated .tgs и video .webm
  // пока не отправляем в vision.
  if (
    sticker.is_animated ||
    sticker.is_video
  ) {
    await sendMessage(
      chatId,
      "😀 Этот стикер анимированный. Пока я умею анализировать обычные статичные стикеры."
    );

    return;
  }

  const stopThinking =
    startThinking(
      chatId,
      "typing"
    );

  try {
    const imageData =
      await getTelegramImageData(
        sticker.file_id
      );

    if (!imageData) {
      await sendMessage(
        chatId,
        "⚠️ Не удалось загрузить стикер."
      );

      return;
    }

    const answer =
      await askVisionAI({
        images: [
          imageData,
        ],

        caption:
          "Пользователь отправил тебе стикер. Посмотри на него и коротко, естественно отреагируй на него как собеседник. Если на стикере есть важный текст, учти его.",

        userId,

        language:
          "ru",
      });

    await saveExchange(
      userId,
      "[Пользователь отправил стикер]",
      answer
    );

    await sendMessage(
      chatId,
      answer
    );
  } finally {
    stopThinking();
  }
}


// ======================================================
// POST
// ======================================================

export async function POST(request) {
  try {
    console.log(
      "AI-GUIDE-V7"
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


    // ==================================================
    // COMMANDS
    // ==================================================

    const text =
      message.text?.trim();

    if (
      text &&
      (
        text.toLowerCase() === "/clear" ||
        text.toLowerCase() === "/reset"
      )
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
    // AUDIO FILE
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
    // PHOTO
    // ==================================================

    if (
      Array.isArray(
        message.photo
      ) &&
      message.photo.length > 0
    ) {
      const biggestPhoto =
        message.photo[
          message.photo.length - 1
        ];

      const fileId =
        biggestPhoto.file_id;

      const caption =
        message.caption?.trim() ||
        "";

      // Альбом
      if (message.media_group_id) {
        await handleAlbum({
          chatId,
          userId,

          mediaGroupId:
            message.media_group_id,

          fileId,
          caption,
        });

        return Response.json({
          ok: true,
        });
      }

      // Одиночное фото
      await handleSinglePhoto({
        chatId,
        userId,
        fileId,
        caption,
      });

      return Response.json({
        ok: true,
      });
    }


    // ==================================================
    // TEXT
    // ==================================================

    if (text) {
      const stopThinking =
        startThinking(
          chatId,
          "typing"
        );

      try {
        const language =
          detectLanguage(text);

        let webContext =
          null;

        if (
          needsInternet(text)
        ) {
          const searchQuery =
            await buildSearchQuery(
              text,
              userId,
              language
            );

          const webData =
            await searchWeb(
              searchQuery
            );

          webContext =
            makeWebContext(
              webData
            );
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
        stopThinking();
      }

      return Response.json({
        ok: true,
      });
    }


    // ==================================================
    // OTHER
    // ==================================================

    await sendMessage(
      chatId,
      "Пока я понимаю текст, фото, альбомы фотографий, голосовые, аудио и обычные статичные стикеры."
    );

    return Response.json({
      ok: true,
    });

  } catch (error) {
    console.error(
      "BOT ERROR:",
      error
    );

    // Возвращаем 200, чтобы Telegram
    // не повторял update снова и снова.
    return Response.json({
      ok: true,
    });
  }
}


// ======================================================
// GET STATUS
// ======================================================

export async function GET() {
  return Response.json({
    version:
      "AI-GUIDE-V7-GROQ",

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

    model:
      AI_MODEL,

    speechModel:
      WHISPER_MODEL,

    memory:
      "Upstash Redis",

    features: {
      text: true,
      photos: true,
      multiPhoto: true,
      maxPhotos: MAX_IMAGES,
      voice: true,
      audio: true,
      staticStickers: true,
      animatedStickers: false,
      typingIndicator: true,
      webSearch: "Tavily",
      telegramSafeMath: true,
    },
  });
}
