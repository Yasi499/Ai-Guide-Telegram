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
        "Telegram error:",
        await response.text()
      );
    }
  }
}

// ======================================================
// ТИП ЗАПРОСА
// ======================================================

function isFastWebRequest(text) {
  const t = text.toLowerCase();

  const words = [
    // погода
    "погода",
    "погоде",
    "температура",
    "дождь",
    "снег",
    "weather",

    // валюты
    "курс дол",
    "курс евро",
    "курс грив",
    "доллар",
    "долара",
    "долларов",
    "евро",
    "usd",
    "eur",
    "uah",

    // цены
    "цена сейчас",
    "сколько стоит сейчас",
    "какая цена",
    "ціна",
    "скільки коштує",

    // простые свежие данные
    "который час",
    "сколько сейчас времени",
    "який зараз час",
  ];

  return words.some((word) => t.includes(word));
}

function needsInternet(text) {
  const t = text.toLowerCase();

  const words = [
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
    "долара",
    "евро",

    "цена",
    "сколько стоит",

    "обновление",
    "обнова",

    "вышел",
    "вышло",
    "выйдет",
    "когда выйдет",
    "когда будет",

    "зараз",
    "сьогодні",
    "новини",
    "що нового",
    "погода",
    "курс",
    "ціна",
    "оновлення",

    "today",
    "current",
    "currently",
    "latest",
    "news",
    "weather",
    "price",
    "update",
    "release",
    "right now",
  ];

  return words.some((word) => t.includes(word));
}

// ======================================================
// TAVILY
// ======================================================

async function searchWeb(query) {
  try {
    if (!TAVILY_API_KEY) {
      console.error("TAVILY_API_KEY отсутствует");
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

    console.log(
      "🌐 Tavily status:",
      response.status
    );

    if (!response.ok) {
      console.error(
        "❌ Tavily error:",
        raw
      );

      return null;
    }

    const data = JSON.parse(raw);

    return data;
  } catch (error) {
    console.error(
      "❌ Tavily exception:",
      error
    );

    return null;
  }
}

// ======================================================
// БЫСТРЫЙ ОТВЕТ TAVILY
// ======================================================

function makeFastWebAnswer(data) {
  if (!data) {
    return null;
  }

  let answer = "";

  if (data.answer) {
    answer += data.answer.trim();
  }

  // Добавляем 1-2 источника
  if (
    Array.isArray(data.results) &&
    data.results.length > 0
  ) {
    answer += "\n\nИсточники:";

    const sources = data.results.slice(0, 2);

    for (const item of sources) {
      if (item.url) {
        answer += `\n${item.url}`;
      }
    }
  }

  return answer || null;
}

// ======================================================
// КОНТЕКСТ ДЛЯ AI
// ======================================================

function makeWebContext(data) {
  if (!data) {
    return null;
  }

  let result = "";

  if (data.answer) {
    result += `
КРАТКИЙ ОТВЕТ ПОИСКА:
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
${item.content || "Нет информации"}

URL:
${item.url || ""}
`;
      })
      .join("\n");
  }

  return result || null;
}

// ======================================================
// OPENROUTER
// ======================================================

async function askAI(userText, webContext = null) {
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
Ты универсальный AI-ассистент.

Текущая дата и время:
${currentDate}

Правила:

- Отвечай на языке пользователя.
- Пиши понятно и естественно.
- Не пиши слишком длинно без необходимости.
- Не выдумывай свежие факты.
- Если предоставлены результаты поиска,
  используй их как источник актуальной информации.
- Если есть веб-данные, не говори,
  что у тебя нет доступа к интернету.
`;

  if (webContext) {
    systemPrompt += `

==================================================
АКТУАЛЬНЫЕ ДАННЫЕ ИЗ ИНТЕРНЕТА
==================================================

${webContext}

==================================================

Ответь пользователю с учётом этих данных.
Не придумывай факты.
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
        max_tokens: 1500,
      }),
    }
  );

  const raw = await response.text();

  console.log(
    "🤖 OpenRouter status:",
    response.status
  );

  if (!response.ok) {
    console.error(
      "❌ OpenRouter error:",
      raw
    );

    return `⚠️ Ошибка OpenRouter (${response.status}).`;
  }

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    return "⚠️ Ошибка ответа OpenRouter.";
  }

  const answer =
    data?.choices?.[0]?.message?.content;

  if (!answer) {
    return "⚠️ AI не вернул ответ.";
  }

  return answer;
}

// ======================================================
// WEBHOOK
// ======================================================

export async function POST(request) {
  try {
    console.log(
      "🚀 VERSION: OPENROUTER-TAVILY-FAST-V2"
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
    // ПРИВАТНЫЙ ДОСТУП
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
    // ТЕКСТ
    // ==================================================

    const text =
      message.text;

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
      "💬 Сообщение:",
      text
    );

    // ==================================================
    // 1. БЫСТРЫЙ WEB
    // ==================================================

    if (isFastWebRequest(text)) {
      console.log(
        "⚡ Быстрый интернет-запрос"
      );

      const webData =
        await searchWeb(text);

      const fastAnswer =
        makeFastWebAnswer(webData);

      if (fastAnswer) {
        await sendMessage(
          chatId,
          fastAnswer
        );

        console.log(
          "⚡ Ответ отправлен напрямую из Tavily"
        );

        return Response.json({
          ok: true,
        });
      }

      console.log(
        "⚠️ Быстрый поиск не дал ответа, используем AI"
      );
    }

    // ==================================================
    // 2. АКТУАЛЬНЫЙ СЛОЖНЫЙ ЗАПРОС
    // ==================================================

    let webContext = null;

    if (needsInternet(text)) {
      console.log(
        "🌐 Нужен интернет + AI"
      );

      const webData =
        await searchWeb(text);

      webContext =
        makeWebContext(webData);
    } else {
      console.log(
        "🧠 Обычный AI запрос"
      );
    }

    // ==================================================
    // 3. OPENROUTER
    // ==================================================

    const answer =
      await askAI(
        text,
        webContext
      );

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
// GET TEST
// ======================================================

export async function GET() {
  return Response.json({
    version:
      "OPENROUTER-TAVILY-FAST-V2",

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
  });
}
