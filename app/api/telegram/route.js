const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const TELEGRAM_API = BOT_TOKEN
  ? `https://api.telegram.org/bot${BOT_TOKEN}`
  : null;


// =====================================================
// ПАМЯТЬ
// =====================================================

const conversations =
  globalThis.__geminiConversations || new Map();

globalThis.__geminiConversations = conversations;

const MAX_HISTORY_MESSAGES = 12;


// =====================================================
// TELEGRAM
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
    const text = await response.text();

    console.error(
      "Telegram API error:",
      response.status,
      text
    );

    throw new Error("Telegram API error");
  }

  return response.json();
}


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
// ОПРЕДЕЛЕНИЕ ТИПА ЗАПРОСА
// =====================================================

function isWeatherRequest(text) {
  const t = text.toLowerCase();

  return (
    /погод/.test(t) ||
    /температур/.test(t) ||
    /дожд/.test(t) ||
    /дощ/.test(t) ||
    /снег/.test(t) ||
    /сніг/.test(t) ||
    /weather/.test(t) ||
    /forecast/.test(t)
  );
}


function isTimeRequest(text) {
  const t = text.toLowerCase();

  return (
    /который час/.test(t) ||
    /сколько сейчас времени/.test(t) ||
    /скільки зараз часу/.test(t) ||
    /котра година/.test(t) ||
    /який зараз час/.test(t) ||
    /what time/.test(t) ||
    /current time/.test(t)
  );
}


function isCurrencyRequest(text) {
  const t = text.toLowerCase();

  return (
    /курс/.test(t) ||
    /доллар/.test(t) ||
    /долар/.test(t) ||
    /евро/.test(t) ||
    /євро/.test(t) ||
    /гривн/.test(t) ||
    /usd/.test(t) ||
    /uah/.test(t) ||
    /eur/.test(t) ||
    /gbp/.test(t)
  );
}


function needsGoogleSearch(text) {
  const t = text.toLowerCase();

  return (
    /новост/.test(t) ||
    /новини/.test(t) ||
    /последние событ/.test(t) ||
    /останні події/.test(t) ||
    /что произошло сегодня/.test(t) ||
    /що сталося сьогодні/.test(t) ||
    /latest news/.test(t) ||
    /breaking news/.test(t) ||
    /fortnite news/.test(t) ||
    /новости fortnite/.test(t) ||
    /новини fortnite/.test(t) ||
    /найди в интернете/.test(t) ||
    /поищи в интернете/.test(t) ||
    /пошукай в інтернеті/.test(t) ||
    /search the web/.test(t)
  );
}


// =====================================================
// ИЗВЛЕЧЕНИЕ ГОРОДА
// =====================================================

function simpleLocationFromText(text) {
  let location = text;

  location = location.replace(
    /какая|какой|какая сейчас|сейчас|погода|погоде|температура|температуру|прогноз|weather|forecast|который час|сколько сейчас времени|скільки зараз часу|котра година|який зараз час|what time is it|current time/gi,
    " "
  );

  location = location.replace(
    /\b(в|во|у|in|at)\b/gi,
    " "
  );

  location = location.replace(/[?!.,]/g, " ");

  return location
    .replace(/\s+/g, " ")
    .trim();
}


// =====================================================
// GEMINI — НОРМАЛИЗУЕТ НАЗВАНИЕ ГОРОДА
// =====================================================

async function normalizeLocation(userText) {
  const fallback =
    simpleLocationFromText(userText);

  if (!GEMINI_API_KEY) {
    return fallback;
  }

  const prompt = `
Extract only the geographical location from this message.

Return only a normal city/location name suitable for a geocoding API.
Do not explain anything.

Examples:
"Какая погода в Полтаве?" -> Poltava
"погода киев" -> Kyiv
"Который час в Нью Йорке?" -> New York
"котра година у Львові" -> Lviv

Message:
${userText}
`;

  const models = [
    "gemini-3.8-flash",
    "gemini-3.5-flash"
  ];

  for (const model of models) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": GEMINI_API_KEY
          },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: prompt
                  }
                ]
              }
            ],
            generationConfig: {
              temperature: 0,
              maxOutputTokens: 50
            }
          })
        }
      );

      if (!response.ok) {
        continue;
      }

      const data = await response.json();

      const result =
        data.candidates?.[0]?.content?.parts
          ?.map(p => p.text || "")
          .join("")
          .trim();

      if (result) {
        return result
          .replace(/^["']|["']$/g, "")
          .trim();
      }

    } catch (error) {
      console.error(
        "Location normalize error:",
        error
      );
    }
  }

  return fallback;
}


// =====================================================
// ПОИСК ГОРОДА — OPEN METEO
// =====================================================

async function geocodeLocation(userText) {
  const locationName =
    await normalizeLocation(userText);

  if (!locationName) {
    return null;
  }

  const url =
    "https://geocoding-api.open-meteo.com/v1/search" +
    `?name=${encodeURIComponent(locationName)}` +
    "&count=1" +
    "&language=en" +
    "&format=json";

  try {
    const response = await fetch(url);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    const result =
      data.results?.[0];

    if (!result) {
      return null;
    }

    return {
      name: result.name,
      country: result.country,
      admin1: result.admin1,
      latitude: result.latitude,
      longitude: result.longitude,
      timezone: result.timezone
    };

  } catch (error) {
    console.error(
      "Geocoding error:",
      error
    );

    return null;
  }
}


// =====================================================
// ПОГОДА
// =====================================================

function weatherCodeToText(code) {
  const codes = {
    0: "ясно",
    1: "в основном ясно",
    2: "переменная облачность",
    3: "пасмурно",

    45: "туман",
    48: "изморозь и туман",

    51: "лёгкая морось",
    53: "морось",
    55: "сильная морось",

    61: "небольшой дождь",
    63: "дождь",
    65: "сильный дождь",

    71: "небольшой снег",
    73: "снег",
    75: "сильный снег",

    80: "небольшие ливни",
    81: "ливни",
    82: "сильные ливни",

    95: "гроза",
    96: "гроза с градом",
    99: "сильная гроза с градом"
  };

  return codes[code] || "неизвестные погодные условия";
}


async function getWeather(userText) {
  const place =
    await geocodeLocation(userText);

  if (!place) {
    return (
      "⚠️ Я не смог определить город.\n\n" +
      "Например напиши:\n" +
      "Какая погода в Полтаве?"
    );
  }

  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${place.latitude}` +
    `&longitude=${place.longitude}` +
    "&current=" +
    [
      "temperature_2m",
      "relative_humidity_2m",
      "apparent_temperature",
      "precipitation",
      "weather_code",
      "wind_speed_10m"
    ].join(",") +
    "&timezone=auto";

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Weather API ${response.status}`
      );
    }

    const data = await response.json();

    const current =
      data.current;

    if (!current) {
      throw new Error(
        "Weather current data missing"
      );
    }

    const placeName =
      place.admin1
        ? `${place.name}, ${place.admin1}`
        : `${place.name}, ${place.country}`;

    return (
      `🌤 Погода сейчас — ${placeName}\n\n` +
      `🌡 Температура: ${current.temperature_2m} °C\n` +
      `🤔 Ощущается как: ${current.apparent_temperature} °C\n` +
      `☁️ ${weatherCodeToText(current.weather_code)}\n` +
      `💧 Влажность: ${current.relative_humidity_2m}%\n` +
      `🌬 Ветер: ${current.wind_speed_10m} км/ч\n` +
      `🌧 Осадки: ${current.precipitation} мм`
    );

  } catch (error) {
    console.error(
      "Weather error:",
      error
    );

    return (
      "⚠️ Сейчас не удалось получить погоду.\n\n" +
      "Попробуй ещё раз."
    );
  }
}


// =====================================================
// ВРЕМЯ
// =====================================================

async function getCurrentTime(userText) {
  const place =
    await geocodeLocation(userText);

  if (!place) {
    return (
      "⚠️ Я не смог определить город.\n\n" +
      "Например:\n" +
      "Который час в Нью-Йорке?"
    );
  }

  try {
    const now =
      new Date();

    const time =
      new Intl.DateTimeFormat(
        "ru-RU",
        {
          timeZone: place.timezone,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false
        }
      ).format(now);

    const date =
      new Intl.DateTimeFormat(
        "ru-RU",
        {
          timeZone: place.timezone,
          day: "2-digit",
          month: "2-digit",
          year: "numeric"
        }
      ).format(now);

    return (
      `🕒 Сейчас в ${place.name}:\n\n` +
      `${time}\n` +
      `📅 ${date}\n\n` +
      `Часовой пояс: ${place.timezone}`
    );

  } catch (error) {
    console.error(
      "Time error:",
      error
    );

    return (
      "⚠️ Не удалось определить текущее время."
    );
  }
}


// =====================================================
// ВАЛЮТЫ
// =====================================================

function detectCurrency(text) {
  const t =
    text.toLowerCase();

  const currencies = [
    {
      code: "USD",
      patterns: [
        "usd",
        "доллар",
        "долар",
        "долара",
        "доллара",
        "доллары",
        "долари"
      ]
    },

    {
      code: "EUR",
      patterns: [
        "eur",
        "евро",
        "євро"
      ]
    },

    {
      code: "GBP",
      patterns: [
        "gbp",
        "фунт",
        "фунта",
        "фунтів"
      ]
    },

    {
      code: "PLN",
      patterns: [
        "pln",
        "злот",
        "злоты",
        "злотых"
      ]
    },

    {
      code: "UAH",
      patterns: [
        "uah",
        "гривн",
        "грн"
      ]
    }
  ];

  const found = [];

  for (const currency of currencies) {
    if (
      currency.patterns.some(
        pattern => t.includes(pattern)
      )
    ) {
      found.push(currency.code);
    }
  }

  return found;
}


function extractAmount(text) {
  const match =
    text.match(
      /(\d+(?:[.,]\d+)?)/
    );

  if (!match) {
    return 1;
  }

  return Number(
    match[1].replace(",", ".")
  );
}


async function getCurrencyRate(userText) {
  const currencies =
    detectCurrency(userText);

  const amount =
    extractAmount(userText);

  let base;
  let quote;


  // Если написано просто:
  // "курс доллара"
  // считаем USD → UAH
  if (currencies.length === 0) {
    base = "USD";
    quote = "UAH";

  } else if (currencies.length === 1) {

    if (currencies[0] === "UAH") {
      base = "UAH";
      quote = "USD";
    } else {
      base = currencies[0];
      quote = "UAH";
    }

  } else {
    base = currencies[0];
    quote = currencies[1];
  }


  if (base === quote) {
    return (
      `${amount} ${base} = ${amount} ${quote}`
    );
  }


  const url =
    `https://api.frankfurter.dev/v2/rate/` +
    `${base.toLowerCase()}/` +
    `${quote.toLowerCase()}`;


  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Currency API ${response.status}`
      );
    }

    const data =
      await response.json();

    const rate =
      data.rate;

    if (!rate) {
      throw new Error(
        "Rate missing"
      );
    }


    const total =
      amount * rate;


    return (
      `💱 Курс валют\n\n` +
      `${amount} ${base} = ${total.toFixed(2)} ${quote}\n\n` +
      `1 ${base} = ${Number(rate).toFixed(4)} ${quote}\n` +
      `📅 Данные: ${data.date}`
    );

  } catch (error) {
    console.error(
      "Currency error:",
      error
    );


    return (
      "⚠️ Сейчас не удалось получить курс валют."
    );
  }
}


// =====================================================
// SYSTEM PROMPT
// =====================================================

function getSystemInstruction(useSearch) {
  let text =
    "You are a helpful AI assistant inside Telegram. " +

    "Always answer in the same language as the user's latest message. " +

    "If the user writes in Russian, answer in Russian. " +
    "If the user writes in Ukrainian, answer in Ukrainian. " +
    "If the user writes in English, answer in English. " +

    "Use conversation history to understand follow-up requests. " +

    "If the user says make it shorter, rewrite it, make it prettier, " +
    "simpler, more detailed or funnier, apply that request to the " +
    "previous relevant response. " +

    "Write naturally and clearly. " +
    "Do not make answers unnecessarily long. ";

  if (useSearch) {
    text +=
      "Google Search is available. " +
      "Use it to answer questions about recent news and current events. " +
      "Prefer current reliable information. ";
  }

  return text;
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
          text:
            getSystemInstruction(
              useSearch
            )
        }
      ]
    },

    contents,

    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2048
    }
  };


  if (useSearch) {
    body.tools = [
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
          "x-goog-api-key":
            GEMINI_API_KEY
        },

        body:
          JSON.stringify(body)
      }
    );


    const data =
      await response.json()
        .catch(() => ({}));


    if (response.ok) {
      const answer =
        data.candidates?.[0]?.content?.parts
          ?.map(
            part => part.text || ""
          )
          .join("")
          .trim();


      if (answer) {
        return {
          success: true,
          answer
        };
      }
    }


    console.error(
      `Gemini error | model=${model} | search=${useSearch}`,
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
// GEMINI + FALLBACK
// =====================================================

async function askGemini(
  chatId,
  userText,
  useSearch
) {
  if (!GEMINI_API_KEY) {
    return (
      "⚠️ GEMINI_API_KEY не настроен."
    );
  }


  const history =
    getHistory(chatId);


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


  const models = [
    "gemini-3.8-flash",
    "gemini-3.5-flash"
  ];


  for (const model of models) {

    for (
      let attempt = 1;
      attempt <= 3;
      attempt++
    ) {

      let result =
        await requestGemini({
          model,
          contents,
          useSearch
        });


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


      // Search получил лимит
      if (
        result.status === 429 &&
        useSearch
      ) {

        console.log(
          "Search limit reached, retry without Search"
        );


        result =
          await requestGemini({
            model,
            contents,
            useSearch: false
          });


        if (result.success) {
          return (
            "⚠️ Сейчас веб-поиск недоступен, поэтому свежесть данных не гарантируется.\n\n" +
            result.answer
          );
        }


        break;
      }


      // Gemini перегружен
      if (result.status === 503) {

        if (attempt < 3) {
          await sleep(
            attempt * 1200
          );

          continue;
        }


        break;
      }


      // Модель недоступна
      if (result.status === 404) {
        break;
      }


      // Лимит модели
      if (result.status === 429) {
        break;
      }


      break;
    }
  }


  return (
    "⚠️ Gemini сейчас временно недоступен.\n\n" +
    "Попробуй немного позже."
  );
}


// =====================================================
// ОБРАБОТКА СООБЩЕНИЯ
// =====================================================

async function handleMessage(message) {
  const chatId =
    message.chat.id;

  const text =
    (message.text || "").trim();


  if (!text) {
    return;
  }


  // START
  if (text === "/start") {

    clearHistory(chatId);

    return sendMessage(
      chatId,
      `Привет! 👋

Я AI-помощник на Gemini.

Я могу отвечать на обычные вопросы, смотреть погоду, время, курсы валют и использовать веб-поиск для свежих новостей.`
    );
  }


  // HELP
  if (text === "/help") {

    return sendMessage(
      chatId,
      `🤖 Просто напиши вопрос.

Например:

Какая погода в Полтаве?

Который час в Нью-Йорке?

Курс доллара

100 долларов в гривнах

Какие сегодня новости Fortnite?

Напиши описание для ролика`
    );
  }


  // RESET
  if (
    text === "/clear" ||
    text === "/reset"
  ) {

    clearHistory(chatId);

    return sendMessage(
      chatId,
      "🧹 История очищена."
    );
  }


  await tg(
    "sendChatAction",
    {
      chat_id: chatId,
      action: "typing"
    }
  );


  // ===================================================
  // ПОГОДА
  // ===================================================

  if (isWeatherRequest(text)) {

    const answer =
      await getWeather(text);

    return sendMessage(
      chatId,
      answer
    );
  }


  // ===================================================
  // ВРЕМЯ
  // ===================================================

  if (isTimeRequest(text)) {

    const answer =
      await getCurrentTime(text);

    return sendMessage(
      chatId,
      answer
    );
  }


  // ===================================================
  // ВАЛЮТА
  // ===================================================

  if (isCurrencyRequest(text)) {

    const answer =
      await getCurrencyRate(text);

    return sendMessage(
      chatId,
      answer
    );
  }


  // ===================================================
  // GEMINI
  // ===================================================

  const useSearch =
    needsGoogleSearch(text);


  const answer =
    await askGemini(
      chatId,
      text,
      useSearch
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
