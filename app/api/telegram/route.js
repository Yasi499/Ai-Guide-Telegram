export const runtime = "nodejs";

// ======================================================
// CONFIG
// ======================================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

const ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID
  ? Number(process.env.TELEGRAM_ALLOWED_USER_ID)
  : null;

const TELEGRAM_API =
  `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

const OPENROUTER_API =
  "https://openrouter.ai/api/v1/chat/completions";

const AI_MODEL = "openrouter/free";

// ======================================================
// TEMPORARY MEMORY
// ======================================================

if (!globalThis.__aiGuideV4Memory) {
  globalThis.__aiGuideV4Memory = new Map();
}

const memory = globalThis.__aiGuideV4Memory;

function getHistory(userId) {
  return memory.get(String(userId)) || [];
}

function saveHistory(userId, history) {
  // Последние 16 сообщений
  memory.set(
    String(userId),
    history.slice(-16)
  );
}

function addHistory(userId, role, content) {
  const history = getHistory(userId);

  history.push({
    role,
    content,
  });

  saveHistory(userId, history);
}

// ======================================================
// TELEGRAM
// ======================================================

async function sendMessage(chatId, text) {
  if (!text) {
    text = "Не удалось получить ответ.";
  }

  // Telegram ограничивает размер одного сообщения.
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
  const t = text.toLowerCase();

  if (
    /[іїєґ]/i.test(text) ||
    /\b(що|цей|ця|зараз|сьогодні|поясни|скороти|новини|свіжі|останні)\b/i.test(t)
  ) {
    return "uk";
  }

  if (/[а-яё]/i.test(text)) {
    return "ru";
  }

  return "en";
}

function languageInstruction(language) {
  if (language === "uk") {
    return "Отвечай на украинском языке.";
  }

  if (language === "ru") {
    return "Отвечай на русском языке.";
  }

  return "Answer in English.";
}

// ======================================================
// INTERNET DETECTION
// ======================================================

function needsInternet(text) {
  const t = text.toLowerCase();

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

    // Валюта
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

    // Игры / обновления / утечки
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
    (trigger) => t.includes(trigger)
  );
}

// ======================================================
// FOLLOW-UP DETECTION
// ======================================================

function isContextFollowUp(text) {
  const t = text.toLowerCase().trim();

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
    (pattern) => t.includes(pattern)
  );
}

// ======================================================
// CONVERSATION CONTEXT FOR SEARCH
// ======================================================

function getConversationContext(userId) {
  const history = getHistory(userId);

  if (!history.length) {
    return "";
  }

  return history
    .slice(-6)
    .map((item) => {
      const speaker =
        item.role === "user"
          ? "User"
          : "Assistant";

      // Ограничиваем огромные старые сообщения.
      const content =
        String(item.content).slice(0, 1200);

      return `${speaker}: ${content}`;
    })
    .join("\n");
}

// ======================================================
// SEARCH QUERY
// ======================================================

function buildSearchQuery(text, userId, language) {
  const t = text.toLowerCase();

  // ------------------------------------------
  // "курс доллара" -> USD/UAH
  // ------------------------------------------

  const genericDollar =
    t.includes("курс доллара") ||
    t.includes("курс долара") ||
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
      return "актуальний курс долара США до української гривні USD UAH сьогодні Україна";
    }

    return "актуальный курс доллара США к украинской гривне USD UAH сегодня Украина";
  }

  // ------------------------------------------
  // "дай свежие новости по этому делу"
  // ------------------------------------------

  if (isContextFollowUp(text)) {
    const context =
      getConversationContext(userId);

    if (context) {
      return `
Найди самую свежую и релевантную информацию по теме разговора.

Контекст разговора:
${context}

Текущий вопрос:
${text}

Сосредоточь поиск на конкретных именах, событиях,
играх, компаниях и датах из контекста.
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
      "🌐 Tavily:",
      query.slice(0, 1200)
    );

    const response = await fetch(
      "https://api.tavily.com/search",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
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
// TAVILY -> AI CONTEXT
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
    Array.isArray(data.results) &&
    data.results.length > 0
  ) {
    context += data.results
      .slice(0, 7)
      .map((item, index) => {
        return `
RESULT ${index + 1}

Title:
${item.title || "Unknown"}

Content:
${item.content || "No content"}

URL:
${item.url || "Unknown"}
`;
      })
      .join("\n");
  }

  return context.trim() || null;
}

// ======================================================
// CLEAN BAD MODEL OUTPUT
// ======================================================

function cleanAIResponse(text) {
  if (!text) {
    return "";
  }

  let cleaned = String(text);

  // ------------------------------------------
  // Tool call garbage
  // ------------------------------------------

  cleaned = cleaned.replace(
    /<\|tool_call_start\|>[\s\S]*?<\|tool_call_end\|>/gi,
    ""
  );

  cleaned = cleaned.replace(
    /<\|tool_call_start\|>[\s\S]*$/gi,
    ""
  );

  cleaned = cleaned.replace(
    /<\|tool_call_end\|>/gi,
    ""
  );

  cleaned = cleaned.replace(
    /<\|tool_call[^>]*\|>/gi,
    ""
  );

  // ------------------------------------------
  // Safety garbage
  // ------------------------------------------

  cleaned = cleaned.replace(
    /^\s*User Safety\s*:\s*safe\s*$/gim,
    ""
  );

  cleaned = cleaned.replace(
    /^\s*Response Safety\s*:\s*safe\s*$/gim,
    ""
  );

  cleaned = cleaned.replace(
    /^\s*Safety\s*:\s*safe\s*$/gim,
    ""
  );

  // ------------------------------------------
  // Иногда модель печатает google(...)
  // ------------------------------------------

  cleaned = cleaned.replace(
    /^\s*google\s*\([^\n]*\)\s*$/gim,
    ""
  );

  cleaned = cleaned.replace(
    /\n{3,}/g,
    "\n\n"
  );

  return cleaned.trim();
}

// ======================================================
// OPENROUTER
// ======================================================

async function requestOpenRouter(messages) {
  if (!OPENROUTER_API_KEY) {
    return null;
  }

  try {
    const response = await fetch(
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
          model: AI_MODEL,

          messages,

          temperature: 0.55,

          max_tokens: 1800,
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
      data?.choices?.[0]?.message?.content ||
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
// ASK AI
// ======================================================

async function askAI({
  text,
  userId,
  language,
  webContext,
}) {
  if (!OPENROUTER_API_KEY) {
    return "⚠️ OPENROUTER_API_KEY не настроен.";
  }

  const currentTime =
    new Date().toLocaleString(
      "ru-RU",
      {
        timeZone: "Europe/Kyiv",
      }
    );

  let systemPrompt = `
Ты AI Guide — персональный AI-ассистент в Telegram.

Текущая дата и время:
${currentTime}

${languageInstruction(language)}

==============================
ОБЩИЕ ПРАВИЛА
==============================

Пиши естественно, понятно и без лишней воды.

На простой вопрос отвечай коротко.

Если вопрос сложный — можешь объяснить подробнее.

Учитывай предыдущие сообщения разговора.

Понимай такие продолжения:

"сократи"
"сделай короче"
"подробнее"
"объясни проще"
"твой прошлый текст"
"а что сейчас?"
"по этому делу"
"про него"
"что с ним?"
"дай свежие новости"

Если нужная информация уже есть в истории,
НЕ проси пользователя прислать её заново.

==============================
ЯЗЫК
==============================

Отвечай на языке текущего сообщения пользователя.

Не переключайся на английский только потому,
что веб-источник написан на английском.

==============================
ИНТЕРНЕТ
==============================

Ты НЕ управляешь интернет-поиском.

Ты НЕ имеешь права самостоятельно вызывать:

Google
google(...)
search(...)
browser(...)
tools
functions

Интернет-поиск выполняет сервер через Tavily.

Если ниже присутствует WEB DATA,
это уже готовые результаты свежего поиска.

Используй их.

Никогда не печатай:

<|tool_call_start|>
<|tool_call_end|>
User Safety: safe
Response Safety: safe

Не изображай вызов инструментов текстом.

==============================
СВЕЖАЯ ИНФОРМАЦИЯ
==============================

Для новостей, утечек, обновлений,
цен, валют, погоды и других меняющихся данных
ориентируйся на WEB DATA.

Не выдавай старые сведения за свежие.

Особенно внимательно проверяй даты.

Если пользователь спрашивает о событии 2026 года,
не заменяй его похожим событием 2022 года.

Если поиск не подтверждает утверждение пользователя,
скажи об этом прямо.

Не придумывай человека, аккаунт,
утечку или событие только потому,
что пользователь назвал его.

Если найдено несколько противоречивых версий,
объясни, что информация пока не подтверждена.

==============================
ИСТОЧНИКИ
==============================

Обычно НЕ показывай пользователю длинный список URL.

Сформулируй нормальный ответ самостоятельно.

Если пользователь прямо просит:
"дай источники",
"скинь ссылки",
"откуда информация",

тогда можешь использовать URL,
которые присутствуют в WEB DATA.

==============================
ВАЛЮТА
==============================

Если русскоязычный или украиноязычный пользователь
просто спрашивает "курс доллара"
и не указывает вторую валюту,
подразумевай:

USD -> UAH

то есть доллар США к украинской гривне.
`;

  if (webContext) {
    systemPrompt += `

==================================================
WEB DATA
==================================================

${webContext}

==================================================

WEB DATA получена сервером прямо перед ответом.

Используй только релевантные результаты.

Не копируй поисковую выдачу как есть.

Сделай из неё понятный человеческий ответ.

Если результаты поиска явно относятся
к другой теме — не используй их как доказательство.

Если точного ответа в результатах нет,
честно скажи, что надёжного подтверждения
найти не удалось.
`;
  }

  const history =
    getHistory(userId);

  const messages = [
    {
      role: "system",
      content: systemPrompt,
    },

    ...history,

    {
      role: "user",
      content: text,
    },
  ];

  console.log(
    `🧠 History: ${history.length}`
  );

  let answer =
    await requestOpenRouter(messages);

  answer =
    cleanAIResponse(answer);

  if (!answer) {
    if (language === "uk") {
      return "⚠️ Не вдалося отримати нормальну відповідь. Спробуй ще раз.";
    }

    if (language === "en") {
      return "⚠️ I couldn't get a proper response. Please try again.";
    }

    return "⚠️ Не удалось получить нормальный ответ. Попробуй ещё раз.";
  }

  return answer;
}

// ======================================================
// POST — TELEGRAM WEBHOOK
// ======================================================

export async function POST(request) {
  try {
    console.log(
      "🚀 AI-GUIDE-V4"
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
    // PRIVATE BOT
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
    // TEXT
    // ==================================================

    const text =
      message.text?.trim();

    if (!text) {
      await sendMessage(
        chatId,
        "Пока V4 работает с текстовыми сообщениями."
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
      text.toLowerCase() === "/clear" ||
      text.toLowerCase() === "/reset"
    ) {
      memory.delete(
        String(userId)
      );

      await sendMessage(
        chatId,
        "🧹 История разговора очищена."
      );

      return Response.json({
        ok: true,
      });
    }

    const language =
      detectLanguage(text);

    // ==================================================
    // WEB SEARCH
    // ==================================================

    let webContext = null;

    if (needsInternet(text)) {
      console.log(
        "🌐 Нужен интернет"
      );

      const searchQuery =
        buildSearchQuery(
          text,
          userId,
          language
        );

      console.log(
        "🔎 Search query:",
        searchQuery.slice(0, 1200)
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
    // AI
    // ==================================================

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

    addHistory(
      userId,
      "user",
      text
    );

    addHistory(
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

    // Telegram лучше вернуть 200,
    // иначе он может повторять update.
    return Response.json({
      ok: true,
    });
  }
}

// ======================================================
// GET — VERSION CHECK
// ======================================================

export async function GET() {
  return Response.json({
    version:
      "AI-GUIDE-V4",

    status:
      "Bot is running",

    telegram:
      !!TELEGRAM_BOT_TOKEN,

    openrouter:
      !!OPENROUTER_API_KEY,

    tavily:
      !!TAVILY_API_KEY,

    privateMode:
      !!ALLOWED_USER_ID,

    memory:
      "temporary",

    search:
      "Tavily",

    model:
      AI_MODEL,
  });
}
