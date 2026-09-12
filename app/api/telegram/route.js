export const runtime = "nodejs";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const TELEGRAM_API = BOT_TOKEN
  ? `https://api.telegram.org/bot${BOT_TOKEN}`
  : null;


// =====================================================
// MODELS
// =====================================================

const MODELS = [
  "gemini-3.8-flash",
  "gemini-3.5-flash"
];


// =====================================================
// MEMORY
// =====================================================

const conversations =
  globalThis.__geminiConversations || new Map();

globalThis.__geminiConversations = conversations;

const MAX_HISTORY_MESSAGES = 14;


// =====================================================
// TELEGRAM
// =====================================================

async function tg(method, payload) {
  if (!TELEGRAM_API) {
    throw new Error("TELEGRAM_BOT_TOKEN is missing");
  }

  const response = await fetch(
    `${TELEGRAM_API}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

  const data =
    await response.json().catch(() => null);

  if (!response.ok || !data?.ok) {
    console.error(
      "Telegram API error:",
      response.status,
      JSON.stringify(data)
    );

    throw new Error("Telegram API error");
  }

  return data;
}


// =====================================================
// SEND MESSAGE
// =====================================================

async function sendMessage(chatId, text) {
  if (!text) {
    text = "Не удалось получить ответ.";
  }

  for (let i = 0; i < text.length; i += 4000) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: text.slice(i, i + 4000),
      disable_web_page_preview: true
    });
  }
}


async function sendTyping(chatId) {
  try {
    await tg("sendChatAction", {
      chat_id: chatId,
      action: "typing"
    });
  } catch {}
}


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// =====================================================
// MEMORY
// =====================================================

function getHistory(chatId) {
  if (!conversations.has(chatId)) {
    conversations.set(chatId, []);
  }

  return conversations.get(chatId);
}


function addToHistory(chatId, role, parts) {
  const history = getHistory(chatId);

  history.push({
    role,
    parts
  });

  while (history.length > MAX_HISTORY_MESSAGES) {
    history.shift();
  }
}


function clearHistory(chatId) {
  conversations.delete(chatId);
}


// =====================================================
// DATE
// =====================================================

function getCurrentDate() {
  return new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }
  ).format(new Date());
}


// =====================================================
// SYSTEM PROMPT
// =====================================================

function getSystemPrompt(webAvailable) {
  const currentDate = getCurrentDate();

  return `
You are a helpful AI assistant inside Telegram.

Current date: ${currentDate}.

Answer naturally, like a modern general-purpose AI assistant.

Always answer in the same language as the user's latest message unless the user asks for another language.

Use conversation history to understand context.

For example, if the user says:
- "make it shorter"
- "rewrite it"
- "make it prettier"
- "continue"
- "explain simpler"
- "what about tomorrow?"

understand the previous conversation instead of treating it as a completely new request.

Do not unnecessarily repeat yourself.

Be concise when the question is simple and detailed when useful.

You can understand casual language, spelling mistakes and incomplete phrases.

${webAvailable
  ? `
Google Search is available.

Use it whenever fresh or current information is needed, including current events, news, weather, prices, sports, software, games, releases, public information or anything that may have changed recently.

Do not rely on old training knowledge when current information is required.
`
  : `
Live web access is currently unavailable.

If the user's question requires current, live or recently changed information, clearly say that you cannot verify the latest information right now.

Do NOT invent current facts and do NOT present old information as if it were current.
`
}

Never claim that the current year is an older year when the current date above says otherwise.
`.trim();
}


// =====================================================
// EXTRACT GEMINI TEXT
// =====================================================

function extractAnswer(data) {
  const parts =
    data?.candidates?.[0]?.content?.parts;

  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .map(part => part.text || "")
    .join("")
    .trim();
}


// =====================================================
// GEMINI REQUEST
// =====================================================

async function requestGemini({
  model,
  contents,
  useSearch
}) {
  const body = {
    systemInstruction: {
      parts: [
        {
          text: getSystemPrompt(useSearch)
        }
      ]
    },

    contents,

    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2048
    }
  };


  // Просто даём Gemini возможность пользоваться Google.
  // Gemini сам решает, нужен ли поиск.
  if (useSearch) {
    body.tools = [
      {
        google_search: {}
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

        body: JSON.stringify(body)
      }
    );


    const data =
      await response.json().catch(() => ({}));


    if (response.ok) {
      const answer = extractAnswer(data);

      if (answer) {
        return {
          success: true,
          answer
        };
      }
    }


    console.error(
      `Gemini error | ${model} | search=${useSearch}`,
      response.status,
      JSON.stringify(data)
    );


    return {
      success: false,
      status: response.status
    };

  } catch (error) {
    console.error(
      "Gemini network error:",
      error
    );

    return {
      success: false,
      status: 0
    };
  }
}


// =====================================================
// ASK GEMINI
// =====================================================

async function askGemini(chatId, userParts) {
  if (!GEMINI_API_KEY) {
    return "⚠️ GEMINI_API_KEY не настроен.";
  }


  const history = getHistory(chatId);


  const contents = [
    ...history,

    {
      role: "user",
      parts: userParts
    }
  ];


  // ===================================================
  // СНАЧАЛА GEMINI + GOOGLE SEARCH
  // ===================================================

  for (const model of MODELS) {

    for (let attempt = 1; attempt <= 3; attempt++) {

      const result =
        await requestGemini({
          model,
          contents,
          useSearch: true
        });


      if (result.success) {

        addToHistory(
          chatId,
          "user",
          userParts
        );

        addToHistory(
          chatId,
          "model",
          [
            {
              text: result.answer
            }
          ]
        );


        return result.answer;
      }


      // ===============================================
      // GOOGLE SEARCH / API LIMIT
      // ===============================================

      if (result.status === 429) {
        console.log(
          "Search/API limit. Retrying without web..."
        );

        break;
      }


      // ===============================================
      // MODEL OVERLOADED
      // ===============================================

      if (result.status === 503) {

        if (attempt < 3) {
          await sleep(
            attempt * 1000
          );

          continue;
        }

        break;
      }


      // Model unavailable
      if (result.status === 404) {
        break;
      }


      break;
    }
  }


  // ===================================================
  // FALLBACK БЕЗ WEB
  // ===================================================

  for (const model of MODELS) {

    for (let attempt = 1; attempt <= 2; attempt++) {

      const result =
        await requestGemini({
          model,
          contents,
          useSearch: false
        });


      if (result.success) {

        addToHistory(
          chatId,
          "user",
          userParts
        );

        addToHistory(
          chatId,
          "model",
          [
            {
              text: result.answer
            }
          ]
        );


        return result.answer;
      }


      if (
        result.status === 503 &&
        attempt < 2
      ) {
        await sleep(1000);
        continue;
      }


      break;
    }
  }


  return (
    "⚠️ Gemini сейчас временно недоступен.\n\n" +
    "Попробуй ещё раз немного позже."
  );
}


// =====================================================
// DOWNLOAD TELEGRAM FILE
// =====================================================

async function downloadTelegramFile(
  fileId,
  defaultMimeType
) {
  const file =
    await tg("getFile", {
      file_id: fileId
    });


  const filePath =
    file.result?.file_path;


  if (!filePath) {
    throw new Error(
      "Telegram file path missing"
    );
  }


  const response =
    await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`
    );


  if (!response.ok) {
    throw new Error(
      `Telegram file download error ${response.status}`
    );
  }


  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );


  return {
    data: buffer.toString("base64"),
    mimeType:
      response.headers.get("content-type") ||
      defaultMimeType
  };
}


// =====================================================
// VOICE
// =====================================================

async function handleVoice(chatId, voice) {
  try {
    const file =
      await downloadTelegramFile(
        voice.file_id,
        "audio/ogg"
      );


    return askGemini(
      chatId,
      [
        {
          text:
            "Listen to this voice message and respond to what I said. " +
            "Do not just transcribe it unless I ask for transcription."
        },

        {
          inlineData: {
            mimeType: file.mimeType,
            data: file.data
          }
        }
      ]
    );

  } catch (error) {
    console.error(
      "Voice error:",
      error
    );

    return (
      "⚠️ Не удалось обработать голосовое сообщение."
    );
  }
}


// =====================================================
// PHOTO
// =====================================================

async function handlePhoto(
  chatId,
  photoArray,
  caption
) {
  try {
    // Самая большая фотография
    const photo =
      photoArray[
        photoArray.length - 1
      ];


    const file =
      await downloadTelegramFile(
        photo.file_id,
        "image/jpeg"
      );


    const prompt =
      caption?.trim() ||
      "Look at this image and help me with it.";


    return askGemini(
      chatId,
      [
        {
          text: prompt
        },

        {
          inlineData: {
            mimeType: file.mimeType,
            data: file.data
          }
        }
      ]
    );

  } catch (error) {
    console.error(
      "Photo error:",
      error
    );

    return (
      "⚠️ Не удалось обработать изображение."
    );
  }
}


// =====================================================
// HANDLE MESSAGE
// =====================================================

async function handleMessage(message) {
  const chatId = message.chat.id;


  // ===================================================
  // START
  // ===================================================

  if (message.text === "/start") {

    clearHistory(chatId);


    return sendMessage(
      chatId,
      `Привет! 👋

Я AI-помощник на Gemini.

Просто пиши мне как обычному ИИ.

Можешь отправлять текст, голосовые сообщения и изображения.`
    );
  }


  // ===================================================
  // CLEAR
  // ===================================================

  if (
    message.text === "/clear" ||
    message.text === "/reset"
  ) {

    clearHistory(chatId);


    return sendMessage(
      chatId,
      "🧹 Контекст диалога очищен."
    );
  }


  await sendTyping(chatId);


  // ===================================================
  // VOICE
  // ===================================================

  if (message.voice) {

    const answer =
      await handleVoice(
        chatId,
        message.voice
      );


    return sendMessage(
      chatId,
      answer
    );
  }


  // ===================================================
  // PHOTO
  // ===================================================

  if (
    Array.isArray(message.photo) &&
    message.photo.length > 0
  ) {

    const answer =
      await handlePhoto(
        chatId,
        message.photo,
        message.caption || ""
      );


    return sendMessage(
      chatId,
      answer
    );
  }


  // ===================================================
  // TEXT
  // ===================================================

  const text =
    (message.text || "").trim();


  if (!text) {
    return;
  }


  const answer =
    await askGemini(
      chatId,
      [
        {
          text
        }
      ]
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
        error:
          "TELEGRAM_BOT_TOKEN is missing"
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
    message:
      "Gemini Telegram bot is running"
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
          "TELEGRAM_BOT_TOKEN is missing"
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
        error:
          "Webhook handler failed"
      },
      {
        status: 500
      }
    );
  }
}
