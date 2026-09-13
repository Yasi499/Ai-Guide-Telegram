export const runtime = "nodejs";

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

    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: part,
      }),
    });
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
    "результат матча",
    "кто победил",

    // Украинский
    "зараз",
    "сьогодні",
    "вчора",
    "завтра",
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
// TAVILY — ЖИВОЙ ИНТЕРНЕТ
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
          query: query,
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
      raw.slice(0, 3000)
    );

    if (!response.ok) {
      console.error("❌ Tavily API error:", raw);
      return null;
    }

    let data;

    try {
      data = JSON.parse(raw);
    } catch (error) {
      console.error(
        "❌ Tavily JSON parse error:",
        error
      );
      return null;
    }

    let result = "";

    if (data.answer) {
      result += `
Краткий ответ поиска:
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

Ссылка:
${item.url || "Нет ссылки"}
`;
        })
        .join("\n");
    }

    if (!result.trim()) {
      console.log(
        "⚠️ Tavily не вернул результатов"
      );

      return null;
    }

    return result;
  } catch (error) {
    console.error(
      "❌ Tavily search error:",
      error
    );

    return null;
  }
}

// ======================================================
// OPENROUTER FREE
// ======================================================

async function askAI(userText, webContext = null) {
  if (!OPENROUTER_API_KEY) {
    throw new Error(
      "OPENROUTER_API_KEY отсутствует"
    );
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

Правила:

1. Отвечай на языке пользователя.

2. Если пользователь пишет на русском —
отвечай на русском.

3. Если пользователь пишет на украинском —
отвечай на украинском.

4. Если пользователь пишет на английском —
отвечай на английском.

5. Пиши естественно и понятно.

6. Не придумывай свежую информацию.

7. Если тебе переданы результаты поиска из интернета,
используй их для актуальных фактов.

8. Если свежих данных нет,
не выдавай старые данные за актуальные.

9. Не говори, что у тебя нет интернета,
если тебе были переданы результаты поиска.

10. Если поиск не дал точного ответа,
честно скажи об этом.

11. Не перегружай ответ лишним текстом.
`;

  if (webContext) {
    systemPrompt += `

==================================================
СВЕЖИЕ ДАННЫЕ ИЗ ИНТЕРНЕТА
==================================================

${webContext}

==================================================

Используй эти данные при ответе.

Для текущих событий, цен, погоды,
новостей и другой меняющейся информации
ориентируйся прежде всего на эти результаты.

Не придумывай факты, которых нет
в результатах поиска.
`;
  }

  console.log("🤖 OpenRouter request");

  const response = await fetch(
    OPENROUTER_API,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",

        Authorization:
          `Bearer ${OPENROUTER_API_KEY}`,

        "HTTP-Referer":
          "https://gemini-telegram-bot-wheat.vercel.app",

        "X-Title":
          "Private Telegram AI Bot",
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
    raw.slice(0, 3000)
  );

  if (!response.ok) {
    console.error(
      "❌ OpenRouter error:",
      raw
    );

    throw new Error(
      `OpenRouter API error ${response.status}`
    );
  }

  let data;

  try {
    data = JSON.parse(raw);
  } catch (error) {
    console.error(
      "❌ OpenRouter JSON error:",
      error
    );

    throw new Error(
      "OpenRouter JSON parse error"
    );
  }

  const answer =
    data?.choices?.[0]?.message?.content;

  if (!answer) {
    console.error(
      "❌ OpenRouter пустой ответ:",
      raw
    );

    return "Не удалось получить ответ от AI.";
  }

  return answer;
}

// ======================================================
// TELEGRAM WEBHOOK
// ======================================================

export async function POST(request) {
  try {
    const update = await request.json();

    console.log(
      "📩 Telegram update received"
    );

    const message = update.message;

    if (!message) {
      return Response.json({
        ok: true,
      });
    }

    const chatId = message.chat.id;
    const userId = message.from?.id;

    // ==================================================
    // ПРИВАТКА
    // ==================================================

    if (
      ALLOWED_USER_ID &&
      userId !== ALLOWED_USER_ID
    ) {
      console.log(
        "⛔ Заблокирован пользователь:",
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
        "Пока эта версия работает только с текстовыми сообщениями."
      );

      return Response.json({
        ok: true,
      });
    }

    console.log(
      "👤 User:",
      userId
    );

    console.log(
      "💬 Message:",
      text
    );

    // ==================================================
    // НУЖЕН ЛИ ИНТЕРНЕТ
    // ==================================================

    let webContext = null;

    if (needsInternet(text)) {
      console.log(
        "🌐 Нужен интернет"
      );

      webContext =
        await searchWeb(text);

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
        "🧠 Интернет не нужен"
      );
    }

    // ==================================================
    // OPENROUTER
    // ==================================================

    const answer = await askAI(
      text,
      webContext
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
