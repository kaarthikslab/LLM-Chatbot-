const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Neural-network background ---------- */
const cv = document.getElementById("bg"), cx = cv.getContext("2d");
let W, H, pts = [], mx = 0, my = 0, think = 0, thinking = false, pulses = [];

function resize() {
  const d = devicePixelRatio || 1;
  W = innerWidth; H = innerHeight;
  cv.width = W * d; cv.height = H * d;
  cx.setTransform(d, 0, 0, d, 0, 0);
  pts = Array.from({ length: Math.min(80, Math.floor((W * H) / 15000)) }, () => ({
    x: Math.random() * W, y: Math.random() * H,
    vx: (Math.random() - 0.5) * 0.35, vy: (Math.random() - 0.5) * 0.35,
    z: Math.random() * 0.8 + 0.4,
  }));
}
addEventListener("resize", resize);
resize();

function frame() {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const col = dark ? "140,160,255" : "79,70,229";
  think += ((thinking ? 1 : 0) - think) * 0.05;
  cx.clearRect(0, 0, W, H);

  const speed = 1 + think * 4, links = [];
  for (const p of pts) {
    p.x += p.vx * speed; p.y += p.vy * speed;
    if (p.x < 0 || p.x > W) p.vx *= -1;
    if (p.y < 0 || p.y > H) p.vy *= -1;
    p.px = p.x + mx * 40 * p.z; p.py = p.y + my * 40 * p.z;   // parallax
  }
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i], b = pts[j], d = Math.hypot(a.px - b.px, a.py - b.py);
      if (d < 140) {
        cx.strokeStyle = `rgba(${col},${(1 - d / 140) * (0.25 + think * 0.35)})`;
        cx.lineWidth = 0.8;
        cx.beginPath(); cx.moveTo(a.px, a.py); cx.lineTo(b.px, b.py); cx.stroke();
        links.push([a, b]);
      }
    }
  }
  // Signal pulses travel along links while the model is "thinking"
  if (thinking && links.length && Math.random() < 0.5) pulses.push({ l: links[(Math.random() * links.length) | 0], t: 0 });
  pulses = pulses.filter((q) => (q.t += 0.03) < 1);
  for (const q of pulses) {
    const [a, b] = q.l;
    cx.fillStyle = "rgba(6,182,212,.95)"; cx.shadowColor = "#06b6d4"; cx.shadowBlur = 14;
    cx.beginPath(); cx.arc(a.px + (b.px - a.px) * q.t, a.py + (b.py - a.py) * q.t, 2.6, 0, 7); cx.fill();
    cx.shadowBlur = 0;
  }
  for (const p of pts) {
    cx.fillStyle = `rgba(${col},${0.55 + think * 0.3})`;
    cx.beginPath(); cx.arc(p.px, p.py, 1.6 * p.z + think, 0, 7); cx.fill();
  }
  if (!reduce) requestAnimationFrame(frame);
}
frame();

/* ---------- 3D tilt ---------- */
const app = document.getElementById("app");
addEventListener("pointermove", (e) => {
  mx = e.clientX / innerWidth - 0.5; my = e.clientY / innerHeight - 0.5;
  if (!reduce && innerWidth > 600) app.style.transform = `rotateY(${mx * 6}deg) rotateX(${-my * 5}deg)`;
});
document.addEventListener("pointerleave", () => (app.style.transform = ""));

/* ---------- Chat ---------- */
const messagesEl = document.getElementById("messages");
const form = document.getElementById("chat-form");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send-btn");
const resetBtn = document.getElementById("reset-btn");
const statusEl = document.getElementById("status");

let sessionId = sessionStorage.getItem("session_id");
let busy = false;

function escapeHtml(t) { const d = document.createElement("div"); d.textContent = t; return d.innerHTML; }

// Escape first (prevents XSS), then turn Markdown bits into elements
function formatMessage(t) {
  return escapeHtml(t)
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${code.trim()}</code></pre>`)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

const scrollDown = () => messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: "smooth" });

function addUser(text) {
  const el = document.createElement("div");
  el.className = "msg user"; el.textContent = text;
  messagesEl.appendChild(el); scrollDown();
}

function addDots() {
  const el = document.createElement("div");
  el.className = "msg bot dots"; el.innerHTML = "<i></i><i></i><i></i>";
  messagesEl.appendChild(el); scrollDown();
  return el;
}

// Reveals the reply word by word. (For true streaming, see the SSE upgrade.)
async function streamBot(text, extraClass = "") {
  const el = document.createElement("div");
  el.className = `msg bot ${extraClass}`;
  messagesEl.appendChild(el);
  let shown = "";
  for (const tok of text.match(/\S+\s*/g) || []) {
    shown += tok;
    let partial = shown;
    if ((partial.match(/```/g) || []).length % 2) partial += "\n```"; // close open code block
    el.innerHTML = formatMessage(partial) + '<span class="caret"></span>';
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if (!reduce) await sleep(22 + Math.random() * 26);
  }
  el.innerHTML = formatMessage(text);
}

function setThinking(on) {
  thinking = on; busy = on;
  document.body.classList.toggle("thinking", on);
  statusEl.textContent = on ? "Thinking…" : "Online";
  sendBtn.disabled = on;
}

async function sendMessage(text) {
  if (busy) return;
  addUser(text);
  const dots = addDots();
  setThinking(true);
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, message: text }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "Request failed");
    }
    const data = await res.json();
    sessionId = data.session_id;
    sessionStorage.setItem("session_id", sessionId);
    dots.remove();
    statusEl.textContent = "Responding…";
    await streamBot(data.reply);
  } catch (err) {
    dots.remove();
    await streamBot(`⚠️ ${err.message}`, "error");
  } finally {
    setThinking(false);
    input.focus();
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = ""; input.style.height = "auto";
  sendMessage(text);
});

input.addEventListener("keydown", (e) => {          // Enter sends, Shift+Enter = new line
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
});
input.addEventListener("input", () => {              // auto-grow
  input.style.height = "auto";
  input.style.height = input.scrollHeight + "px";
});

resetBtn.addEventListener("click", async () => {
  if (busy) return;
  if (sessionId) await fetch(`/api/reset?session_id=${sessionId}`, { method: "POST" }).catch(() => {});
  sessionStorage.removeItem("session_id");
  sessionId = null;
  messagesEl.innerHTML = "";
  streamBot("New chat started. What would you like to do?");
});

["Why is the sky blue?", "Write an email asking for Friday off", "Translate “Where is the bus station?” into Tamil", "Python palindrome function", "Make that shorter"]
  .forEach((t, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.style.setProperty("--i", i); b.textContent = t;
    b.onclick = () => sendMessage(t);
    document.getElementById("chips").appendChild(b);
  });

streamBot("Hi! Ask me anything, request content, translations, or code.");
