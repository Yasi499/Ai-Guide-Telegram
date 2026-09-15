export const runtime = "nodejs";

// ======================================================
// ENV / CONFIG
// ======================================================

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN;

const OPENROUTER_API_KEY =
  process.env.OPENROUTER_API_KEY;

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

const OPENROUTER_API =
  "https://openrouter.ai/api/v1/chat/completions";

const AI_MODEL = "openrouter/free";

// Сколько сообщений храним.
// 20 = примерно 10 обменов user <-> assistant.
const MAX_HISTORY_MESSAGES = 20;


// ======================================================
// UPSTASH REDIS — ПОСТОЯННАЯ ПАМЯТЬ
// ======================================================

function memoryKey(userId) {
  return `ai-guide:history:${userId}`;
}


async function redisCommand(command) {
  if (
    !UPSTASH_REDIS_REST_URL ||
    !UPSTASH_REDIS_REST_TOKEN
  ) {
    console.error(
      "❌ Upstash Redis не настроен"
    );

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

    const raw =
      await response.text();

    if (!response.ok) {
      console.error(
        "❌ Redis error:",
        raw
      );

      return null;
    }

    const data =
      JSON.parse(raw);

    return data.result;
  } catch (error) {
    console.error(
      "❌ Redis exception:",
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

    if (!Array.isArray(history)) {
      return [];
    }

    return history;
  } catch (error) {
    console.error(
      "❌ History JSON error:",
      error
    );

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
// TELEGRAM
// ======================================================

async function sendMessage(
  chatId,
  text
) {
  if (!text) {
    text =
      "Не удалось получить ответ.";
  }

  // Telegram имеет лимит на размер сообщения.
  for (
    let i = 0;
    i < text.length;
    i += 4000
  ) {
    const part =
      text.slice(i, i + 4000);

    const response =
      await fetch(
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
        "❌ Telegram:",
        await response.text()
      );
    }
  }
}


// ======================================================
// LANGUAGE
// ======================================================

function detectLanguage(text) {
  const t =
    text.toLowerCase();

  if (
    /[іїєґ]/i.test(text) ||
    /\b(що|цей|ця|зараз|сьогодні|поясни|скороти|новини|свіжі|останні|напиши)\b/i.test(t)
  ) {
    return "uk";
  }

  if (/[а-яё]/i.test(text)) {
    return "ru";
  }

  return "en";
}


function languageInstruction(
  language
) {
  if (language === "uk") {
    return `
Отвечай на украинском языке.
Если предыдущие сообщения были на русском,
но текущий вопрос украинский — отвечай украинским.
`;
  }

  if (language === "ru") {
    return `
Отвечай на русском языке.
Если веб-источники английские,
всё равно отвечай пользователю по-русски.
`;
  }

  return `
Answer in English.
`;
}


// ======================================================
// НУЖЕН ЛИ ИНТЕРНЕТ
// ======================================================

function needsInternet(text) {
  const t =
    text.toLowerCase();

  const triggers = [

    // Актуальность
    "сейчас",
    "сегодня",
    "вчера",
    "завтра",
    "свеж",
    "актуаль",
    "последн",
    "недавно",

    // Новости
    "новости",
    "что нового",
    "что там с",
    "что там по",
    "что произошло",
    "что случилось",

    // Погода
    "погода",
    "температура",
    "дождь",
    "снег",
    "ветер",

    // Валюты
    "курс",
    "доллар",
    "долара",
    "евро",
    "гривн",
    "usd",
    "uah",
    "eur",

    // Цены
    "цена",
    "сколько стоит",

    // Игры / новости / утечки
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

    // Украинский
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

    // English
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
// FOLLOW-UP
// ======================================================

function isContextFollowUp(text) {
  const t =
    text.toLowerCase().trim();

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
    "what about now",
  ];

  return patterns.some(
    (pattern) =>
      t.includes(pattern)
  );
}


// ======================================================
// КОНТЕКСТ ДЛЯ ПОИСКА
// ======================================================

async function getConversationContext(
  userId
) {
  const history =
    await getHistory(userId);

  if (!history.length) {
    return "";
  }

  return history
    .slice(-8)
    .map((item) => {

      const speaker =
        item.role === "user"
          ? "User"
          : "Assistant";

      const content =
        String(
          item.content
        ).slice(0, 1200);

      return (
        `${speaker}: ${content}`
      );
    })
    .join("\n");
}


// ======================================================
// СОЗДАНИЕ ПОИСКОВОГО ЗАПРОСА
// ======================================================

async function buildSearchQuery(
  text,
  userId,
  language
) {
  const t =
    text.toLowerCase();

  // ------------------------------------------
  // КУРС ДОЛЛАРА
  // ------------------------------------------

  const genericDollar =
    t.includes(
      "курс доллара"
    ) ||
    t.includes(
      "курс долара"
    ) ||
    t === "доллар" ||
    t === "долар";

  const specifiedCurrency =
    t.includes("руб") ||
    t.includes("rub") ||

    t.includes("евро") ||
    t.includes("eur") ||
    t.includes("euro") ||

    t.includes("злот") ||
    t.includes("pln") ||

    t.includes("тенге") ||
    t.includes("kzt");

  if (
    genericDollar &&
    !specifiedCurrency
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


  // ------------------------------------------
  // КОНТЕКСТНЫЙ FOLLOW-UP
  // ------------------------------------------

  if (
    isContextFollowUp(text)
  ) {
    const context =
      await getConversationContext(
        userId
      );

    if (context) {
      return `
Найди самую свежую и релевантную
информацию по теме разговора.

КОНТЕКСТ:

${context}

НОВЫЙ ВОПРОС:

${text}

Определи главную тему из контекста.

Особенно учитывай:
- имена людей;
- названия аккаунтов;
- игры;
- компании;
- события;
- даты;
- утечки;
- новости.

Не ищи только фразу
"${text}".

Ищи именно тему,
о которой пользователь говорил раньше.
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
    console.error(
      "❌ TAVILY_API_KEY не настроен"
    );

    return null;
  }

  try {
    console.log(
      "🌐 Tavily query:",
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

            max_results: 7,

            include_answer:
              true,

            include_raw_content:
              false,
          }),
        }
      );

    const raw =
      await response.text();

    console.log(
      "🌐 Tavily status:",
      response.status
    );

    if (!response.ok) {
      console.error(
        "❌ Tavily:",
        raw
      );

      return null;
    }

    return JSON.parse(raw);

  } catch (error) {
    console.error(
      "❌ Tavily exception:",
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

  let context = "";

  if (data.answer) {
    context += `
SEARCH SUMMARY:

${data.answer}

`;
  }


  if (
    Array.isArray(
      data.results
    )
  ) {
    context +=
      data.results
        .slice(0, 7)
        .map(
          (
            item,
            index
          ) => {

            return `
RESULT ${index + 1}

TITLE:
${item.title || "Unknown"}

CONTENT:
${item.content || "No content"}

URL:
${item.url || "Unknown"}

`;

          }
        )
        .join("\n");
  }


  return (
    context.trim() ||
    null
  );
}


// ======================================================
// УБИРАЕМ МУСОР FREE-МОДЕЛЕЙ
// ======================================================

function cleanAIResponse(text) {
  if (!text) {
    return "";
  }

  let cleaned =
    String(text);


  // Tool calls
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


  // Safety
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


  // google(...)
  cleaned =
    cleaned.replace(
      /^\s*google\s*\([^\n]*\)\s*$/gim,
      ""
    );


  // Лишние пустые строки
  cleaned =
    cleaned.replace(
      /\n{3,}/g,
      "\n\n"
    );


  return cleaned.trim();
}


// ======================================================
// OPENROUTER
// ======================================================

async function requestOpenRouter(
  messages
) {
  if (!OPENROUTER_API_KEY) {
    return null;
  }

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
      "🤖 OpenRouter status:",
      response.status
    );


    if (!response.ok) {
      console.error(
        "❌ OpenRouter:",
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
      "❌ OpenRouter exception:",
      error
    );

    return null;
  }
}


// ======================================================
// AI
// ======================================================

async function askAI({
  text,
  userId,
  language,
  webContext,
}) {

  if (!OPENROUTER_API_KEY) {
    return (
      "⚠️ OPENROUTER_API_KEY " +
      "не настроен."
    );
  }


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
Ты AI Guide — персональный
AI-ассистент пользователя в Telegram.

ТЕКУЩАЯ ДАТА И ВРЕМЯ:

${currentTime}

${languageInstruction(language)}

================================
ПАМЯТЬ
================================

У тебя есть история последних сообщений.

Используй её.

Понимай продолжения:

"сократи"

"сделай короче"

"подробнее"

"объясни проще"

"что?"

"а почему?"

"твой прошлый текст"

"позапрошлый ответ"

"про него"

"что с ним?"

"по этому делу"

"дай свежие новости"

"а что сейчас?"

Если нужный текст или тема уже есть
в истории разговора,
НЕ проси пользователя отправить
информацию повторно.


================================
СТИЛЬ
================================

Отвечай естественно.

Не пиши слишком официально.

На простой вопрос —
короткий понятный ответ.

На сложный вопрос —
нормальное объяснение.

Можно использовать эмодзи,
но умеренно.


================================
ИНТЕРНЕТ
================================

Ты НЕ управляешь поиском.

Ты НЕ должен самостоятельно
вызывать:

Google
google(...)
search(...)
browser(...)
tools
functions

Поиск выполняет сервер через Tavily.

Если WEB DATA присутствует,
значит свежий поиск УЖЕ выполнен.

Используй эти данные.


НИКОГДА НЕ ВЫВОДИ:

<|tool_call_start|>

<|tool_call_end|>

User Safety: safe

Response Safety: safe


================================
АКТУАЛЬНАЯ ИНФОРМАЦИЯ
================================

Для:

новостей,
утечек,
инсайдов,
погоды,
курсов валют,
цен,
релизов,
обновлений

используй WEB DATA.

Не выдавай старые сведения
за свежие.

Особенно следи за датами.

Если вопрос относится к 2026 году,
не заменяй его похожей историей
из 2022 или другого года.

Если поиск не подтверждает
утверждение пользователя —
скажи об этом.

Не придумывай:

людей,
аккаунты,
утечки,
новости,
даты,
официальные заявления.


================================
ИСТОЧНИКИ
================================

Не кидай пользователю
список сырых URL без необходимости.

Если он прямо просит:

"дай ссылки"

"дай источники"

"откуда инфа"

тогда можешь показать
релевантные URL из WEB DATA.


================================
ВАЛЮТА
================================

Если пользователь просто пишет:

"курс доллара"

и не указывает вторую валюту,

подразумевай:

USD -> UAH

доллар США к украинской гривне.
`;


  if (webContext) {

    systemPrompt += `

================================
WEB DATA — СВЕЖИЙ ПОИСК
================================

${webContext}

================================

Эти данные получены сервером
прямо перед текущим ответом.

Используй только результаты,
относящиеся к вопросу.

Проверяй даты.

Если найденные страницы говорят
о другом человеке или событии,
не используй их как подтверждение.

Если точной информации нет —
честно скажи:

что надёжного подтверждения
найти не удалось.

Не заменяй неизвестную свежую
информацию похожей старой историей.

Сформулируй ответ самостоятельно,
а не копируй поисковую выдачу.
`;
  }


  // ==================================================
  // ЗАГРУЖАЕМ ИСТОРИЮ ИЗ REDIS
  // ==================================================

  const history =
    await getHistory(userId);


  console.log(
    "🧠 Redis history:",
    history.length
  );


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


  if (!answer) {

    if (language === "uk") {
      return (
        "⚠️ Не вдалося отримати " +
        "нормальну відповідь. " +
        "Спробуй ще раз."
      );
    }


    if (language === "en") {
      return (
        "⚠️ I couldn't get a proper " +
        "response. Please try again."
      );
    }


    return (
      "⚠️ Не удалось получить " +
      "нормальный ответ. " +
      "Попробуй ещё раз."
    );
  }


  return answer;
}


// ======================================================
// TELEGRAM WEBHOOK
// ======================================================

export async function POST(
  request
) {

  try {

    console.log(
      "🚀 AI-GUIDE-V5-MEMORY"
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
    // PRIVATE ACCESS
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
    // TEXT
    // ==================================================

    const text =
      message.text?.trim();


    if (!text) {

      await sendMessage(
        chatId,
        "Пока V5 работает с текстовыми сообщениями."
      );


      return Response.json({
        ok: true,
      });

    }


    console.log(
      "💬 User:",
      text
    );


    // ==================================================
    // CLEAR MEMORY
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
    // LANGUAGE
    // ==================================================

    const language =
      detectLanguage(text);


    // ==================================================
    // WEB SEARCH
    // ==================================================

    let webContext =
      null;


    if (
      needsInternet(text)
    ) {

      console.log(
        "🌐 Нужен интернет"
      );


      const searchQuery =
        await buildSearchQuery(
          text,
          userId,
          language
        );


      console.log(
        "🔎 Search:",
        searchQuery.slice(
          0,
          1500
        )
      );


      const webData =
        await searchWeb(
          searchQuery
        );


      webContext =
        makeWebContext(
          webData
        );


      if (webContext) {

        console.log(
          "✅ WEB DATA ready"
        );

      } else {

        console.log(
          "⚠️ WEB DATA empty"
        );

      }

    } else {

      console.log(
        "🧠 Интернет не нужен"
      );

    }


    // ==================================================
    // ASK AI
    // ==================================================

    const answer =
      await askAI({
        text,
        userId,
        language,
        webContext,
      });


    // ==================================================
    // СОХРАНЯЕМ В REDIS
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


    console.log(
      "💾 History saved to Redis"
    );


    // ==================================================
    // TELEGRAM RESPONSE
    // ==================================================

    await sendMessage(
      chatId,
      answer
    );


    console.log(
      "✅ Ответ отправлен"
    );


    return Response.json({
      ok: true,
    });


  } catch (error) {

    console.error(
      "🔥 BOT ERROR:",
      error
    );


    // Возвращаем Telegram 200,
    // чтобы он не отправлял update повторно.

    return Response.json({
      ok: true,
    });

  }
}


// ======================================================
// GET — STATUS
// ======================================================

export async function GET() {

  return Response.json({

    version:
      "AI-GUIDE-V5-MEMORY",

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
      (
        UPSTASH_REDIS_REST_URL &&
        UPSTASH_REDIS_REST_TOKEN
      )
        ? "Upstash Redis"
        : "NOT CONFIGURED",

    historyMessages:
      MAX_HISTORY_MESSAGES,

    search:
      "Tavily",

    model:
      AI_MODEL,

  });
}
