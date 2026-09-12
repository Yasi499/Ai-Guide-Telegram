const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const TELEGRAM_API = BOT_TOKEN
  ? `https://api.telegram.org/bot${BOT_TOKEN}`
  : null;


// =====================================================
// ПРОСТАЯ ПАМЯТЬ ВНУТРИ ТЕКУЩЕГО VERCEL INSTANCE
// =====================================================

const conversations = new Map();

const MAX_HISTORY_MESSAGES = 12;


// =====================================================
// TELEGRAM API
// =====================================================

async function tg(method, payload) {
  if (!TELEGRAM_API) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }

  const response = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();

    console.error(
      "Telegram API error:",
      response.status,
      errorText
    );

    throw new Error("Telegram API error");
  }

  return response.json();
}


// =====================================================
// ОТПРАВКА СООБЩЕНИЯ
// =====================================================

async function sendMessage(chatId, text) {
  if (!text) {
    text = "Не вдалося отримати відповідь від Gemini.";
  }

  for (let i = 0; i < text.length; i += 4000) {
    const part = text.slice(i, i + 4000);

    await tg("sendMessage", {
      chat_id: chatId,
      text: part
    });
  }
}


// =====================================================
// ПАУЗА
// =====================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// =====================================================
// ПАМЯТЬ
// =====================================================

function getHistory(chatId) {
  if (!conversations.has(chatId)) {
    conversations.set(chatId, []);
  }

  return conversations.get(chatId);
}


function addToHistory(chatId, role, text) {
  const history = getHistory(chatId);

  history.push({
    role,
    parts: [
      {
        text
      }
    ]
  });

  while (history.length > MAX_HISTORY_MESSAGES) {
    history.shift();
  }
}


function clearHistory(chatId) {
  conversations.delete(chatId);
}


// =====================================================
// GEMINI
// =====================================================

async function askGemini(chatId, userText) {
  if (!GEMINI_API_KEY) {
    return "⚠️ GEMINI_API_KEY не налаштований у Vercel.";
  }

  const history = getHistory(chatId);

  const contents = [
    ...history,
    {
      role: "user",
      parts: [
        {
          text: userText
        }
      ]
    }
  ];

  const requestBody = {
    systemInstruction: {
      parts: [
        {
          text:
            "You are a helpful AI assistant inside Telegram. " +
            "Always answer in the same language as the user's latest message. " +
            "If the user writes in Russian, answer in Russian. " +
            "If the user writes in Ukrainian, answer in Ukrainian. " +
            "If the user writes in English, answer in English. " +
            "If the user changes language, switch language too. " +
            "Use the conversation history to understand follow-up requests. " +
            "If the user says 'make it shorter', 'rewrite it', 'make it prettier', " +
            "'simpler', 'more detailed', 'funnier' or similar, apply that request " +
            "to the previous relevant answer. " +
            "Write naturally, clearly and not unnecessarily long."
        }
      ]
    },

    contents,

    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2048
    }
  };


  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": GEMINI_API_KEY
          },

          body: JSON.stringify(requestBody)
        }
      );

      const data = await response.json();


      // =================================================
      // УСПЕШНЫЙ ОТВЕТ
      // =================================================

      if (response.ok) {
        const parts =
          data.candidates?.[0]?.content?.parts;

        if (!parts || parts.length === 0) {
          console.error(
            "Gemini returned no content:",
            JSON.stringify(data)
          );

          return "⚠️ Gemini не повернув відповідь.";
        }

        const answer = parts
          .map(part => part.text || "")
          .join("")
          .trim();

        if (!answer) {
          return "⚠️ Gemini повернув порожню відповідь.";
        }


        // Сохраняем в память
        addToHistory(chatId, "user", userText);
        addToHistory(chatId, "model", answer);

        return answer;
      }


      // =================================================
      // ЕСЛИ 503 — ПЕРЕГРУЗКА GEMINI
      // =================================================

      if (response.status === 503) {
        console.error(
          `Gemini 503, attempt ${attempt}:`,
          JSON.stringify(data)
        );

        if (attempt < 3) {
          await sleep(attempt * 1200);
          continue;
        }

        return (
          "⚠️ Gemini зараз перевантажений.\n\n" +
          "Спробуй ще раз через кілька секунд."
        );
      }


      // =================================================
      // 429 — ЛИМИТ
      // =================================================

      if (response.status === 429) {
        console.error(
          "Gemini rate limit:",
          JSON.stringify(data)
        );

        return (
          "⚠️ Досягнуто ліміт Gemini API.\n\n" +
          "Спробуй трохи пізніше."
        );
      }


      // =================================================
      // ПРОЧИЕ ОШИБКИ
      // =================================================

      console.error(
        "Gemini API error:",
        response.status,
        JSON.stringify(data)
      );

      return (
        `⚠️ Gemini зараз не зміг відповісти.\n\n` +
        `Код помилки: ${response.status}`
      );

    } catch (error) {
      console.error(
        `Gemini request error, attempt ${attempt}:`,
        error
      );

      if (attempt < 3) {
        await sleep(attempt * 1200);
        continue;
      }

      return (
        "⚠️ Сталася помилка при зверненні до Gemini."
      );
    }
  }


  return "⚠️ Gemini зараз недоступний.";
}


// =====================================================
// ОБРАБОТКА TELEGRAM СООБЩЕНИЙ
// =====================================================

async function handleMessage(message) {
  const chatId = message.chat.id;

  const text =
    (message.text || "").trim();

  if (!text) {
    return;
  }


  // ===================================================
  // START
  // ===================================================

  if (text === "/start") {
    clearHistory(chatId);

    return sendMessage(
      chatId,
      `Привіт! 👋

Я AI-помічник на Gemini.

Просто напиши мені будь-яке повідомлення.

Я також пам'ятаю контекст недавньої розмови.`
    );
  }


  // ===================================================
  // HELP
  // ===================================================

  if (text === "/help") {
    return sendMessage(
      chatId,
      `🤖 Просто напиши своє питання.

Наприклад:

Напиши опис для відео

Потім можеш написати:

Зроби коротше

або:

Зроби красивіше`
    );
  }


  // ===================================================
  // ОЧИСТКА ПАМЯТИ
  // ===================================================

  if (
    text === "/clear" ||
    text === "/reset"
  ) {
    clearHistory(chatId);

    return sendMessage(
      chatId,
      "🧹 Історію діалогу очищено."
    );
  }


  // ===================================================
  // ПЕЧАТАЕТ...
  // ===================================================

  await tg("sendChatAction", {
    chat_id: chatId,
    action: "typing"
  });


  // ===================================================
  // GEMINI
  // ===================================================

  const answer =
    await askGemini(
      chatId,
      text
    );


  // ===================================================
  // ОТВЕТ
  // ===================================================

  return sendMessage(
    chatId,
    answer
  );
}


// =====================================================
// GET — ПРОВЕРКА ENDPOINT
// =====================================================

export async function GET(request) {
  const url =
    new URL(request.url);

  const token =
    url.searchParams.get("token");


  if (!BOT_TOKEN) {
    return Response.json(
      {
        ok: false,
        error:
          "TELEGRAM_BOT_TOKEN is not set"
      },
      {
        status: 500
      }
    );
  }


  if (token !== BOT_TOKEN) {
    return Response.json(
      {
        ok: false,
        error:
          "Invalid token"
      },
      {
        status: 401
      }
    );
  }


  return Response.json({
    ok: true,
    message:
      "Gemini Telegram webhook is ready"
  });
}


// =====================================================
// POST — TELEGRAM WEBHOOK
// =====================================================

export async function POST(request) {
  const url =
    new URL(request.url);

  const token =
    url.searchParams.get("token");


  if (!BOT_TOKEN) {
    return Response.json(
      {
        ok: false,
        error:
          "TELEGRAM_BOT_TOKEN is not set"
      },
      {
        status: 500
      }
    );
  }


  if (token !== BOT_TOKEN) {
    return Response.json(
      {
        ok: false,
        error:
          "Invalid token"
      },
      {
        status: 401
      }
    );
  }


  try {
    const update =
      await request.json();


    if (update.message) {
      await handleMessage(
        update.message
      );
    }


    return Response.json({
      ok: true
    });

  } catch (error) {
    console.error(
      "Webhook error:",
      error
    );


    return Response.json(
      {
        ok: false,
        error:
          "Webhook handler failed"
      },
      {
        status: 500
      }
    );
  }
}
