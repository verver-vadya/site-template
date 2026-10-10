// Автопроверка сайта на типичные ошибки «сайта от нейросети»: битые ссылки и кнопки без состояний,
// формы без реакции на ошибки, ошибки в консоли, горизонтальная прокрутка, заглушки и штампы в текстах.
// Полный список признаков: ../CHECKLIST.md
//
//   npm run check           ошибки валят проверку, заглушки только предупреждают (черновик)
//   npm run check:release   заглушки тоже валят проверку (перед публикацией на боевой адрес)
//   npm run check -- --base <папка>   ещё сравнить размеры блоков с прошлой версией сайта из этой папки
//
// Скриншоты и отчёт складываются в .check/ в корне сайта.

import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OUT = path.join(ROOT, ".check");
const RELEASE = process.argv.includes("--release");
const BASE_ARG = process.argv.indexOf("--base");
const BASE = BASE_ARG > 0 && process.argv[BASE_ARG + 1] ? path.resolve(process.argv[BASE_ARG + 1]) : null;

// Размеры экрана. shot: "full" — скриншот всей страницы, "screen" — только первого экрана, как его видит человек.
// scale — масштаб Windows: 125 % на мониторе 1920×1080 даёт окно браузера 1536 px с дробными пикселями,
// на них расходятся тонкие линии и «прыгают» элементы, которых на 100 % не видно.
const SIZES = [
  { width: 320, height: 640 },
  { width: 375, height: 800, shot: "full", boxes: true },
  { width: 414, height: 896 },
  { width: 768, height: 1024, shot: "full" },
  { width: 1024, height: 768 },
  { width: 1280, height: 900, shot: "full", audit: true, boxes: true },
  { width: 1280, height: 630, shot: "screen", label: "ноутбук 1280×630" },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 730, scale: 1.25, shot: "screen", label: "Windows 125 %" },
  { width: 1280, height: 600, scale: 1.5, label: "Windows 150 %" },
  { width: 1920, height: 1080, shot: "screen", boxes: true },
  { width: 2560, height: 1440 },
];
const sizeLabel = (s) => s.label || `${s.width}×${s.height}`;
const sizeFile = (s) => `${s.width}x${s.height}${s.scale ? `@${s.scale}` : ""}`;
const YEAR = new Date().getFullYear();

const PLACEHOLDERS = [
  [/lorem ipsum/i, "Lorem ipsum"],
  [/example\.(ru|com|org)/i, "адрес example.ru"],
  [/YOUR_FORM_ID/, "форма не подключена (YOUR_FORM_ID)"],
  [/\[ЗАПОЛНИТЬ|\[ТЕКСТ/, "пометка [ЗАПОЛНИТЬ…]"],
  [/заглушк/i, "слово «заглушка»"],
  [/примерн(ая|ый)\b/i, "«Примерная улица» и т. п."],
  [/123-45-67|999\) ?123/, "телефон-заглушка"],
  [/Иван Иванов/, "«Иван Иванов»"],
  [/\bTODO\b/, "TODO"],
  [/>\s*Логотип\s*</, "логотип-заглушка"],
  [/Название сайта|>\s*Название\s*</, "название-заглушка"],
  [/Главный заголовок/, "заголовок-заглушка"],
  [/Услуга \d/, "«Услуга 1»"],
];

const STAMPS = [
  "откройте для себя", "добро пожаловать в мир", "инновационн", "раскройте", "на новый уровень",
  "бесшовн", "в современном мире", "команда профессионалов", "индивидуальный подход", "узнать больше",
  "не просто", "уникальн", "лучшие решения", "качественно и в срок",
];

// ---------- отчёт ----------

const issues = [];
const report = (level, where, message) => issues.push({ level, where, message });
// Одна и та же находка на многих размерах экрана: пишем один раз со списком размеров
const bySize = new Map();
const sized = (level, pathname, label, message) => {
  const id = `${level}|${pathname}|${message}`;
  bySize.set(id, [...(bySize.get(id) || []), label]);
};
const flushSized = () => {
  for (const [id, labels] of bySize) {
    const [level, pathname, ...rest] = id.split("|");
    const message = rest.join("|");
    report(level, `${pathname} (${labels.length === SIZES.length ? "все размеры" : labels.join(", ")})`, message);
  }
  bySize.clear();
};
const error = (where, message) => report("error", where, message);
const warn = (where, message) => report("warn", where, message);
const placeholder = (where, message) => report(RELEASE ? "error" : "warn", where, message);

// ---------- статический сервер: как хостинг, несуществующий адрес отдаёт 404.html ----------

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".avif": "image/avif", ".woff2": "font/woff2", ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8", ".ico": "image/x-icon", ".pdf": "application/pdf",
};

async function resolveFile(urlPath, root = ROOT) {
  const rel = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, "");
  if (rel.split("/").some((part) => part.startsWith(".") || part === "node_modules")) return null;
  let file = path.join(root, rel);
  try {
    if ((await fs.stat(file)).isDirectory()) file = path.join(file, "index.html");
    await fs.access(file);
    return file;
  } catch {
    return null;
  }
}

function startServer(root = ROOT) {
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST") { res.writeHead(405).end(); return; }
    const file = await resolveFile(new URL(req.url, "http://x").pathname, root);
    const served = file || path.join(root, "404.html");
    const body = await fs.readFile(served);
    res.writeHead(file ? 200 : 404, { "Content-Type": TYPES[path.extname(served)] || "application/octet-stream" });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ---------- проверки исходников (метатеги, robots, sitemap) ----------

async function checkSourceText(name, text) {
  for (const [re, label] of PLACEHOLDERS) {
    if (re.test(text)) placeholder(name, `осталась заглушка: ${label}`);
  }
}

// ---------- проверки страницы в браузере ----------

function watchPage(page, where, origin) {
  const problems = [];
  page.on("console", (msg) => {
    // Незагрузившиеся файлы ловим ниже, с их адресом
    if (msg.type() === "error" && !msg.text().startsWith("Failed to load resource")) problems.push(`ошибка в консоли: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`ошибка скрипта: ${err.message}`));
  page.on("response", (res) => {
    const url = res.url();
    if (url.includes("__check_submit")) return; // ответы, которые проверка форм подделывает нарочно
    if (url.startsWith(origin) && res.status() >= 400 && res.request().resourceType() !== "document") {
      problems.push(`файл не найден (${res.status()}): ${url.slice(origin.length)}`);
    }
  });
  page.on("requestfailed", (req) => {
    if (req.url().startsWith(origin) && !req.url().includes("__check_submit")) problems.push(`файл не загрузился: ${req.url().slice(origin.length)}`);
  });
  return () => [...new Set(problems)].forEach((p) => error(where, p));
}

async function auditDom(page) {
  return page.evaluate((year) => {
    const out = { errors: [], warns: [], links: [], title: document.title.trim() };
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const describe = (el) => {
      const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 40);
      return `<${el.tagName.toLowerCase()}${el.className ? ` class="${el.className}"` : ""}>${text ? ` «${text}»` : ""}`;
    };

    if (!document.documentElement.lang) out.errors.push("у <html> нет lang");
    if (!out.title) out.errors.push("пустой <title>");
    const robots = document.querySelector('meta[name="robots"]')?.content || "";
    if (!robots.includes("noindex") && !document.querySelector('meta[name="description"]')?.content) {
      out.errors.push("нет meta description");
    }
    const h1 = document.querySelectorAll("h1").length;
    if (h1 !== 1) out.errors.push(`заголовков h1 на странице ${h1}, нужен ровно один`);
    let prev = 0;
    for (const h of document.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
      const level = Number(h.tagName[1]);
      if (prev && level > prev + 1) out.warns.push(`заголовок перескакивает уровень: h${prev} → h${level} «${h.textContent.trim().slice(0, 40)}»`);
      prev = level;
      if (/\p{Extended_Pictographic}/u.test(h.textContent)) out.warns.push(`эмодзи в заголовке «${h.textContent.trim().slice(0, 40)}»`);
    }

    // Ссылки
    for (const a of document.querySelectorAll("a")) {
      const href = a.getAttribute("href");
      if (href === null || href === "" || href === "#" || /^javascript:/i.test(href)) {
        out.errors.push(`ссылка-пустышка ${describe(a)} (href="${href ?? ""}")`);
        continue;
      }
      if (href.startsWith("#") && href.length > 1 && !document.getElementById(decodeURIComponent(href.slice(1)))) {
        out.errors.push(`якорь ведёт в никуда: ${href}`);
      }
      if (/^(mailto|tel):/i.test(href)) continue;
      const url = new URL(a.href);
      if (url.origin === location.origin) out.links.push(url.pathname);
    }
    for (const el of document.querySelectorAll("[onclick]:not(a):not(button):not(input)")) {
      out.errors.push(`клик повешен на ${describe(el)} вместо <button> или <a>: не работает с клавиатуры`);
    }

    // Картинки
    for (const img of document.querySelectorAll("img")) {
      const alt = img.getAttribute("alt");
      const name = img.getAttribute("src");
      if (alt === null) out.errors.push(`у картинки нет alt: ${name}`);
      else if (/^(image|img|photo|picture|фото|картинка|изображение)\s*\d*$/i.test(alt.trim())) out.warns.push(`бессмысленный alt="${alt}" у ${name}`);
      if (!img.getAttribute("width") || !img.getAttribute("height")) out.warns.push(`у картинки нет width/height (страница будет прыгать при загрузке): ${name}`);
    }

    // Кнопки: есть текст, есть состояния hover / нажатия / фокуса, у кнопок отправки есть disabled
    const selectors = [];
    const collect = (rules) => {
      for (const rule of rules) {
        if (rule.selectorText) selectors.push(...rule.selectorText.split(","));
        if (rule.cssRules) collect(rule.cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      try { collect(sheet.cssRules); } catch { /* чужой домен */ }
    }
    const hasState = (el, pseudo) => selectors.some((sel) => {
      if (!sel.includes(pseudo)) return false;
      const base = sel.replace(/:(hover|active|focus-visible|focus|disabled)\b/g, "").replace(/\[aria-disabled="true"\]/g, "").trim();
      try { return el.matches(base || "*"); } catch { return false; }
    });
    const buttons = [...document.querySelectorAll('button, .button, [role="button"], input[type="submit"]')].filter(visible);
    for (const el of buttons) {
      if (!(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim()) {
        out.errors.push(`у кнопки нет текста или aria-label: ${describe(el)}`);
      }
      if (!hasState(el, ":hover")) out.errors.push(`кнопка не реагирует на наведение (:hover): ${describe(el)}`);
      if (!hasState(el, ":active")) out.errors.push(`кнопка не реагирует на нажатие (:active): ${describe(el)}`);
      if (!hasState(el, ":focus-visible") && !hasState(el, ":focus")) out.errors.push(`у кнопки не видно фокуса с клавиатуры: ${describe(el)}`);
      if (el.type === "submit" && !hasState(el, ":disabled")) out.errors.push(`у кнопки отправки нет вида «недоступна» (:disabled): ${describe(el)}`);
    }

    // Формы
    for (const form of document.querySelectorAll("form")) {
      const fields = [...form.querySelectorAll("input, textarea, select")].filter(
        (el) => el.type !== "hidden" && el.type !== "submit" && el.getAttribute("aria-hidden") !== "true" && el.tabIndex !== -1
      );
      for (const el of fields) {
        const labelled = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest("label") ||
          el.getAttribute("aria-label") || el.getAttribute("aria-labelledby");
        if (!labelled) out.errors.push(`у поля нет подписи <label> (placeholder не считается): ${describe(el)} name="${el.name}"`);
      }
      const personal = fields.some((el) => ["tel", "email"].includes(el.type) || /name|phone|mail/i.test(el.name));
      const consent = [...form.querySelectorAll('input[type="checkbox"]')].some((box) => {
        const label = box.id && document.querySelector(`label[for="${CSS.escape(box.id)}"]`);
        return box.required && /персональн/i.test((label || box.closest("label"))?.textContent || "");
      });
      if (personal && !consent) out.errors.push("форма собирает личные данные без обязательного согласия на их обработку (152-ФЗ)");
      if (personal && consent) {
        const policy = [...form.querySelectorAll("a")].some((a) => /конфиденциальн|персональн/i.test(a.textContent));
        if (!policy) out.errors.push("в согласии нет ссылки на политику конфиденциальности");
      }
      const action = form.getAttribute("action");
      if (!action && !form.hasAttribute("data-form")) out.errors.push("форма никуда не отправляет (нет action)");
    }

    // Тексты
    const text = document.body.innerText;
    if (/"[^"\n]{1,80}"/.test(text)) out.warns.push("в тексте английские кавычки \"…\", в русском нужны «ёлочки»");
    if (/ - /.test(text)) out.warns.push("дефис вместо тире: « - » нужно заменить на « — »");
    const copy = text.match(/©\s*(\d{4})/);
    if (copy && Number(copy[1]) !== year) out.warns.push(`в подвале устаревший год: © ${copy[1]}`);
    out.text = text;
    return out;
  }, YEAR);
}

async function checkLayout(page, where, width) {
  const res = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const scroll = document.documentElement.scrollWidth > vw + 1;
    const wide = [];
    if (scroll) {
      // Самые глубокие элементы, которые вылезают за экран или чей текст не помещается в них самих
      const over = [...document.body.querySelectorAll("*")].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && getComputedStyle(el).position !== "fixed" && (r.right > vw + 1 || el.scrollWidth > el.clientWidth + 1);
      });
      for (const el of over.filter((el) => !over.some((other) => other !== el && el.contains(other))).slice(0, 3)) {
        const cls = typeof el.className === "string" && el.className ? `.${el.className.split(" ")[0]}` : "";
        wide.push(`<${el.tagName.toLowerCase()}${cls}> «${el.textContent.trim().slice(0, 40)}»`);
      }
    }
    const small = [];
    const targets = document.querySelectorAll('button, .button, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), select, textarea, nav a');
    for (const el of targets) {
      if (el.getAttribute("aria-hidden") === "true" || el.tabIndex === -1) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < 44 || r.width < 24) small.push(`${(el.innerText || el.name || el.tagName).trim().slice(0, 30)} (${Math.round(r.width)}×${Math.round(r.height)})`);
    }
    return { scroll, wide, small };
  });
  if (res.scroll) error(where, `горизонтальная прокрутка на ширине ${width} px, вылезает: ${res.wide.join(", ")}`);
  if (width === 375 && res.small.length) {
    error(where, `на телефоне слишком мелкая зона нажатия (нужно не меньше 44 px по высоте): ${res.small.slice(0, 5).join("; ")}`);
  }
}

// Прокручиваем страницу до низа и обратно: блоки, которые проявляются при прокрутке, должны успеть появиться
async function revealAll(page) {
  await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight * 0.8) {
      window.scrollTo(0, y);
      await wait(60);
    }
    window.scrollTo(0, 0);
    await wait(800);
  });
}

// Наложения: картинка или другой текст наезжает на текст. Края картинки, задевающие строку, — ошибка,
// откуда бы картинка ни лежала; подпись целиком внутри фото считается замыслом, если текст сверху.
// Если наложение задумано, пометьте элемент или его блок атрибутом data-overlap-ok.
function scanOverlap(scope) {
  // Скрытое визуально (в том числе .visually-hidden для экранного диктора) не считается
  const shown = (el) => {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      const r = n.getBoundingClientRect();
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) < 0.05) return false;
      if (/inset\([^)]*(100|50)%/.test(s.clipPath) || /rect\(0(px)?,? 0(px)?/.test(s.clip) || (s.display !== "contents" && (r.width <= 1 || r.height <= 1))) return false;
    }
    return true;
  };
  const toPage = (r) => ({ left: r.left + scrollX, top: r.top + scrollY, right: r.right + scrollX, bottom: r.bottom + scrollY });
  const cross = (a, b) => {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 3 && h > 3 ? { w, h, x: Math.max(a.left, b.left) + w / 2, y: Math.max(a.top, b.top) + h / 2 } : null;
  };
  const area = (r) => (r.right - r.left) * (r.bottom - r.top);
  const root = scope ? document.querySelector(`[data-check-hover="${scope}"]`) : document.body;
  const media = [...document.querySelectorAll("img, video, canvas, svg")].filter((el) => {
    if (scope && !root.contains(el)) return false;
    if (el.closest("[data-overlap-ok], a svg, button svg, label svg") || (el.tagName === "svg" && el.parentElement.closest("svg"))) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 48 && r.height >= 48 && shown(el);
  }).map((el) => ({ el, box: toPage(el.getBoundingClientRect()) }));
  const lines = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode() && lines.length < 3000) {
    const node = walker.currentNode;
    const el = node.parentElement;
    if (!node.textContent.trim() || el.closest("svg, script, style, noscript, [data-overlap-ok]") || !shown(el)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) if (r.width > 2 && r.height > 6) lines.push({ el, text: node.textContent.trim(), box: toPage(r) });
  }
  const topAt = (x, y) => { window.scrollTo(0, y - innerHeight / 2); return document.elementFromPoint(x - scrollX, y - scrollY); };
  const out = { media: [], text: [] };
  for (const m of media) {
    for (const t of lines) {
      const c = cross(m.box, t.box);
      if (!c || c.w * c.h < area(t.box) * 0.15) continue;
      const top = topAt(c.x, c.y);
      const imageOnTop = top && (top === m.el || m.el.contains(top));
      const inside = c.w * c.h > area(t.box) * 0.9;
      if (imageOnTop || !inside) {
        out.media.push(`«${t.text.slice(0, 30)}» и картинка ${(m.el.getAttribute("src") || `<${m.el.tagName.toLowerCase()}>`).split("/").pop()}`);
        break;
      }
    }
  }
  if (!scope) {
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        const a = lines[i];
        const b = lines[j];
        if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
        // Сравниваем середину строки: у крупных шрифтов рамка строки заметно выше самих букв
        const core = (r) => { const pad = (r.bottom - r.top) * 0.2; return { ...r, top: r.top + pad, bottom: r.bottom - pad }; };
        const c = cross(core(a.box), core(b.box));
        if (c && c.w * c.h > Math.min(area(a.box), area(b.box)) * 0.2) out.text.push(`«${a.text.slice(0, 25)}» и «${b.text.slice(0, 25)}»`);
      }
    }
  }
  window.scrollTo(0, 0);
  return { media: [...new Set(out.media)], text: [...new Set(out.text)] };
}

async function checkOverlap(page, pathname, label) {
  const found = await page.evaluate(scanOverlap, null);
  if (found.media.length) sized("error", pathname, label, `картинка наезжает на текст: ${found.media.slice(0, 4).join("; ")}`);
  // Текст на тексте бывает задуман (пометка от руки поверх заголовка), поэтому только предупреждение
  if (found.text.length) sized("warn", pathname, label, `текст наезжает на текст (если это задумано, пометьте data-overlap-ok): ${found.text.slice(0, 4).join("; ")}`);
}

// То же при наведении: картинка, которая выезжает по :hover, не должна ложиться на соседний текст
async function checkHoverOverlap(page, pathname, label) {
  const bases = await page.evaluate(() => {
    const out = new Set();
    const collect = (rules) => {
      for (const rule of rules) {
        if (rule.selectorText) {
          for (const sel of rule.selectorText.split(",")) {
            const m = sel.match(/^(.*?):hover[\s>+~]+\S/);
            if (m && m[1].trim() && !/:/.test(m[1])) out.add(m[1].trim());
          }
        }
        if (rule.cssRules) collect(rule.cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      try { collect(sheet.cssRules); } catch { /* чужой домен */ }
    }
    let n = 0;
    for (const sel of out) {
      for (const el of document.querySelectorAll(sel)) if (n < 12 && el.getBoundingClientRect().width) el.dataset.checkHover = String(n++);
    }
    return n;
  });
  const found = new Set();
  for (let i = 0; i < bases; i++) {
    const el = page.locator(`[data-check-hover="${i}"]`);
    await el.hover({ force: true }).catch(() => {});
    await page.waitForTimeout(700);
    (await page.evaluate(scanOverlap, String(i))).media.forEach((f) => found.add(f));
  }
  await page.mouse.move(0, 0);
  if (found.size) sized("warn", pathname, label, `при наведении картинка наезжает на текст (если это задумано, пометьте data-overlap-ok): ${[...found].slice(0, 4).join("; ")}`);
}

// Ссылка намного больше своей надписи: тап по пустому месту или по картинке рядом уводит не туда
async function checkHitArea(page, where) {
  const found = await page.evaluate(() => {
    const out = [];
    for (const a of document.querySelectorAll("a[href]")) {
      // pointer-events: none у ссылки значит, что нажимается только часть внутри неё
      if (a.matches(".button") || a.querySelector("img, picture, video") || getComputedStyle(a).pointerEvents === "none") continue;
      const r = a.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      let text = 0;
      const walker = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        for (const t of range.getClientRects()) text += t.width * t.height;
      }
      const area = r.width * r.height;
      if (text && area > 15000 && area > text * 5) out.push(`«${a.textContent.trim().slice(0, 30)}» (${Math.round(area / text)}× больше текста)`);
    }
    return out;
  });
  if (found.length) warn(where, `ссылка ловит нажатия далеко за своей надписью: ${found.slice(0, 4).join("; ")}`);
}

// Размеры заметных блоков: картинки, заголовки, секции. Сравниваются с прошлой версией (--base),
// чтобы правка в одном месте не поменяла молча размеры в другом
async function measureBoxes(page) {
  return page.evaluate(() => {
    const key = (el) => {
      const parts = [];
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (n.id) { parts.unshift(`#${n.id}`); break; }
        const cls = typeof n.className === "string" && n.className.trim() ? `.${n.className.trim().split(/\s+/)[0]}` : "";
        const sel = n.tagName.toLowerCase() + cls;
        const same = [...n.parentElement.children].filter((c) => c.tagName === n.tagName && (!cls || c.classList.contains(cls.slice(1))));
        parts.unshift(same.length > 1 ? `${sel}:nth(${same.indexOf(n) + 1})` : sel);
      }
      return parts.join(" > ");
    };
    const boxes = {};
    for (const el of document.querySelectorAll("img, video, h1, h2, h3, section, header, footer, form, figure")) {
      const r = el.getBoundingClientRect();
      if (r.width && r.height) boxes[key(el)] = [Math.round(r.width), Math.round(r.height)];
    }
    return boxes;
  });
}

// Движение: анимации свойств, которые пересчитывают страницу, transition: all,
// «выключить всё» для prefers-reduced-motion и <dialog> с overflow: hidden
async function auditMotion(page) {
  return page.evaluate(() => {
    const warns = [];
    const layout = /^(width|height|top|left|right|bottom|inset|margin.*|padding.*|letter-spacing|word-spacing|font-size|line-height|max-width|max-height|min-width|min-height|border-width|grid-template.*|flex-basis)$/;
    const walk = (rules, reduced) => {
      for (const rule of rules) {
        if (rule instanceof CSSKeyframesRule) {
          for (const frame of rule.cssRules) {
            const props = [...frame.style].filter((p) => layout.test(p));
            if (props.length) { warns.push(`@keyframes ${rule.name} анимирует ${[...new Set(props)].join(", ")}: движение пойдёт рывками, двигайте transform и opacity`); break; }
          }
          continue;
        }
        if (rule instanceof CSSMediaRule) { walk(rule.cssRules, reduced || /prefers-reduced-motion:\s*reduce/.test(rule.conditionText)); continue; }
        if (rule.cssRules && !(rule instanceof CSSStyleRule)) { walk(rule.cssRules, reduced); continue; }
        if (!(rule instanceof CSSStyleRule)) continue;
        // Если в transition есть var(), браузер не раскладывает его на части, разбираем сами
        const raw = rule.style.transitionProperty || rule.style.getPropertyValue("transition");
        const parts = [];
        let depth = 0;
        let cur = "";
        for (const ch of raw) {
          if (ch === "(") depth++;
          if (ch === ")") depth--;
          if (ch === "," && !depth) { parts.push(cur); cur = ""; } else cur += ch;
        }
        parts.push(cur);
        const props = parts.map((p) => p.trim().split(/\s+/)[0]).filter((p) => p && /^[a-z-]+$/.test(p) && !/^(ease|linear|step|cubic|none|initial|inherit|unset)/.test(p));
        if (props.includes("all")) warns.push(`transition: all у ${rule.selectorText}: анимируются и размеры, лучше перечислить свойства`);
        const bad = props.filter((p) => layout.test(p));
        if (bad.length) warns.push(`у ${rule.selectorText} анимируется ${bad.join(", ")}: страница пересчитывается на каждом кадре, двигайте transform и opacity`);
        if (reduced && /(^|[\s,>])\*($|[\s,:])/.test(rule.selectorText) &&
            /none|^0s|^0\.0*1m?s/.test(`${rule.style.transition || rule.style.transitionDuration || ""}${rule.style.animation || rule.style.animationDuration || ""}`)) {
          warns.push("при выключенных в системе анимациях сайт убирает всё движение разом (правило для *): окна появятся рывком; пусть они мягко проявляются на месте, а мелкие эффекты остаются");
        }
      }
    };
    for (const sheet of document.styleSheets) {
      try { walk(sheet.cssRules, false); } catch { /* чужой домен */ }
    }
    for (const dialog of document.querySelectorAll("dialog")) {
      if (getComputedStyle(dialog).overflowY === "hidden") {
        warns.push(`у <dialog${dialog.id ? ` id="${dialog.id}"` : ""}> overflow: hidden: окно всё равно прокручивается, и фокус внутри может подбросить его в конце выезда; нужен overflow: clip`);
      }
    }
    return [...new Set(warns)];
  });
}

// ---------- поведение: меню и формы ----------

async function checkMenu(browser, url) {
  const where = `${url.pathname} (меню, 375 px)`;
  const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(url.href);
  const toggle = page.locator("[aria-expanded][aria-controls]").first();
  if (!(await toggle.count()) || !(await toggle.isVisible())) { await ctx.close(); return; }
  const navId = await toggle.getAttribute("aria-controls");
  const nav = page.locator(`#${navId}`);

  await toggle.click();
  if ((await toggle.getAttribute("aria-expanded")) !== "true" || !(await nav.isVisible())) {
    error(where, "кнопка меню не открывает меню или не меняет aria-expanded");
  } else {
    await page.keyboard.press("Escape");
    if ((await toggle.getAttribute("aria-expanded")) !== "false" || (await nav.isVisible())) error(where, "меню не закрывается по Esc");
    else if (!(await toggle.evaluate((el) => el === document.activeElement))) warn(where, "после закрытия по Esc фокус не вернулся на кнопку меню");

    await toggle.click();
    await page.mouse.click(10, 790);
    if ((await toggle.getAttribute("aria-expanded")) !== "false") error(where, "меню не закрывается по клику вне его");
  }
  await ctx.close();
}

// Окна (<dialog>): открываются кнопкой с aria-haspopup="dialog" или aria-controls. Покадрово следим,
// как выезжает окно: без скачков и подскока в конце, с анимацией, фокус не на «Закрыть»;
// закрывается по Esc и по клику на затемнение, фокус возвращается на кнопку.
async function checkDialogs(browser, url) {
  const runs = [
    { viewport: { width: 1280, height: 800 }, reducedMotion: "no-preference", label: "1280 px" },
    { viewport: { width: 375, height: 800 }, reducedMotion: "no-preference", label: "375 px" },
    { viewport: { width: 1280, height: 800 }, reducedMotion: "reduce", label: "без анимаций" },
  ];
  for (const run of runs) {
    const ctx = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion });
    const page = await ctx.newPage();
    await page.goto(url.href, { waitUntil: "load" });
    const openers = await page.locator('[aria-haspopup="dialog"], [aria-controls]').evaluateAll((els) => els
      .filter((el) => el.getAttribute("aria-haspopup") === "dialog" || document.getElementById(el.getAttribute("aria-controls"))?.tagName === "DIALOG")
      .map((el, i) => { el.dataset.checkOpener = String(i); return i; }));
    const tried = new Set();
    for (const i of openers) {
      const opener = page.locator(`[data-check-opener="${i}"]`);
      if (!(await opener.isVisible())) continue;
      const name = ((await opener.innerText().catch(() => "")) || (await opener.getAttribute("aria-label")) || "").trim().replace(/\s+/g, " ").slice(0, 30);
      await opener.scrollIntoViewIfNeeded();
      // Каждый кадр записываем положение и прозрачность листа и прокрутку самого окна
      await page.evaluate(() => {
        window.__frames = [];
        const start = performance.now();
        const tick = () => {
          const dialog = document.querySelector("dialog[open]");
          if (dialog) {
            const panel = dialog.firstElementChild || dialog;
            const r = panel.getBoundingClientRect();
            window.__frames.push({ x: r.left, y: r.top, opacity: Number(getComputedStyle(panel).opacity), scroll: dialog.scrollTop + dialog.scrollLeft, id: dialog.id || dialog.className });
          }
          if (performance.now() - start < 1200) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await opener.click();
      await page.waitForTimeout(1300);
      const frames = await page.evaluate(() => window.__frames);
      const where = `${url.pathname} (окно «${name}», ${run.label})`;
      if (!frames.length) { error(where, "кнопка не открывает окно"); continue; }
      const dialogId = frames.at(-1).id;
      if (tried.has(dialogId)) { await page.keyboard.press("Escape"); await page.waitForTimeout(700); continue; }
      tried.add(dialogId);

      if (frames.some((f) => f.scroll > 0)) error(where, "окно прокручивается при открытии и подпрыгивает в конце выезда: у <dialog> нужен overflow: clip, фокус на заголовок");
      const last = frames.at(-1);
      const total = Math.hypot(last.x - frames[0].x, last.y - frames[0].y);
      if (run.reducedMotion === "reduce") {
        if (frames[0].opacity >= 0.99 && total < 1) warn(where, "при выключенных анимациях окно появляется рывком: пусть мягко проявляется на месте");
      } else {
        if (total < 1 && frames[0].opacity >= 0.99) warn(where, "окно появляется сразу, без выезда или проявления");
        let back = 0;
        let leap = 0;
        for (let k = 1; k < frames.length; k++) {
          const dx = frames[k].x - frames[k - 1].x;
          const dy = frames[k].y - frames[k - 1].y;
          const along = total ? (dx * (last.x - frames[0].x) + dy * (last.y - frames[0].y)) / total : 0;
          if (along < -1) back = Math.max(back, -along);
          if (total > 50) leap = Math.max(leap, along / total);
        }
        if (back) error(where, `окно дёргается при выезде: откатывается назад на ${Math.round(back)} px`);
        if (leap > 0.3) warn(where, `окно проезжает ${Math.round(leap * 100)} % пути за один кадр: выезд выглядит рывком (тяжёлую работу до старта анимации, мягкая кривая)`);
      }
      const focus = await page.evaluate(() => {
        const el = document.activeElement;
        const dialog = document.querySelector("dialog[open]");
        return { inside: !!dialog && dialog.contains(el), close: !!el && el.matches("button") && /закрыть|close|✕|×/i.test(`${el.innerText} ${el.getAttribute("aria-label") || ""}`) };
      });
      if (!focus.inside) error(where, "при открытии фокус не попадает в окно");
      else if (focus.close) warn(where, "при открытии фокус встаёт на «Закрыть»: на телефоне вокруг неё рамка; ставьте фокус на заголовок окна (tabindex=\"-1\")");

      await page.keyboard.press("Escape");
      await page.waitForTimeout(800);
      if (await page.locator("dialog[open]").count()) { error(where, "окно не закрывается по Esc"); await page.evaluate(() => document.querySelector("dialog[open]")?.close()); continue; }
      if (!(await opener.evaluate((el) => el === document.activeElement))) warn(where, "после закрытия фокус не вернулся на кнопку, которая открыла окно");

      await opener.click();
      await page.waitForTimeout(900);
      await page.mouse.click(4, 4);
      await page.waitForTimeout(800);
      if (await page.locator("dialog[open]").count()) { error(where, "окно не закрывается кликом по затемнению"); await page.evaluate(() => document.querySelector("dialog[open]")?.close()); }
    }
    await ctx.close();
  }
}

async function fillValid(form) {
  for (const input of await form.locator("input, textarea").all()) {
    const type = await input.getAttribute("type");
    if (["hidden", "submit"].includes(type) || (await input.getAttribute("tabindex")) === "-1") continue;
    if (type === "checkbox") { if (await input.getAttribute("required") !== null) await input.check(); continue; }
    const name = (await input.getAttribute("name")) || "";
    const value = type === "tel" || /phone/i.test(name) ? "8 (912) 345-67-80"
      : type === "email" ? "check@mail.ru"
      : (await input.evaluate((el) => el.tagName)) === "TEXTAREA" ? "Проверочная заявка"
      : "Анна";
    await input.fill(value);
  }
}

async function checkForm(browser, url, index) {
  const where = `${url.pathname} (форма ${index + 1})`;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const flush = watchPage(page, where, url.origin);
  await page.goto(url.href);
  const form = page.locator("form[data-form]").nth(index);
  // Подменяем адрес приёма заявок, чтобы управлять ответом сервера
  await form.evaluate((el) => { el.action = `${location.origin}/__check_submit`; });
  const submit = form.locator('[type="submit"]');
  const status = form.locator('[role="status"], [aria-live]').first();
  let requests = 0;
  let mode = { status: 200, delay: 0, abort: false };
  await page.route("**/__check_submit", async (route) => {
    requests++;
    await new Promise((r) => setTimeout(r, mode.delay));
    if (mode.abort) return route.abort("internetdisconnected");
    return route.fulfill({ status: mode.status, contentType: "application/json", body: mode.status < 400 ? '{"ok":true}' : '{"error":"fail"}' });
  });
  const statusState = async () => ({
    visible: await status.isVisible().catch(() => false),
    text: ((await status.textContent().catch(() => "")) || "").trim(),
    state: await status.getAttribute("data-state").catch(() => null),
  });
  const values = () => form.locator('input:not([type="checkbox"]):not([tabindex="-1"]), textarea').evaluateAll((els) => els.map((el) => el.value));

  // 0. Человек ввёл ерунду в поле и сразу жмёт «Отправить»: ошибка под полем появляется при уходе из него
  //    и сдвигает кнопку. Если из-за сдвига нажатие теряется, кнопка «не реагирует».
  const firstText = form.locator('input[type="text"]:not([tabindex="-1"]), input[type="email"], input[type="tel"]').first();
  if (await firstText.count()) {
    await firstText.fill("1");
    await submit.click();
    const st0 = await statusState();
    if (!st0.visible) error(where, "нажатие на «Отправить» теряется: кнопку сдвигает появившаяся ошибка поля, и форма не реагирует");
    await firstText.fill("");
  }

  // 1. Пустая отправка: ошибки на русском, фокус на первом поле с ошибкой, запроса нет
  await submit.click();
  const invalid = await form.locator('[aria-invalid="true"]').count();
  const focusInvalid = await page.evaluate(() => document.activeElement?.getAttribute("aria-invalid") === "true");
  const messages = await form.locator(".field__error:visible, [id$='-error']:visible").allTextContents();
  if (!invalid) error(where, "пустая форма не подсвечивает ошибки (нет aria-invalid)");
  if (invalid && !focusInvalid) error(where, "после ошибки фокус не переходит на первое неверное поле");
  if (!messages.some((m) => /[а-яё]/i.test(m))) error(where, "под полями нет понятного текста ошибки на русском");
  if (requests) error(where, "пустая форма всё равно отправилась на сервер");

  // 2. Ошибка сервера: кнопка блокируется на время отправки, ошибка видна, данные не стёрты
  await fillValid(form);
  mode = { status: 500, delay: 400, abort: false };
  await submit.click();
  await page.waitForTimeout(150);
  if (!(await submit.isDisabled())) error(where, "во время отправки кнопка не блокируется (возможна двойная отправка)");
  await page.waitForTimeout(600);
  let st = await statusState();
  if (!st.visible || st.state !== "error" || !/[а-яё]/i.test(st.text)) error(where, "при ошибке сервера форма молчит или не говорит, что случилось");
  if ((await values()).some((v) => !v)) error(where, "после ошибки сервера введённые данные стёрлись");

  // 3. Обрыв сети
  mode = { status: 200, delay: 0, abort: true };
  await submit.click();
  await page.waitForTimeout(400);
  st = await statusState();
  if (!st.visible || st.state !== "error") error(where, "при обрыве сети форма молчит");

  // 4. Нет интернета совсем
  await ctx.setOffline(true);
  const before = requests;
  await submit.click();
  await page.waitForTimeout(300);
  if (requests > before) warn(where, "без интернета форма всё равно пытается отправиться");
  st = await statusState();
  if (!st.visible || st.state !== "error" || !/интернет|сет/i.test(st.text)) warn(where, "без интернета форма не говорит, что дело в подключении");
  await ctx.setOffline(false);

  // 5. Двойной клик и успех: ровно один запрос, «спасибо» после ответа, форма очищена
  mode = { status: 200, delay: 400, abort: false };
  const start = requests;
  await submit.dblclick();
  await page.waitForTimeout(900);
  if (requests - start > 1) error(where, `двойной клик отправил заявку ${requests - start} раза`);
  st = await statusState();
  if (!st.visible || st.state !== "success") error(where, "после успешной отправки нет сообщения об успехе");
  if ((await values()).some((v) => v)) warn(where, "после успешной отправки поля не очистились");

  flush();
  await ctx.close();
}

async function check404(browser, origin) {
  const where = "страница 404";
  const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const page = await ctx.newPage();
  const flush = watchPage(page, where, origin);
  const res = await page.goto(`${origin}/__nope__/deep/page`);
  if (res.status() !== 404) error(where, `несуществующий адрес отвечает ${res.status()}, а не 404`);
  const styled = await page.evaluate(() => [...document.styleSheets].some((s) => { try { return s.cssRules.length > 0; } catch { return false; } }));
  if (!styled) error(where, "страница 404 открывается без стилей");
  const home = await page.locator("a").evaluateAll((as) => as.map((a) => a.href));
  const homeOk = await Promise.all(home.map((h) => fetch(h).then((r) => r.ok && new URL(h).pathname === "/").catch(() => false)));
  if (!homeOk.some(Boolean)) error(where, "на странице 404 нет рабочей ссылки на главную");
  await page.screenshot({ path: path.join(OUT, "screenshots", "404-375.png"), fullPage: true });
  flush();
  await ctx.close();
}

// ---------- запуск ----------

const server = await startServer();
const origin = `http://127.0.0.1:${server.address().port}`;
await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(path.join(OUT, "screenshots"), { recursive: true });

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const queue = ["/"];
const seen = new Set();
const titles = new Map();
const boxes = new Map();

for (const file of ["robots.txt", "sitemap.xml"]) {
  const text = await fs.readFile(path.join(ROOT, file), "utf8").catch(() => null);
  if (text === null) error(file, "файла нет");
  else await checkSourceText(file, text);
}

while (queue.length) {
  const pathname = queue.shift();
  if (seen.has(pathname)) continue;
  seen.add(pathname);
  const url = new URL(pathname, origin);
  const file = await resolveFile(pathname);
  if (!file) { error(pathname, "ссылка ведёт на несуществующую страницу"); continue; }
  if (!file.endsWith(".html")) continue;

  await checkSourceText(pathname, await fs.readFile(file, "utf8"));
  const name = pathname === "/" ? "index" : pathname.replace(/^\/|\.html$/g, "").replace(/\//g, "_");

  for (const size of SIZES) {
    const { width } = size;
    const ctx = await browser.newContext({ viewport: { width, height: size.height }, deviceScaleFactor: size.scale || 1 });
    const page = await ctx.newPage();
    const where = `${pathname} (${sizeLabel(size)})`;
    const flush = watchPage(page, where, origin);
    await page.goto(url.href, { waitUntil: "load" });
    if (size.shot === "screen") await page.screenshot({ path: path.join(OUT, "screenshots", `${name}-${sizeFile(size)}-screen.png`) });
    await revealAll(page);
    await checkLayout(page, where, width);
    await checkOverlap(page, pathname, sizeLabel(size));
    if (size.audit || width === 1920) await checkHoverOverlap(page, pathname, sizeLabel(size));
    if (width === 375) await checkHitArea(page, where);
    if (size.shot === "full") await page.screenshot({ path: path.join(OUT, "screenshots", `${name}-${width}.png`), fullPage: true });
    if (size.boxes) boxes.set(`${pathname}|${sizeFile(size)}`, await measureBoxes(page));

    if (size.audit) {
      const dom = await auditDom(page);
      dom.errors.forEach((m) => error(pathname, m));
      dom.warns.forEach((m) => warn(pathname, m));
      (await auditMotion(page)).forEach((m) => warn(pathname, m));
      for (const stamp of STAMPS) {
        if (dom.text.toLowerCase().includes(stamp)) warn(pathname, `штамп в тексте: «${stamp}»`);
      }
      if (titles.has(dom.title)) warn(pathname, `такой же title, как у ${titles.get(dom.title)}`);
      titles.set(dom.title, pathname);
      for (const link of dom.links) {
        const clean = link.replace(/index\.html$/, "");
        if (!seen.has(clean)) queue.push(clean);
      }
      const og = await page.locator('meta[property="og:image"]').getAttribute("content").catch(() => null);
      if (og && !(await resolveFile(new URL(og, url).pathname))) placeholder(pathname, `нет картинки для превью в мессенджерах: ${new URL(og, url).pathname}`);
      const forms = await page.locator("form[data-form]").count();
      for (let i = 0; i < forms; i++) await checkForm(browser, url, i);
    }
    flush();
    await ctx.close();
  }
  flushSized();
  await checkMenu(browser, url);
  await checkDialogs(browser, url);
}

// Сравнение размеров с прошлой версией: не ошибка, а список для проверки глазами — так ли задумано
if (BASE) {
  const baseServer = await startServer(BASE);
  const baseOrigin = `http://127.0.0.1:${baseServer.address().port}`;
  for (const size of SIZES.filter((s) => s.boxes)) {
    const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height } });
    const page = await ctx.newPage();
    for (const [id, now] of boxes) {
      const [pathname, file] = id.split("|");
      if (file !== sizeFile(size) || !(await resolveFile(pathname, BASE))) continue;
      await page.goto(new URL(pathname, baseOrigin).href, { waitUntil: "load" });
      await revealAll(page);
      const before = await measureBoxes(page);
      const changed = Object.keys(now).filter((k) => before[k] && (Math.abs(before[k][0] - now[k][0]) > 2 || Math.abs(before[k][1] - now[k][1]) > 2));
      const where = `${pathname} (${sizeLabel(size)}, размеры по сравнению с прошлой версией)`;
      for (const k of changed.slice(0, 8)) warn(where, `${k}: ${before[k].join("×")} → ${now[k].join("×")}`);
      if (changed.length > 8) warn(where, `и ещё ${changed.length - 8}`);
    }
    await ctx.close();
  }
  baseServer.close();
}
await check404(browser, origin);
await browser.close();
server.close();

// ---------- вывод ----------

const errors = issues.filter((i) => i.level === "error");
const warns = issues.filter((i) => i.level === "warn");
const group = (list) => {
  const byPlace = new Map();
  for (const i of list) byPlace.set(i.where, [...(byPlace.get(i.where) || []), i.message]);
  return [...byPlace].map(([where, msgs]) => `**${where}**\n${[...new Set(msgs)].map((m) => `- ${m}`).join("\n")}`).join("\n\n");
};
const md = [
  `# Проверка сайта${RELEASE ? " перед публикацией" : ""}`,
  `Страниц: ${seen.size}. Ошибок: ${errors.length}. Предупреждений: ${warns.length}.`,
  errors.length ? `## Ошибки (нужно исправить)\n\n${group(errors)}` : "Ошибок нет.",
  warns.length ? `## Предупреждения${RELEASE ? "" : " (заглушки станут ошибками в проверке перед публикацией)"}\n\n${group(warns)}` : "",
  "Скриншоты 375 / 768 / 1280 (вся страница), первый экран на 1280×630, 1920×1080 и при масштабе Windows 125 %: папка `.check/screenshots`.",
].filter(Boolean).join("\n\n");

await fs.writeFile(path.join(OUT, "report.md"), md + "\n");
if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n");
console.log(md);
process.exit(errors.length ? 1 : 0);
