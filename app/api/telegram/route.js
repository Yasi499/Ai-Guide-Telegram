export const runtime = "nodejs";

// ======================================================
// CONFIG
// ======================================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

const UPSTASH_REDIS_REST_URL =
  process.env.UPSTASH_REDIS_REST_URL;

const UPSTASH_REDIS_REST_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN;

const ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID
  ? Number(process.env.TELEGRAM_ALLOWED_USER_ID)
  : null;

const TELEGRAM_API =
  `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

const OPENROUTER_API =
  "https://openrouter.ai/api/v1/chat/completions";

const AI_MODEL = "openrouter/free";

const MAX_HISTORY_MESSAGES = 20;


// ======================================================
// REDIS MEMORY
// ======================================================

function memoryKey(userId) {
  return `ai-guide:history:${userId}`;
}


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

        body: JSON.stringify(command),
      }
    );

    const raw = await response.text();

    if (!response.ok) {
      console.error("Redis error:", raw);
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

  if (!result) {
    return [];
  }

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


async function addHistory(
  userId,
  role,
  content
) {
  const history =
    await getHistory(userId);

  history.push({
    role,
    content:
      String(content).slice(0, 5000),
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
// TELEGRAM SEND
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
      text.slice(i, i + 4000);

    const response = await fetch(
      `${TELEGRAM_API}/sendMessage`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
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
// TELEGRAM PHOTO
// ======================================================

async function getTelegramPhotoBase64(
  fileId
) {
  try {

    // Получаем путь к файлу
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
        "Telegram getFile error:",
        info
      );

      return null;
    }


    const filePath =
      info.result.file_path;


    // Скачиваем изображение
    const imageResponse =
      await fetch(
        `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`
      );


    if (!imageResponse.ok) {
      console.error(
        "Photo download error:",
        imageResponse.status
      );

      return null;
    }


    const arrayBuffer =
      await imageResponse.arrayBuffer();


    // В Node.js Buffer доступен
    const base64 =
      Buffer
        .from(arrayBuffer)
        .toString("base64");


    // Telegram-фотографии обычно JPEG
    let mimeType =
      "image/jpeg";


    if (
      filePath
        .toLowerCase()
        .endsWith(".png")
    ) {
      mimeType =
        "image/png";
    }


    return (
      `data:${mimeType};base64,${base64}`
    );

  } catch (error) {

    console.error(
      "Photo exception:",
      error
    );

    return null;
  }
}


// ======================================================
// LANGUAGE
// ======================================================

function detectLanguage(text) {
  const t =
    (text || "").toLowerCase();

  if (
    /[іїєґ]/i.test(text || "") ||
    /\b(що|цей|ця|зараз|сьогодні|поясни|скороти|новини|свіжі|останні)\b/i.test(t)
  ) {
    return "uk";
  }

  if (
    /[а-яё]/i.test(text || "")
  ) {
    return "ru";
  }

  // Для фото без подписи
  // используем русский по умолчанию.
  return "ru";
}


function languageInstruction(language) {
  if (language === "uk") {
    return (
      "Отвечай на украинском языке."
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
    "недавно",

    "новости",
    "что нового",
    "что там с",
    "что там по",
    "что произошло",
    "что случилось",

    "погода",
    "температура",
    "дождь",
    "снег",
    "ветер",

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
    "вышел",
    "вышла",
    "вышло",
    "выйдет",
    "релиз",

    "утечк",
    "слив",
    "сливал",
    "слили",
    "инсайдер",
    "инсайд",

    "зараз",
    "сьогодні",
    "свіж",
    "останні",
    "новини",
    "що нового",
    "ціна",
    "скільки коштує",
    "оновлення",
    "витік",

    "today",
    "current",
    "currently",
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
// FOLLOW-UP DETECTION
// ======================================================

function isContextFollowUp(text) {
  if (!text) {
    return false;
  }

  const t =
    text.toLowerCase();

  const patterns = [

    "по этому",
    "про это",
    "об этом",
    "по этому делу",

    "про него",
    "про неё",
    "про них",

    "а сейчас",
    "а сегодня",
    "а что сейчас",
    "а что нового",

    "дай свеж",
    "свежие новости",

    "подробнее",
    "поподробнее",

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


// ======================================================
// SEARCH CONTEXT
// ======================================================

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
        `${String(item.content).slice(0, 1200)}`
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


  // USD -> UAH
  const genericDollar =
    t.includes("курс доллара") ||
    t.includes("курс долара");


  const anotherCurrency =
    t.includes("руб") ||
    t.includes("rub") ||
    t.includes("евро") ||
    t.includes("eur") ||
    t.includes("злот") ||
    t.includes("pln") ||
    t.includes("тенге");


  if (
    genericDollar &&
    !anotherCurrency
  ) {

    if (language === "uk") {

      return (
        "актуальний курс долара США " +
        "до української гривні " +
        "USD UAH сьогодні Україна"
      );

    }


    return (
      "актуальный курс доллара США " +
      "к украинской гривне " +
      "USD UAH сегодня Украина"
    );
  }


  // Контекстный поиск
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
по теме текущего разговора.

КОНТЕКСТ:

${context}

ВОПРОС:

${text}

Определи конкретную тему,
человека, игру, компанию,
событие или утечку из контекста.

Не ищи только слова
из текущего короткого вопроса.
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

    console.log(
      "Tavily:",
      query.slice(0, 1500)
    );


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

          body: JSON.stringify({

            query,

            search_depth:
              "basic",

            max_results:
              7,

            include_answer:
              true,

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


// ======================================================
// WEB CONTEXT
// ======================================================

function makeWebContext(data) {

  if (!data) {
    return null;
  }


  let result = "";


  if (data.answer) {

    result += `

SEARCH SUMMARY:

${data.answer}

`;

  }


  if (
    Array.isArray(
      data.results
    )
  ) {

    result +=
      data.results
        .slice(0, 7)
        .map(
          (
            item,
            index
          ) => `

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


  return (
    result.trim() ||
    null
  );
}


// ======================================================
// CLEAN MODEL OUTPUT
// ======================================================

function cleanAIResponse(text) {

  if (!text) {
    return "";
  }


  let cleaned =
    String(text);


  cleaned =
    cleaned.replace(
      /<\|tool_call_start\|>[\s\S]*?<\|tool_call_end\|>/gi,
      ""
    );


  cleaned =
    cleaned.replace(
      /<\|tool_call_start\|>[\s\S]*$/gi,
      ""
    );


  cleaned =
    cleaned.replace(
      /<\|tool_call_end\|>/gi,
      ""
    );


  cleaned =
    cleaned.replace(
      /<\|tool_call[^>]*\|>/gi,
      ""
    );


  cleaned =
    cleaned.replace(
      /^\s*User Safety\s*:\s*safe\s*$/gim,
      ""
    );


  cleaned =
    cleaned.replace(
      /^\s*Response Safety\s*:\s*safe\s*$/gim,
      ""
    );


  cleaned =
    cleaned.replace(
      /^\s*Safety\s*:\s*safe\s*$/gim,
      ""
    );


  cleaned =
    cleaned.replace(
      /^\s*google\s*\([^\n]*\)\s*$/gim,
      ""
    );


  cleaned =
    cleaned.replace(
      /\n{3,}/g,
      "\n\n"
    );


  return cleaned.trim();
}


// ======================================================
// OPENROUTER TEXT REQUEST
// ======================================================

async function requestOpenRouter(
  messages
) {

  try {

    const response =
      await fetch(
        OPENROUTER_API,
        {
          method: "POST",

          headers: {

            "Content-Type":
              "application/json",

            Authorization:
              `Bearer ${OPENROUTER_API_KEY}`,

            "X-Title":
              "AI Guide Telegram Bot",

          },

          body: JSON.stringify({

            model:
              AI_MODEL,

            messages,

            temperature:
              0.55,

            max_tokens:
              1800,

          }),
        }
      );


    const raw =
      await response.text();


    console.log(
      "OpenRouter:",
      response.status
    );


    if (!response.ok) {

      console.error(
        "OpenRouter:",
        raw
      );

      return null;
    }


    const data =
      JSON.parse(raw);


    return (
      data
        ?.choices
        ?.[0]
        ?.message
        ?.content ||
      null
    );

  } catch (error) {

    console.error(
      "OpenRouter exception:",
      error
    );

    return null;
  }
}


// ======================================================
// TEXT AI
// ======================================================

async function askAI({
  text,
  userId,
  language,
  webContext,
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


  let systemPrompt = `

Ты AI Guide —
персональный Telegram AI-ассистент.

Сейчас:

${currentTime}

${languageInstruction(language)}

Учитывай историю разговора.

Если пользователь пишет:

"сократи"
"подробнее"
"про него"
"что с ним?"
"по этому делу"
"твой прошлый ответ"

понимай контекст предыдущих сообщений.

Не проси отправлять текст повторно,
если он уже есть в истории.

Для актуальной информации
используй WEB DATA,
если она предоставлена.

Не придумывай свежие факты.

Не заменяй событие 2026 года
старой похожей историей.

Ты не управляешь Google,
браузером или tools.

Никогда не выводи:

<|tool_call_start|>
<|tool_call_end|>
User Safety: safe
Response Safety: safe

Не показывай URL,
если пользователь сам
не попросил источники.

Если пользователь просто спрашивает
"курс доллара",
подразумевай USD -> UAH.

`;


  if (webContext) {

    systemPrompt += `

==========================
WEB DATA
==========================

${webContext}

==========================

Это свежие результаты поиска.

Проверяй даты и релевантность.

Если точного подтверждения нет,
честно скажи об этом.

`;

  }


  const history =
    await getHistory(userId);


  const messages = [

    {
      role:
        "system",

      content:
        systemPrompt,
    },

    ...history,

    {
      role:
        "user",

      content:
        text,
    },

  ];


  let answer =
    await requestOpenRouter(
      messages
    );


  answer =
    cleanAIResponse(
      answer
    );


  return (
    answer ||
    "⚠️ Не удалось получить нормальный ответ. Попробуй ещё раз."
  );
}


// ======================================================
// VISION AI
// ======================================================

async function askVisionAI({
  imageData,
  caption,
  userId,
  language,
}) {

  const history =
    await getHistory(userId);


  // В историю передаём только текст.
  // Старые изображения в Redis не сохраняем.
  const safeHistory =
    history.slice(-12);


  const systemPrompt = `

Ты AI Guide —
персональный Telegram AI-ассистент.

${languageInstruction(language)}

Пользователь отправил изображение.

Внимательно изучи его.

Если это:

- школьное задание —
  реши его и объясни;

- скриншот ошибки —
  найди проблему;

- интерфейс программы —
  объясни, что на нём;

- предмет —
  расскажи, что видно;

- текст —
  прочитай и выполни просьбу пользователя;

- фотография —
  ответь на вопрос пользователя
  об изображении.

Не придумывай мелкие детали,
которые невозможно уверенно увидеть.

Учитывай предыдущую историю разговора.

Если подписи к фотографии нет,
сам опиши главное на изображении
и предложи полезную помощь.

Не выводи:

User Safety: safe
Response Safety: safe
<|tool_call_start|>

`;


  const userPrompt =
    caption ||
    "Что изображено на этой фотографии? Объясни главное и помоги, если на ней есть задание, текст или проблема.";


  const messages = [

    {
      role:
        "system",

      content:
        systemPrompt,
    },

    ...safeHistory,

    {
      role:
        "user",

      content: [

        {
          type:
            "text",

          text:
            userPrompt,
        },

        {
          type:
            "image_url",

          image_url: {
            url:
              imageData,
          },
        },

      ],
    },

  ];


  let answer =
    await requestOpenRouter(
      messages
    );


  answer =
    cleanAIResponse(
      answer
    );


  return (
    answer ||
    "⚠️ Не удалось проанализировать изображение. Попробуй отправить его ещё раз."
  );
}


// ======================================================
// POST
// ======================================================

export async function POST(request) {

  try {

    console.log(
      "AI-GUIDE-V6-VISION"
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
    // PHOTO
    // ==================================================

    if (
      Array.isArray(
        message.photo
      ) &&
      message.photo.length > 0
    ) {

      console.log(
        "📷 Получено фото"
      );


      // Telegram присылает несколько размеров.
      // Берём самый большой.
      const biggestPhoto =
        message.photo[
          message.photo.length - 1
        ];


      const fileId =
        biggestPhoto.file_id;


      const caption =
        message.caption?.trim() ||
        "";


      const language =
        detectLanguage(
          caption
        );


      const imageData =
        await getTelegramPhotoBase64(
          fileId
        );


      if (!imageData) {

        await sendMessage(
          chatId,
          "⚠️ Не удалось скачать фотографию из Telegram."
        );


        return Response.json({
          ok: true,
        });

      }


      console.log(
        "📷 Фото скачано"
      );


      const answer =
        await askVisionAI({

          imageData,

          caption,

          userId,

          language,

        });


      // Сохраняем только текстовое описание
      // факта отправки фото.
      // Base64 в Redis НЕ кладём.

      await addHistory(

        userId,

        "user",

        caption
          ? `[Пользователь отправил изображение]\n${caption}`
          : "[Пользователь отправил изображение]"

      );


      await addHistory(

        userId,

        "assistant",

        answer

      );


      await sendMessage(
        chatId,
        answer
      );


      console.log(
        "📷 Vision answer sent"
      );


      return Response.json({
        ok: true,
      });

    }


    // ==================================================
    // TEXT
    // ==================================================

    const text =
      message.text?.trim();


    if (!text) {

      await sendMessage(
        chatId,
        "Пока я поддерживаю текст и фотографии 📷"
      );


      return Response.json({
        ok: true,
      });

    }


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
        "🧹 Постоянная история разговора очищена."
      );


      return Response.json({
        ok: true,
      });

    }


    // ==================================================
    // NORMAL TEXT
    // ==================================================

    const language =
      detectLanguage(text);


    let webContext =
      null;


    if (
      needsInternet(text)
    ) {

      console.log(
        "🌐 Web search"
      );


      const query =
        await buildSearchQuery(
          text,
          userId,
          language
        );


      const webData =
        await searchWeb(
          query
        );


      webContext =
        makeWebContext(
          webData
        );

    }


    const answer =
      await askAI({

        text,

        userId,

        language,

        webContext,

      });


    // ==================================================
    // SAVE MEMORY
    // ==================================================

    await addHistory(
      userId,
      "user",
      text
    );


    await addHistory(
      userId,
      "assistant",
      answer
    );


    // ==================================================
    // SEND
    // ==================================================

    await sendMessage(
      chatId,
      answer
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
// GET
// ======================================================

export async function GET() {

  return Response.json({

    version:
      "AI-GUIDE-V6-VISION",

    status:
      "Bot is running",

    telegram:
      !!TELEGRAM_BOT_TOKEN,

    openrouter:
      !!OPENROUTER_API_KEY,

    tavily:
      !!TAVILY_API_KEY,

    redis:
      !!(
        UPSTASH_REDIS_REST_URL &&
        UPSTASH_REDIS_REST_TOKEN
      ),

    privateMode:
      !!ALLOWED_USER_ID,

    memory:
      "Upstash Redis",

    vision:
      true,

    search:
      "Tavily",

    model:
      AI_MODEL,

  });
}
