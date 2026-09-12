const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const TELEGRAM_API = BOT_TOKEN
  ? `https://api.telegram.org/bot${BOT_TOKEN}`
  : null;


// ==========================================
// TELEGRAM API
// ==========================================

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


// ==========================================
// ОТПРАВКА СООБЩЕНИЯ
// ==========================================

async function sendMessage(chatId, text) {
  if (!text) {
    text = "Не вдалося отримати відповідь від Gemini.";
  }

  // Telegram не позволяет отправлять слишком
  // большие сообщения одним сообщением.
  for (let i = 0; i < text.length; i += 4000) {
    const part = text.slice(i, i + 4000);

    await tg("sendMessage", {
      chat_id: chatId,
      text: part
    });
  }
}


// ==========================================
// GEMINI
// ==========================================

async function askGemini(userText) {
  if (!GEMINI_API_KEY) {
    return "⚠️ GEMINI_API_KEY не налаштований у Vercel.";
  }

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY
        },

        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text:
                  "You are a helpful AI assistant inside Telegram. " +

                  "Always answer in the same language as the user's latest message. " +

                  "If the user writes in Russian, answer in Russian. " +
                  "If the user writes in Ukrainian, answer in Ukrainian. " +
                  "If the user writes in English, answer in English. " +
                  "If the user changes language, change your response language too. " +

                  "Write naturally and clearly. " +

                  "Do not make answers unnecessarily long. " +

                  "If the user asks to make something shorter, prettier, simpler, " +
                  "more detailed, funnier, more formal or rewrite it, follow their request."
              }
            ]
          },

          contents: [
            {
              role: "user",
              parts: [
                {
                  text: userText
                }
              ]
            }
          ],

          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 2048
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error(
        "Gemini API error:",
        response.status,
        JSON.stringify(data)
      );

      return (
        "⚠️ Gemini зараз не зміг відповісти.\n\n" +
        "Перевір GEMINI_API_KEY або Vercel Logs."
      );
    }

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

    return answer;

  } catch (error) {
    console.error(
      "Gemini request error:",
      error
    );

    return (
      "⚠️ Сталася помилка при зверненні до Gemini."
    );
  }
}


// ==========================================
// ОБРАБОТКА TELEGRAM СООБЩЕНИЯ
// ==========================================

async function handleMessage(message) {
  const chatId = message.chat.id;

  const text =
    (message.text || "").trim();

  if (!text) {
    return;
  }


  // /start
  if (text === "/start") {
    return sendMessage(
      chatId,
      `Привіт! 👋

Я AI-помічник на Gemini.

Просто напиши мені будь-яке повідомлення.`
    );
  }


  // /help
  if (text === "/help") {
    return sendMessage(
      chatId,
      `🤖 Просто напиши своє питання.

Я можу відповідати українською, російською, англійською та іншими мовами.`
    );
  }


  // Показываем "печатает..."
  await tg("sendChatAction", {
    chat_id: chatId,
    action: "typing"
  });


  // Отправляем сообщение Gemini
  const answer =
    await askGemini(text);


  // Отправляем ответ пользователю
  return sendMessage(
    chatId,
    answer
  );
}


// ==========================================
// GET — ПРОВЕРКА WEBHOOK
// ==========================================

export async function GET(request) {
  const url =
    new URL(request.url);

  const token =
    url.searchParams.get("token");


  // Проверяем переменную Vercel
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


  // Проверяем token в URL
  if (token !== BOT_TOKEN) {
    return Response.json(
      {
        ok: false,
        error: "Invalid token"
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


// ==========================================
// POST — TELEGRAM WEBHOOK
// ==========================================

export async function POST(request) {
  const url =
    new URL(request.url);

  const token =
    url.searchParams.get("token");


  // Проверяем Telegram token
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


  // Защита webhook
  if (token !== BOT_TOKEN) {
    return Response.json(
      {
        ok: false,
        error: "Invalid token"
      },
      {
        status: 401
      }
    );
  }


  try {
    const update =
      await request.json();


    // Получили обычное сообщение
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
