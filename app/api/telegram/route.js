export const runtime = "nodejs";

// ======================================================
// AI GUIDE V7.2
//
// Groq:
// - Text: openai/gpt-oss-120b
// - Text fallback: openai/gpt-oss-20b
// - Vision: qwen/qwen3.8-27b
// - Voice: whisper-large-v3-turbo
//
// + Tavily
// + Upstash memory
// + Telegram typing
// + single photo
// + albums
// + REPLY TO PHOTO
// + voice/audio
// + static stickers
// + Telegram-safe math
//
// OpenRouter DISABLED
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

// Qwen 3.8 — максимум 3 изображения
const MAX_VISION_IMAGES = 3;


// ======================================================
// HELPERS
// ======================================================

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
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

        body:
          JSON.stringify(command),
      }
    );

    const raw =
      await response.text();

    if (!response.ok) {
      console.error(
        "Redis:",
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
// TELEGRAM SEND MESSAGE
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
        "Telegram sendMessage:",
        await response.text()
      );
    }
  }
}


// ======================================================
// TYPING
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
      "ChatAction:",
      error
    );
  }
}


function startThinking(
  chatId
) {
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
// GROQ MODELS
// ======================================================

async function getGroqModels() {
  if (!GROQ_API_KEY) {
    return [];
  }

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

    if (!response.ok) {
      console.error(
        "Groq models:",
        await response.text()
      );

      return [];
    }

    const data =
      await response.json();

    return Array.isArray(data.data)
      ? data.data
          .map(x => x.id)
          .filter(Boolean)
      : [];

  } catch (error) {
    console.error(
      "Groq models exception:",
      error
    );

    return [];
  }
}


// ======================================================
// TELEGRAM FILE
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
        "Telegram file:",
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
  const lower =
    String(filePath)
      .toLowerCase();

  if (lower.endsWith(".png")) {
    return "image/png";
  }

  if (lower.endsWith(".webp")) {
    return "image/webp";
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
    imageMimeType(
      file.filePath
    );

  const base64 =
    file.buffer
      .toString("base64");

  console.log(
    "Image:",
    file.filePath,
    "bytes:",
    file.buffer.length
  );

  return {
    dataUrl:
      `data:${mimeType};base64,${base64}`,

    bytes:
      file.buffer.length,
  };
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
    /\b(що|цей|ця|зараз|сьогодні|поясни|виконай|зроби|скороти|новини|свіжі|останні|вправу)\b/i.test(lower)
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
// TELEGRAM MATH
// ======================================================

function telegramMathRules() {
  return `
ВАЖНО:

Telegram показывает обычный текст.

НЕ используй LaTeX.

Не используй:
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
$...$
$$...$$

Пиши так:

5,4 · 10⁴
1,02 · 10⁻²
R = U / I
Q = I² · R · t
h = √(m · n)
x = (-b ± √D) / (2a)

Используй Unicode:
² ³ ⁴
₀ ₁ ₂
√
·
×
±
≈
`;
}


// ======================================================
// CLEAN AI OUTPUT
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
      char =>
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
      char =>
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
// INTERNET DETECTION
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
    "курс",
    "доллар",
    "евро",
    "гривн",
    "цена",
    "сколько стоит",
    "обновление",
    "патч",
    "релиз",
    "утечк",
    "слив",

    "зараз",
    "сьогодні",
    "свіж",
    "останні",
    "новини",
    "ціна",
    "скільки коштує",
    "оновлення",

    "today",
    "current",
    "latest",
    "recent",
    "news",
    "weather",
    "price",
    "update",
    "release",
  ];

  return triggers.some(
    trigger =>
      t.includes(trigger)
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
      "Tavily:",
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
      `SEARCH SUMMARY:\n${data.answer}\n\n`;
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

Учитывай предыдущую историю разговора.

Не придумывай факты.

Если пользователь просит:
"сделай короче"
"подробнее"
"продолжи"
"почему?"
"сделай 3"
учитывай предыдущий контекст.

Для школьных заданий:
- внимательно прочитай условие;
- не меняй числа;
- не придумывай текст;
- выполняй именно тот пункт,
  который попросил пользователь;
- проверяй вычисления;
- отвечай на уровне школьника,
  если вопрос школьный.

Если на странице написано:
"ВПРАВА №1"

и ниже есть пункты:
1.
2.
3.
4.

а пользователь пишет:
"3 вправу виконай"

это означает:
выполни ПУНКТ 3
этой упражнения.

Не решай всю страницу,
если этого не просили.

Не показывай скрытую
цепочку рассуждений.

${telegramMathRules()}
`;

  if (vision) {
    prompt += `

Ты получил реальное изображение.

ВНИМАТЕЛЬНО его изучи.

Если пользователь ответил
на старое фото через Reply,
это изображение является тем фото,
на которое он отвечает.

Текст текущего сообщения —
это инструкция к изображению.

Например:

изображение содержит
"ВПРАВА №1"
и пункты 1-8.

Пользователь пишет:
"3 вправу виконай"

Нужно выполнить ТОЛЬКО пункт 3.

Не говори:
"я не вижу изображение",
если изображение реально передано
в этом запросе.

Если текст мелкий:
постарайся прочитать его,
но не выдумывай нечитаемые слова.

Если критически важную часть
прочитать невозможно —
скажи конкретно какую.

Если изображений несколько,
рассматривай их вместе.
`;
  }

  if (webContext) {
    prompt += `

СВЕЖИЕ ДАННЫЕ TAVILY:

${webContext}

Используй их для ответа
на актуальный вопрос.
`;
  }

  return prompt;
}


// ======================================================
// GROQ REQUEST
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

      return {
        ok: false,
        status:
          response.status,
        error: raw,
        text: null,
      };
    }

    const data =
      JSON.parse(raw);

    return {
      ok: true,
      status: 200,
      error: null,

      text:
        data
          ?.choices
          ?.[0]
          ?.message
          ?.content ||
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
      error:
        String(error),
      text: null,
    };
  }
}


// ======================================================
// DETECT GROQ ERROR
// ======================================================

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
  webContext,
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
      temperature: 0.4,
      maxTokens: 1800,
    });

  if (!result.ok) {
    result =
      await requestGroq({
        model:
          TEXT_FALLBACK_MODEL,

        messages,
        temperature: 0.4,
        maxTokens: 1800,
      });
  }

  const cleaned =
    cleanAIResponse(
      result.text
    );

  if (cleaned) {
    return cleaned;
  }

  if (
    result.status === 429
  ) {
    return (
      "⚠️ Сейчас достигнут лимит Groq. " +
      "Попробуй немного позже."
    );
  }

  return (
    "⚠️ Не удалось получить ответ от Groq. " +
    "Попробуй ещё раз."
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
  // Для Vision специально НЕ отправляем
  // всю 20-сообщений историю.
  //
  // Фото само по себе уже занимает
  // существенный объём запроса.

  const history =
    await getHistory(userId);

  // Только последние 2 текстовых сообщения.
  const tinyHistory =
    history
      .slice(-2)
      .map(item => ({
        role: item.role,

        content:
          String(item.content)
            .slice(0, 700),
      }));

  const userContent = [
    {
      type: "text",

      text:
        caption ||
        (
          images.length > 1
            ? "Внимательно проанализируй эти изображения вместе."
            : "Внимательно проанализируй это изображение."
        ),
    },
  ];

  for (
    const image of
    images.slice(
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
      model:
        VISION_MODEL,

      messages,

      temperature: 0.15,

      // Уменьшили максимум ответа.
      // Для школьного фото этого
      // более чем достаточно.
      maxTokens: 1200,
    });


  // ====================================================
  // RETRY IF REQUEST TOO LARGE
  // ====================================================

  if (
    !result.ok &&
    isRequestTooLarge(result)
  ) {
    console.log(
      "Vision request too large. Retrying without history..."
    );

    // Вторая попытка:
    // вообще без истории,
    // только короткий system prompt +
    // изображение + инструкция.

    messages = [
      {
        role: "system",

        content: `
Ты анализируешь изображение
для пользователя Telegram.

${languageInstruction(language)}

Внимательно прочитай изображение.

Если это школьное задание,
выполни только тот пункт,
который попросил пользователь.

Не придумывай нечитаемый текст.

Не используй LaTeX.

Формулы пиши обычным текстом:
R = U / I
Q = I² · R · t
√
·
×
²
³
`.trim(),
      },

      {
        role: "user",
        content: userContent,
      },
    ];

    result =
      await requestGroq({
        model:
          VISION_MODEL,

        messages,

        temperature:
          0.1,

        maxTokens:
          800,
      });
  }


  const cleaned =
    cleanAIResponse(
      result.text
    );

  if (cleaned) {
    return cleaned;
  }


  // ====================================================
  // CORRECT ERROR MESSAGE
  // ====================================================

  if (
    isRequestTooLarge(result)
  ) {
    return (
      "⚠️ Это изображение оказалось слишком большим " +
      "для Groq Vision. Попробуй отправить его как скриншот " +
      "или обрезать только нужную часть страницы."
    );
  }

  if (
    result.status === 429
  ) {
    return (
      "⚠️ Сейчас достигнут лимит запросов Groq Vision. " +
      "Попробуй немного позже."
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
    await getTelegramFile(
      fileId
    );

  if (!file) {
    return null;
  }

  try {
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

    const form =
      new FormData();

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
      const webData =
        await searchWeb(
          transcription
        );

      webContext =
        makeWebContext(
          webData
        );
    }

    const answer =
      await askTextAI({
        text:
          transcription,

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
    startThinking(chatId);

  try {
    const image =
      await getTelegramImageData(
        fileId
      );

    if (!image) {
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
    !reply ||
    !Array.isArray(reply.photo) ||
    !reply.photo.length
  ) {
    return false;
  }

  console.log(
    "Reply to photo detected"
  );

  const largestPhoto =
    reply.photo[
      reply.photo.length - 1
    ];

  const fileId =
    largestPhoto.file_id;

  const stopThinking =
    startThinking(chatId);

  try {
    const image =
      await getTelegramImageData(
        fileId
      );

    if (!image) {
      await sendMessage(
        chatId,
        "⚠️ Не удалось загрузить фото, на которое ты ответил."
      );

      return true;
    }

    const originalCaption =
      reply.caption?.trim() ||
      "";

    let instruction =
      text?.trim() ||
      "Проанализируй это изображение.";

    if (originalCaption) {
      instruction +=
        `\n\nПодпись исходного фото: ${originalCaption}`;
    }

    const language =
      detectLanguage(
        instruction
      );

    const answer =
      await askVisionAI({
        images: [image],

        caption:
          instruction,

        userId,
        language,
      });

    await saveExchange(
      userId,

      `[Ответ на ранее отправленное фото]\n${instruction}`,

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
// ALBUM REDIS
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

  // RPUSH вместо GET + SET.
  // Так надёжнее при нескольких
  // одновременных webhook.
  await redisCommand([
    "RPUSH",
    key,

    JSON.stringify({
      fileId,
      caption:
        caption || "",
      messageId:
        messageId || 0,
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

  if (
    !Array.isArray(result)
  ) {
    return [];
  }

  const items = [];

  for (const raw of result) {
    try {
      const item =
        JSON.parse(raw);

      items.push(item);
    } catch {
      // ignore broken item
    }
  }

  items.sort(
    (a, b) =>
      (a.messageId || 0) -
      (b.messageId || 0)
  );

  return items;
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
// HANDLE ALBUM
// ======================================================

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

  // Ждём остальные части альбома
  await sleep(1500);

  const gotLock =
    await tryAlbumLock(
      userId,
      mediaGroupId
    );

  if (!gotLock) {
    return;
  }

  // Последний шанс для позднего update
  await sleep(500);

  const album =
    await getAlbum(
      userId,
      mediaGroupId
    );

  if (!album.length) {
    return;
  }

  const stopThinking =
    startThinking(chatId);

  try {
    const selected =
      album.slice(
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
        "⚠️ Не удалось скачать фотографии."
      );

      return;
    }

    const caption =
      album
        .map(x => x.caption)
        .find(Boolean) ||
      "";

    const language =
      detectLanguage(
        caption
      );

    const answer =
      await askVisionAI({
        images,
        caption,
        userId,
        language,
      });

    await saveExchange(
      userId,

      `[Альбом: ${images.length} фото]` +
      (
        caption
          ? `\n${caption}`
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
      "😀 Пока я понимаю только обычные статичные стикеры."
    );

    return;
  }

  const stopThinking =
    startThinking(chatId);

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
          "Пользователь отправил стикер. Коротко и естественно отреагируй на него как собеседник. Если на нём есть текст, учти его.",

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
      "AI-GUIDE-V7.2"
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
    // PRIVATE MODE
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


    const text =
      message.text?.trim() ||
      "";


    // ==================================================
    // CLEAR
    // ==================================================

    if (
      text.toLowerCase() ===
        "/clear" ||

      text.toLowerCase() ===
        "/reset"
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
    // REPLY TO PHOTO
    //
    // ВАЖНО:
    // проверяем ДО обычного текста.
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

      // Album
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

          messageId:
            message.message_id,
        });

        return Response.json({
          ok: true,
        });
      }

      // Single photo
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
        startThinking(chatId);

      try {
        const language =
          detectLanguage(text);

        let webContext =
          null;

        if (
          needsInternet(text)
        ) {
          const webData =
            await searchWeb(text);

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
      "Сейчас я понимаю текст, фото, несколько фото, Reply на фото, голосовые, аудио и статичные стикеры."
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

  return Response.json({
    version:
      "AI-GUIDE-V7.2",

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
        models.includes(
          TEXT_MODEL
        ),

      textFallback:
        models.includes(
          TEXT_FALLBACK_MODEL
        ),

      vision:
        models.includes(
          VISION_MODEL
        ),

      whisper:
        models.includes(
          WHISPER_MODEL
        ),
    },

    features: {
      text: true,

      singlePhoto: true,

      multiPhoto: true,

      maxVisionImages:
        MAX_VISION_IMAGES,

      replyToPhoto: true,

      voice: true,

      audio: true,

      staticStickers: true,

      typingIndicator: true,

      memory:
        "Upstash Redis",

      search:
        "Tavily",

      telegramSafeMath:
        true,
    },
  });
}
