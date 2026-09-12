const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const TELEGRAM_API = BOT_TOKEN
  ? `https://api.telegram.org/bot${BOT_TOKEN}`
  : null;


// =====================================================
// ПРОСТАЯ ПАМЯТЬ
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
// ОТПРАВКА СООБЩЕНИЙ
// =====================================================

async function sendMessage(chatId, text) {
  if (!text) {
    text = "Не удалось получить ответ.";
  }

  for (let i = 0; i < text.length; i += 4000) {
    const part = text.slice(i, i + 4000);

    await tg("sendMessage", {
      chat_id: chatId,
      text: part,
      disable_web_page_preview: true
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
    return "⚠️ GEMINI_API_KEY не настроен в Vercel.";
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
            "If the user changes language, switch to that language. " +

            "Use conversation history to understand follow-up requests. " +

            "If the user asks to make the previous response shorter, prettier, " +
            "simpler, more detailed, funnier, more formal or rewritten, " +
            "apply that request to the previous relevant answer. " +

            "Use Google Search when current or recent information may be useful, " +
            "including weather, current time, news, prices, sports results, " +
            "recent events, software versions, public figures, companies, " +
            "games, products and other changing information. " +

            "Do not invent current facts. " +
            "If search results are available, base the answer on them. " +

            "Write naturally, clearly and not unnecessarily long."
        }
      ]
    },

    contents,

    // =================================================
    // GOOGLE SEARCH
    // =================================================

    tools: [
      {
        googleSearch: {}
      }
    ],

    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2048
    }
  };


  // ===================================================
  // ДО 3 ПОПЫТОК
  // ===================================================

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
      // УСПЕХ
      // =================================================

      if (response.ok) {

        const parts =
          data.candidates?.[0]?.content?.parts;


        if (!parts || parts.length === 0) {

          console.error(
            "Gemini returned no content:",
            JSON.stringify(data)
          );

          return "⚠️ Gemini не вернул ответ.";
        }


        const answer = parts
          .map(part => part.text || "")
          .join("")
          .trim();


        if (!answer) {
          return "⚠️ Gemini вернул пустой ответ.";
        }


        // Сохраняем историю
        addToHistory(
          chatId,
          "user",
          userText
        );

        addToHistory(
          chatId,
          "model",
          answer
        );


        return answer;
      }


      // =================================================
      // 503 — ПЕРЕГРУЗКА
      // =================================================

      if (response.status === 503) {

        console.error(
          `Gemini 503 attempt ${attempt}:`,
          JSON.stringify(data)
        );


        if (attempt < 3) {

          await sleep(
            attempt * 1200
          );

          continue;
        }


        return (
          "⚠️ Gemini сейчас перегружен.\n\n" +
          "Попробуй ещё раз через несколько секунд."
        );
      }


      // =================================================
      // 429 — ЛИМИТ / SEARCH QUOTA
      // =================================================

      if (response.status === 429) {

        console.error(
          "Gemini 429:",
          JSON.stringify(data)
        );


        return (
          "⚠️ Сейчас достигнут лимит Gemini API или Google Search.\n\n" +
          "Попробуй позже."
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
        "⚠️ Gemini сейчас не смог ответить.\n\n" +
        `Код ошибки: ${response.status}`
      );


    } catch (error) {

      console.error(
        `Gemini request error attempt ${attempt}:`,
        error
      );


      if (attempt < 3) {

        await sleep(
          attempt * 1200
        );

        continue;
      }


      return (
        "⚠️ Произошла ошибка при обращении к Gemini."
      );
    }
  }


  return "⚠️ Gemini сейчас недоступен.";
}


// =====================================================
// ОБРАБОТКА СООБЩЕНИЙ
// =====================================================

async function handleMessage(message) {

  const chatId =
    message.chat.id;

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
      `Привет! 👋

Я AI-помощник на Gemini.

Просто напиши мне любое сообщение.

Я могу помнить контекст недавней переписки и использовать Google Search для актуальной информации.`
    );
  }


  // ===================================================
  // HELP
  // ===================================================

  if (text === "/help") {

    return sendMessage(
      chatId,
      `🤖 Просто напиши вопрос.

Например:

Какая сейчас погода в Токио?

Какие сегодня новости Fortnite?

Кто выиграл последний матч Барселоны?

Напиши описание для видео

А потом:

Сделай покороче`
    );
  }


  // ===================================================
  // CLEAR
  // ===================================================

  if (
    text === "/clear" ||
    text === "/reset"
  ) {

    clearHistory(chatId);

    return sendMessage(
      chatId,
      "🧹 История диалога очищена."
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
// GET
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
// POST
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
