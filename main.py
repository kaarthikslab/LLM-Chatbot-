import os
import uuid

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from google import genai
from google.genai import types
from pydantic import BaseModel, Field

load_dotenv()

API_KEY = os.getenv("GEMINI_API_KEY")
if not API_KEY:
    raise RuntimeError("GEMINI_API_KEY is missing. Add it to your .env file.")

MODEL = os.getenv("GEMINI_MODEL", "gemini-3.8-flash")
print(f"Using model: {MODEL}")

client = genai.Client(api_key=API_KEY)

SYSTEM_PROMPT = """You are a friendly, knowledgeable assistant. You can:
- answer questions clearly and accurately
- write and improve content (emails, stories, summaries)
- translate text between languages
- write, explain, and debug code
Put all code in fenced Markdown code blocks with a language tag.
Keep answers concise unless the user asks for detail.
If you are unsure, say so instead of guessing."""

config = types.GenerateContentConfig(
    system_instruction=SYSTEM_PROMPT,
    temperature=0.7,
)

app = FastAPI(title="Gemini Chatbot")

# In-memory chat sessions: {session_id: chat}. Use Redis/a DB in production.
sessions: dict = {}


class ChatRequest(BaseModel):
    session_id: str | None = None
    message: str = Field(min_length=1, max_length=4000)


class ChatResponse(BaseModel):
    session_id: str
    reply: str


@app.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    sid = req.session_id or str(uuid.uuid4())

    chat_session = sessions.get(sid)
    if chat_session is None:
        chat_session = client.aio.chats.create(model=MODEL, config=config)
        sessions[sid] = chat_session

    try:
        response = await chat_session.send_message(req.message)
    except Exception as e:
        msg = str(e)
        print(f"Gemini error: {msg}")
        if "API key" in msg or "API_KEY_INVALID" in msg:
            detail = "Invalid Gemini API key. Check your .env file."
        elif "NOT_FOUND" in msg or "404" in msg:
            detail = f"Model '{MODEL}' not found. Update GEMINI_MODEL in .env."
        elif "429" in msg or "RESOURCE_EXHAUSTED" in msg:
            detail = "Rate limit reached. Wait a minute and retry."
        else:
            detail = "The AI service failed. Check the server logs."
        raise HTTPException(status_code=502, detail=detail)

    return ChatResponse(session_id=sid, reply=response.text or "(No response)")


@app.post("/api/reset")
async def reset(session_id: str):
    sessions.pop(session_id, None)
    return {"status": "cleared"}


# Serve the frontend. This must come AFTER the API routes.
app.mount("/", StaticFiles(directory="static", html=True), name="static")
