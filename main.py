import hashlib
import json
import os
import time
from collections import OrderedDict
from typing import Literal

import groq
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from groq import AsyncGroq
from pydantic import BaseModel, Field, field_validator, model_validator
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

load_dotenv(override=True)

# ---------------------------------------------------------------- configuration
API_KEY = os.getenv("GROQ_API_KEY")
if not API_KEY:
    raise RuntimeError("GROQ_API_KEY is missing. Add it to your .env file.")

MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
RATE_LIMIT = os.getenv("RATE_LIMIT", "10/minute")                       # per visitor IP
REQUEST_TIMEOUT = float(os.getenv("REQUEST_TIMEOUT_SECONDS", "30"))    # max wait for Groq
CACHE_TTL = int(os.getenv("CACHE_TTL_SECONDS", "600"))                  # 10 minutes
CACHE_MAX_ITEMS = int(os.getenv("CACHE_MAX_ITEMS", "200"))
MAX_HISTORY = 20
MAX_TOTAL_CHARS = 60_000                                                # whole request budget
print(f"Using model: {MODEL}")

# timeout stops a slow Groq call from hanging forever; max_retries retries transient failures once
client = AsyncGroq(api_key=API_KEY, timeout=REQUEST_TIMEOUT, max_retries=1)

SYSTEM_PROMPT = """You are a precise, knowledgeable assistant. You answer questions, write content, translate text, and write and debug code.

Formatting rules (important):
- Reply in clean Markdown.
- Use short paragraphs. Use "##" headings only for longer answers.
- Use bullet or numbered lists for steps and options, and tables for comparisons.
- Do not use emojis, decorative symbols, horizontal rules, or ASCII art.
- Use bold sparingly, only for key terms.
- Put all code in fenced code blocks with a language tag. Never put normal prose in a code block.
- Keep answers concise unless the user asks for detail. If unsure, say so."""


# ---------------------------------------------------------------- cache
class TTLCache:
    """Small in-memory cache: entries expire after `ttl` seconds, and the least
    recently used entry is evicted once `max_items` is exceeded."""

    def __init__(self, max_items: int, ttl: int):
        self.max_items, self.ttl = max_items, ttl
        self._data: OrderedDict[str, tuple[float, str]] = OrderedDict()
        self.hits = 0
        self.misses = 0

    def get(self, key: str) -> str | None:
        item = self._data.get(key)
        if item and item[0] > time.monotonic():
            self._data.move_to_end(key)          # mark as recently used
            self.hits += 1
            return item[1]
        if item:                                  # expired
            del self._data[key]
        self.misses += 1
        return None

    def set(self, key: str, value: str) -> None:
        self._data[key] = (time.monotonic() + self.ttl, value)
        self._data.move_to_end(key)
        while len(self._data) > self.max_items:
            self._data.popitem(last=False)       # drop the oldest entry

    def clear(self) -> None:
        self._data.clear()
        self.hits = self.misses = 0

    def __len__(self) -> int:
        return len(self._data)


cache = TTLCache(CACHE_MAX_ITEMS, CACHE_TTL)


def cache_key(messages: list[dict]) -> str:
    """Same model + same system prompt + same conversation => same key."""
    raw = json.dumps({"model": MODEL, "messages": messages}, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()


# ---------------------------------------------------------------- app + request handling
limiter = Limiter(key_func=get_remote_address)
app = FastAPI(title="LLM Chatbot")
app.state.limiter = limiter


@app.exception_handler(RateLimitExceeded)
async def too_many_requests(request: Request, exc: RateLimitExceeded):
    return JSONResponse(status_code=429,
                        content={"detail": "Too many requests. Please wait a minute."})


@app.exception_handler(RequestValidationError)
async def bad_request(request: Request, exc: RequestValidationError):
    # Turn Pydantic's technical error list into one readable sentence for the UI
    first = exc.errors()[0]
    field = ".".join(str(p) for p in first["loc"] if p != "body")
    msg = first["msg"].removeprefix("Value error, ")
    where = f" ({field})" if field else ""
    return JSONResponse(status_code=422, content={"detail": f"Invalid request{where}: {msg}"})


class Msg(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=20000)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    history: list[Msg] = Field(default_factory=list, max_length=60)
    fresh: bool = False          # True = skip the cache and ask the model again

    @field_validator("message")
    @classmethod
    def not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Message cannot be empty.")
        return v

    @model_validator(mode="after")
    def within_size_budget(self):
        total = len(self.message) + sum(len(m.content) for m in self.history)
        if total > MAX_TOTAL_CHARS:
            raise ValueError(f"Conversation too long ({total} characters, limit {MAX_TOTAL_CHARS}).")
        return self


class ChatResponse(BaseModel):
    reply: str


def build_messages(req: ChatRequest) -> list[dict]:
    return (
        [{"role": "system", "content": SYSTEM_PROMPT}]
        + [m.model_dump() for m in req.history[-MAX_HISTORY:]]
        + [{"role": "user", "content": req.message}]
    )


async def ask_groq(messages: list[dict]) -> str:
    try:
        resp = await client.chat.completions.create(model=MODEL, messages=messages, temperature=0.6)
    except groq.AuthenticationError:
        raise HTTPException(502, "Invalid Groq API key. Check your .env file.")
    except groq.NotFoundError:
        raise HTTPException(502, f"Model '{MODEL}' not found. Update GROQ_MODEL in .env.")
    except groq.RateLimitError:
        raise HTTPException(429, "Groq rate limit reached. Wait a minute and retry.")
    except groq.APITimeoutError:
        raise HTTPException(504, f"The model took longer than {REQUEST_TIMEOUT:.0f}s to respond. Try again.")
    except groq.APIConnectionError:
        raise HTTPException(502, "Could not reach the AI service. Try again shortly.")
    except Exception as e:
        print(f"Groq error: {e}")
        raise HTTPException(502, "The AI service failed. Check the server logs.")
    return resp.choices[0].message.content or ""


# ---------------------------------------------------------------- routes
@app.get("/api/info")
async def info():
    return {"model": MODEL}


@app.get("/api/stats")
async def stats():
    total = cache.hits + cache.misses
    return {
        "cache_entries": len(cache),
        "cache_hits": cache.hits,
        "cache_misses": cache.misses,
        "hit_rate": round(cache.hits / total, 3) if total else 0.0,
    }


@app.post("/api/chat", response_model=ChatResponse)
@limiter.limit(RATE_LIMIT)
async def chat(request: Request, req: ChatRequest, response: Response):
    messages = build_messages(req)
    key = cache_key(messages)

    if not req.fresh:
        cached = cache.get(key)
        if cached is not None:
            response.headers["X-Cache"] = "HIT"
            return ChatResponse(reply=cached)

    reply = await ask_groq(messages)
    if reply:                                   # never cache empty answers (errors raise above)
        cache.set(key, reply)
    response.headers["X-Cache"] = "MISS"
    return ChatResponse(reply=reply or "(No response)")


# Serve the frontend. This must come AFTER the API routes.
app.mount("/", StaticFiles(directory="static", html=True), name="static")
