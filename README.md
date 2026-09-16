# AI Guide V7.7.0

Telegram AI assistant on Next.js 16 App Router and Vercel.

Main features:

- Groq text chat with fallback model;
- Groq Vision with Gemini fallback;
- photos, albums, videos and Telegram video notes;
- Whisper voice/audio transcription;
- stickers, custom emoji and GIF reactions;
- Tavily web search;
- Upstash conversation memory;
- Telegram reply graph and active-task context;
- follow-up re-analysis of saved media.

Vercel environment variables:

- TELEGRAM_BOT_TOKEN
- GROQ_API_KEY
- GEMINI_API_KEY
- TAVILY_API_KEY
- UPSTASH_REDIS_REST_URL
- UPSTASH_REDIS_REST_TOKEN
- TELEGRAM_ALLOWED_USER_ID (optional)

Webhook:

https://YOUR-DOMAIN.vercel.app/api/telegram?token=YOUR_TELEGRAM_BOT_TOKEN
