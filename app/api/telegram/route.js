export const runtime = "nodejs";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

const ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID
  ? Number(process.env.TELEGRAM_ALLOWED_USER_ID)
  : null;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

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
    // русский
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
    "вышло",
    "вышел",
    "обновление",
    "обнова",
    "когда выйдет",
    "когда будет",

    // украинский
    "зараз",
    "сьогодні",
    "вчора",
    "завтра",
    "новини",
    "що нового",
    "останні",
    "погода",
    "температура",
    "курс",
    "ціна",
    "скільки коштує",
    "оновлення",
    "коли вийде",

    // английский
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

    const response = await fetch("https://api.tavily.com/search", {
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
    });

    const raw = await response.text();

    console.log("🌐 Tavily status:", response.status);
    console.log("🌐 Tavily response:", raw.slice(0, 3000));

    if (!response.ok) {
      console.error("❌ Tavily API error:", raw);
      return null;
    }

    let data;

    try {
      data = JSON.parse(raw);
    } catch (error) {
      console.error("❌ Tavily JSON parse error:", error);
      return null;
    }

    let result = "";

    if (data.answer) {
      result += `Краткий ответ поиска:\n${data.answer}\n\n`;
    }

    if (Array.isArray(data.results) && data.results.length > 0) {
      result += data.results
        .map((item, index) => {
          return `
Источник ${index + 1}

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
      console.log("⚠️ Tavily не вернул результатов");
      return null;
    }

    return result;
  } catch (error) {
    console.error("❌ Tavily search error:", error);
    return null;
  }
}

// ======================================================
// GEMINI
// ======================================================

async function askGemini(userText, webContext = null) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY отсутствует");
  }

  const currentDate = new Date().toLocaleString("ru-RU", {
    timeZone: "Europe/Kyiv",
  });

  let prompt = `
Ты универсальный AI-ассистент в Telegram.

Текущая дата и время:
${currentDate}

ПРАВИЛА:

1. Отвечай на языке пользователя.

2. Если пользователь пишет по-русски —
отвечай по-русски.

3. Если пользователь пишет по-украински —
отвечай по-украински.

4. Если пользователь пишет по-английски —
отвечай по-английски.

5. Пиши понятно, естественно и без лишней воды.

6. Не придумывай свежую информацию.

7. Если тебе предоставлены результаты поиска из интернета,
используй именно их для актуальной информации.

8. Не говори, что у тебя нет доступа к интернету,
если результаты поиска были предоставлены.

9. Если результатов поиска недостаточно —
честно скажи, что точную информацию найти не удалось.
`;

  if (webContext) {
    prompt += `

================================================
СВЕЖАЯ ИНФОРМАЦИЯ ИЗ ИНТЕРНЕТА
================================================

${webContext}

================================================

Используй эту информацию при ответе пользователю.

Если возможно, укажи источники или названия сайтов.

Не придумывай данные, которых нет в результатах.
`;
  }

  prompt += `

================================================
СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ
================================================

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
          maxOutputTokens: 2500,
        },
      }),
    }
  );

  const raw = await response.text();

  console.log("🤖 Gemini status:", response.status);

  if (!response.ok) {
    console.error("❌ Gemini error:", raw);
    throw new Error("Gemini API error");
  }

  let data;

  try {
    data = JSON.parse(raw);
  } catch (error) {
    console.error("❌ Gemini JSON error:", error);
    throw new Error("Gemini JSON error");
  }

  const answer =
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("") || null;

  if (!answer) {
    console.error("❌ Gemini пустой ответ:", raw);
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

    console.log("📩 Telegram update received");

    const message = update.message;

    if (!message) {
      return Response.json({
        ok: true,
      });
    }

    const chatId = message.chat.id;
    const userId = message.from?.id;

    // ==================================================
    // ПРИВАТНЫЙ БОТ
    // ==================================================

    if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
      console.log("⛔ Заблокирован пользователь:", userId);

      await sendMessage(chatId, "⛔ Это приватный бот.");

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

    console.log("👤 User:", userId);
    console.log("💬 Message:", text);

    // ==================================================
    // ПРОВЕРЯЕМ, НУЖЕН ЛИ WEB SEARCH
    // ==================================================

    let webContext = null;

    if (needsInternet(text)) {
      console.log("🌐 Нужен интернет");

      webContext = await searchWeb(text);

      if (webContext) {
        console.log("✅ Tavily поиск успешен");
      } else {
        console.log("⚠️ Tavily поиск не удался");
      }
    } else {
      console.log("🧠 Интернет не нужен");
    }

    // ==================================================
    // GEMINI
    // ==================================================

    const answer = await askGemini(text, webContext);

    // ==================================================
    // TELEGRAM RESPONSE
    // ==================================================

    await sendMessage(chatId, answer);

    console.log("✅ Ответ отправлен");

    return Response.json({
      ok: true,
    });
  } catch (error) {
    console.error("🔥 BOT ERROR:", error);

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

    telegram: !!TELEGRAM_BOT_TOKEN,
    gemini: !!GEMINI_API_KEY,
    tavily: !!TAVILY_API_KEY,

    privateMode: !!ALLOWED_USER_ID,
  });
}
