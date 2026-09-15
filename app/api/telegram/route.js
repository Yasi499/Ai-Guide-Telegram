export const runtime = "nodejs";

// ======================================================
// AI GUIDE V7.4.1
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
// CLEAN AI RESPONSE
// ======================================================

function cleanAIResponse(text) {
  let result =
    String(text || "").trim();

  // Groq / model internal garbage
  result = result.replace(
    /<\|(?:channel|start|end)[^>]*\|>/gi,
    ""
  );

  result = result.replace(
    /<tool_call>[\s\S]*?<\/tool_call>/gi,
    ""
  );

  result = result.replace(
    /```(?:json)?\s*\{[\s\S]*?"name"\s*:\s*"[^"]+"[\s\S]*?\}\s*```/gi,
    ""
  );

  // Safety labels
  result = result.replace(
    /^\s*User\s+Safety\s*:\s*safe\s*$/gim,
    ""
  );

  result = result.replace(
    /^\s*Response\s+Safety\s*:\s*safe\s*$/gim,
    ""
  );

  // Markdown bold
  result = result.replace(
    /\*\*(.*?)\*\*/g,
    "$1"
  );

  // Remove LaTeX wrappers
  result = result
    .replace(/\$\$([\s\S]*?)\$\$/g, "$1")
    .replace(/\$([^$\n]+)\$/g, "$1")
    .replace(/\\\[((?:.|\n)*?)\\\]/g, "$1")
    .replace(/\\\((.*?)\\\)/g, "$1");

  // Common LaTeX commands
  result = result
    .replace(/\\cdot/g, "·")
    .replace(/\\times/g, "×")
    .replace(/\\div/g, "÷")
    .replace(/\\pm/g, "±")
    .replace(/\\approx/g, "≈")
    .replace(/\\leq?/g, "≤")
    .replace(/\\geq?/g, "≥")
    .replace(/\\neq/g, "≠")
    .replace(/\\infty/g, "∞")
    .replace(/\\degree/g, "°")
    .replace(/\\%/g, "%");

  // Square root
  result = result.replace(
    /\\sqrt\s*\{([^{}]+)\}/g,
    "√($1)"
  );

  result = result.replace(
    /\\sqrt\s+([A-Za-z0-9.,]+)/g,
    "√$1"
  );

  // Fractions
  let previous;

  do {
    previous = result;

    result = result.replace(
      /\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g,
      "($1) / ($2)"
    );
  } while (result !== previous);

  // Powers
  result = result.replace(
    /\^\{([+\-]?\d+)\}/g,
    (_, value) =>
      superscriptNumber(value)
  );

  result = result.replace(
    /\^([+\-]?\d+)/g,
    (_, value) =>
      superscriptNumber(value)
  );

  // Subscripts
  result = result.replace(
    /_\{([+\-]?\d+)\}/g,
    (_, value) =>
      subscriptNumber(value)
  );

  result = result.replace(
    /_([+\-]?\d+)/g,
    (_, value) =>
      subscriptNumber(value)
  );

  // Remove remaining braces in simple math
  result = result
    .replace(/\\left/g, "")
    .replace(/\\right/g, "")
    .replace(/\\,/g, " ")
    .replace(/\\;/g, " ")
    .replace(/\\:/g, " ")
    .replace(/\\!/g, "");

  // Clean excessive blank lines
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
  const value =
    String(text || "")
      .toLowerCase();

  if (!value) return false;

  const triggers = [
    "сегодня",
    "сейчас",
    "актуальн",
    "последн",
    "новост",
    "погода",
    "температур",
    "курс",
    "доллар",
    "долар",
    "евро",
    "євро",
    "гривн",
    "цена",
    "ціна",
    "стоимость",
    "сколько стоит",
    "скільки коштує",
    "кто выиграл",
    "хто виграв",
    "результат",
    "расписание",
    "розклад",
    "когда выйдет",
    "коли вийде",
    "вышел ли",
    "вийшов",
    "обновление",
    "оновлення",
    "версия",
    "версія",
    "президент",
    "выборы",
    "вибори",
    "война",
    "війна",
    "курс валют",
    "exchange rate",
    "weather",
    "today",
    "latest",
    "news",
    "current",
    "price",
    "release date",
  ];

  return triggers.some(
    trigger =>
      value.includes(trigger)
  );
}


// ======================================================
// TAVILY WEB SEARCH
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
            Authorization:
              `Bearer ${TAVILY_API_KEY}`,

            "Content-Type":
              "application/json",
          },

          body: JSON.stringify({
            query:
              String(query || "")
                .slice(0, 1500),

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
        response.status,
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
  if (!data) return "";

  const parts = [];

  if (data.answer) {
    parts.push(
      `Краткий ответ поисковой системы:\n${data.answer}`
    );
  }

  if (
    Array.isArray(data.results)
  ) {
    const results =
      data.results.slice(0, 7);

    for (
      let i = 0;
      i < results.length;
      i++
    ) {
      const item = results[i];

      const title =
        String(
          item?.title || ""
        ).trim();

      const content =
        String(
          item?.content || ""
        )
          .trim()
          .slice(0, 1800);

      if (!title && !content) {
        continue;
      }

      parts.push(
        `Источник ${i + 1}:\n` +
        `${title}\n` +
        `${content}`
      );
    }
  }

  return parts.join("\n\n");
}


// ======================================================
// SYSTEM PROMPT
// ======================================================

function makeSystemPrompt({
  language,
  webContext = "",
  vision = false,
}) {
  const now =
    new Intl.DateTimeFormat(
      "ru-RU",
      {
        timeZone:
          "Europe/Kyiv",

        dateStyle:
          "full",

        timeStyle:
          "medium",
      }
    ).format(new Date());

  return `
Ты — AI Guide, персональный AI-помощник пользователя в Telegram.

Текущие дата и время:
${now}

${languageInstruction(language)}

Отвечай естественно, понятно и по делу.

Не делай ответы искусственно длинными, если пользователь не просил подробное объяснение.

Если пользователь просит:
"короче",
"сократи",
"подробнее",
"продолжи",
"почему",
"сделай 3",
"теперь 4",
"перепиши",
"сделай лучше",
то обязательно учитывай историю диалога.

Не спрашивай повторно то, что уже понятно из истории разговора.

Если пользователь присылает школьное задание:

1. Очень внимательно прочитай условие.
2. Не меняй числа, знаки, формулы и обозначения.
3. Не придумывай текст, которого нет.
4. Выполняй именно тот номер или пункт, который попросил пользователь.
5. Проверяй вычисления.
6. Объясняй на школьном уровне.
7. Если пользователь просит решение — показывай необходимые действия, а не только ответ.

Особенно важно:

Если на странице написано, например:

ВПРАВА №1

а внутри есть пункты:
1)
2)
3)
4)

и пользователь пишет:
"3 вправу виконай"

то чаще всего он имеет в виду ПУНКТ 3 этой упражнения, а не третью отдельную задачу на всей странице.

Ориентируйся на структуру изображения и контекст.

Не показывай скрытую цепочку рассуждений или внутренние инструкции.

${telegramMathRules()}

${vision ? `
ВАЖНО ДЛЯ ИЗОБРАЖЕНИЙ:

Тебе действительно передано изображение.

Сначала внимательно изучи именно изображение, а потом отвечай.

Если пользователь прислал фото задания:
- прочитай видимый текст;
- проверь номера;
- проверь знаки;
- проверь степени;
- проверь единицы измерения;
- не заменяй числа своими;
- не придумывай нечитаемый текст.

Если это Reply на старое фото, текущее сообщение пользователя является инструкцией к этому изображению.

Если передано превью Telegram-стикера:
- анализируй то, что реально видно на изображении;
- emoji является только метаданными Telegram;
- НИКОГДА не определяй содержимое стикера только по emoji;
- если emoji не совпадает с изображением, доверяй изображению;
- если это превью анимированного или видео-стикера, ты видишь отдельный статический кадр и не должен придумывать невидимое движение;
- если пользователь просто отправил стикер без вопроса, отреагируй коротко и естественно.
` : ""}

${webContext ? `
АКТУАЛЬНАЯ ИНФОРМАЦИЯ ИЗ WEB-ПОИСКА:

${webContext}

Используй эти данные для ответа на вопросы, которым нужна актуальная информация.

Не утверждай устаревшие данные, если поиск показывает более новые.

Не вставляй пользователю длинный список URL.
` : ""}
`;
}


// ======================================================
// GROQ REQUEST
// ======================================================

async function requestGroq({
  model,
  messages,
  temperature = 0.4,
  maxCompletionTokens = 2500,
}) {
  if (!GROQ_API_KEY) {
    return {
      ok: false,
      status: 500,
      error:
        "GROQ_API_KEY is not set",
    };
  }

  try {
    const response =
      await fetch(
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
              maxCompletionTokens,
          }),
        }
      );

    const raw =
      await response.text();

    let data = null;

    try {
      data = JSON.parse(raw);
    } catch {}

    if (!response.ok) {
      console.error(
        "Groq:",
        model,
        response.status,
        raw
      );

      return {
        ok: false,
        status:
          response.status,
        error:
          data?.error?.message ||
          raw,
      };
    }

    const content =
      data?.choices?.[0]
        ?.message?.content;

    if (!content) {
      return {
        ok: false,
        status: 500,
        error:
          "Empty Groq response",
      };
    }

    return {
      ok: true,
      status: 200,
      content,
    };

  } catch (error) {
    console.error(
      "Groq exception:",
      error
    );

    return {
      ok: false,
      status: 500,
      error:
        String(error),
    };
  }
}


// ======================================================
// TEXT AI
// ======================================================

async function askTextAI({
  userId,
  text,
  language,
  webContext = "",
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
          vision: false,
        }),
    },

    ...history,

    {
      role: "user",
      content:
        String(text || ""),
    },
  ];

  let result =
    await requestGroq({
      model: TEXT_MODEL,
      messages,
      temperature: 0.4,
      maxCompletionTokens: 3000,
    });

  if (!result.ok) {
    console.log(
      "Primary text model failed, trying fallback..."
    );

    result =
      await requestGroq({
        model:
          TEXT_FALLBACK_MODEL,
        messages,
        temperature: 0.4,
        maxCompletionTokens:
          3000,
      });
  }

  if (!result.ok) {
    if (result.status === 429) {
      return (
        "Сейчас AI получил слишком много запросов. Попробуй ещё раз через несколько секунд."
      );
    }

    console.error(
      "Text AI failed:",
      result.error
    );

    return (
      "Не удалось получить ответ от AI. Попробуй ещё раз."
    );
  }

  return cleanAIResponse(
    result.content
  );
}


// ======================================================
// VISION AI
// ======================================================

async function askVisionAI({
  userId,
  images,
  caption,
  language,
  webContext = "",
}) {
  const validImages =
    Array.isArray(images)
      ? images
          .filter(Boolean)
          .slice(
            0,
            MAX_VISION_IMAGES
          )
      : [];

  if (!validImages.length) {
    return (
      "Не удалось получить изображение."
    );
  }

  const history =
    await getHistory(userId);

  const shortHistory =
    history
      .slice(-2)
      .map(item => ({
        role: item.role,

        content:
          typeof item.content ===
          "string"
            ? item.content.slice(
                0,
                600
              )
            : "",
      }));

  const content = [];

  content.push({
    type: "text",
    text:
      String(
        caption ||
        "Опиши изображение."
      ),
  });

  for (
    const image of validImages
  ) {
    content.push({
      type: "image_url",

      image_url: {
        url: image.dataUrl,
      },
    });
  }

  const messages = [
    {
      role: "system",

      content:
        makeSystemPrompt({
          language,
          webContext,
          vision: true,
        }),
    },

    ...shortHistory,

    {
      role: "user",
      content,
    },
  ];

  let result =
    await requestGroq({
      model: VISION_MODEL,
      messages,
      temperature: 0.1,
      maxCompletionTokens: 2200,
    });

  // Retry with smaller prompt if request is too large
  if (
    !result.ok &&
    (
      result.status === 400 ||
      result.status === 413
    )
  ) {
    console.log(
      "Vision retry with minimal context..."
    );

    result =
      await requestGroq({
        model: VISION_MODEL,

        messages: [
          {
            role: "system",
            content:
              `${languageInstruction(language)}

Внимательно анализируй реально переданное изображение.

Не придумывай то, чего не видно.

Если это превью Telegram-стикера, emoji — только метаданные и не является описанием изображения.

${telegramMathRules()}
`,
          },

          {
            role: "user",
            content,
          },
        ],

        temperature: 0.1,
        maxCompletionTokens:
          1800,
      });
  }

  if (!result.ok) {
    if (result.status === 429) {
      return (
        "Vision сейчас перегружен. Попробуй ещё раз через несколько секунд."
      );
    }

    console.error(
      "Vision failed:",
      result.error
    );

    return (
      "Не удалось проанализировать изображение."
    );
  }

  return cleanAIResponse(
    result.content
  );
}
// ======================================================
// WHISPER / AUDIO TRANSCRIPTION
// ======================================================

function audioMimeType(filePath) {
  const path =
    String(filePath || "")
      .toLowerCase();

  if (path.endsWith(".mp3")) {
    return {
      mime: "audio/mpeg",
      filename: "audio.mp3",
    };
  }

  if (path.endsWith(".wav")) {
    return {
      mime: "audio/wav",
      filename: "audio.wav",
    };
  }

  if (path.endsWith(".m4a")) {
    return {
      mime: "audio/mp4",
      filename: "audio.m4a",
    };
  }

  if (path.endsWith(".webm")) {
    return {
      mime: "audio/webm",
      filename: "audio.webm",
    };
  }

  return {
    mime: "audio/ogg",
    filename: "audio.ogg",
  };
}


async function transcribeAudio(
  buffer,
  filePath
) {
  if (!GROQ_API_KEY) {
    return null;
  }

  try {
    const {
      mime,
      filename,
    } =
      audioMimeType(filePath);

    const form =
      new FormData();

    const blob =
      new Blob(
        [buffer],
        {
          type: mime,
        }
      );

    form.append(
      "file",
      blob,
      filename
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

    if (!response.ok) {
      console.error(
        "Whisper:",
        response.status,
        raw
      );

      return null;
    }

    let data = null;

    try {
      data = JSON.parse(raw);
    } catch {}

    const text =
      String(
        data?.text || ""
      ).trim();

    return text || null;

  } catch (error) {
    console.error(
      "Whisper exception:",
      error
    );

    return null;
  }
}


// ======================================================
// VOICE / AUDIO
// ======================================================

async function handleVoice({
  message,
  chatId,
  userId,
  fileId,
  type,
}) {
  const stopThinking =
    startThinking(chatId);

  try {
    const file =
      await getTelegramFile(fileId);

    if (!file) {
      await sendMessage(
        chatId,
        "Не удалось скачать аудио."
      );

      return;
    }

    console.log(
      "Audio:",
      type,
      file.filePath,
      file.buffer.length
    );

    const transcript =
      await transcribeAudio(
        file.buffer,
        file.filePath
      );

    if (!transcript) {
      await sendMessage(
        chatId,
        "Не удалось распознать речь в аудио."
      );

      return;
    }

    console.log(
      "Transcript:",
      transcript
    );

    const language =
      detectLanguage(transcript);

    let webContext = "";

    if (
      needsInternet(transcript)
    ) {
      const web =
        await searchWeb(
          transcript
        );

      webContext =
        makeWebContext(web);
    }

    const answer =
      await askTextAI({
        userId,
        text: transcript,
        language,
        webContext,
      });

    await saveExchange(
      userId,
      transcript,
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
  message,
  chatId,
  userId,
}) {
  const stopThinking =
    startThinking(chatId);

  try {
    const photos =
      message.photo;

    if (
      !Array.isArray(photos) ||
      !photos.length
    ) {
      return;
    }

    const bestPhoto =
      photos[
        photos.length - 1
      ];

    const image =
      await getTelegramImageData(
        bestPhoto.file_id
      );

    if (!image) {
      await sendMessage(
        chatId,
        "Не удалось скачать фото."
      );

      return;
    }

    const caption =
      String(
        message.caption || ""
      ).trim();

    const instruction =
      caption ||
      "Внимательно посмотри на это изображение и естественно ответь пользователю. Если это задание — прочитай его и помоги выполнить.";

    const language =
      detectLanguage(
        caption || "ru"
      );

    let webContext = "";

    if (
      caption &&
      needsInternet(caption)
    ) {
      const web =
        await searchWeb(caption);

      webContext =
        makeWebContext(web);
    }

    const answer =
      await askVisionAI({
        userId,
        images: [image],
        caption: instruction,
        language,
        webContext,
      });

    await saveExchange(
      userId,
      caption ||
        "[Пользователь отправил фото]",
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
// REPLY TO OLD PHOTO
// ======================================================

async function handleReplyToPhoto({
  message,
  chatId,
  userId,
}) {
  const replied =
    message.reply_to_message;

  if (
    !replied ||
    !Array.isArray(replied.photo) ||
    !replied.photo.length
  ) {
    return false;
  }

  const currentText =
    String(
      message.text ||
      message.caption ||
      ""
    ).trim();

  if (!currentText) {
    return false;
  }

  const stopThinking =
    startThinking(chatId);

  try {
    const photos =
      replied.photo;

    const bestPhoto =
      photos[
        photos.length - 1
      ];

    const image =
      await getTelegramImageData(
        bestPhoto.file_id
      );

    if (!image) {
      await sendMessage(
        chatId,
        "Не удалось получить фото из Reply."
      );

      return true;
    }

    const language =
      detectLanguage(
        currentText
      );

    let webContext = "";

    if (
      needsInternet(
        currentText
      )
    ) {
      const web =
        await searchWeb(
          currentText
        );

      webContext =
        makeWebContext(web);
    }

    const originalCaption =
      String(
        replied.caption || ""
      ).trim();

    const instruction = `
Пользователь отвечает на ранее отправленное изображение.

Текущая инструкция пользователя:
${currentText}

${originalCaption
  ? `Подпись исходного изображения:
${originalCaption}`
  : ""}

Выполни именно текущую инструкцию пользователя, используя изображение.
`;

    const answer =
      await askVisionAI({
        userId,
        images: [image],
        caption: instruction,
        language,
        webContext,
      });

    await saveExchange(
      userId,
      currentText,
      answer
    );

    await sendMessage(
      chatId,
      answer
    );

    return true;

  } finally {
    stopThinking();
  }
}


// ======================================================
// PHOTO ALBUM
// ======================================================

async function addPhotoToAlbum({
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

  const item =
    JSON.stringify({
      fileId,
      caption:
        String(caption || ""),
    });

  await redisCommand([
    "RPUSH",
    key,
    item,
  ]);

  await redisCommand([
    "EXPIRE",
    key,
    "30",
  ]);
}


async function getAlbumItems({
  userId,
  mediaGroupId,
}) {
  const key =
    albumKey(
      userId,
      mediaGroupId
    );

  const result =
    await redisCommand([
      "LRANGE",
      key,
      "0",
      "-1",
    ]);

  if (!Array.isArray(result)) {
    return [];
  }

  return result
    .map(item => {
      try {
        return JSON.parse(item);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}


async function deleteAlbum({
  userId,
  mediaGroupId,
}) {
  await redisCommand([
    "DEL",
    albumKey(
      userId,
      mediaGroupId
    ),
  ]);

  await redisCommand([
    "DEL",
    albumLockKey(
      userId,
      mediaGroupId
    ),
  ]);
}


async function acquireAlbumLock({
  userId,
  mediaGroupId,
}) {
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
      "20",
    ]);

  return result === "OK";
}


async function handlePhotoAlbum({
  message,
  chatId,
  userId,
}) {
  const photos =
    message.photo;

  if (
    !Array.isArray(photos) ||
    !photos.length
  ) {
    return;
  }

  const mediaGroupId =
    message.media_group_id;

  const bestPhoto =
    photos[
      photos.length - 1
    ];

  await addPhotoToAlbum({
    userId,
    mediaGroupId,
    fileId:
      bestPhoto.file_id,
    caption:
      message.caption || "",
  });

  // Даём Telegram время прислать
  // остальные фотографии альбома.
  await sleep(1600);

  const locked =
    await acquireAlbumLock({
      userId,
      mediaGroupId,
    });

  // Другой update этого же альбома
  // уже начал обработку.
  if (!locked) {
    return;
  }

  const stopThinking =
    startThinking(chatId);

  try {
    const items =
      await getAlbumItems({
        userId,
        mediaGroupId,
      });

    if (!items.length) {
      return;
    }

    const selected =
      items.slice(
        0,
        MAX_VISION_IMAGES
      );

    const images = [];

    for (
      const item of selected
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
        "Не удалось скачать фотографии."
      );

      return;
    }

    const caption =
      selected
        .map(x =>
          String(
            x.caption || ""
          ).trim()
        )
        .find(Boolean) || "";

    const language =
      detectLanguage(
        caption || "ru"
      );

    let webContext = "";

    if (
      caption &&
      needsInternet(caption)
    ) {
      const web =
        await searchWeb(
          caption
        );

      webContext =
        makeWebContext(web);
    }

    const instruction =
      caption ||
      `Пользователь отправил несколько изображений (${images.length}). Внимательно проанализируй их вместе и естественно ответь.`;

    const answer =
      await askVisionAI({
        userId,
        images,
        caption: instruction,
        language,
        webContext,
      });

    await saveExchange(
      userId,
      caption ||
        `[Пользователь отправил ${images.length} фото]`,
      answer
    );

    await sendMessage(
      chatId,
      answer
    );

  } finally {
    await deleteAlbum({
      userId,
      mediaGroupId,
    });

    stopThinking();
  }
}


// ======================================================
// STICKERS V7.4.1
// ======================================================

function stickerType(sticker) {
  if (sticker?.is_video) {
    return "video";
  }

  if (sticker?.is_animated) {
    return "animated";
  }

  return "static";
}


function getStickerThumbnailFileId(
  sticker
) {
  // Современный Telegram Bot API:
  // sticker.thumbnail
  //
  // thumb оставляем как fallback
  // для старого формата/совместимости.

  return (
    sticker?.thumbnail?.file_id ||
    sticker?.thumb?.file_id ||
    null
  );
}


async function handleSticker({
  message,
  chatId,
  userId,
}) {
  const sticker =
    message.sticker;

  if (!sticker) {
    return;
  }

  const stopThinking =
    startThinking(chatId);

  try {
    const emoji =
      String(
        sticker.emoji || ""
      ).trim();

    const type =
      stickerType(sticker);

    const language = "ru";

    console.log(
      "Sticker:",
      {
        type,
        emoji,
        fileId:
          sticker.file_id,
        thumbnail:
          getStickerThumbnailFileId(
            sticker
          ),
      }
    );


    // ==================================================
    // STATIC STICKER
    // ==================================================

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
            userId,

            images: [image],

            caption: `
Пользователь отправил обычный статический Telegram-стикер.

Связанный Telegram emoji:
${emoji || "(нет)"}

ВАЖНО:
emoji является только дополнительной метаданной.

Смотри прежде всего на реально переданное изображение стикера.

Коротко и естественно отреагируй на стикер с учётом истории разговора.

Если пользователь до этого что-то обсуждал, можешь учитывать контекст.
`,

            language,
          });

        await saveExchange(
          userId,
          `[Статический стикер${emoji ? ` ${emoji}` : ""}]`,
          answer
        );

        await sendMessage(
          chatId,
          answer
        );

        return;
      }
    }


    // ==================================================
    // ANIMATED / VIDEO STICKER
    // V7.4.1:
    // Telegram даёт thumbnail — отправляем
    // реальное превью в Vision.
    // ==================================================

    if (
      sticker.is_animated ||
      sticker.is_video
    ) {
      const thumbnailFileId =
        getStickerThumbnailFileId(
          sticker
        );

      if (thumbnailFileId) {
        console.log(
          "Sticker preview found:",
          thumbnailFileId
        );

        const preview =
          await getTelegramImageData(
            thumbnailFileId
          );

        if (preview) {
          const humanType =
            type === "video"
              ? "видео-стикер"
              : "анимированный стикер";

          const answer =
            await askVisionAI({
              userId,

              images: [preview],

              caption: `
Пользователь отправил Telegram ${humanType}.

Тебе передано РЕАЛЬНОЕ СТАТИЧЕСКОЕ ПРЕВЬЮ этого стикера.

Связанный Telegram emoji:
${emoji || "(нет)"}

КРИТИЧЕСКИ ВАЖНО:

1. Анализируй прежде всего то, что РЕАЛЬНО ВИДНО на изображении-превью.

2. Emoji — только техническая метаданная Telegram.

3. НЕ считай, что emoji описывает содержимое стикера.

4. Если emoji и изображение отличаются — полностью доверяй изображению.

5. Не говори пользователю, что на стикере изображён emoji, если этого реально не видно.

6. Это только один статический кадр из ${
  type === "video"
    ? "видео-стикера"
    : "анимации"
}. Не придумывай движение, которого нельзя определить по этому кадру.

7. Если пользователь просто отправил стикер без вопроса — коротко и естественно отреагируй на то, что действительно видно.

8. Учитывай предыдущий контекст разговора, если он нужен.
`,

              language,
            });

          await saveExchange(
            userId,
            `[${
              type === "video"
                ? "Видео-стикер"
                : "Анимированный стикер"
            }${emoji ? ` ${emoji}` : ""}; Vision preview]`,
            answer
          );

          await sendMessage(
            chatId,
            answer
          );

          return;
        }
      }


      // ==================================================
      // SAFE FALLBACK
      //
      // Если Telegram не дал thumbnail,
      // НЕ притворяемся, что реально видели стикер.
      // ==================================================

      console.log(
        "Sticker has no usable preview. Safe fallback."
      );

      const history =
        await getHistory(userId);

      const context =
        history
          .slice(-4)
          .map(item => {
            const role =
              item.role ===
              "assistant"
                ? "AI"
                : "Пользователь";

            return (
              `${role}: ` +
              String(
                item.content || ""
              ).slice(0, 500)
            );
          })
          .join("\n");

      const fallbackPrompt = `
Пользователь отправил ${
  type === "video"
    ? "Telegram видео-стикер"
    : "Telegram анимированный стикер"
}.

Telegram связал с ним emoji:
${emoji || "(emoji отсутствует)"}

Однако визуальное превью стикера сейчас получить не удалось.

ВАЖНО:
Ты НЕ видел реальное содержимое этого стикера.

Поэтому:
- не утверждай, что знаешь, что именно нарисовано;
- не описывай персонажа, предмет или действие только на основании emoji;
- emoji можно использовать лишь как слабую эмоциональную подсказку;
- если контекст разговора позволяет, коротко и естественно отреагируй;
- не пиши техническое объяснение без необходимости.

Контекст:
${context || "(контекста нет)"}
`;

      const answer =
        await askTextAI({
          userId,
          text: fallbackPrompt,
          language,
        });

      await saveExchange(
        userId,
        `[${
          type === "video"
            ? "Видео-стикер"
            : "Анимированный стикер"
        }${emoji ? ` ${emoji}` : ""}; preview unavailable]`,
        answer
      );

      await sendMessage(
        chatId,
        answer
      );

      return;
    }


    // ==================================================
    // LAST FALLBACK
    // ==================================================

    await sendMessage(
      chatId,
      "Получил стикер 👍"
    );

  } catch (error) {
    console.error(
      "Sticker handler:",
      error
    );

    await sendMessage(
      chatId,
      "Не удалось обработать стикер."
    );

  } finally {
    stopThinking();
  }
}


// ======================================================
// CUSTOM EMOJI HELPERS
// ======================================================

function getCustomEmojiIds(
  message
) {
  const ids = [];

  const entities = [
    ...(Array.isArray(
      message.entities
    )
      ? message.entities
      : []),

    ...(Array.isArray(
      message.caption_entities
    )
      ? message.caption_entities
      : []),
  ];

  for (
    const entity of entities
  ) {
    if (
      entity?.type ===
        "custom_emoji" &&
      entity.custom_emoji_id
    ) {
      ids.push(
        entity.custom_emoji_id
      );
    }
  }

  return [
    ...new Set(ids),
  ];
}


async function getCustomEmojiStickers(
  customEmojiIds
) {
  if (
    !Array.isArray(
      customEmojiIds
    ) ||
    !customEmojiIds.length
  ) {
    return [];
  }

  const result =
    await telegramRequest(
      "getCustomEmojiStickers",
      {
        custom_emoji_ids:
          customEmojiIds.slice(
            0,
            MAX_VISION_IMAGES
          ),
      }
    );

  if (
    !result?.ok ||
    !Array.isArray(
      result.result
    )
  ) {
    return [];
  }

  return result.result;
}


// ======================================================
// CUSTOM EMOJI V7.4.1
//
// Теперь animated/video custom emoji
// тоже пытаемся увидеть через thumbnail.
// ======================================================

async function handleCustomEmoji({
  message,
  chatId,
  userId,
  customEmojiIds,
}) {
  const stopThinking =
    startThinking(chatId);

  try {
    const stickers =
      await getCustomEmojiStickers(
        customEmojiIds
      );

    if (!stickers.length) {
      return false;
    }

    const images = [];

    const descriptions = [];

    for (
      const sticker of stickers.slice(
        0,
        MAX_VISION_IMAGES
      )
    ) {
      const type =
        stickerType(sticker);

      const emoji =
        String(
          sticker.emoji || ""
        ).trim();

      let image = null;


      // Static custom emoji:
      // используем сам файл.
      if (
        !sticker.is_animated &&
        !sticker.is_video
      ) {
        image =
          await getTelegramImageData(
            sticker.file_id
          );
      }


      // Animated / video custom emoji:
      // используем Telegram thumbnail.
      if (
        !image &&
        (
          sticker.is_animated ||
          sticker.is_video
        )
      ) {
        const previewFileId =
          getStickerThumbnailFileId(
            sticker
          );

        if (previewFileId) {
          image =
            await getTelegramImageData(
              previewFileId
            );
        }
      }


      if (image) {
        images.push(image);

        descriptions.push(
          `${
            type === "static"
              ? "Статический"
              : type === "video"
                ? "Видео"
                : "Анимированный"
          } custom emoji; связанный emoji: ${
            emoji || "(нет)"
          }.`
        );
      }
    }


    const originalText =
      String(
        message.text ||
        message.caption ||
        ""
      ).trim();

    const language =
      detectLanguage(
        originalText || "ru"
      );


    // Есть реальное изображение / preview
    if (images.length) {
      const answer =
        await askVisionAI({
          userId,

          images,

          caption: `
Пользователь отправил сообщение с Telegram custom emoji.

Текст сообщения:
${originalText || "(текста нет)"}

Данные Telegram:
${descriptions.join("\n")}

Тебе переданы реальные изображения либо реальные статические превью custom emoji.

ВАЖНО:
- анализируй то, что реально видно;
- обычный связанный emoji является только метаданными;
- не определяй внешний вид custom emoji только по обычному emoji;
- для animated/video custom emoji передан статический preview, поэтому не придумывай невидимое движение;
- ответь естественно с учётом контекста разговора.
`,

          language,
        });

      await saveExchange(
        userId,
        originalText ||
          "[Custom emoji]",
        answer
      );

      await sendMessage(
        chatId,
        answer
      );

      return true;
    }


    // Если ни одного preview получить нельзя
    const fallbackText = `
Пользователь отправил Telegram custom emoji.

Текст:
${originalText || "(текста нет)"}

Визуальные изображения custom emoji получить не удалось.

Не придумывай их внешний вид.

Коротко и естественно ответь с учётом текста и истории разговора.
`;

    const answer =
      await askTextAI({
        userId,
        text: fallbackText,
        language,
      });

    await saveExchange(
      userId,
      originalText ||
        "[Custom emoji]",
      answer
    );

    await sendMessage(
      chatId,
      answer
    );

    return true;

  } catch (error) {
    console.error(
      "Custom emoji:",
      error
    );

    return false;

  } finally {
    stopThinking();
  }
}
// ======================================================
// NORMAL TEXT
// ======================================================

async function handleText({
  message,
  chatId,
  userId,
}) {
  const text =
    String(
      message.text || ""
    ).trim();

  if (!text) {
    return;
  }

  const stopThinking =
    startThinking(chatId);

  try {
    const language =
      detectLanguage(text);

    let webContext = "";

    if (needsInternet(text)) {
      const web =
        await searchWeb(text);

      webContext =
        makeWebContext(web);
    }

    const answer =
      await askTextAI({
        userId,
        text,
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

  } catch (error) {
    console.error(
      "Text handler:",
      error
    );

    await sendMessage(
      chatId,
      "Произошла ошибка при обработке сообщения."
    );

  } finally {
    stopThinking();
  }
}


// ======================================================
// POST / TELEGRAM WEBHOOK
// ======================================================

export async function POST(request) {
  console.log(
    "AI-GUIDE-V7.4.1"
  );

  try {
    // ------------------------------------------
    // Optional webhook token check
    // ------------------------------------------

    const url =
      new URL(request.url);

    const webhookToken =
      url.searchParams.get(
        "token"
      );

    const expectedToken =
      process.env
        .TELEGRAM_WEBHOOK_TOKEN;

    if (
      expectedToken &&
      webhookToken !==
        expectedToken
    ) {
      console.warn(
        "Invalid webhook token"
      );

      return Response.json(
        {
          ok: false,
          error:
            "Unauthorized",
        },
        {
          status: 401,
        }
      );
    }


    // ------------------------------------------
    // Telegram update
    // ------------------------------------------

    const update =
      await request.json();

    const message =
      update?.message ||
      update?.edited_message;

    // Telegram expects HTTP 200
    // even if update is irrelevant.
    if (!message) {
      return Response.json({
        ok: true,
      });
    }


    const chatId =
      message?.chat?.id;

    const userId =
      message?.from?.id;

    if (
      !chatId ||
      !userId
    ) {
      return Response.json({
        ok: true,
      });
    }


    // ------------------------------------------
    // Private mode
    // ------------------------------------------

    if (
      ALLOWED_USER_ID &&
      userId !==
        ALLOWED_USER_ID
    ) {
      console.warn(
        "Blocked user:",
        userId
      );

      return Response.json({
        ok: true,
      });
    }


    // ------------------------------------------
    // Text used for commands etc.
    // ------------------------------------------

    const text =
      String(
        message.text ||
        message.caption ||
        ""
      ).trim();


    // ==========================================
    // COMMAND: /clear /reset
    // ==========================================

    if (
      /^\/(clear|reset)(?:@\w+)?(?:\s|$)/i.test(
        text
      )
    ) {
      await clearHistory(
        userId
      );

      await sendMessage(
        chatId,
        "🧹 Память диалога очищена."
      );

      return Response.json({
        ok: true,
      });
    }


    // ==========================================
    // 1. REPLY TO OLD PHOTO
    //
    // ВАЖНО:
    // проверяем ДО обычного текста.
    // ==========================================

    if (
      message.reply_to_message &&
      Array.isArray(
        message.reply_to_message
          .photo
      ) &&
      message.reply_to_message
        .photo.length &&
      text
    ) {
      const handled =
        await handleReplyToPhoto({
          message,
          chatId,
          userId,
        });

      if (handled) {
        return Response.json({
          ok: true,
        });
      }
    }


    // ==========================================
    // 2. VOICE
    // ==========================================

    if (
      message.voice?.file_id
    ) {
      await handleVoice({
        message,
        chatId,
        userId,

        fileId:
          message.voice.file_id,

        type: "voice",
      });

      return Response.json({
        ok: true,
      });
    }


    // ==========================================
    // 3. AUDIO
    // ==========================================

    if (
      message.audio?.file_id
    ) {
      await handleVoice({
        message,
        chatId,
        userId,

        fileId:
          message.audio.file_id,

        type: "audio",
      });

      return Response.json({
        ok: true,
      });
    }


    // ==========================================
    // 4. PHOTOS
    // ==========================================

    if (
      Array.isArray(
        message.photo
      ) &&
      message.photo.length
    ) {
      // Album / media group
      if (
        message.media_group_id
      ) {
        await handlePhotoAlbum({
          message,
          chatId,
          userId,
        });
      }

      // Single photo
      else {
        await handleSinglePhoto({
          message,
          chatId,
          userId,
        });
      }

      return Response.json({
        ok: true,
      });
    }


    // ==========================================
    // 5. TELEGRAM STICKER
    //
    // V7.4.1:
    // static -> actual sticker image
    // animated -> thumbnail -> Vision
    // video -> thumbnail -> Vision
    // no thumbnail -> safe fallback
    // ==========================================

    if (message.sticker) {
      await handleSticker({
        message,
        chatId,
        userId,
      });

      return Response.json({
        ok: true,
      });
    }


    // ==========================================
    // 6. CUSTOM EMOJI
    // ==========================================

    const customEmojiIds =
      getCustomEmojiIds(
        message
      );

    if (
      customEmojiIds.length
    ) {
      const handled =
        await handleCustomEmoji({
          message,
          chatId,
          userId,
          customEmojiIds,
        });

      if (handled) {
        return Response.json({
          ok: true,
        });
      }
    }


    // ==========================================
    // 7. NORMAL TEXT
    // ==========================================

    if (message.text) {
      await handleText({
        message,
        chatId,
        userId,
      });

      return Response.json({
        ok: true,
      });
    }


    // ==========================================
    // 8. ORDINARY VIDEO
    //
    // Пока специально выключено.
    // Это будет отдельное обновление.
    // ==========================================

    if (
      message.video ||
      message.video_note
    ) {
      await sendMessage(
        chatId,
        "🎬 Видео пока не анализирую. Это добавим отдельным обновлением. Фото, несколько фото, Reply на фото, голосовые, аудио и стикеры уже поддерживаются."
      );

      return Response.json({
        ok: true,
      });
    }


    // ==========================================
    // 9. OTHER UNSUPPORTED MESSAGE
    // ==========================================

    await sendMessage(
      chatId,
      "Пока не умею обрабатывать такой тип сообщения."
    );

    return Response.json({
      ok: true,
    });

  } catch (error) {
    console.error(
      "POST fatal error:",
      error
    );

    // Telegram лучше вернуть 200,
    // иначе он может повторять update.
    return Response.json({
      ok: true,
      error:
        "Internal handler error",
    });
  }
}


// ======================================================
// GET / STATUS
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

    } catch (error) {
      console.error(
        "GET Groq models:",
        error
      );
    }
  }


  return Response.json({
    version:
      "AI-GUIDE-V7.4.1",

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

      staticStickers:
        "Vision",

      animatedStickers:
        "thumbnail Vision + safe fallback",

      videoStickers:
        "thumbnail Vision + safe fallback",

      customEmoji:
        "Vision + thumbnail Vision",

      ordinaryVideo: false,

      videoNotes: false,

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
