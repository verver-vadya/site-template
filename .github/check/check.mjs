// Автопроверка сайта на типичные ошибки «сайта от нейросети»: битые ссылки и кнопки без состояний,
// формы без реакции на ошибки, ошибки в консоли, горизонтальная прокрутка, заглушки и штампы в текстах.
// Полный список признаков: ../CHECKLIST.md
//
//   npm run check           ошибки валят проверку, заглушки только предупреждают (черновик)
//   npm run check:release   заглушки тоже валят проверку (перед публикацией на боевой адрес)
//
// Скриншоты 375 / 768 / 1280 и отчёт складываются в .check/ в корне сайта.

import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OUT = path.join(ROOT, ".check");
const RELEASE = process.argv.includes("--release");
const WIDTHS = [375, 768, 1280];
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

async function resolveFile(urlPath) {
  const rel = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, "");
  if (rel.split("/").some((part) => part.startsWith(".") || part === "node_modules")) return null;
  let file = path.join(ROOT, rel);
  try {
    if ((await fs.stat(file)).isDirectory()) file = path.join(file, "index.html");
    await fs.access(file);
    return file;
  } catch {
    return null;
  }
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST") { res.writeHead(405).end(); return; }
    const file = await resolveFile(new URL(req.url, "http://x").pathname);
    const served = file || path.join(ROOT, "404.html");
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

  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    const where = `${pathname} (${width} px)`;
    const flush = watchPage(page, where, origin);
    await page.goto(url.href, { waitUntil: "load" });
    await checkLayout(page, where, width);
    await page.screenshot({ path: path.join(OUT, "screenshots", `${name}-${width}.png`), fullPage: true });

    if (width === 1280) {
      const dom = await auditDom(page);
      dom.errors.forEach((m) => error(pathname, m));
      dom.warns.forEach((m) => warn(pathname, m));
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
  await checkMenu(browser, url);
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
  "Скриншоты 375 / 768 / 1280: папка `.check/screenshots`.",
].filter(Boolean).join("\n\n");

await fs.writeFile(path.join(OUT, "report.md"), md + "\n");
if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n");
console.log(md);
process.exit(errors.length ? 1 : 0);
