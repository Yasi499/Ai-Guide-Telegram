const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;

async function tg(method, payload) {
  const r = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function sendMessage(chatId, text) {
  const parts = text.match(/[\\s\\S]{1,4000}/g) || ["Не вдалося отримати відповідь."];
  for (const part of parts) await tg("sendMessage", {chat_id: chatId, text: part});
}

async function askGemini(text) {
  if (!GEMINI_API_KEY) return "GEMINI_API_KEY не налаштований у Vercel.";

  const r = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    {
      method: "POST",
      headers: {
        "Content-Type":"application/json",
        "x-goog-api-key": GEMINI_API_KEY
      },
      body: JSON.stringify({
        systemInstruction: {parts:[{text:
          "You are a helpful Telegram AI assistant. Always answer in the same language as the user's latest message. Be clear, natural and concise."
        }]},
        contents:[{role:"user",parts:[{text}]}]
      })
    }
  );

  const data = await r.json();
  if (!r.ok) {
    console.error("Gemini error:", JSON.stringify(data));
    return "Gemini зараз не зміг відповісти. Перевір Vercel Logs.";
  }

  return data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim()
    || "Не вдалося отримати відповідь від Gemini.";
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = (message.text || "").trim();
  if (!text) return;

  if (text === "/start") {
    return sendMessage(chatId, "Привіт! Я Gemini-бот. Просто напиши мені будь-яке повідомлення.");
  }

  await tg("sendChatAction", {chat_id: chatId, action:"typing"});
  return sendMessage(chatId, await askGemini(text));
}

export async function GET(request) {
  const token = new URL(request.url).searchParams.get("token");
  if (!BOT_TOKEN) return Response.json({ok:false,error:"TELEGRAM_BOT_TOKEN is not set"},{status:500});
  if (token !== BOT_TOKEN) return Response.json({ok:false,error:"Invalid token"},{status:401});
  return Response.json({ok:true,message:"Gemini Telegram webhook is ready"});
}

export async function POST(request) {
  const token = new URL(request.url).searchParams.get("token");
  if (!BOT_TOKEN) return Response.json({ok:false,error:"TELEGRAM_BOT_TOKEN is not set"},{status:500});
  if (token !== BOT_TOKEN) return Response.json({ok:false,error:"Invalid token"},{status:401});

  try {
    const update = await request.json();
    if (update.message) await handleMessage(update.message);
    return Response.json({ok:true});
  } catch (e) {
    console.error("Webhook error:", e);
    return Response.json({ok:false,error:"Webhook handler failed"},{status:500});
  }
}
