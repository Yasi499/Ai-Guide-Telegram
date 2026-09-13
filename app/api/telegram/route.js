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

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

const OPENROUTER_API =
  "https://openrouter.ai/api/v1/chat/completions";

// ======================================================
// TELEGRAM SEND
// ======================================================

async function sendMessage(chatId, text) {
  if (!text) {
    text = "Не удалось получить ответ.";
  }

  // Telegram ограничивает длину одного сообщения
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
      const error = await response.text();
      console.error("❌ Telegram error:", error);
    }
  }
}

// ======================================================
// ОПРЕДЕЛЯЕМ, НУЖЕН ЛИ ИНТЕРНЕТ
// ======================================================

function needsInternet(text) {
  const t = text.toLowerCase();

  const words = [
    // Русский
    "сейчас",
    "сегодня",
    "вчера",
    "завтра",
    "новости",
    "что нового",
    "последние",
    "последний",
    "последняя",
    "актуаль",
    "погода",
    "температура",
    "курс",
    "доллар",
    "евро",
    "цена",
    "сколько стоит",
    "когда выйдет",
    "когда будет",
    "обновление",
    "обнова",
    "вышло",
    "вышел",
    "результат",
    "кто победил",

    // Украинский
    "зараз",
    "сьогодні",
    "вчора",
    "новини",
    "що нового",
    "останні",
    "актуаль",
    "погода",
    "температура",
    "курс",
    "ціна",
    "скільки коштує",
    "оновлення",
    "коли вийде",
    "хто переміг",

    // English
    "today",
    "current",
    "currently",
    "latest",
    "news",
    "weather",
    "temperature",
    "price",
    "update",
    "release",
    "right now",
    "who won",
  ];

  return words.some((word) => t.includes(word));
}

// ======================================================
// TAVILY SEARCH
// ======================================================

async function searchWeb(query) {
  try {
    if (!TAVILY_API_KEY) {
      console.error("❌ TAVILY_API_KEY отсутствует");
      return null;
    }

    console.log("🌐 Tavily query:", query);

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

    const raw = await response.text();

    console.log("🌐 Tavily status:", response.status);
    console.log(
      "🌐 Tavily response:",
      raw.slice(0, 2000)
    );

    if (!response.ok) {
      console.error("❌ Tavily error:", raw);
      return null;
    }

    let data;

    try {
      data = JSON.parse(raw);
    } catch (error) {
      console.error("❌ Tavily JSON error:", error);
      return null;
    }

    let result = "";

    if (data.answer) {
      result += `
ОТВЕТ ПОИСКА:
${data.answer}

`;
    }

    if (
      Array.isArray(data.results) &&
      data.results.length > 0
    ) {
      result += data.results
        .map((item, index) => {
          return `
ИСТОЧНИК ${index + 1}

Название:
${item.title || "Без названия"}

Информация:
${item.content || "Нет описания"}

URL:
${item.url || "Нет ссылки"}
`;
        })
        .join("\n");
    }

    if (!result.trim()) {
      console.log("⚠️ Tavily: результатов нет");
      return null;
    }

    return result;
  } catch (error) {
    console.error("❌ Tavily exception:", error);
    return null;
  }
}

// ======================================================
// OPENROUTER
// ======================================================

async function askAI(userText, webContext = null) {
  if (!OPENROUTER_API_KEY) {
    return "⚠️ OPENROUTER_API_KEY не настроен.";
  }

  const currentDate = new Date().toLocaleString(
    "ru-RU",
    {
      timeZone: "Europe/Kyiv",
    }
  );

  let systemPrompt = `
Ты универсальный AI-ассистент в Telegram.

Текущая дата и время:
${currentDate}

ПРАВИЛА:

- Отвечай на языке пользователя.
- Русский вопрос -> русский ответ.
- Украинский вопрос -> украинский ответ.
- Английский вопрос -> английский ответ.

- Отвечай естественно и понятно.
- Не пиши слишком много без необходимости.

- Не выдумывай актуальные данные.

- Если ниже предоставлена информация из веб-поиска,
используй её для актуальных данных.

- Если веб-поиск был выполнен,
не говори пользователю, что у тебя нет доступа к интернету.

- Для погоды, новостей, цен, курсов,
обновлений и текущих событий используй результаты поиска.

- Если найденной информации недостаточно,
честно скажи об этом.
`;

  if (webContext) {
    systemPrompt += `

==================================================
РЕЗУЛЬТАТЫ ЖИВОГО ПОИСКА В ИНТЕРНЕТЕ
==================================================

${webContext}

==================================================

Сформируй ответ пользователю на основе этих результатов.

Не придумывай факты, которых нет в результатах.
`;
  }

  console.log("🤖 OpenRouter request");

  const response = await fetch(
    OPENROUTER_API,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "X-Title": "Private Telegram AI Bot",
      },

      body: JSON.stringify({
        model: "openrouter/free",

        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: userText,
          },
        ],

        temperature: 0.7,
        max_tokens: 2000,
      }),
    }
  );

  const raw = await response.text();

  console.log(
    "🤖 OpenRouter status:",
    response.status
  );

  console.log(
    "🤖 OpenRouter response:",
    raw.slice(0, 2000)
  );

  if (!response.ok) {
    console.error(
      "❌ OpenRouter API error:",
      raw
    );

    return `⚠️ Ошибка OpenRouter (${response.status}).`;
  }

  let data;

  try {
    data = JSON.parse(raw);
  } catch (error) {
    console.error(
      "❌ OpenRouter JSON error:",
      error
    );

    return "⚠️ OpenRouter вернул неправильный ответ.";
  }

  const answer =
    data?.choices?.[0]?.message?.content;

  if (!answer) {
    console.error(
      "❌ OpenRouter empty response:",
      raw
    );

    return "⚠️ AI не вернул ответ.";
  }

  return answer;
}

// ======================================================
// TELEGRAM WEBHOOK
// ======================================================

export async function POST(request) {
  try {
    console.log(
      "🚀 VERSION: OPENROUTER-TEST-2026"
    );

    const update = await request.json();

    const message = update.message;

    // Например Telegram service update
    if (!message) {
      return Response.json({
        ok: true,
      });
    }

    const chatId = message.chat?.id;
    const userId = message.from?.id;

    console.log("👤 User:", userId);

    // ==================================================
    // ПРИВАТНЫЙ ДОСТУП
    // ==================================================

    if (
      ALLOWED_USER_ID &&
      userId !== ALLOWED_USER_ID
    ) {
      console.log(
        "⛔ Пользователь заблокирован:",
        userId
      );

      await sendMessage(
        chatId,
        "⛔ Это приватный бот."
      );

      return Response.json({
        ok: true,
      });
    }

    // ==================================================
    // ТЕКСТ
    // ==================================================

    const text = message.text;

    if (!text) {
      await sendMessage(
        chatId,
        "Пока эта версия работает только с текстом."
      );

      return Response.json({
        ok: true,
      });
    }

    console.log("💬 Message:", text);

    // ==================================================
    // WEB SEARCH
    // ==================================================

    let webContext = null;

    if (needsInternet(text)) {
      console.log("🌐 Нужен интернет");

      webContext = await searchWeb(text);

      if (webContext) {
        console.log(
          "✅ Tavily поиск успешен"
        );
      } else {
        console.log(
          "⚠️ Tavily поиск не удался"
        );
      }
    } else {
      console.log(
        "🧠 Интернет для запроса не нужен"
      );
    }

    // ==================================================
    // AI
    // ==================================================

    const answer = await askAI(
      text,
      webContext
    );

    // ==================================================
    // ОТПРАВЛЯЕМ
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
// ПРОВЕРКА В БРАУЗЕРЕ
// ======================================================

export async function GET() {
  return Response.json({
    version: "OPENROUTER-TEST-2026",

    status: "Bot is running",

    telegram:
      !!TELEGRAM_BOT_TOKEN,

    openrouter:
      !!OPENROUTER_API_KEY,

    tavily:
      !!TAVILY_API_KEY,

    privateMode:
      !!ALLOWED_USER_ID,
  });
}
