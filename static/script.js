const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

const frame = $("frame"), listEl = $("list"), messagesEl = $("messages"), form = $("chat-form"),
  input = $("input"), sendBtn = $("send-btn"), titleEl = $("title"), statusEl = $("status"),
  modelEl = $("model"), latencyEl = $("latency");

const KEY = "llm-terminal:v1";
const SUGGESTIONS = [
  ["EXPLAIN", "Why is the sky blue?"],
  ["WRITE", "Write a short email asking my manager for Friday off"],
  ["TRANSLATE", "Translate 'Where is the bus station?' into Tamil and Hindi"],
  ["CODE", "Write a Python function that checks if a string is a palindrome"],
];

/* ---------- Decorative hex dump (static) ---------- */
function hexDump(rows, seed) {
  let s = seed, out = [];
  for (let i = 0; i < rows; i++) {
    let line = (i * 8).toString(16).padStart(4, "0").toUpperCase() + "  ";
    for (let j = 0; j < 8; j++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      line += ((s >> 8) & 255).toString(16).padStart(2, "0").toUpperCase() + " ";
    }
    out.push(line);
  }
  return out.join("\n");
}
$("hexL").textContent = hexDump(70, 1337);
$("hexR").textContent = hexDump(70, 4242);

/* ---------- Chat history (stored in this browser's localStorage) ---------- */
let state = { chats: [], active: null };
let busy = false;

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && Array.isArray(s.chats)) state = s;
  } catch {}
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
}
const current = () => state.chats.find((c) => c.id === state.active);

function newChat() {
  const cur = current();
  if (cur && cur.messages.length === 0) { input.focus(); return; }   // reuse empty chat
  const c = { id: crypto.randomUUID(), title: "New chat", updated: Date.now(), messages: [] };
  state.chats.unshift(c);
  state.active = c.id;
  save(); render(); input.focus();
}
function switchTo(id) {
  state.active = id; save(); render();
  frame.classList.remove("open");
}
function removeChat(id) {
  state.chats = state.chats.filter((c) => c.id !== id);
  if (state.active === id) state.active = state.chats[0]?.id ?? null;
  if (!current()) { state.chats = []; newChat(); return; }
  save(); render();
}

function ago(t) {
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  if (m < 1440) return Math.floor(m / 60) + "h ago";
  return Math.floor(m / 1440) + "d ago";
}

function renderList() {
  listEl.innerHTML = "";
  [...state.chats].sort((a, b) => b.updated - a.updated).forEach((c) => {
    const row = document.createElement("div");
    row.className = "item" + (c.id === state.active ? " active" : "");
    const open = document.createElement("button");
    open.className = "open";
    open.innerHTML = '<span class="t"></span><span class="m"></span>';
    open.querySelector(".t").textContent = c.title;
    open.querySelector(".m").textContent = `${ago(c.updated)} · ${c.messages.length} msgs`;
    open.onclick = () => switchTo(c.id);
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "×";
    del.title = "Delete chat"; del.setAttribute("aria-label", "Delete chat");
    del.onclick = (e) => { e.stopPropagation(); removeChat(c.id); };
    row.append(open, del);
    listEl.append(row);
  });
}

/* ---------- Message rendering (Markdown) ---------- */
const esc = (t) => { const d = document.createElement("div"); d.textContent = t; return d.innerHTML; };
if (window.marked) marked.setOptions({ gfm: true, breaks: false });

function md(text) {
  if (!window.marked || !window.DOMPurify) return `<p>${esc(text)}</p>`;
  return DOMPurify.sanitize(marked.parse(text));
}

// Adds a language header + copy button to code blocks, and syntax highlighting
function enhance(root) {
  root.querySelectorAll("pre").forEach((pre) => {
    if (pre.parentElement.classList.contains("codeblock")) return;
    const code = pre.querySelector("code");
    if (!code) return;
    const lang = ([...code.classList].find((c) => c.startsWith("language-")) || "language-text").slice(9);
    if (window.hljs) { try { hljs.highlightElement(code); } catch {} }
    const box = document.createElement("div");
    box.className = "codeblock";
    const head = document.createElement("div");
    head.className = "cb-head";
    head.innerHTML = `<span>${esc(lang)}</span>`;
    const btn = document.createElement("button");
    btn.className = "cb-copy"; btn.textContent = "Copy";
    btn.onclick = async () => {
      try { await navigator.clipboard.writeText(code.innerText); btn.textContent = "Copied"; }
      catch { btn.textContent = "Failed"; }
      setTimeout(() => (btn.textContent = "Copy"), 1500);
    };
    head.append(btn);
    pre.replaceWith(box);
    box.append(head, pre);
  });
}

const scrollDown = () => (messagesEl.scrollTop = messagesEl.scrollHeight);

function addMsg(kind, content) {          // kind: user | bot | error
  const el = document.createElement("div");
  el.className = "msg " + kind;
  if (kind === "user") {
    el.innerHTML = '<div class="body"></div>';
    el.firstChild.textContent = content;
  } else {
    el.innerHTML = '<div class="md"></div>';
    const m = el.firstChild;
    if (kind === "error") m.textContent = content;
    else { m.innerHTML = md(content); enhance(m); }
  }
  messagesEl.append(el);
  scrollDown();
  return el;
}

function addPending() {
  const el = document.createElement("div");
  el.className = "msg bot";
  el.innerHTML = '<div class="md"><span class="proc">PROCESSING<span class="cur"></span></span></div>';
  messagesEl.append(el); scrollDown();
  return el;
}

const closeFence = (s) => ((s.match(/```/g) || []).length % 2 ? s + "\n```" : s);

async function reveal(el, text) {
  const target = el.querySelector(".md");
  const toks = text.match(/\S+\s*/g) || [];
  const step = Math.max(1, Math.ceil(toks.length / 160));   // keep reveal short for long answers
  let shown = "";
  for (let i = 0; i < toks.length; i += step) {
    if (!el.isConnected) return;
    shown += toks.slice(i, i + step).join("");
    target.innerHTML = md(closeFence(shown)) + '<span class="cur"></span>';
    scrollDown();
    if (!reduce) await sleep(14);
  }
  target.innerHTML = md(text);
  enhance(target);
  scrollDown();
}

function renderMessages() {
  messagesEl.innerHTML = "";
  const chat = current();
  if (!chat.messages.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.innerHTML = '<h2><span>&gt;</span> ready_</h2><p>Ask a question, draft content, translate text, or write code.</p><div class="suggs"></div>';
    SUGGESTIONS.forEach(([label, text]) => {
      const b = document.createElement("button");
      b.className = "sugg"; b.innerHTML = "<b></b><span></span>";
      b.querySelector("b").textContent = label;
      b.querySelector("span").textContent = text;
      b.onclick = () => send(text);
      e.querySelector(".suggs").append(b);
    });
    messagesEl.append(e);
    return;
  }
  chat.messages.forEach((m) => addMsg(m.role === "user" ? "user" : "bot", m.content));
}

function render() {
  titleEl.textContent = current().title;
  renderList();
  renderMessages();
}

/* ---------- Sending ---------- */
function setBusy(on) {
  busy = on;
  sendBtn.disabled = on;
  frame.classList.toggle("busy", on);
  statusEl.textContent = on ? "PROCESSING" : "ONLINE";
}

async function send(text) {
  if (busy) return;
  const chat = current();
  const history = chat.messages.slice(-20).map(({ role, content }) => ({ role, content }));

  chat.messages.push({ role: "user", content: text });
  if (chat.messages.length === 1) chat.title = text.slice(0, 44);
  chat.updated = Date.now();
  save(); titleEl.textContent = chat.title; renderList(); renderMessages();

  const pending = addPending();
  setBusy(true);
  const t0 = performance.now();
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, history }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Request failed (${res.status})`);
    }
    const data = await res.json();
    latencyEl.textContent = Math.round(performance.now() - t0) + " ms";
    chat.messages.push({ role: "assistant", content: data.reply });
    chat.updated = Date.now();
    save(); renderList();
    if (state.active === chat.id) {
      pending.remove();
      const el = addMsg("bot", "");
      await reveal(el, data.reply);
    }
  } catch (err) {
    chat.messages.pop();               // drop the failed prompt so history stays clean
    save(); renderList();
    if (state.active === chat.id) {
      renderMessages();
      addMsg("error", err.message);
      input.value = text;              // let the user retry
    }
  } finally {
    setBusy(false);
    input.focus();
  }
}

/* ---------- Events ---------- */
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = ""; input.style.height = "auto";
  send(text);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = input.scrollHeight + "px";
});
$("new-btn").onclick = () => { newChat(); frame.classList.remove("open"); };
$("clear-btn").onclick = () => {
  if (!confirm("Delete all conversations from this browser?")) return;
  state = { chats: [], active: null };
  newChat();
};
$("menu").onclick = () => frame.classList.toggle("open");
$("scrim").onclick = () => frame.classList.remove("open");

/* ---------- Init ---------- */
load();
if (!current()) { state.active = state.chats[0]?.id ?? null; }
if (!current()) { state.chats = []; newChat(); } else render();
fetch("/api/info").then((r) => r.json()).then((d) => (modelEl.textContent = d.model)).catch(() => {});
