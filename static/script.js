const messagesEl = document.getElementById("messages");
const form = document.getElementById("chat-form");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send-btn");
const resetBtn = document.getElementById("reset-btn");

let sessionId = sessionStorage.getItem("session_id");

// Escape HTML first, then turn ```code``` and `inline` into elements
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function formatMessage(text) {
  let html = escapeHtml(text);
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g,
    (_, lang, code) => `<pre><code>${code.trim()}</code></pre>`);
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return html;
}

function addMessage(text, role, { raw = false } = {}) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  if (role === "bot" && !raw) el.innerHTML = formatMessage(text);
  else el.textContent = text;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

async function sendMessage(text) {
  addMessage(text, "user");
  const typing = addMessage("Thinking…", "bot typing", { raw: true });
  sendBtn.disabled = true;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, message: text }),
    });

    if (!res.ok) throw new Error((await res.json()).detail || "Request failed");

    const data = await res.json();
    sessionId = data.session_id;
    sessionStorage.setItem("session_id", sessionId);

    typing.remove();
    addMessage(data.reply, "bot");
  } catch (err) {
    typing.remove();
    addMessage(`⚠️ ${err.message}`, "bot error", { raw: true });
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  input.style.height = "auto";
  sendMessage(text);
});

// Enter sends, Shift+Enter makes a new line
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

// Auto-grow textarea
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = input.scrollHeight + "px";
});

resetBtn.addEventListener("click", async () => {
  if (sessionId) await fetch(`/api/reset?session_id=${sessionId}`, { method: "POST" });
  sessionStorage.removeItem("session_id");
  sessionId = null;
  messagesEl.innerHTML = "";
  addMessage("New chat started. What would you like to do?", "bot");
});
