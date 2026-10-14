/**
 * Telegram-to-GitHub Portfolio Admin
 * Deploy as a Cloudflare Worker.
 *
 * Required secrets: TELEGRAM_BOT_TOKEN, GITHUB_TOKEN, WEBHOOK_SECRET
 * Required vars: ADMIN_TELEGRAM_ID, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH
 *
 * File operations are deliberately command-based and commit directly to the configured branch.
 */
const API = "https://api.github.com";
const TG = "https://api.telegram.org";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Portfolio Telegram admin is running.", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname !== "/webhook" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    if (!env.WEBHOOK_SECRET ||
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }

    try {
      if (update.callback_query) {
        const cq = update.callback_query;
        if (String(cq.from?.id) !== String(env.ADMIN_TELEGRAM_ID)) {
          await answerCallback(env, cq.id, "غير مصرح لك.");
          return new Response("ok");
        }
        await answerCallback(env, cq.id);
        const chatId = cq.message?.chat?.id;
        if (chatId) {
          switch (cq.data) {
            case "files":
              await listFiles(env, chatId);
              break;
            case "status":
              await repoStatus(env, chatId);
              break;
            case "readhelp":
              await sendText(env, chatId, "📄 لقراءة ملف ابعت الأمر بالشكل ده:\n/read index.html\nهيوصلك الملف كمرفق على تيليجرام.");
              break;
            case "writehelp":
              await sendText(env, chatId, "✏️ لتعديل ملف موجود، ابعته كـ Document واكتب في Caption:\n/replace index.html\n\nلإنشاء ملف جديد:\n/create assets/new-file.css");
              break;
            case "deletehelp":
              await sendText(env, chatId, "🗑️ للحذف اكتب اسم الملف والتأكيد، مثال:\n/delete assets/old.css CONFIRM\n⚠️ الحذف يسجل Commit مباشر على GitHub.");
              break;
            case "help":
              await sendText(env, chatId, helpText());
              break;
            default:
              await showMenu(env, chatId);
          }
        }
      } else if (update.message) {
        const msg = update.message;
        if (String(msg.from?.id) !== String(env.ADMIN_TELEGRAM_ID)) {
          if (msg.chat?.id) await sendText(env, msg.chat.id, "⛔ البوت خاص بصاحبه فقط.");
          return new Response("ok");
        }
        await handleMessage(env, msg);
      }
    } catch (error) {
      console.error("Update failed:", error?.stack || error);
      const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
      if (chatId) {
        const detail = String(error?.message || "خطأ غير معروف")
          .replace(/Bearer\\s+[^\\s]+/gi, "Bearer [hidden]")
          .replace(/bot\\d+:[A-Za-z0-9_-]+/g, "bot[hidden]")
          .slice(0, 700);
        await sendText(env, chatId, "❌ حصل خطأ: " + detail + "\\n\\nراجع إعدادات GitHub/Cloudflare بناءً على الرسالة دي.");
      }
    }
    return new Response("ok");
  },
};

async function handleMessage(env, msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || msg.caption || "").trim();

  if (msg.document && (/^\/(replace|create)\s+/i.test(msg.caption || ""))) {
    const match = (msg.caption || "").trim().match(/^\/(replace|create)\s+([^\s]+)\s*$/i);
    if (!match) return sendText(env, chatId, "اكتب في وصف الملف: /replace path/to/file أو /create path/to/file");
    const [, operation, path] = match;
    const bytes = await downloadTelegramFile(env, msg.document.file_id);
    if (bytes.byteLength > 18 * 1024 * 1024) return sendText(env, chatId, "الملف كبير جدًا. الحد هنا 18MB.");
    await writeRepoFile(env, path, bytes, operation.toLowerCase() === "create");
    return sendText(env, chatId, `✅ تم ${operation.toLowerCase() === "create" ? "إنشاء" : "تحديث"} الملف ${path}\nاتحفظ Commit جديد على GitHub. لو ده ملف بالموقع، استنى GitHub Pages يحدّث النشر.`);
  }

  if (!text) {
    if (msg.document) return sendText(env, chatId, "علشان ترفع ملف: اكتب في وصفه /replace path/to/file أو /create path/to/file.");
    return;
  }

  if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) return showMenu(env, chatId);
  if (/^\/help(?:@\w+)?$/i.test(text)) return sendText(env, chatId, helpText());
  if (/^\/files(?:@\w+)?(?:\s|$)/i.test(text) || /^\/ls(?:\s|$)/i.test(text)) {
    const path = text.split(/\s+/)[1] || "";
    return listFiles(env, chatId, path);
  }
  if (/^\/read\s+/i.test(text)) {
    const path = text.replace(/^\/read\s+/i, "").trim();
    if (!path) return sendText(env, chatId, "استخدم: /read index.html");
    const file = await getRepoFile(env, path);
    if (!file || file.type !== "file") return sendText(env, chatId, "❌ مش لاقي ملف بالمسار ده.");
    const bytes = decodeBase64(file.content || "");
    return sendDocument(env, chatId, bytes, path.split("/").pop(), `📄 ${path}`);
  }
  if (/^\/delete\s+/i.test(text)) {
    const match = text.match(/^\/delete\s+(.+?)\s+CONFIRM$/i);
    if (!match) return sendText(env, chatId, "⚠️ الحذف نهائي من الفرع الحالي. للتأكيد اكتب:\n/delete path/to/file CONFIRM");
    const path = match[1].trim();
    if (!safePath(path)) return sendText(env, chatId, "المسار غير مسموح.");
    const file = await getRepoFile(env, path);
    if (!file || file.type !== "file") return sendText(env, chatId, "❌ الملف مش موجود.");
    const result = await githubRequest(env, `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodePath(path)}`, {
      method: "DELETE",
      body: JSON.stringify({ message: `Delete ${path} via Telegram admin`, sha: file.sha, branch: env.GITHUB_BRANCH || "main" }),
    });
    if (!result.ok) throw new Error("GitHub delete failed: " + result.status);
    return sendText(env, chatId, `🗑️ اتمسح ${path} من GitHub واتسجل Commit. تقدر تسترجعه من سجل الملفات/Commits على GitHub.`);
  }
  if (/^\/status$/i.test(text)) return repoStatus(env, chatId);
  if (/^\/replace(?:\s|$)/i.test(text) || /^\/create(?:\s|$)/i.test(text)) {
    return sendText(env, chatId, "📎 ابعت الملف كمرفق Document، واكتب الأمر في خانة الوصف (Caption)، مثال:\n/replace index.html\nأو:\n/create assets/new-file.css");
  }
  if (/^\/menu$/i.test(text)) return showMenu(env, chatId);
  return sendText(env, chatId, "مش فاهم الأمر ده. اكتب /help علشان تشوف الأوامر.");
}

async function showMenu(env, chatId) {
  const keyboard = {
    inline_keyboard: [
      [{ text: "📁 ملفات المستودع", callback_data: "files" }, { text: "📊 حالة الموقع", callback_data: "status" }],
      [{ text: "📄 طريقة قراءة ملف", callback_data: "readhelp" }, { text: "✏️ تعديل/إنشاء ملف", callback_data: "writehelp" }],
      [{ text: "🗑️ حذف ملف", callback_data: "deletehelp" }, { text: "❓ المساعدة", callback_data: "help" }],
    ],
  };
  await sendText(env, chatId, "🛠️ لوحة تحكم الـ Portfolio\nاختار عملية، أو استخدم الأوامر المكتوبة تحت.", keyboard);
}

async function listFiles(env, chatId, path = "") {
  if (!safePath(path, true)) return sendText(env, chatId, "المسار غير مسموح.");
  const endpoint = `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents${path ? "/" + encodePath(path) : ""}?ref=${encodeURIComponent(env.GITHUB_BRANCH || "main")}`;
  const response = await githubRequest(env, endpoint);
  if (response.status === 404) return sendText(env, chatId, "❌ المسار مش موجود.");
  if (!response.ok) throw new Error("GitHub listing failed: " + response.status);
  const items = await response.json();
  if (!Array.isArray(items)) return sendText(env, chatId, "ده ملف مش مجلد. استخدم /read " + path);
  if (!items.length) return sendText(env, chatId, "المجلد فاضي.");
  const lines = items.slice(0, 70).map(item => `${item.type === "dir" ? "📁" : "📄"} ${item.name}${item.type === "dir" ? "/" : ""}`);
  const suffix = items.length > 70 ? "\n… تم عرض أول 70 عنصر." : "";
  await sendText(env, chatId, `📂 ${path || "/"}\n\n${lines.join("\n")}${suffix}\n\nلقراءة ملف: /read ${path ? path + "/" : ""}filename\nلفتح مجلد: /files ${path ? path + "/" : ""}folder`);
}

async function repoStatus(env, chatId) {
  const branch = env.GITHUB_BRANCH || "main";
  const res = await githubRequest(env, `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/commits/${encodeURIComponent(branch)}`);
  if (!res.ok) throw new Error("GitHub status failed: " + res.status);
  const commit = await res.json();
  const short = (commit.sha || "").slice(0, 7);
  const date = commit.commit?.committer?.date || "غير متاح";
  const message = commit.commit?.message?.split("\n")[0] || "بدون رسالة";
  await sendText(env, chatId, `📊 حالة المستودع\nالمستودع: ${env.GITHUB_OWNER}/${env.GITHUB_REPO}\nالفرع: ${branch}\nآخر Commit: ${short}\nالتاريخ: ${date}\nالرسالة: ${message}\n\nhttps://github.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/commits/${branch}`);
}

async function getRepoFile(env, path) {
  if (!safePath(path)) return null;
  const res = await githubRequest(env, `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodePath(path)}?ref=${encodeURIComponent(env.GITHUB_BRANCH || "main")}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("GitHub read failed: " + res.status);
  return res.json();
}

async function writeRepoFile(env, path, bytes, createOnly) {
  if (!safePath(path)) throw new Error("Unsafe file path");
  if (bytes.byteLength > 18 * 1024 * 1024) throw new Error("File too large");
  const existing = await getRepoFile(env, path);
  if (createOnly && existing) throw new Error("File already exists; use /replace instead");
  if (!createOnly && !existing) throw new Error("File does not exist; use /create instead");
  const content = encodeBase64(bytes);
  const body = { message: `${existing ? "Update" : "Create"} ${path} via Telegram admin`, content, branch: env.GITHUB_BRANCH || "main" };
  if (existing?.sha) body.sha = existing.sha;
  const res = await githubRequest(env, `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodePath(path)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error("GitHub write failed: " + res.status + " " + detail.slice(0, 300));
  }
}

async function githubRequest(env, path, init = {}) {
  return fetch(API + path, {
    ...init,
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Portfolio-Telegram-Admin",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

async function downloadTelegramFile(env, fileId) {
  const metaRes = await fetch(`${TG}/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const meta = await metaRes.json();
  if (!meta.ok || !meta.result?.file_path) throw new Error("Telegram file download failed");
  const fileRes = await fetch(`${TG}/file/bot${env.TELEGRAM_BOT_TOKEN}/${meta.result.file_path}`);
  if (!fileRes.ok) throw new Error("Telegram file fetch failed");
  return await fileRes.arrayBuffer();
}

async function sendDocument(env, chatId, bytes, filename, caption = "") {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("caption", caption.slice(0, 900));
  form.set("document", new Blob([bytes]), filename.replace(/[\\/]/g, "_").slice(0, 120));
  const res = await fetch(`${TG}/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: "POST", body: form });
  if (!res.ok) throw new Error("Telegram sendDocument failed: " + res.status);
}

async function sendText(env, chatId, text, replyMarkup) {
  const payload = { chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const res = await fetch(`${TG}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error("Telegram sendMessage failed:", res.status, (await res.text()).slice(0, 200));
}

async function answerCallback(env, id, text = "") {
  await fetch(`${TG}/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: id, text }),
  });
}

function safePath(path, allowEmpty = false) {
  if (allowEmpty && path === "") return true;
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some(p => !p || p === "." || p === "..")) return false;
  return !path.split("/").some(p => p === ".git");
}
function encodePath(path) { return path.split("/").map(encodeURIComponent).join("/"); }
function encodeBase64(bytes) {
  const view = new Uint8Array(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) binary += String.fromCharCode(...view.subarray(i, i + chunk));
  return btoa(binary);
}
function decodeBase64(input) {
  const binary = atob(input.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function helpText() {
  return [
    "🛠️ أوامر بوت إدارة الـ Portfolio",
    "",
    "/start — القائمة الرئيسية",
    "/files — عرض ملفات المستودع",
    "/files assets — عرض مجلد",
    "/read index.html — إرسال الملف كوثيقة",
    "ارفع ملفًا مع Caption: /replace index.html — استبدال ملف موجود",
    "ارفع ملفًا مع Caption: /create assets/new.css — إنشاء ملف جديد",
    "/delete path/to/file CONFIRM — حذف ملف بعد التأكيد",
    "/status — آخر Commit وحالة المستودع",
    "",
    "مهم: أوامر الكتابة والحذف تنشئ Commits مباشرة على الفرع المحدد. خُد نسخة احتياطية قبل التعديلات الكبيرة.",
    "البوت ينفّذ عمليات ملفات GitHub فقط؛ لا يوجد ذكاء اصطناعي مدمج لتوليد كود من وصف طبيعي.",
  ].join("\n");
}
