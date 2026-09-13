export const runtime = "nodejs";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

// Если добавлял приватный ID в Vercel
const ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID
  ? Number(process.env.TELEGRAM_ALLOWED_USER_ID)
  : null;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// ==============================
// TELEGRAM
// ==============================

async function sendMessage(chatId, text) {
  if (!text) text = "Не удалось получить ответ.";

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

// ==============================
// НУЖЕН ЛИ ИНТЕРНЕТ
// ==============================

function needsInternet(text) {
  const t = text.toLowerCase();

  const currentWords = [
    "сейчас",
    "сегодня",
    "вчера",
    "завтра",
    "последние",
    "последний",
    "последняя",
    "новости",
    "нового",
    "что нового",
    "актуаль",
    "погода",
    "температура",
    "курс",
    "доллар",
    "евро",
    "цена",
    "стоит сейчас",
    "вышло",
    "вышел",
    "обновление",
    "обнова",
    "когда выйдет",
    "когда будет",
    "новий",
    "сьогодні",
    "зараз",
    "погода",
    "новини",
    "курс",
    "актуальн",
    "latest",
    "today",
    "current",
    "news",
    "weather",
    "price",
    "update",
    "release",
  ];

  return currentWords.some((word) => t.includes(word));
}

// ==============================
// TAVILY SEARCH
// ==============================

async function searchWeb(query) {
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        search_depth: "basic",
        max_results: 5,
        include_answer: true,
      }),
    });

    if (!response.ok) {
      console.error("Tavily error:", await response.text());
      return null;
    }

    const data = await response.json();

    let result = "";

    if (data.answer) {
      result += `Краткий ответ поиска:\n${data.answer}\n\n`;
    }

    if (Array.isArray(data.results)) {
      result += data.results
        .map((item, index) => {
          return `${index + 1}. ${item.title || ""}
${item.content || ""}
Источник: ${item.url || ""}`;
        })
        .join("\n\n");
    }

    return result || null;
  } catch (error) {
    console.error("Search error:", error);
    return null;
  }
}

// ==============================
// GEMINI
// ==============================

async function askGemini(userText, webContext = null) {
  const currentDate = new Date().toLocaleString("ru-RU", {
    timeZone: "Europe/Kyiv",
  });

  let prompt = `
Ты универсальный AI-ассистент в Telegram.

Текущая дата и время: ${currentDate}.

Правила:
- Отвечай на языке пользователя.
- Если пользователь пишет по-русски — отвечай по-русски.
- Если по-украински — по-украински.
- Пиши понятно и естественно.
- Не придумывай свежие факты.
`;

  if (webContext) {
    prompt += `

Пользователь задал вопрос, для которого был выполнен поиск в интернете.

Вот свежая информация из интернета:

====================
${webContext}
====================

Используй найденную информацию для ответа.
Не утверждай то, чего нет в результатах поиска.
Если источники противоречат друг другу — скажи об этом.
`;
  }

  prompt += `

Сообщение пользователя:
${userText}
`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: prompt,
              },
            ],
          },
        ],

        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2000,
        },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    console.error("Gemini error:", error);

    throw new Error("Gemini API error");
  }

  const data = await response.json();

  return (
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("") || "Не удалось получить ответ от AI."
  );
}

// ==============================
// WEBHOOK
// ==============================

export async function POST(request) {
  try {
    const update = await request.json();

    const message = update.message;

    if (!message) {
      return Response.json({ ok: true });
    }

    const chatId = message.chat.id;
    const userId = message.from?.id;

    // ==============================
    // ПРИВАТНЫЙ БОТ
    // ==============================

    if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
      await sendMessage(chatId, "⛔ Это приватный бот.");
      return Response.json({ ok: true });
    }

    // ==============================
    // ПОКА ТОЛЬКО ТЕКСТ
    // ==============================

    const text = message.text;

    if (!text) {
      await sendMessage(
        chatId,
        "Пока эта версия работает с текстовыми сообщениями."
      );

      return Response.json({ ok: true });
    }

    // ==============================
    // РЕШАЕМ, НУЖЕН ЛИ ИНТЕРНЕТ
    // ==============================

    let webContext = null;

    if (needsInternet(text)) {
      console.log("🌐 Используем Tavily:", text);

      webContext = await searchWeb(text);

      if (!webContext) {
        console.log("⚠️ Tavily недоступен");
      }
    } else {
      console.log("🧠 Обычный Gemini:", text);
    }

    // ==============================
    // ОТВЕТ
    // ==============================

    const answer = await askGemini(text, webContext);

    await sendMessage(chatId, answer);

    return Response.json({ ok: true });
  } catch (error) {
    console.error("BOT ERROR:", error);

    return Response.json({
      ok: true,
    });
  }
}

// Для проверки адреса в браузере
export async function GET() {
  return Response.json({
    status: "Bot is running",
    gemini: true,
    tavily: !!TAVILY_API_KEY,
  });
}
