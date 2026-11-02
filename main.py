import os
import uuid

import groq
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from groq import AsyncGroq
from pydantic import BaseModel, Field

load_dotenv(override=True)

API_KEY = os.getenv("GROQ_API_KEY")
if not API_KEY:
    raise RuntimeError("GROQ_API_KEY is missing. Add it to your .env file.")

MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
print(f"Using model: {MODEL}")

client = AsyncGroq(api_key=API_KEY)

SYSTEM_PROMPT = """You are a friendly, knowledgeable assistant. You can:
- answer questions clearly and accurately
- write and improve content (emails, stories, summaries)
- translate text between languages
- write, explain, and debug code
Put all code in fenced Markdown code blocks with a language tag.
Keep answers concise unless the user asks for detail.
If you are unsure, say so instead of guessing."""

MAX_HISTORY = 20  # messages kept per session (keeps requests small)

app = FastAPI(title="Groq Chatbot")

# In-memory chat history: {session_id: [messages]}. Use Redis/a DB in production.
sessions: dict[str, list[dict]] = {}


class ChatRequest(BaseModel):
    session_id: str | None = None
    message: str = Field(min_length=1, max_length=4000)


class ChatResponse(BaseModel):
    session_id: str
    reply: str


@app.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    sid = req.session_id or str(uuid.uuid4())
    history = sessions.setdefault(sid, [])
    history.append({"role": "user", "content": req.message})

    messages = [{"role": "system", "content": SYSTEM_PROMPT}] + history[-MAX_HISTORY:]

    try:
        response = await client.chat.completions.create(
            model=MODEL,
            messages=messages,
            temperature=0.7,
        )
    except groq.AuthenticationError:
        history.pop()
        raise HTTPException(status_code=502, detail="Invalid Groq API key. Check your .env file.")
    except groq.NotFoundError:
        history.pop()
        raise HTTPException(status_code=502, detail=f"Model '{MODEL}' not found. Update GROQ_MODEL in .env.")
    except groq.RateLimitError:
        history.pop()
        raise HTTPException(status_code=429, detail="Rate limit reached. Wait a minute and retry.")
    except Exception as e:
        print(f"Groq error: {e}")
        history.pop()
        raise HTTPException(status_code=502, detail="The AI service failed. Check the server logs.")

    reply = response.choices[0].message.content or "(No response)"
    history.append({"role": "assistant", "content": reply})
    return ChatResponse(session_id=sid, reply=reply)


@app.post("/api/reset")
async def reset(session_id: str):
    sessions.pop(session_id, None)
    return {"status": "cleared"}


# Serve the frontend. This must come AFTER the API routes.
app.mount("/", StaticFiles(directory="static", html=True), name="static")
