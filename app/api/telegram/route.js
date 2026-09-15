export const runtime = "nodejs";

// ======================================================
// AI GUIDE V6.1
// Telegram + OpenRouter + Tavily + Upstash Redis + Vision
// ======================================================


// ======================================================
// CONFIG
// ======================================================

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN;

const OPENROUTER_API_KEY =
  process.env.OPENROUTER_API_KEY;

const TAVILY_API_KEY =
  process.env.TAVILY_API_KEY;

const UPSTASH_REDIS_REST_URL =
  process.env.UPSTASH_REDIS_REST_URL;

const UPSTASH_REDIS_REST_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN;

const ALLOWED_USER_ID =
  process.env.TELEGRAM_ALLOWED_USER_ID
    ? Number(process.env.TELEGRAM_ALLOWED_USER_ID)
    : null;


const TELEGRAM_API =
  `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

const OPENROUTER_API =
  "https://openrouter.ai/api/v1/chat/completions";

const AI_MODEL =
  "openrouter/free";

const MAX_HISTORY_MESSAGES = 20;


// ======================================================
// REDIS
// ======================================================

function memoryKey(userId) {
  return `ai-guide:history:${userId}`;
}


async function redisCommand(command) {

  if (
    !UPSTASH_REDIS_REST_URL ||
    !UPSTASH_REDIS_REST_TOKEN
  ) {

    console.error(
      "❌ Redis not configured"
    );

    return null;
  }


  try {

    const response =
      await fetch(
        UPSTASH_REDIS_REST_URL,
        {
          method: "POST",

          headers: {

            Authorization:
              `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,

            "Content-Type":
              "application/json",

          },

          body:
            JSON.stringify(command),
        }
      );


    const raw =
      await response.text();


    if (!response.ok) {

      console.error(
        "❌ Redis:",
        raw
      );

      return null;
    }


    const data =
      JSON.parse(raw);


    return data.result;

  } catch (error) {

    console.error(
      "❌ Redis exception:",
      error
    );

    return null;
  }
}


async function getHistory(userId) {

  const result =
    await redisCommand([
      "GET",
      memoryKey(userId),
    ]);


  if (!result) {
    return [];
  }


  try {

    const history =
      JSON.parse(result);


    return Array.isArray(history)
      ? history
      : [];

  } catch {

    return [];
  }
}


async function saveHistory(
  userId,
  history
) {

  const trimmed =
    history.slice(
      -MAX_HISTORY_MESSAGES
    );


  await redisCommand([

    "SET",

    memoryKey(userId),

    JSON.stringify(trimmed),

  ]);
}


async function addHistory(
  userId,
  role,
  content
) {

  const history =
    await getHistory(userId);


  history.push({

    role,

    content:
      String(content)
        .slice(0, 5000),

  });


  await saveHistory(
    userId,
    history
  );
}


async function saveExchange(
  userId,
  userText,
  assistantText
) {

  const history =
    await getHistory(userId);


  history.push({

    role: "user",

    content:
      String(userText)
        .slice(0, 5000),

  });


  history.push({

    role: "assistant",

    content:
      String(assistantText)
        .slice(0, 5000),

  });


  await saveHistory(
    userId,
    history
  );
}


async function clearHistory(userId) {

  await redisCommand([

    "DEL",

    memoryKey(userId),

  ]);
}


// ======================================================
// TELEGRAM
// ======================================================

async function sendMessage(
  chatId,
  text
) {

  if (!text) {

    text =
      "Не удалось получить ответ.";

  }


  for (
    let i = 0;
    i < text.length;
    i += 4000
  ) {

    const part =
      text.slice(
        i,
        i + 4000
      );


    const response =
      await fetch(
        `${TELEGRAM_API}/sendMessage`,
        {

          method: "POST",

          headers: {

            "Content-Type":
              "application/json",

          },

          body:
            JSON.stringify({

              chat_id:
                chatId,

              text:
                part,

            }),

        }
      );


    if (!response.ok) {

      console.error(
        "❌ Telegram:",
        await response.text()
      );

    }
  }
}


// ======================================================
// TELEGRAM PHOTO
// ======================================================

async function getTelegramPhotoBase64(
  fileId
) {

  try {

    // Получаем путь к фото

    const infoResponse =
      await fetch(
        `${TELEGRAM_API}/getFile?file_id=${encodeURIComponent(fileId)}`
      );


    const info =
      await infoResponse.json();


    if (
      !info.ok ||
      !info.result?.file_path
    ) {

      console.error(
        "❌ Telegram getFile:",
        info
      );

      return null;
    }


    const filePath =
      info.result.file_path;


    // Скачиваем фото

    const imageResponse =
      await fetch(

        `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`

      );


    if (!imageResponse.ok) {

      console.error(
        "❌ Photo download:",
        imageResponse.status
      );

      return null;
    }


    const arrayBuffer =
      await imageResponse.arrayBuffer();


    const base64 =
      Buffer
        .from(arrayBuffer)
        .toString("base64");


    let mimeType =
      "image/jpeg";


    if (
      filePath
        .toLowerCase()
        .endsWith(".png")
    ) {

      mimeType =
        "image/png";

    }


    if (
      filePath
        .toLowerCase()
        .endsWith(".webp")
    ) {

      mimeType =
        "image/webp";

    }


    return (
      `data:${mimeType};base64,${base64}`
    );

  } catch (error) {

    console.error(
      "❌ Photo exception:",
      error
    );

    return null;
  }
}


// ======================================================
// LANGUAGE
// ======================================================

function detectLanguage(text) {

  const source =
    text || "";

  const t =
    source.toLowerCase();


  if (
    /[іїєґ]/i.test(source) ||

    /\b(що|цей|ця|зараз|сьогодні|поясни|виконай|зроби|скороти|новини|свіжі|останні)\b/i.test(t)
  ) {

    return "uk";

  }


  if (
    /[а-яё]/i.test(source)
  ) {

    return "ru";

  }


  if (source.trim()) {

    return "en";

  }


  // Фото без подписи

  return "ru";
}


function languageInstruction(language) {

  if (language === "uk") {

    return `
Відповідай українською мовою.
Пиши природно та зрозуміло.
`;

  }


  if (language === "en") {

    return `
Answer in English.
Write naturally and clearly.
`;

  }


  return `
Отвечай на русском языке.
Пиши естественно и понятно.
`;
}


// ======================================================
// TELEGRAM FORMAT RULES
// ======================================================

function telegramFormattingRules() {

  return `

========================================
ВАЖНО: ФОРМАТ TELEGRAM
========================================

Ответ будет показан как обычный текст
в Telegram.

Telegram в этом боте НЕ рендерит LaTeX.

НИКОГДА не используй LaTeX-команды:

\\[
\\]

\\(
\\)

\\frac

\\cdot

\\times

\\text

\\mathrm

\\sqrt

\\begin

\\end

\\boxed

^{}

_{}

Не оборачивай формулы в $ или $$.

Не пиши математические формулы
в формате LaTeX.

Пиши их обычными читаемыми символами.


ПРАВИЛЬНО:

5,4 · 10⁴

5 · 10⁶

1,02 · 10⁻²

R = U / I

S = a²

Q = I² · R · t

h = √(m · n)

x = (-b ± √D) / (2a)


НЕПРАВИЛЬНО:

5{,}4\\cdot10^4

\\frac{U}{I}

I^2R

\\sqrt{mn}

\\text{Ом}


Для умножения используй:

·

или

×

Для деления:

/

или

:

Для корня:

√

Для степеней по возможности используй:

²
³
⁴
⁵
⁶
⁷
⁸
⁹

Для степени 10 используй:

10⁻⁵
10⁻³
10²
10⁴
10⁸
10⁹

Если Unicode-степень неудобна,
можно написать:

10^12

Но НЕ используй LaTeX.

Единицы измерения пиши нормально:

Ом
В
А
Вт
Дж
Кл
м
см
кг
°C

`;
}


// ======================================================
// CLEAN TELEGRAM OUTPUT
// Дополнительная защита от LaTeX
// ======================================================

function superscriptNumber(value) {

  const map = {

    "0": "⁰",
    "1": "¹",
    "2": "²",
    "3": "³",
    "4": "⁴",
    "5": "⁵",
    "6": "⁶",
    "7": "⁷",
    "8": "⁸",
    "9": "⁹",

    "-": "⁻",
    "+": "⁺",

  };


  return String(value)
    .split("")
    .map(
      (char) =>
        map[char] || char
    )
    .join("");
}


function cleanTelegramMath(text) {

  if (!text) {
    return "";
  }


  let result =
    String(text);


  // ==========================================
  // МУСОР OPENROUTER
  // ==========================================

  result =
    result.replace(
      /<\|tool_call_start\|>[\s\S]*?<\|tool_call_end\|>/gi,
      ""
    );


  result =
    result.replace(
      /<\|tool_call_start\|>[\s\S]*$/gi,
      ""
    );


  result =
    result.replace(
      /<\|tool_call_end\|>/gi,
      ""
    );


  result =
    result.replace(
      /<\|tool_call[^>]*\|>/gi,
      ""
    );


  result =
    result.replace(
      /^\s*User Safety\s*:\s*safe\s*$/gim,
      ""
    );


  result =
    result.replace(
      /^\s*Response Safety\s*:\s*safe\s*$/gim,
      ""
    );


  result =
    result.replace(
      /^\s*Safety\s*:\s*safe\s*$/gim,
      ""
    );


  result =
    result.replace(
      /^\s*google\s*\([^\n]*\)\s*$/gim,
      ""
    );


  // ==========================================
  // LATEX WRAPPERS
  // ==========================================

  result =
    result.replace(
      /\\\[/g,
      ""
    );


  result =
    result.replace(
      /\\\]/g,
      ""
    );


  result =
    result.replace(
      /\\\(/g,
      ""
    );


  result =
    result.replace(
      /\\\)/g,
      ""
    );


  result =
    result.replace(
      /\$\$/g,
      ""
    );


  // ==========================================
  // ПРОСТЫЕ LATEX-КОМАНДЫ
  // ==========================================

  result =
    result.replace(
      /\\cdot/g,
      "·"
    );


  result =
    result.replace(
      /\\times/g,
      "×"
    );


  result =
    result.replace(
      /\\div/g,
      "÷"
    );


  result =
    result.replace(
      /\\pm/g,
      "±"
    );


  result =
    result.replace(
      /\\approx/g,
      "≈"
    );


  result =
    result.replace(
      /\\neq/g,
      "≠"
    );


  result =
    result.replace(
      /\\leq/g,
      "≤"
    );


  result =
    result.replace(
      /\\geq/g,
      "≥"
    );


  result =
    result.replace(
      /\\alpha/g,
      "α"
    );


  result =
    result.replace(
      /\\beta/g,
      "β"
    );


  result =
    result.replace(
      /\\gamma/g,
      "γ"
    );


  result =
    result.replace(
      /\\Delta/g,
      "Δ"
    );


  result =
    result.replace(
      /\\pi/g,
      "π"
    );


  // ==========================================
  // \text{...}
  // ==========================================

  result =
    result.replace(
      /\\text\{([^{}]*)\}/g,
      "$1"
    );


  result =
    result.replace(
      /\\mathrm\{([^{}]*)\}/g,
      "$1"
    );


  // ==========================================
  // \sqrt{...}
  // ==========================================

  result =
    result.replace(
      /\\sqrt\{([^{}]*)\}/g,
      "√($1)"
    );


  // ==========================================
  // \frac{a}{b}
  // Простые дроби
  // ==========================================

  for (
    let i = 0;
    i < 5;
    i++
  ) {

    result =
      result.replace(
        /\\frac\{([^{}]+)\}\{([^{}]+)\}/g,
        "($1) / ($2)"
      );

  }


  // ==========================================
  // 10^{4} -> 10⁴
  // ==========================================

  result =
    result.replace(
      /10\^\{([+\-]?\d+)\}/g,
      (_, power) =>
        "10" +
        superscriptNumber(power)
    );


  result =
    result.replace(
      /10\^([+\-]?\d+)/g,
      (_, power) =>
        "10" +
        superscriptNumber(power)
    );


  // ==========================================
  // x^{2} -> x²
  // ==========================================

  result =
    result.replace(
      /([A-Za-zА-Яа-яІіЇїЄєҐґ0-9)])\^\{([+\-]?\d+)\}/g,
      (_, base, power) =>
        base +
        superscriptNumber(power)
    );


  // ==========================================
  // Убираем {,} из LaTeX
  // 5{,}4 -> 5,4
  // ==========================================

  result =
    result.replace(
      /\{,\}/g,
      ","
    );


  // ==========================================
  // Простые нижние индексы:
  // R_{0} -> R₀
  // ==========================================

  result =
    result.replace(
      /_\{(\d+)\}/g,
      (_, number) =>
        superscriptNumber(number)
    );


  // ==========================================
  // Остатки команд
  // ==========================================

  result =
    result.replace(
      /\\,/g,
      " "
    );


  result =
    result.replace(
      /\\;/g,
      " "
    );


  result =
    result.replace(
      /\\!/g,
      ""
    );


  // ==========================================
  // Пустые строки
  // ==========================================

  result =
    result.replace(
      /\n{3,}/g,
      "\n\n"
    );


  return result.trim();
}


// ======================================================
// INTERNET
// ======================================================

function needsInternet(text) {

  if (!text) {
    return false;
  }


  const t =
    text.toLowerCase();


  const triggers = [

    "сейчас",
    "сегодня",
    "вчера",
    "завтра",
    "свеж",
    "актуаль",
    "последн",
    "недавно",

    "новости",
    "что нового",
    "что там с",
    "что там по",
    "что произошло",
    "что случилось",

    "погода",
    "температура",
    "дождь",
    "снег",
    "ветер",

    "курс",
    "доллар",
    "долара",
    "евро",
    "гривн",
    "usd",
    "uah",
    "eur",

    "цена",
    "сколько стоит",

    "обновление",
    "обнова",
    "патч",
    "вышел",
    "вышла",
    "вышло",
    "выйдет",
    "релиз",

    "утечк",
    "слив",
    "сливал",
    "слили",
    "инсайдер",
    "инсайд",

    "зараз",
    "сьогодні",
    "свіж",
    "останні",
    "новини",
    "що нового",
    "ціна",
    "скільки коштує",
    "оновлення",
    "витік",

    "today",
    "current",
    "currently",
    "latest",
    "recent",
    "news",
    "weather",
    "price",
    "update",
    "release",
    "leak",

  ];


  return triggers.some(
    (trigger) =>
      t.includes(trigger)
  );
}


// ======================================================
// FOLLOW UP
// ======================================================

function isContextFollowUp(text) {

  if (!text) {
    return false;
  }


  const t =
    text
      .toLowerCase()
      .trim();


  const patterns = [

    "по этому",
    "про это",
    "об этом",
    "по этому делу",

    "про него",
    "про неё",
    "про них",

    "а сейчас",
    "а сегодня",

    "а что сейчас",
    "а что нового",

    "дай свеж",
    "свежие новости",

    "подробнее",
    "поподробнее",

    "что с ним",
    "что с ней",

    "про це",
    "по цьому",
    "про нього",

    "що нового",
    "свіжі новини",

    "about it",
    "about this",
    "latest on this",

  ];


  return patterns.some(
    (pattern) =>
      t.includes(pattern)
  );
}


// ======================================================
// CONVERSATION CONTEXT
// ======================================================

async function getConversationContext(
  userId
) {

  const history =
    await getHistory(userId);


  return history
    .slice(-8)
    .map(
      (item) => {

        const speaker =
          item.role === "user"
            ? "User"
            : "Assistant";


        return (
          `${speaker}: ` +
          `${String(item.content).slice(0, 1200)}`
        );

      }
    )
    .join("\n");
}


// ======================================================
// SEARCH QUERY
// ======================================================

async function buildSearchQuery(
  text,
  userId,
  language
) {

  const t =
    text.toLowerCase();


  const genericDollar =

    t.includes(
      "курс доллара"
    ) ||

    t.includes(
      "курс долара"
    );


  const anotherCurrency =

    t.includes("руб") ||

    t.includes("rub") ||

    t.includes("евро") ||

    t.includes("eur") ||

    t.includes("злот") ||

    t.includes("pln") ||

    t.includes("тенге");


  if (
    genericDollar &&
    !anotherCurrency
  ) {

    if (language === "uk") {

      return (
        "актуальний курс долара США " +
        "до української гривні " +
        "USD UAH сьогодні Україна"
      );

    }


    return (
      "актуальный курс доллара США " +
      "к украинской гривне " +
      "USD UAH сегодня Украина"
    );
  }


  if (
    isContextFollowUp(text)
  ) {

    const context =
      await getConversationContext(
        userId
      );


    if (context) {

      return `

Найди самую свежую информацию
по теме разговора.

КОНТЕКСТ:

${context}

ТЕКУЩИЙ ВОПРОС:

${text}

Определи конкретную тему
из предыдущих сообщений.

Особенно учитывай:

имена,
названия,
игры,
компании,
события,
даты,
утечки,
новости.

Не ищи только короткую фразу
из текущего сообщения.

`.trim();

    }
  }


  return text;
}


// ======================================================
// TAVILY
// ======================================================

async function searchWeb(query) {

  if (!TAVILY_API_KEY) {

    console.error(
      "❌ Tavily not configured"
    );

    return null;
  }


  try {

    console.log(
      "🌐 Tavily:",
      query.slice(0, 1500)
    );


    const response =
      await fetch(
        "https://api.tavily.com/search",
        {

          method: "POST",

          headers: {

            "Content-Type":
              "application/json",

            Authorization:
              `Bearer ${TAVILY_API_KEY}`,

          },

          body:
            JSON.stringify({

              query,

              search_depth:
                "basic",

              max_results:
                7,

              include_answer:
                true,

              include_raw_content:
                false,

            }),

        }
      );


    const raw =
      await response.text();


    if (!response.ok) {

      console.error(
        "❌ Tavily:",
        raw
      );

      return null;
    }


    return JSON.parse(raw);

  } catch (error) {

    console.error(
      "❌ Tavily exception:",
      error
    );

    return null;
  }
}


// ======================================================
// WEB CONTEXT
// ======================================================

function makeWebContext(data) {

  if (!data) {
    return null;
  }


  let result = "";


  if (data.answer) {

    result += `

SEARCH SUMMARY:

${data.answer}

`;

  }


  if (
    Array.isArray(
      data.results
    )
  ) {

    result +=
      data.results
        .slice(0, 7)
        .map(
          (
            item,
            index
          ) => `

RESULT ${index + 1}

TITLE:
${item.title || "Unknown"}

CONTENT:
${item.content || "Unknown"}

URL:
${item.url || "Unknown"}

`
        )
        .join("\n");

  }


  return (
    result.trim() ||
    null
  );
}


// ======================================================
// OPENROUTER
// ======================================================

async function requestOpenRouter(
  messages,
  options = {}
) {

  if (!OPENROUTER_API_KEY) {
    return null;
  }


  try {

    const response =
      await fetch(
        OPENROUTER_API,
        {

          method: "POST",

          headers: {

            "Content-Type":
              "application/json",

            Authorization:
              `Bearer ${OPENROUTER_API_KEY}`,

            "X-Title":
              "AI Guide Telegram Bot",

          },

          body:
            JSON.stringify({

              model:
                AI_MODEL,

              messages,

              temperature:
                options.temperature ?? 0.45,

              max_tokens:
                options.maxTokens ?? 1800,

            }),

        }
      );


    const raw =
      await response.text();


    console.log(
      "🤖 OpenRouter:",
      response.status
    );


    if (!response.ok) {

      console.error(
        "❌ OpenRouter:",
        raw
      );

      return null;
    }


    const data =
      JSON.parse(raw);


    return (
      data
        ?.choices
        ?.[0]
        ?.message
        ?.content ||
      null
    );

  } catch (error) {

    console.error(
      "❌ OpenRouter exception:",
      error
    );

    return null;
  }
}


// ======================================================
// NORMAL AI
// ======================================================

async function askAI({

  text,

  userId,

  language,

  webContext,

}) {

  const currentTime =
    new Date()
      .toLocaleString(
        "ru-RU",
        {
          timeZone:
            "Europe/Kyiv",
        }
      );


  let systemPrompt = `

Ты AI Guide —
персональный AI-ассистент
пользователя в Telegram.

Текущая дата и время:

${currentTime}

${languageInstruction(language)}

Учитывай предыдущую историю
разговора.

Понимай продолжения:

"сократи"
"сделай короче"
"подробнее"
"объясни проще"
"а почему?"
"про него"
"по этому делу"
"твой прошлый ответ"
"позапрошлый ответ"

Если нужная информация
уже есть в истории,
не проси пользователя
отправлять её снова.


========================================
ТОЧНОСТЬ
========================================

Не придумывай факты.

Если не уверен —
так и скажи.

Если это школьная задача,
сначала правильно пойми условие,
потом решай.

Если пользователь просит
конкретный номер задания,
выполняй именно этот номер,
а не все задания подряд.


========================================
ИНТЕРНЕТ
========================================

Ты не управляешь поиском.

Не вызывай самостоятельно:

Google
google(...)
search(...)
browser(...)
tools
functions

Если WEB DATA есть,
поиск уже выполнен сервером.

Для свежей информации
используй WEB DATA.

Следи за датами.

Не заменяй событие 2026 года
похожим событием 2022 года.

Не показывай сырые URL,
если пользователь сам
не попросил ссылки.


========================================
ВАЛЮТА
========================================

Если пользователь просто спрашивает
"курс доллара",
подразумевай USD -> UAH.

${telegramFormattingRules()}

`;


  if (webContext) {

    systemPrompt += `

========================================
WEB DATA
========================================

${webContext}

========================================

Это результаты свежего поиска.

Используй только информацию,
относящуюся к вопросу.

Проверяй даты.

Если поиск не подтверждает
какое-либо утверждение,
не придумывай подтверждение.

Если точных данных нет —
честно скажи об этом.

`;

  }


  const history =
    await getHistory(userId);


  const messages = [

    {

      role:
        "system",

      content:
        systemPrompt,

    },

    ...history,

    {

      role:
        "user",

      content:
        text,

    },

  ];


  let answer =
    await requestOpenRouter(
      messages
    );


  answer =
    cleanTelegramMath(
      answer
    );


  return (
    answer ||
    "⚠️ Не удалось получить нормальный ответ. Попробуй ещё раз."
  );
}


// ======================================================
// VISION
// ======================================================

async function visionRequest({

  imageData,

  caption,

  history,

  language,

  attempt,

}) {

  const systemPrompt = `

Ты AI Guide —
AI-ассистент в Telegram.

Пользователь отправил изображение.

${languageInstruction(language)}

ВНИМАТЕЛЬНО изучи изображение.


========================================
ВАЖНО: ЧТО ИМЕННО ПРОСИТ ПОЛЬЗОВАТЕЛЬ
========================================

Сначала прочитай подпись пользователя.

Подпись:

"${caption || "Подписи нет"}"


Если пользователь пишет:

"виконай вправу 3"
"зроби вправу 3"
"реши упражнение 3"
"зроби №3"
"виконай 3"
"реши пункт 3"

и на изображении находится
"ВПРАВА №1",
внутри которой есть пункты
1, 2, 3, 4...

то пользователь, скорее всего,
просит выполнить ПУНКТ 3.

В таком случае выполняй
ТОЛЬКО пункт 3.

Не решай автоматически
все пункты 1-8.


Если на изображении действительно
есть отдельное задание или упражнение
с номером 3,
тогда выполняй именно его.


Всегда сопоставляй просьбу
с реальной структурой изображения.


========================================
НЕ ГАЛЛЮЦИНИРУЙ
========================================

Не придумывай текст,
которого нет на изображении.

Не придумывай числа.

Не придумывай условия задачи.

Не заменяй плохо читаемый текст
похожим заданием из памяти.

Если важная часть изображения
реально не читается,
скажи конкретно,
какая часть не читается.


========================================
ШКОЛЬНЫЕ ЗАДАНИЯ
========================================

Если это школьное задание:

1. Определи предмет.

2. Прочитай точное условие.

3. Определи,
   какой номер попросил пользователь.

4. Выполни именно его.

5. Проверь вычисления.

6. Дай понятный ответ.

Не добавляй решения других заданий,
если пользователь их не просил.


========================================
ФИЗИКА И МАТЕМАТИКА
========================================

Проверяй:

знаки,
степени,
единицы измерения,
формулы,
арифметику.

Не меняй вопрос задачи.

Например:

если спрашивают сопротивление,
не начинай вычислять мощность,
если это не требуется.


========================================
СКРИНШОТЫ
========================================

Если это скриншот ошибки программы:

прочитай ошибку,
объясни причину,
дай конкретное решение.


========================================
ОБЫЧНЫЕ ФОТО
========================================

Если это обычная фотография,
ответь на вопрос пользователя
о том, что видно.

Если подписи нет,
кратко опиши главное
и спроси/предложи,
чем помочь.


${telegramFormattingRules()}


========================================
ПОПЫТКА
========================================

Это попытка анализа №${attempt}.

Если изображение доступно,
обязательно постарайся
реально его проанализировать.

`;


  const userPrompt =
    caption ||
    "Внимательно проанализируй изображение. Опиши главное и помоги с заданием, текстом или проблемой, если они есть.";


  const messages = [

    {

      role:
        "system",

      content:
        systemPrompt,

    },

    ...history,

    {

      role:
        "user",

      content: [

        {

          type:
            "text",

          text:
            userPrompt,

        },

        {

          type:
            "image_url",

          image_url: {

            url:
              imageData,

          },

        },

      ],

    },

  ];


  return await requestOpenRouter(
    messages,
    {
      temperature: 0.25,
      maxTokens: 2200,
    }
  );
}


// ======================================================
// VISION WITH RETRY
// ======================================================

async function askVisionAI({

  imageData,

  caption,

  userId,

  language,

}) {

  const history =
    await getHistory(userId);


  const safeHistory =
    history.slice(-10);


  // ==================================================
  // TRY 1
  // ==================================================

  console.log(
    "📷 Vision attempt 1"
  );


  let answer =
    await visionRequest({

      imageData,

      caption,

      history:
        safeHistory,

      language,

      attempt: 1,

    });


  answer =
    cleanTelegramMath(
      answer
    );


  // ==================================================
  // ЕСЛИ ПЕРВАЯ МОДЕЛЬ НЕ ОТВЕТИЛА
  // ПРОБУЕМ ЕЩЁ РАЗ
  // ==================================================

  if (
    !answer ||
    answer.length < 10
  ) {

    console.log(
      "⚠️ Vision retry..."
    );


    answer =
      await visionRequest({

        imageData,

        caption,

        history:
          safeHistory,

        language,

        attempt: 2,

      });


    answer =
      cleanTelegramMath(
        answer
      );

  }


  if (!answer) {

    if (language === "uk") {

      return (
        "⚠️ Не вдалося проаналізувати зображення. " +
        "Спробуй надіслати його ще раз."
      );

    }


    if (language === "en") {

      return (
        "⚠️ I couldn't analyze the image. " +
        "Please try sending it again."
      );

    }


    return (
      "⚠️ Не удалось проанализировать изображение. " +
      "Попробуй отправить его ещё раз."
    );
  }


  return answer;
}


// ======================================================
// POST
// ======================================================

export async function POST(request) {

  try {

    console.log(
      "🚀 AI-GUIDE-V6.1"
    );


    const update =
      await request.json();


    const message =
      update.message;


    if (!message) {

      return Response.json({
        ok: true,
      });

    }


    const chatId =
      message.chat?.id;


    const userId =
      message.from?.id;


    // ==================================================
    // PRIVATE MODE
    // ==================================================

    if (
      ALLOWED_USER_ID &&
      userId !==
        ALLOWED_USER_ID
    ) {

      await sendMessage(
        chatId,
        "⛔ Это приватный бот."
      );


      return Response.json({
        ok: true,
      });

    }


    // ==================================================
    // PHOTO
    // ==================================================

    if (
      Array.isArray(
        message.photo
      ) &&
      message.photo.length > 0
    ) {

      console.log(
        "📷 Photo received"
      );


      const biggestPhoto =
        message.photo[
          message.photo.length - 1
        ];


      const fileId =
        biggestPhoto.file_id;


      const caption =
        message.caption?.trim() ||
        "";


      const language =
        detectLanguage(
          caption
        );


      const imageData =
        await getTelegramPhotoBase64(
          fileId
        );


      if (!imageData) {

        await sendMessage(
          chatId,
          "⚠️ Не удалось скачать изображение из Telegram."
        );


        return Response.json({
          ok: true,
        });

      }


      console.log(
        "✅ Photo downloaded"
      );


      const answer =
        await askVisionAI({

          imageData,

          caption,

          userId,

          language,

        });


      // ==================================================
      // SAVE PHOTO CONTEXT
      // ==================================================

      const memoryDescription =
        caption

          ? (
              "[Пользователь отправил изображение]\n" +
              "Подпись: " +
              caption
            )

          : (
              "[Пользователь отправил изображение без подписи]"
            );


      await saveExchange(

        userId,

        memoryDescription,

        answer

      );


      // ==================================================
      // SEND
      // ==================================================

      await sendMessage(
        chatId,
        answer
      );


      console.log(
        "✅ Vision answer sent"
      );


      return Response.json({
        ok: true,
      });

    }


    // ==================================================
    // TEXT
    // ==================================================

    const text =
      message.text?.trim();


    if (!text) {

      await sendMessage(
        chatId,
        "Пока я поддерживаю текст и фотографии 📷"
      );


      return Response.json({
        ok: true,
      });

    }


    console.log(
      "💬 User:",
      text
    );


    // ==================================================
    // CLEAR
    // ==================================================

    if (
      text.toLowerCase() ===
        "/clear" ||

      text.toLowerCase() ===
        "/reset"
    ) {

      await clearHistory(
        userId
      );


      await sendMessage(
        chatId,
        "🧹 История разговора очищена."
      );


      return Response.json({
        ok: true,
      });

    }


    // ==================================================
    // LANGUAGE
    // ==================================================

    const language =
      detectLanguage(text);


    // ==================================================
    // INTERNET
    // ==================================================

    let webContext =
      null;


    if (
      needsInternet(text)
    ) {

      console.log(
        "🌐 Internet required"
      );


      const searchQuery =
        await buildSearchQuery(

          text,

          userId,

          language

        );


      const webData =
        await searchWeb(
          searchQuery
        );


      webContext =
        makeWebContext(
          webData
        );


      if (webContext) {

        console.log(
          "✅ WEB DATA ready"
        );

      } else {

        console.log(
          "⚠️ WEB DATA empty"
        );

      }

    }


    // ==================================================
    // AI
    // ==================================================

    const answer =
      await askAI({

        text,

        userId,

        language,

        webContext,

      });


    // ==================================================
    // MEMORY
    // ==================================================

    await saveExchange(

      userId,

      text,

      answer

    );


    console.log(
      "💾 Saved to Redis"
    );


    // ==================================================
    // SEND
    // ==================================================

    await sendMessage(
      chatId,
      answer
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
// GET STATUS
// ======================================================

export async function GET() {

  return Response.json({

    version:
      "AI-GUIDE-V6.1",

    status:
      "Bot is running",

    telegram:
      !!TELEGRAM_BOT_TOKEN,

    openrouter:
      !!OPENROUTER_API_KEY,

    tavily:
      !!TAVILY_API_KEY,

    redis:
      !!(
        UPSTASH_REDIS_REST_URL &&
        UPSTASH_REDIS_REST_TOKEN
      ),

    privateMode:
      !!ALLOWED_USER_ID,

    memory:
      (
        UPSTASH_REDIS_REST_URL &&
        UPSTASH_REDIS_REST_TOKEN
      )
        ? "Upstash Redis"
        : "NOT CONFIGURED",

    vision:
      true,

    visionRetry:
      true,

    telegramMath:
      "Plain text / Unicode",

    latex:
      false,

    search:
      "Tavily",

    model:
      AI_MODEL,

  });
}
