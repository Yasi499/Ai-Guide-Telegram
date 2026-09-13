export const runtime = "nodejs";

// ======================================================
// ENV
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

// ======================================================
// ВРЕМЕННАЯ ПАМЯТЬ
// ======================================================

// Важно:
// На Vercel эта память может иногда очищаться.
// Позже подключим постоянную базу.

if (!globalThis.__telegramAIHistory) {
  globalThis.__telegramAIHistory = new Map();
}

const memory = globalThis.__telegramAIHistory;

function getHistory(userId) {
  return memory.get(String(userId)) || [];
}

function saveHistory(userId, history) {
  // Храним последние 12 сообщений
  const trimmed = history.slice(-12);

  memory.set(
    String(userId),
    trimmed
  );
}

function addToHistory(userId, role, content) {
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
// ЯЗЫК
// ======================================================

function detectLanguage(text) {
  const t = text.toLowerCase();

  // Явные украинские буквы/слова
  if (
    /[іїєґ]/i.test(text) ||
    /\b(що|як|цей|ця|це|зараз|сьогодні|будь|будь ласка|скороти|поясни)\b/i.test(t)
  ) {
    return "uk";
  }

  // Кириллица
  if (/[а-яё]/i.test(text)) {
    return "ru";
  }

  return "en";
}

function languageName(language) {
  if (language === "uk") {
    return "украинском языке";
  }

  if (language === "ru") {
    return "русском языке";
  }

  return "английском языке";
}

// ======================================================
// НУЖЕН ЛИ ИНТЕРНЕТ
// ======================================================

function needsInternet(text) {
  const t = text.toLowerCase();

  const words = [
    // время / актуальность
    "сейчас",
    "сегодня",
    "вчера",
    "завтра",
    "на данный момент",
    "актуаль",

    // новости
    "новости",
    "что нового",
    "последние новости",
    "последние события",

    // погода
    "погода",
    "погоде",
    "температура",
    "дождь",
    "снег",
    "ветер",

    // деньги
    "курс",
    "доллар",
    "долара",
    "евро",
    "гривн",
    "usd",
    "eur",
    "uah",

    // цены
    "цена",
    "сколько стоит",

    // игры / обновления
    "обновление",
    "обнова",
    "вышло",
    "вышел",
    "вышла",
    "когда выйдет",
    "когда будет",

    // украинский
    "зараз",
    "сьогодні",
    "вчора",
    "новини",
    "що нового",
    "погода",
    "погоді",
    "курс",
    "ціна",
    "скільки коштує",
    "оновлення",
    "коли вийде",

    // english
    "today",
    "right now",
    "current",
    "currently",
    "latest",
    "news",
    "weather",
    "price",
    "exchange rate",
    "update",
    "release",
  ];

  return words.some(
    (word) => t.includes(word)
  );
}

// ======================================================
// УЛУЧШАЕМ ПОИСКОВЫЙ ЗАПРОС
// ======================================================

function prepareSearchQuery(text, language) {
  const t = text.toLowerCase();

  // Если человек просто написал "курс доллара",
  // для нашего бота считаем USD -> UAH.

  const dollarRequest =
    t.includes("курс доллара") ||
    t.includes("курс долара") ||
    t === "доллар" ||
    t === "долар";

  const mentionsOtherCurrency =
    t.includes("руб") ||
    t.includes("ruble") ||
    t.includes("eur") ||
    t.includes("евро") ||
    t.includes("euro") ||
    t.includes("тенге") ||
    t.includes("злот");

  if (
    dollarRequest &&
    !mentionsOtherCurrency
  ) {
    return language === "uk"
      ? "актуальний курс долара США до української гривні USD UAH сьогодні Україна"
      : "актуальный курс доллара США к украинской гривне USD UAH сегодня Украина";
  }

  return text;
}

// ======================================================
// TAVILY
// ======================================================

async function searchWeb(query) {
  try {
    if (!TAVILY_API_KEY) {
      console.error(
        "❌ TAVILY_API_KEY отсутствует"
      );

      return null;
    }

    console.log(
      "🌐 Tavily:",
      query
    );

    const response = await fetch(
      "https://api.tavily.com/search",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TAVILY_API_KEY}`,
        },

        body: JSON.stringify({
          query,
          search_depth: "basic",
          max_results: 5,
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
// ПРЕВРАЩАЕМ TAVILY В КОНТЕКСТ
// ======================================================

function makeWebContext(data) {
  if (!data) {
    return null;
  }

  let result = "";

  if (data.answer) {
    result += `
КРАТКИЙ РЕЗУЛЬТАТ ПОИСКА:
${data.answer}

`;
  }

  if (
    Array.isArray(data.results) &&
    data.results.length
  ) {
    result += data.results
      .slice(0, 5)
      .map((item, index) => {
        return `
ИСТОЧНИК ${index + 1}

Название:
${item.title || "Нет названия"}

Информация:
${item.content || "Нет информации"}

URL:
${item.url || ""}
`;
      })
      .join("\n");
  }

  return result.trim() || null;
}

// ======================================================
// OPENROUTER
// ======================================================

async function askAI({
  userText,
  userId,
  webContext = null,
  language,
}) {
  if (!OPENROUTER_API_KEY) {
    return "⚠️ OPENROUTER_API_KEY не настроен.";
  }

  const currentDate =
    new Date().toLocaleString(
      "ru-RU",
      {
        timeZone: "Europe/Kyiv",
      }
    );

  let systemPrompt = `
Ты персональный AI-ассистент в Telegram.

Сейчас:
${currentDate}

ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:

1. Ответь на ${languageName(language)}.

2. Если пользователь меняет язык,
переключайся вместе с ним.

3. Пиши естественно, аккуратно и понятно.

4. Не используй слишком много заголовков.

5. Для короткого вопроса давай короткий ответ.

6. Можно использовать подходящие эмодзи,
но умеренно.

7. Учитывай историю переписки.

Например:

Пользователь:
"объясни чёрную дыру"

Ассистент:
даёт объяснение

Пользователь:
"сократи"

Ты должен сократить СВОЙ ПРЕДЫДУЩИЙ ответ,
а не просить пользователя прислать текст заново.

То же самое относится к:
"подробнее",
"проще",
"а почему?",
"переделай",
"переведи это",
"твой прошлый текст"
и другим продолжениям разговора.

8. Не придумывай свежие данные.

9. Если предоставлены результаты поиска,
считай их свежим веб-контекстом.

10. Не говори, что у тебя нет доступа
к интернету, если веб-контекст предоставлен.

11. НЕ показывай пользователю технические
результаты поиска.

12. НЕ добавляй длинные URL в ответ,
если пользователь сам не попросил источники.

13. Не упоминай Tavily или OpenRouter,
если пользователь об этом не спрашивает.

14. Для валют:
если пользователь на русском или украинском
просто спрашивает "курс доллара"
без указания второй валюты,
подразумевай доллар США к украинской гривне:
USD -> UAH.

15. Для погоды красиво укажи основные данные,
если они присутствуют:
температуру, ощущаемую температуру,
условия, ветер и влажность.

16. Никогда не превращай русский вопрос
в английский ответ только потому,
что источник поиска написан на английском.
`;

  if (webContext) {
    systemPrompt += `

==================================================
СВЕЖАЯ ИНФОРМАЦИЯ ИЗ ИНТЕРНЕТА
==================================================

${webContext}

==================================================

Используй эти сведения для актуальной части ответа.

Сформулируй результат самостоятельно
на языке пользователя.

Не копируй сырой ответ поисковой системы.

Не вставляй список URL,
если пользователь не просил источники.
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
      content: userText,
    },
  ];

  console.log(
    "🤖 OpenRouter | history:",
    history.length
  );

  const response = await fetch(
    OPENROUTER_API,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        Authorization:
          `Bearer ${OPENROUTER_API_KEY}`,
        "X-Title":
          "Private Telegram AI Bot",
      },

      body: JSON.stringify({
        model: "openrouter/free",

        messages,

        temperature: 0.6,
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

    return `⚠️ Ошибка AI (${response.status}). Попробуй ещё раз.`;
  }

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    return "⚠️ Не удалось обработать ответ AI.";
  }

  const answer =
    data?.choices?.[0]?.message?.content;

  if (!answer) {
    return "⚠️ AI не вернул ответ. Попробуй ещё раз.";
  }

  return answer.trim();
}

// ======================================================
// TELEGRAM POST
// ======================================================

export async function POST(request) {
  try {
    console.log(
      "🚀 VERSION: AI-GUIDE-V3-MEMORY"
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
    // ПРИВАТКА
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
        "Пока эта версия работает с текстовыми сообщениями."
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
    // /CLEAR
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

    // ==================================================
    // LANGUAGE
    // ==================================================

    const language =
      detectLanguage(text);

    // ==================================================
    // INTERNET
    // ==================================================

    let webContext = null;

    if (needsInternet(text)) {
      console.log(
        "🌐 Нужен свежий интернет"
      );

      const searchQuery =
        prepareSearchQuery(
          text,
          language
        );

      console.log(
        "🔎 Search query:",
        searchQuery
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
          "✅ Web context получен"
        );
      } else {
        console.log(
          "⚠️ Web context отсутствует"
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
        userText: text,
        userId,
        webContext,
        language,
      });

    // ==================================================
    // MEMORY
    // ==================================================

    addToHistory(
      userId,
      "user",
      text
    );

    addToHistory(
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
      "AI-GUIDE-V3-MEMORY",

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
  });
}
