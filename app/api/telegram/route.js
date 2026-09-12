export const runtime = "nodejs";

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


const toolStates =
  globalThis.__geminiToolStates || new Map();

globalThis.__geminiToolStates = toolStates;


const MAX_HISTORY_MESSAGES = 12;


// =====================================================
// TELEGRAM API
// =====================================================

async function tg(method, payload) {
  if (!TELEGRAM_API) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
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

  const data = await response.json().catch(() => null);

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
// TELEGRAM MESSAGE
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


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// =====================================================
// HISTORY
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


function rememberExchange(chatId, userText, answer) {
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
}


function clearHistory(chatId) {
  conversations.delete(chatId);
  toolStates.delete(chatId);
}


// =====================================================
// INTENT DETECTION
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


function isTomorrowWeatherFollowup(chatId, text) {
  const state =
    toolStates.get(chatId);

  if (!state || state.type !== "weather") {
    return false;
  }

  return (
    /завтра/.test(text.toLowerCase()) ||
    /tomorrow/.test(text.toLowerCase())
  );
}


function isTimeRequest(text) {
  const t = text.toLowerCase();

  return (
    /который час/.test(t) ||
    /который сейчас час/.test(t) ||
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
    /gbp/.test(t) ||
    /pln/.test(t)
  );
}


function needsGoogleSearch(text) {
  const t = text.toLowerCase();

  return (
    /новост/.test(t) ||
    /новини/.test(t) ||
    /сегодня произошло/.test(t) ||
    /сьогодні сталося/.test(t) ||
    /последние события/.test(t) ||
    /останні події/.test(t) ||
    /latest news/.test(t) ||
    /breaking news/.test(t) ||
    /fortnite news/.test(t) ||
    /новости fortnite/.test(t) ||
    /новини fortnite/.test(t) ||
    /найди в интернете/.test(t) ||
    /поищи в интернете/.test(t) ||
    /проверь в интернете/.test(t) ||
    /пошукай в інтернеті/.test(t) ||
    /search the web/.test(t) ||
    /google it/.test(t)
  );
}


// =====================================================
// LOCATION EXTRACTION
// =====================================================

function extractLocationText(text) {
  let s = text.trim();

  s = s.replace(
    /^(какая|какой|какое|яка|який|яке)\s+/i,
    ""
  );

  s = s.replace(
    /погода|погоде|погоду|weather|forecast|температура|температуре|температуру|который час|который сейчас час|сколько сейчас времени|скільки зараз часу|котра година|який зараз час|what time is it|current time/gi,
    " "
  );

  s = s.replace(/[?!.,]/g, " ");

  const match =
    s.match(
      /(?:\bв\b|\bво\b|\bу\b|\bin\b)\s+(.+)/i
    );

  if (match?.[1]) {
    s = match[1];
  }

  return s
    .replace(/\s+/g, " ")
    .trim();
}


// =====================================================
// LOCATION CANDIDATES
// =====================================================

function locationCandidates(name) {
  const value = name.trim();

  const results = new Set();

  if (!value) {
    return [];
  }

  results.add(value);


  // Частые формы
  const known = {
    "полтаве": "Полтава",
    "полтаві": "Полтава",

    "киеве": "Киев",
    "києві": "Київ",
    "киев": "Киев",
    "київ": "Київ",

    "львове": "Львов",
    "львові": "Львів",

    "одессе": "Одесса",
    "одесі": "Одеса",

    "харькове": "Харьков",
    "харкові": "Харків",

    "днепре": "Днепр",
    "дніпрі": "Дніпро",

    "варшаве": "Варшава",
    "варшаві": "Warsaw",

    "нью-йорке": "New York",
    "нью йорке": "New York",

    "токио": "Tokyo",
    "токіо": "Tokyo",

    "лондоне": "London",
    "лондоні": "London",

    "париже": "Paris",
    "парижі": "Paris",

    "берлине": "Berlin",
    "берліні": "Berlin"
  };


  const lower = value.toLowerCase();

  if (known[lower]) {
    results.add(known[lower]);
  }


  // Киевe -> Киев
  if (/[еі]$/i.test(value)) {
    results.add(
      value.slice(0, -1)
    );
  }


  // Полтаве -> Полтава
  if (/ве$/i.test(value)) {
    results.add(
      value.slice(0, -2) + "ва"
    );
  }


  // Варшаве -> Варшава
  if (/аве$/i.test(value)) {
    results.add(
      value.slice(0, -1) + "а"
    );
  }


  // Одессе -> Одесса
  if (/ссе$/i.test(value)) {
    results.add(
      value.slice(0, -1) + "а"
    );
  }


  // Нью Йорк -> New York-ish fallback
  results.add(
    value.replace(/-/g, " ")
  );


  return [...results];
}


// =====================================================
// OPEN-METEO GEOCODING
// =====================================================

async function findPlaceFromName(rawName) {
  const candidates =
    locationCandidates(rawName);


  for (const candidate of candidates) {
    try {
      const url =
        "https://geocoding-api.open-meteo.com/v1/search" +
        `?name=${encodeURIComponent(candidate)}` +
        "&count=5" +
        "&language=ru" +
        "&format=json";


      const response =
        await fetch(url);


      if (!response.ok) {
        continue;
      }


      const data =
        await response.json();


      const place =
        data.results?.[0];


      if (place) {
        return {
          name: place.name,
          country: place.country,
          admin1: place.admin1,
          latitude: place.latitude,
          longitude: place.longitude,
          timezone: place.timezone
        };
      }

    } catch (error) {
      console.error(
        "Geocoding candidate error:",
        candidate,
        error
      );
    }
  }


  return null;
}


async function geocodeFromMessage(text) {
  const raw =
    extractLocationText(text);

  if (!raw) {
    return null;
  }

  return findPlaceFromName(raw);
}


// =====================================================
// WEATHER
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

  return (
    codes[code] ||
    "неизвестные погодные условия"
  );
}


function placeTitle(place) {
  if (place.admin1) {
    return `${place.name}, ${place.admin1}`;
  }

  return `${place.name}, ${place.country}`;
}


// =====================================================
// CURRENT WEATHER
// =====================================================

async function getCurrentWeather(place) {
  try {
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


    const response =
      await fetch(url);


    if (!response.ok) {
      throw new Error(
        `Weather API ${response.status}`
      );
    }


    const data =
      await response.json();


    const current =
      data.current;


    if (!current) {
      throw new Error(
        "Missing current weather"
      );
    }


    return (
      `🌤 Погода сейчас — ${placeTitle(place)}\n\n` +
      `🌡 Температура: ${current.temperature_2m} °C\n` +
      `🤔 Ощущается как: ${current.apparent_temperature} °C\n` +
      `☁️ ${weatherCodeToText(current.weather_code)}\n` +
      `💧 Влажность: ${current.relative_humidity_2m}%\n` +
      `🌬 Ветер: ${current.wind_speed_10m} км/ч\n` +
      `🌧 Осадки: ${current.precipitation} мм`
    );

  } catch (error) {
    console.error(
      "Current weather error:",
      error
    );

    return (
      "⚠️ Сейчас не удалось получить погоду."
    );
  }
}


// =====================================================
// TOMORROW WEATHER
// =====================================================

async function getTomorrowWeather(place) {
  try {
    const url =
      "https://api.open-meteo.com/v1/forecast" +
      `?latitude=${place.latitude}` +
      `&longitude=${place.longitude}` +
      "&daily=" +
      [
        "weather_code",
        "temperature_2m_max",
        "temperature_2m_min",
        "precipitation_probability_max",
        "wind_speed_10m_max"
      ].join(",") +
      "&forecast_days=2" +
      "&timezone=auto";


    const response =
      await fetch(url);


    if (!response.ok) {
      throw new Error(
        `Forecast API ${response.status}`
      );
    }


    const data =
      await response.json();


    const d =
      data.daily;


    if (!d?.time?.[1]) {
      throw new Error(
        "Tomorrow data missing"
      );
    }


    return (
      `🌤 Завтра — ${placeTitle(place)}\n\n` +
      `🌡 Максимум: ${d.temperature_2m_max[1]} °C\n` +
      `🌡 Минимум: ${d.temperature_2m_min[1]} °C\n` +
      `☁️ ${weatherCodeToText(d.weather_code[1])}\n` +
      `🌧 Вероятность осадков: ${d.precipitation_probability_max[1]}%\n` +
      `🌬 Ветер до: ${d.wind_speed_10m_max[1]} км/ч`
    );

  } catch (error) {
    console.error(
      "Tomorrow weather error:",
      error
    );

    return (
      "⚠️ Не удалось получить прогноз на завтра."
    );
  }
}


// =====================================================
// TIME
// =====================================================

async function getCurrentTime(place) {
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
      "⚠️ Не удалось определить время."
    );
  }
}


// =====================================================
// CURRENCY
// =====================================================

function detectCurrencies(text) {
  const t = text.toLowerCase();

  const list = [
    {
      code: "USD",
      words: [
        "usd",
        "доллар",
        "долар"
      ]
    },
    {
      code: "EUR",
      words: [
        "eur",
        "евро",
        "євро"
      ]
    },
    {
      code: "UAH",
      words: [
        "uah",
        "гривн",
        "грн"
      ]
    },
    {
      code: "GBP",
      words: [
        "gbp",
        "фунт"
      ]
    },
    {
      code: "PLN",
      words: [
        "pln",
        "злот"
      ]
    }
  ];


  const found = [];


  for (const currency of list) {
    if (
      currency.words.some(
        word => t.includes(word)
      )
    ) {
      found.push(
        currency.code
      );
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


async function getCurrencyRate(text) {
  const found =
    detectCurrencies(text);

  const amount =
    extractAmount(text);


  let base;
  let quote;


  if (found.length === 0) {
    base = "USD";
    quote = "UAH";

  } else if (found.length === 1) {

    if (found[0] === "UAH") {
      base = "UAH";
      quote = "USD";
    } else {
      base = found[0];
      quote = "UAH";
    }

  } else {
    base = found[0];
    quote = found[1];
  }


  try {
    const url =
      `https://api.frankfurter.dev/v2/rate/` +
      `${base.toLowerCase()}/` +
      `${quote.toLowerCase()}`;


    const response =
      await fetch(url);


    if (!response.ok) {
      throw new Error(
        `Currency API ${response.status}`
      );
    }


    const data =
      await response.json();


    if (!data.rate) {
      throw new Error(
        "Currency rate missing"
      );
    }


    const converted =
      amount * data.rate;


    return (
      `💱 Курс валют\n\n` +
      `${amount} ${base} = ${converted.toFixed(2)} ${quote}\n\n` +
      `1 ${base} = ${Number(data.rate).toFixed(4)} ${quote}\n` +
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

function systemPrompt(useSearch = false) {
  let prompt =
    "You are a helpful AI assistant inside Telegram. " +

    "Always answer in the same language as the user's latest message. " +

    "If the user writes Russian, answer Russian. " +
    "If the user writes Ukrainian, answer Ukrainian. " +
    "If the user writes English, answer English. " +

    "Use conversation history to understand context. " +

    "If the user says make it shorter, rewrite it, make it prettier, " +
    "simpler, more detailed or funnier, apply the instruction to the " +
    "previous relevant answer. " +

    "Write naturally and clearly. " +
    "Do not be unnecessarily verbose. ";


  if (useSearch) {
    prompt +=
      "Google Search is available for this request. " +
      "The user is asking for current or recent information. " +
      "Use current search results. " +
      "Never present old information as today's news. ";
  }


  return prompt;
}


// =====================================================
// GEMINI TEXT REQUEST
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
            systemPrompt(
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
        google_search: {}
      }
    ];
  }


  try {
    const response =
      await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

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
      `Gemini error model=${model} search=${useSearch}`,
      response.status,
      JSON.stringify(data)
    );


    return {
      success: false,
      status: response.status,
      data
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
// GEMINI CHAT
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

      const result =
        await requestGemini({
          model,
          contents,
          useSearch
        });


      if (result.success) {
        rememberExchange(
          chatId,
          userText,
          result.answer
        );

        return result.answer;
      }


      // =================================================
      // SEARCH LIMIT
      // =================================================

      if (
        useSearch &&
        result.status === 429
      ) {
        return (
          "⚠️ Сейчас веб-поиск временно недоступен или достигнут лимит.\n\n" +
          "Я не буду выдавать старую информацию за сегодняшние новости. " +
          "Попробуй запрос чуть позже."
        );
      }


      // =================================================
      // 503
      // =================================================

      if (result.status === 503) {
        if (attempt < 3) {
          await sleep(
            attempt * 1200
          );

          continue;
        }

        break;
      }


      // 429 обычного Gemini
      if (result.status === 429) {
        break;
      }


      // модель недоступна
      if (result.status === 404) {
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
// TELEGRAM VOICE DOWNLOAD
// =====================================================

async function downloadTelegramVoice(fileId) {
  const fileInfo =
    await tg(
      "getFile",
      {
        file_id: fileId
      }
    );


  const filePath =
    fileInfo.result?.file_path;


  if (!filePath) {
    throw new Error(
      "Telegram file path missing"
    );
  }


  const fileUrl =
    `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;


  const response =
    await fetch(fileUrl);


  if (!response.ok) {
    throw new Error(
      `Voice download failed ${response.status}`
    );
  }


  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );


  return {
    buffer,
    mimeType:
      "audio/ogg"
  };
}


// =====================================================
// GEMINI AUDIO
// =====================================================

async function askGeminiWithVoice(
  chatId,
  voice
) {
  if (!GEMINI_API_KEY) {
    return (
      "⚠️ GEMINI_API_KEY не настроен."
    );
  }


  let audio;


  try {
    audio =
      await downloadTelegramVoice(
        voice.file_id
      );

  } catch (error) {
    console.error(
      "Voice download error:",
      error
    );

    return (
      "⚠️ Не удалось скачать голосовое сообщение."
    );
  }


  const base64 =
    audio.buffer.toString(
      "base64"
    );


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

      const body = {
        systemInstruction: {
          parts: [
            {
              text:
                "You are an AI assistant inside Telegram. " +

                "Listen carefully to the user's voice message. " +

                "Understand what the user says and answer their request directly. " +

                "Answer in the same language spoken by the user. " +

                "Use conversation context when useful. " +

                "Do not only provide a transcription unless the user asks for transcription."
            }
          ]
        },

        contents: [
          ...getHistory(chatId),

          {
            role: "user",
            parts: [
              {
                text:
                  "This is my voice message. Listen to it and respond to what I said."
              },

              {
                inlineData: {
                  mimeType:
                    audio.mimeType,

                  data:
                    base64
                }
              }
            ]
          }
        ],

        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048
        }
      };


      try {
        const response =
          await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
            {
              method: "POST",

              headers: {
                "Content-Type":
                  "application/json",

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

            // Голосовое сохраняем в историю
            // как условное сообщение пользователя.
            rememberExchange(
              chatId,
              "[Голосовое сообщение пользователя]",
              answer
            );


            return answer;
          }
        }


        console.error(
          `Gemini voice error model=${model}`,
          response.status,
          JSON.stringify(data)
        );


        if (
          response.status === 503 &&
          attempt < 3
        ) {
          await sleep(
            attempt * 1200
          );

          continue;
        }


        break;

      } catch (error) {
        console.error(
          "Gemini voice network error:",
          error
        );


        if (attempt < 3) {
          await sleep(
            attempt * 1000
          );

          continue;
        }


        break;
      }
    }
  }


  return (
    "⚠️ Сейчас не удалось обработать голосовое сообщение."
  );
}


// =====================================================
// MESSAGE HANDLER
// =====================================================

async function handleMessage(message) {
  const chatId =
    message.chat.id;


  // ===================================================
  // VOICE
  // ===================================================

  if (message.voice) {

    await tg(
      "sendChatAction",
      {
        chat_id: chatId,
        action: "typing"
      }
    );


    const answer =
      await askGeminiWithVoice(
        chatId,
        message.voice
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


  // START
  if (text === "/start") {

    clearHistory(chatId);


    return sendMessage(
      chatId,
      `Привет! 👋

Я AI-помощник на Gemini.

Можешь писать текстом или отправлять голосовые сообщения.

Я умею отвечать на обычные вопросы, смотреть погоду, время, курс валют и искать свежие новости.`
    );
  }


  // HELP
  if (text === "/help") {

    return sendMessage(
      chatId,
      `🤖 Примеры:

Какая погода в Полтаве?

А завтра?

Который час в Токио?

100 долларов в гривнах

Какие сегодня новости Fortnite?

Или просто отправь голосовое 🎤`
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
  // WEATHER FOLLOWUP
  // ===================================================

  if (
    isTomorrowWeatherFollowup(
      chatId,
      text
    )
  ) {

    const state =
      toolStates.get(chatId);


    const answer =
      await getTomorrowWeather(
        state.place
      );


    rememberExchange(
      chatId,
      text,
      answer
    );


    return sendMessage(
      chatId,
      answer
    );
  }


  // ===================================================
  // WEATHER
  // ===================================================

  if (isWeatherRequest(text)) {

    const place =
      await geocodeFromMessage(
        text
      );


    if (!place) {
      return sendMessage(
        chatId,
        `⚠️ Я не смог определить город.

Попробуй написать, например:

Погода Полтава

или:

Какая погода в Киеве?`
      );
    }


    const answer =
      await getCurrentWeather(
        place
      );


    toolStates.set(
      chatId,
      {
        type:
          "weather",

        place
      }
    );


    rememberExchange(
      chatId,
      text,
      answer
    );


    return sendMessage(
      chatId,
      answer
    );
  }


  // ===================================================
  // TIME
  // ===================================================

  if (isTimeRequest(text)) {

    const place =
      await geocodeFromMessage(
        text
      );


    if (!place) {
      return sendMessage(
        chatId,
        `⚠️ Я не смог определить город.

Например:

Который час в Токио?`
      );
    }


    const answer =
      await getCurrentTime(
        place
      );


    rememberExchange(
      chatId,
      text,
      answer
    );


    return sendMessage(
      chatId,
      answer
    );
  }


  // ===================================================
  // CURRENCY
  // ===================================================

  if (isCurrencyRequest(text)) {

    const answer =
      await getCurrencyRate(
        text
      );


    rememberExchange(
      chatId,
      text,
      answer
    );


    return sendMessage(
      chatId,
      answer
    );
  }


  // ===================================================
  // NEWS / SEARCH
  // ===================================================

  const useSearch =
    needsGoogleSearch(
      text
    );


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
    url.searchParams.get(
      "token"
    );


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
    url.searchParams.get(
      "token"
    );


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
