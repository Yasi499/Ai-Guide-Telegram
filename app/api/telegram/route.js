export const runtime = "nodejs";

// ======================================================
// AI GUIDE V7.1
// Groq + automatic model detection
// Tavily + Upstash + Telegram
//
// TEXT:
//   GPT-OSS 120B -> GPT-OSS 20B -> available model
//
// VISION:
//   Qwen 3.8 -> Qwen 3.6
//   ONLY if actually available to current Groq key
//
// VOICE:
//   Whisper Large V3 Turbo
//
// OpenRouter: DISABLED
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

const WHISPER_MODEL =
  "whisper-large-v3-turbo";

const MAX_HISTORY_MESSAGES = 20;
const MAX_IMAGES = 3;


// ======================================================
// MODEL PRIORITY
// ======================================================

const TEXT_MODEL_PRIORITY = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
];

const VISION_MODEL_PRIORITY = [
  "qwen/qwen3.8-27b",
  "qwen/qwen3.6-27b",
];


// ======================================================
// MODEL CACHE
// ======================================================

let modelCache = {
  models: [],
  loadedAt: 0,
};

const MODEL_CACHE_TIME =
  5 * 60 * 1000;


// ======================================================
// HELPERS
// ======================================================

function sleep(ms) {
  return new Promise(
    (resolve) => setTimeout(resolve, ms)
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
    console.error("Redis not configured");
    return null;
  }

  try {
    const response =
      await fetch(
        UPSTASH_REDIS_REST_URL,
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,

            "Content-Type":
              "application/json",
          },

          body:
            JSON.stringify(command),
        }
      );

    const raw =
      await response.text();

    if (!response.ok) {
      console.error(
        "Redis error:",
        raw
      );

      return null;
    }

    const data =
      JSON.parse(raw);

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
  const result =
    await redisCommand([
      "GET",
      memoryKey(userId),
    ]);

  if (!result) {
    return [];
  }

  try {
    const history =
      JSON.parse(result);

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
  const trimmed =
    history.slice(
      -MAX_HISTORY_MESSAGES
    );

  await redisCommand([
    "SET",
    memoryKey(userId),
    JSON.stringify(trimmed),
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
      String(userText)
        .slice(0, 5000),
  });

  history.push({
    role: "assistant",

    content:
      String(assistantText)
        .slice(0, 5000),
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
// TELEGRAM MESSAGE
// ======================================================

async function sendMessage(
  chatId,
  text
) {
  if (!text) {
    text =
      "Не удалось получить ответ.";
  }

  for (
    let i = 0;
    i < text.length;
    i += 4000
  ) {
    const part =
      text.slice(
        i,
        i + 4000
      );

    const response =
      await fetch(
        `${TELEGRAM_API}/sendMessage`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          body:
            JSON.stringify({
              chat_id: chatId,
              text: part,
            }),
        }
      );

    if (!response.ok) {
      console.error(
        "Telegram:",
        await response.text()
      );
    }
  }
}


// ======================================================
// TYPING...
// ======================================================

async function sendChatAction(
  chatId,
  action = "typing"
) {
  try {
    await fetch(
      `${TELEGRAM_API}/sendChatAction`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        body:
          JSON.stringify({
            chat_id: chatId,
            action,
          }),
      }
    );
  } catch (error) {
    console.error(
      "Chat action:",
      error
    );
  }
}


function startThinking(
  chatId,
  action = "typing"
) {
  let stopped = false;

  const run = async () => {
    while (!stopped) {
      await sendChatAction(
        chatId,
        action
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
// GROQ AVAILABLE MODELS
// ======================================================

async function getGroqModels(
  forceRefresh = false
) {
  if (!GROQ_API_KEY) {
    return [];
  }

  const now =
    Date.now();

  if (
    !forceRefresh &&
    modelCache.models.length &&
    now - modelCache.loadedAt <
      MODEL_CACHE_TIME
  ) {
    return modelCache.models;
  }

  try {
    const response =
      await fetch(
        GROQ_MODELS_API,
        {
          method: "GET",

          headers: {
            Authorization:
              `Bearer ${GROQ_API_KEY}`,

            "Content-Type":
              "application/json",
          },
        }
      );

    const raw =
      await response.text();

    console.log(
      "Groq models:",
      response.status
    );

    if (!response.ok) {
      console.error(
        "Groq models error:",
        raw
      );

      return [];
    }

    const data =
      JSON.parse(raw);

    const models =
      Array.isArray(data.data)
        ? data.data
            .map((item) => item.id)
            .filter(Boolean)
        : [];

    modelCache = {
      models,
      loadedAt: now,
    };

    console.log(
      "Available Groq models:",
      models
    );

    return models;

  } catch (error) {
    console.error(
      "Groq models exception:",
      error
    );

    return [];
  }
}


// ======================================================
// CHOOSE MODEL
// ======================================================

function findAvailableModel(
  available,
  priority
) {
  for (const model of priority) {
    if (available.includes(model)) {
      return model;
    }
  }

  return null;
}


async function chooseTextModel() {
  const available =
    await getGroqModels();

  const preferred =
    findAvailableModel(
      available,
      TEXT_MODEL_PRIORITY
    );

  if (preferred) {
    return preferred;
  }

  // Если /models по какой-то причине
  // не сработал, пробуем production
  // модель напрямую.
  if (!available.length) {
    return "openai/gpt-oss-120b";
  }

  return null;
}


async function chooseVisionModel() {
  const available =
    await getGroqModels();

  return findAvailableModel(
    available,
    VISION_MODEL_PRIORITY
  );
}


// ======================================================
// TELEGRAM FILE DOWNLOAD
// ======================================================

async function getTelegramFile(fileId) {
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

    const fileResponse =
      await fetch(
        `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`
      );

    if (!fileResponse.ok) {
      console.error(
        "Telegram download:",
        fileResponse.status
      );

      return null;
    }

    const arrayBuffer =
      await fileResponse.arrayBuffer();

    return {
      buffer:
        Buffer.from(arrayBuffer),

      filePath,
    };

  } catch (error) {
    console.error(
      "Telegram file:",
      error
    );

    return null;
  }
}


// ======================================================
// IMAGE
// ======================================================

function getImageMimeType(
  filePath
) {
  const lower =
    String(filePath)
      .toLowerCase();

  if (
    lower.endsWith(".png")
  ) {
    return "image/png";
  }

  if (
    lower.endsWith(".webp")
  ) {
    return "image/webp";
  }

  if (
    lower.endsWith(".gif")
  ) {
    return "image/gif";
  }

  return "image/jpeg";
}


async function getTelegramImageData(
  fileId
) {
  const file =
    await getTelegramFile(fileId);

  if (!file) {
    return null;
  }

  const mimeType =
    getImageMimeType(
      file.filePath
    );

  const base64 =
    file.buffer
      .toString("base64");

  return (
    `data:${mimeType};base64,${base64}`
  );
}


// ======================================================
// LANGUAGE
// ======================================================

function detectLanguage(text) {
  const source =
    String(text || "")
      .trim();

  const lower =
    source.toLowerCase();

  if (!source) {
    return "ru";
  }

  if (
    /[іїєґ]/i.test(source) ||

    /\b(що|цей|ця|зараз|сьогодні|поясни|виконай|зроби|скороти|новини|свіжі|останні)\b/i.test(
      lower
    )
  ) {
    return "uk";
  }

  if (
    /[а-яё]/i.test(source)
  ) {
    return "ru";
  }

  return "en";
}


function languageInstruction(
  language
) {
  if (language === "uk") {
    return (
      "Відповідай українською мовою."
    );
  }

  if (language === "en") {
    return (
      "Answer in English."
    );
  }

  return (
    "Отвечай на русском языке."
  );
}


// ======================================================
// TELEGRAM MATH RULES
// ======================================================

function telegramFormattingRules() {
  return `
ВАЖНО ДЛЯ TELEGRAM:

Telegram показывает обычный текст.

НЕ используй LaTeX:

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

Не используй $...$.

Пиши формулы обычным текстом.

Примеры:

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
Unicode-степени, когда возможно.
`;
}


// ======================================================
// CLEAN OUTPUT
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
    .map(
      (char) =>
        map[char] || char
    )
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
    .map(
      (char) =>
        map[char] || char
    )
    .join("");
}


function cleanAIResponse(text) {
  if (!text) {
    return "";
  }

  let result =
    String(text);

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

  result = result
    .replace(/\\\[/g, "")
    .replace(/\\\]/g, "")
    .replace(/\\\(/g, "")
    .replace(/\\\)/g, "")
    .replace(/\$\$/g, "");

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

  for (
    let i = 0;
    i < 5;
    i++
  ) {
    result = result.replace(
      /\\frac\{([^{}]+)\}\{([^{}]+)\}/g,
      "($1) / ($2)"
    );
  }

  result = result.replace(
    /\{,\}/g,
    ","
  );

  result = result.replace(
    /10\^\{([+\-]?\d+)\}/g,
    (_, power) =>
      "10" +
      superscriptNumber(power)
  );

  result = result.replace(
    /10\^([+\-]?\d+)/g,
    (_, power) =>
      "10" +
      superscriptNumber(power)
  );

  result = result.replace(
    /([A-Za-zА-Яа-яІіЇїЄєҐґ0-9])\^\{([+\-]?\d+)\}/g,
    (_, base, power) =>
      base +
      superscriptNumber(power)
  );

  result = result.replace(
    /_\{([+\-]?\d+)\}/g,
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
// INTERNET
// ======================================================

function needsInternet(text) {
  if (!text) {
    return false;
  }

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
    "новости",
    "что нового",
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
    "патч",
    "релиз",
    "утечк",
    "слив",
    "инсайд",

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


function isContextFollowUp(text) {
  if (!text) {
    return false;
  }

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


async function getConversationContext(
  userId
) {
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
        String(item.content)
          .slice(0, 1200)
      );
    })
    .join("\n");
}


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

  if (genericDollar) {
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

  if (
    isContextFollowUp(text)
  ) {
    const context =
      await getConversationContext(
        userId
      );

    if (context) {
      return `
Найди свежую информацию
по теме разговора.

КОНТЕКСТ:
${context}

ВОПРОС:
${text}
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
    return null;
  }

  try {
    const response =
      await fetch(
        "https://api.tavily.com/search",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            Authorization:
              `Bearer ${TAVILY_API_KEY}`,
          },

          body:
            JSON.stringify({
              query,
              search_depth:
                "basic",
              max_results: 7,
              include_answer: true,
              include_raw_content:
                false,
            }),
        }
      );

    const raw =
      await response.text();

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
  if (!data) {
    return null;
  }

  let result = "";

  if (data.answer) {
    result +=
      `SEARCH SUMMARY:\n` +
      `${data.answer}\n\n`;
  }

  if (
    Array.isArray(data.results)
  ) {
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
// SYSTEM PROMPT
// ======================================================

function makeSystemPrompt({
  language,
  webContext = null,
  vision = false,
}) {
  const currentTime =
    new Date()
      .toLocaleString(
        "ru-RU",
        {
          timeZone:
            "Europe/Kyiv",
        }
      );

  let prompt = `
Ты AI Guide —
персональный Telegram AI-ассистент.

Текущее время:
${currentTime}

${languageInstruction(language)}

Учитывай историю разговора.

Понимай продолжения:
"сократи"
"подробнее"
"продолжи"
"а почему?"
"сделай №3"

Не проси повторять информацию,
если она уже есть в истории.

Не придумывай факты.

Если не уверен —
честно скажи об этом.

Для школьных заданий:
1. Внимательно прочитай условие.
2. Не меняй числа.
3. Не придумывай условие.
4. Решай именно тот номер,
   который попросил пользователь.
5. Проверяй вычисления.

Если написано "Вправа №1",
внутри есть пункты 1, 2, 3...
и пользователь пишет
"виконай вправу 3",
обычно имеется в виду пункт 3.

Не решай всю страницу,
если этого не просили.

Не показывай внутреннюю
цепочку рассуждений модели.

${telegramFormattingRules()}
`;

  if (vision) {
    prompt += `

Пользователь прислал изображение
или несколько изображений.

Реально изучи изображения.

Если это школьная работа:
прочитай точное условие.

Если это скриншот:
прочитай интерфейс и ошибки.

Если это текст:
прочитай его.

Если это обычное фото:
ответь на вопрос пользователя.

Если изображений несколько,
рассматривай их вместе.

Не придумывай нечитаемые детали.

Если часть изображения
действительно невозможно прочитать,
скажи об этом.
`;
  }

  if (webContext) {
    prompt += `

WEB DATA:

${webContext}

Это результаты Tavily.

Используй их для свежей информации.
Проверяй даты.

Не показывай URL,
если пользователь не попросил ссылки.
`;
  }

  return prompt;
}


// ======================================================
// GROQ CHAT REQUEST
// ======================================================

async function requestGroq({
  messages,
  model,
  temperature = 0.4,
  maxTokens = 1800,
}) {
  if (!GROQ_API_KEY) {
    return {
      ok: false,
      status: 0,
      text: null,
      error:
        "GROQ_API_KEY missing",
    };
  }

  try {
    const response =
      await fetch(
        GROQ_CHAT_API,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            Authorization:
              `Bearer ${GROQ_API_KEY}`,
          },

          body:
            JSON.stringify({
              model,
              messages,
              temperature,

              max_completion_tokens:
                maxTokens,

              tool_choice:
                "none",
            }),
        }
      );

    const raw =
      await response.text();

    console.log(
      `Groq ${model}:`,
      response.status
    );

    if (!response.ok) {
      console.error(
        `Groq ${model}:`,
        raw
      );

      // Если модель пропала/недоступна,
      // обновим cache при следующем запросе.
      if (
        response.status === 400 ||
        response.status === 404
      ) {
        modelCache = {
          models: [],
          loadedAt: 0,
        };
      }

      return {
        ok: false,
        status:
          response.status,
        text: null,
        error: raw,
      };
    }

    const data =
      JSON.parse(raw);

    const content =
      data
        ?.choices
        ?.[0]
        ?.message
        ?.content;

    return {
      ok: true,
      status:
        response.status,
      text:
        content || null,
      error: null,
    };

  } catch (error) {
    console.error(
      "Groq exception:",
      error
    );

    return {
      ok: false,
      status: 0,
      text: null,
      error:
        String(error),
    };
  }
}


// ======================================================
// TEXT AI
// ======================================================

async function askTextAI({
  text,
  userId,
  language,
  webContext,
}) {
  const history =
    await getHistory(userId);

  const model =
    await chooseTextModel();

  if (!model) {
    return (
      "⚠️ Groq сейчас не показывает " +
      "ни одной подходящей текстовой модели для этого API-ключа."
    );
  }

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
      messages,
      model,
      temperature: 0.4,
      maxTokens: 1800,
    });

  // Если GPT-OSS 120B внезапно
  // недоступна, пробуем 20B.
  if (
    !result.ok &&
    model ===
      "openai/gpt-oss-120b"
  ) {
    const available =
      await getGroqModels(true);

    if (
      available.includes(
        "openai/gpt-oss-20b"
      )
    ) {
      result =
        await requestGroq({
          messages,

          model:
            "openai/gpt-oss-20b",

          temperature: 0.4,
          maxTokens: 1800,
        });
    }
  }

  const cleaned =
    cleanAIResponse(
      result.text
    );

  if (cleaned) {
    return cleaned;
  }

  if (result.status === 429) {
    return (
      "⚠️ Сейчас достигнут лимит Groq. " +
      "Попробуй немного позже."
    );
  }

  return (
    "⚠️ Groq не смог получить ответ. " +
    "Посмотри логи Vercel — там будет точная ошибка."
  );
}


// ======================================================
// VISION AI
// ======================================================

async function askVisionAI({
  images,
  caption,
  userId,
  language,
}) {
  const model =
    await chooseVisionModel();

  if (!model) {
    return (
      "⚠️ Твой Groq API-ключ сейчас не показывает " +
      "доступную Vision-модель. " +
      "Текст и голос продолжат работать, " +
      "но фото пока недоступны для этого ключа."
    );
  }

  const history =
    await getHistory(userId);

  const userContent = [
    {
      type: "text",

      text:
        caption ||
        (
          images.length > 1
            ? "Проанализируй все изображения вместе."
            : "Внимательно проанализируй изображение."
        ),
    },
  ];

  const imageLimit =
    model === "qwen/qwen3.8-27b"
      ? 3
      : 5;

  for (
    const imageData of
    images.slice(
      0,
      imageLimit
    )
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

      content:
        makeSystemPrompt({
          language,
          vision: true,
        }),
    },

    ...history.slice(-10),

    {
      role: "user",
      content: userContent,
    },
  ];

  let result =
    await requestGroq({
      messages,
      model,
      temperature: 0.2,
      maxTokens: 2400,
    });

  // Если одна Qwen исчезла,
  // обновляем список и пробуем вторую.
  if (!result.ok) {
    const available =
      await getGroqModels(true);

    const fallback =
      VISION_MODEL_PRIORITY.find(
        (candidate) =>
          candidate !== model &&
          available.includes(candidate)
      );

    if (fallback) {
      result =
        await requestGroq({
          messages,
          model: fallback,
          temperature: 0.2,
          maxTokens: 2400,
        });
    }
  }

  const cleaned =
    cleanAIResponse(
      result.text
    );

  if (cleaned) {
    return cleaned;
  }

  if (result.status === 429) {
    return (
      "⚠️ Сейчас достигнут лимит Groq Vision. " +
      "Попробуй немного позже."
    );
  }

  return (
    "⚠️ Groq не смог проанализировать изображение."
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

  if (!file) {
    return null;
  }

  try {
    const form =
      new FormData();

    const lower =
      String(file.filePath)
        .toLowerCase();

    let extension = "ogg";
    let mime = "audio/ogg";

    if (
      lower.endsWith(".mp3")
    ) {
      extension = "mp3";
      mime = "audio/mpeg";
    }

    if (
      lower.endsWith(".wav")
    ) {
      extension = "wav";
      mime = "audio/wav";
    }

    if (
      lower.endsWith(".m4a")
    ) {
      extension = "m4a";
      mime = "audio/mp4";
    }

    if (
      lower.endsWith(".webm")
    ) {
      extension = "webm";
      mime = "audio/webm";
    }

    const blob =
      new Blob(
        [file.buffer],
        {
          type: mime,
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
        "Whisper:",
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
// VOICE
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
        "⚠️ Не удалось распознать голосовое."
      );

      return;
    }

    console.log(
      "VOICE:",
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
        makeWebContext(webData);
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
    const image =
      await getTelegramImageData(
        fileId
      );

    if (!image) {
      await sendMessage(
        chatId,
        "⚠️ Не удалось скачать фото."
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
        : "[Пользователь отправил фото]",

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
}


async function getAlbum(
  userId,
  mediaGroupId
) {
  const raw =
    await redisCommand([
      "GET",
      albumKey(
        userId,
        mediaGroupId
      ),
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
}) {
  await addAlbumPhoto({
    userId,
    mediaGroupId,
    fileId,
    caption,
  });

  await sleep(1800);

  const locked =
    await tryAlbumLock(
      userId,
      mediaGroupId
    );

  if (!locked) {
    return;
  }

  await sleep(700);

  const album =
    await getAlbum(
      userId,
      mediaGroupId
    );

  if (
    !album ||
    !album.photos?.length
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
      const photoId of
      album.photos.slice(
        0,
        MAX_IMAGES
      )
    ) {
      const image =
        await getTelegramImageData(
          photoId
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

    const language =
      detectLanguage(
        album.caption
      );

    const answer =
      await askVisionAI({
        images,
        caption:
          album.caption,
        userId,
        language,
      });

    await saveExchange(
      userId,

      `[Альбом: ${images.length} фото]` +
      (
        album.caption
          ? `\n${album.caption}`
          : ""
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
// STICKER
// ======================================================

async function handleSticker({
  chatId,
  userId,
  sticker,
}) {
  if (
    sticker.is_animated ||
    sticker.is_video
  ) {
    await sendMessage(
      chatId,
      "😀 Пока я анализирую только обычные статичные стикеры."
    );

    return;
  }

  const stopThinking =
    startThinking(
      chatId,
      "typing"
    );

  try {
    const image =
      await getTelegramImageData(
        sticker.file_id
      );

    if (!image) {
      await sendMessage(
        chatId,
        "⚠️ Не удалось загрузить стикер."
      );

      return;
    }

    const answer =
      await askVisionAI({
        images: [image],

        caption:
          "Посмотри на стикер и коротко, естественно отреагируй как собеседник. Если на нём есть текст, учти его.",

        userId,
        language: "ru",
      });

    await saveExchange(
      userId,
      "[Стикер]",
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

export async function POST(
  request
) {
  try {
    console.log(
      "AI-GUIDE-V7.1"
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

    if (
      !chatId ||
      !userId
    ) {
      return Response.json({
        ok: true,
      });
    }


    // ==================================================
    // PRIVATE
    // ==================================================

    if (
      ALLOWED_USER_ID &&
      userId !==
        ALLOWED_USER_ID
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
    // TEXT / COMMAND
    // ==================================================

    const text =
      message.text?.trim();


    if (
      text &&
      (
        text.toLowerCase() ===
          "/clear" ||

        text.toLowerCase() ===
          "/reset"
      )
    ) {
      await clearHistory(
        userId
      );

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

    if (
      message.voice?.file_id
    ) {
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

    if (
      message.audio?.file_id
    ) {
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

    if (
      message.sticker?.file_id
    ) {
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
      message.photo.length
    ) {
      const photo =
        message.photo[
          message.photo.length - 1
        ];

      const fileId =
        photo.file_id;

      const caption =
        message.caption?.trim() ||
        "";

      if (
        message.media_group_id
      ) {
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
    // NORMAL TEXT
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

        let webContext = null;

        if (
          needsInternet(text)
        ) {
          const query =
            await buildSearchQuery(
              text,
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
    // UNKNOWN
    // ==================================================

    await sendMessage(
      chatId,
      "Сейчас я понимаю текст, фото, несколько фото, голосовые, аудио и статичные стикеры."
    );

    return Response.json({
      ok: true,
    });

  } catch (error) {
    console.error(
      "BOT ERROR:",
      error
    );

    return Response.json({
      ok: true,
    });
  }
}


// ======================================================
// GET STATUS
// ======================================================

export async function GET() {
  const models =
    await getGroqModels();

  const textModel =
    findAvailableModel(
      models,
      TEXT_MODEL_PRIORITY
    );

  const visionModel =
    findAvailableModel(
      models,
      VISION_MODEL_PRIORITY
    );

  return Response.json({
    version:
      "AI-GUIDE-V7.1",

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

    textModel:
      textModel ||
      "NO SUPPORTED TEXT MODEL",

    visionModel:
      visionModel ||
      "NO VISION MODEL AVAILABLE",

    whisperModel:
      WHISPER_MODEL,

    availableGroqModels:
      models,

    features: {
      text: true,
      photos:
        !!visionModel,
      multiPhoto:
        !!visionModel,
      voice: true,
      audio: true,
      staticStickers:
        !!visionModel,
      typingIndicator:
        true,
      memory:
        "Upstash Redis",
      webSearch:
        "Tavily",
      telegramSafeMath:
        true,
    },
  });
}
