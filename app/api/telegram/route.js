const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const TELEGRAM_API = BOT_TOKEN
  ? `https://api.telegram.org/bot${BOT_TOKEN}`
  : null;


// =====================================================
// ПАМЯТЬ
// =====================================================

// globalThis помогает сохранить память,
// пока Vercel instance остаётся живым.
const conversations =
  globalThis.__geminiConversations || new Map();

globalThis.__geminiConversations = conversations;

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
// НУЖЕН ЛИ GOOGLE SEARCH?
// =====================================================

function needsWebSearch(text) {
  const t = text.toLowerCase();

  const searchPatterns = [
    // ПОГОДА
    /погода/,
    /температур/,
    /дожд/,
    /снег/,
    /ветер/,
    /прогноз погод/,
    /weather/,
    /temperature/,
    /forecast/,

    // НОВОСТИ / СВЕЖИЕ СОБЫТИЯ
    /новост/,
    /последние событ/,
    /свежие событ/,
    /что произошло сегодня/,
    /что случилось сегодня/,
    /останні новини/,
    /новини/,
    /latest news/,
    /breaking news/,
    /what happened today/,

    // ТЕКУЩЕЕ ВРЕМЯ
    /сколько сейчас времени/,
    /который сейчас час/,
    /который час/,
    /скільки зараз часу/,
    /котра година/,
    /current time/,
    /what time is it/,
    /time in /,

    // КУРСЫ / ЦЕНЫ
    /курс доллар/,
    /курс евро/,
    /курс валют/,
    /курс гривн/,
    /цена биткоин/,
    /курс биткоин/,
    /bitcoin price/,
    /btc price/,
    /ethereum price/,
    /eth price/,
    /current price/,
    /акции сегодня/,
    /stock price/,

    // СПОРТ
    /кто выиграл/,
    /кто победил/,
    /результат матч/,
    /счёт матч/,
    /счет матч/,
    /последний матч/,
    /таблица чемпионата/,
    /турнирная таблица/,
    /who won/,
    /match result/,
    /latest match/,
    /score /,

    // ИГРЫ / ОБНОВЛЕНИЯ
    /последнее обновление/,
    /новое обновление/,
    /вышло обновление/,
    /патч/,
    /обновление fortnite/,
    /новости fortnite/,
    /фортнайт новости/,
    /fortnite news/,
    /fortnite update/,
    /fortnite patch/,

    // ЯВНАЯ ПРОСЬБА ПОИСКАТЬ
    /найди в интернете/,
    /поищи в интернете/,
    /проверь в интернете/,
    /найди в гугле/,
    /погугли/,
    /пошукай в інтернеті/,
    /перевір в інтернеті/,
    /search the web/,
    /search online/,
    /google it/
  ];

  return searchPatterns.some(pattern => pattern.test(t));
}


// =====================================================
// SYSTEM PROMPT
// =====================================================

function getSystemInstruction(useSearch) {
  let prompt =
    "You are a helpful AI assistant inside Telegram. " +

    "Always answer in the same language as the user's latest message. " +

    "If the user writes in Russian, answer in Russian. " +
    "If the user writes in Ukrainian, answer in Ukrainian. " +
    "If the user writes in English, answer in English. " +

    "If the user changes language, change your response language too. " +

    "Use the conversation history to understand follow-up requests. " +

    "For example, if you previously wrote a text and the user says " +
    "'make it shorter', 'make it prettier', 'rewrite it', 'simplify it', " +
    "'make it funnier' or something similar, understand that they are " +
    "referring to the previous relevant answer. " +

    "Write naturally and clearly. " +
    "Do not make answers unnecessarily long. " +

    "Do not pretend you know live information if you do not have access to it. ";

  if (useSearch) {
    prompt +=
      "Google Search is available for this request. " +
      "Use it when needed to get current and recent information. " +
      "Prefer fresh information when the user asks about weather, news, " +
      "current time, prices, sports results or recent events. ";
  }

  return prompt;
}


// =====================================================
// ОДИН ЗАПРОС К GEMINI
// =====================================================

async function requestGemini({
  model,
  contents,
  useSearch
}) {
  const requestBody = {
    systemInstruction: {
      parts: [
        {
          text: getSystemInstruction(useSearch)
        }
      ]
    },

    contents,

    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2048
    }
  };


  // Google Search добавляем ТОЛЬКО когда он нужен
  if (useSearch) {
    requestBody.tools = [
      {
        googleSearch: {}
      }
    ];
  }


  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY
        },

        body: JSON.stringify(requestBody)
      }
    );


    let data;

    try {
      data = await response.json();
    } catch {
      data = {};
    }


    // ===============================================
    // УСПЕХ
    // ===============================================

    if (response.ok) {
      const parts =
        data.candidates?.[0]?.content?.parts;

      if (!parts || parts.length === 0) {
        console.error(
          `${model} returned no content:`,
          JSON.stringify(data)
        );

        return {
          success: false,
          status: 500,
          type: "EMPTY"
        };
      }


      const answer = parts
        .map(part => part.text || "")
        .join("")
        .trim();


      if (!answer) {
        return {
          success: false,
          status: 500,
          type: "EMPTY"
        };
      }


      return {
        success: true,
        answer
      };
    }


    console.error(
      `Gemini API error | model=${model} | search=${useSearch}`,
      response.status,
      JSON.stringify(data)
    );


    // ===============================================
    // 429
    // ===============================================

    if (response.status === 429) {
      return {
        success: false,
        status: 429,
        type: "RATE_LIMIT"
      };
    }


    // ===============================================
    // 503
    // ===============================================

    if (response.status === 503) {
      return {
        success: false,
        status: 503,
        type: "OVERLOADED"
      };
    }


    // ===============================================
    // 404 — например модель недоступна
    // ===============================================

    if (response.status === 404) {
      return {
        success: false,
        status: 404,
        type: "MODEL_NOT_FOUND"
      };
    }


    return {
      success: false,
      status: response.status,
      type: "OTHER"
    };


  } catch (error) {
    console.error(
      `Gemini network error | model=${model}:`,
      error
    );

    return {
      success: false,
      status: 0,
      type: "NETWORK"
    };
  }
}


// =====================================================
// GEMINI С RETRY + FALLBACK
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


  // Определяем, нужен ли интернет
  let useSearch = needsWebSearch(userText);


  console.log(
    `Request | chat=${chatId} | search=${useSearch} | text=${userText.slice(0, 100)}`
  );


  // Основная + запасная модель
  const models = [
    "gemini-3.8-flash",
    "gemini-3.5-flash"
  ];


  // ===================================================
  // ПРОХОД ПО МОДЕЛЯМ
  // ===================================================

  for (const model of models) {

    // До трёх попыток одной модели
    for (let attempt = 1; attempt <= 3; attempt++) {

      console.log(
        `Gemini attempt ${attempt} | model=${model} | search=${useSearch}`
      );


      const result = await requestGemini({
        model,
        contents,
        useSearch
      });


      // ===============================================
      // УСПЕХ
      // ===============================================

      if (result.success) {

        addToHistory(
          chatId,
          "user",
          userText
        );

        addToHistory(
          chatId,
          "model",
          result.answer
        );


        return result.answer;
      }


      // ===============================================
      // SEARCH ПОЛУЧИЛ 429
      // ===============================================

      if (
        result.status === 429 &&
        useSearch
      ) {
        console.log(
          "Google Search quota/rate limit reached. Retrying WITHOUT Search."
        );


        // Выключаем Search
        useSearch = false;


        const fallbackWithoutSearch =
          await requestGemini({
            model,
            contents,
            useSearch: false
          });


        if (fallbackWithoutSearch.success) {

          const answer =
            "⚠️ Сейчас веб-поиск недоступен, поэтому ответ может быть неактуальным.\n\n" +
            fallbackWithoutSearch.answer;


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


        // Если модель без Search перегружена —
        // перейдём к retry / другой модели
        if (
          fallbackWithoutSearch.status === 503
        ) {
          await sleep(attempt * 1200);
          continue;
        }


        // Если и обычный Gemini получил 429 —
        // пробуем запасную модель
        if (
          fallbackWithoutSearch.status === 429
        ) {
          break;
        }


        break;
      }


      // ===============================================
      // 503 — ЖДЁМ И ПРОБУЕМ СНОВА
      // ===============================================

      if (result.status === 503) {

        console.log(
          `${model} overloaded. Attempt ${attempt}/3`
        );


        if (attempt < 3) {
          await sleep(attempt * 1200);
          continue;
        }


        // Три попытки не помогли —
        // переключаемся на следующую модель
        console.log(
          `${model} still overloaded. Trying fallback model...`
        );

        break;
      }


      // ===============================================
      // NETWORK ERROR
      // ===============================================

      if (result.type === "NETWORK") {

        if (attempt < 3) {
          await sleep(attempt * 1000);
          continue;
        }

        break;
      }


      // ===============================================
      // 404 — МОДЕЛЬ НЕДОСТУПНА
      // ===============================================

      if (result.status === 404) {

        console.log(
          `${model} is not available. Trying next model.`
        );

        break;
      }


      // ===============================================
      // 429 БЕЗ SEARCH
      // ===============================================

      if (result.status === 429) {

        console.log(
          `${model} rate limit. Trying fallback model.`
        );

        break;
      }


      // Прочая ошибка
      break;
    }
  }


  // ===================================================
  // ВСЕ МОДЕЛИ НЕ СРАБОТАЛИ
  // ===================================================

  return (
    "⚠️ Gemini сейчас временно недоступен или достигнут лимит API.\n\n" +
    "Попробуй ещё раз немного позже."
  );
}


// =====================================================
// TELEGRAM MESSAGE
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
      `Привет! 👋

Я AI-помощник на Gemini.

Можешь просто писать мне вопросы.

Для актуальной информации я могу использовать Google Search, когда это действительно необходимо.`
    );
  }


  // ===================================================
  // HELP
  // ===================================================

  if (text === "/help") {

    return sendMessage(
      chatId,
      `🤖 Просто напиши свой вопрос.

Например:

Какая сейчас погода в Киеве?

Какие сегодня новости Fortnite?

Который час в Нью-Йорке?

Напиши описание для видео

А потом можешь написать:

Сделай покороче`
    );
  }


  // ===================================================
  // RESET
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
  // TYPING
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
        error: "TELEGRAM_BOT_TOKEN is not set"
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
        error: "Invalid token"
      },
      {
        status: 401
      }
    );
  }


  return Response.json({
    ok: true,
    message: "Gemini Telegram webhook is ready"
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
        error: "TELEGRAM_BOT_TOKEN is not set"
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
        error: "Webhook handler failed"
      },
      {
        status: 500
      }
    );
  }
}
