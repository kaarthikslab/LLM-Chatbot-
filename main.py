import os
from typing import Literal

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

SYSTEM_PROMPT = """You are a precise, knowledgeable assistant. You answer questions, write content, translate text, and write and debug code.

Formatting rules (important):
- Reply in clean Markdown.
- Use short paragraphs. Use "##" headings only for longer answers.
- Use bullet or numbered lists for steps and options, and tables for comparisons.
- Do not use emojis, decorative symbols, horizontal rules, or ASCII art.
- Use bold sparingly, only for key terms.
- Put all code in fenced code blocks with a language tag. Never put normal prose in a code block.
- Keep answers concise unless the user asks for detail. If unsure, say so."""

MAX_HISTORY = 20  # previous messages sent to the model with each request

app = FastAPI(title="LLM Chatbot")


class Msg(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=20000)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    # Chat history lives in the browser (localStorage) and is sent with each request,
    # so the server stays stateless and survives restarts.
    history: list[Msg] = Field(default_factory=list, max_length=60)


class ChatResponse(BaseModel):
    reply: str


@app.get("/api/info")
async def info():
    return {"model": MODEL}


@app.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    messages = (
        [{"role": "system", "content": SYSTEM_PROMPT}]
        + [m.model_dump() for m in req.history[-MAX_HISTORY:]]
        + [{"role": "user", "content": req.message}]
    )
    try:
        response = await client.chat.completions.create(
            model=MODEL, messages=messages, temperature=0.6
        )
    except groq.AuthenticationError:
        raise HTTPException(status_code=502, detail="Invalid Groq API key. Check your .env file.")
    except groq.NotFoundError:
        raise HTTPException(status_code=502, detail=f"Model '{MODEL}' not found. Update GROQ_MODEL in .env.")
    except groq.RateLimitError:
        raise HTTPException(status_code=429, detail="Rate limit reached. Wait a minute and retry.")
    except Exception as e:
        print(f"Groq error: {e}")
        raise HTTPException(status_code=502, detail="The AI service failed. Check the server logs.")

    return ChatResponse(reply=response.choices[0].message.content or "(No response)")


# Serve the frontend. This must come AFTER the API routes.
app.mount("/", StaticFiles(directory="static", html=True), name="static")
