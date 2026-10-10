// Без этого Safari на iPhone не показывает нажатие (:active) на кнопках и ссылках
document.addEventListener("touchstart", () => {}, { passive: true });

// Мобильное меню: закрывается кнопкой, по ссылке, по Esc и по клику вне меню
const toggle = document.querySelector(".nav-toggle");
const nav = document.getElementById("site-nav");
if (toggle && nav) {
  const label = toggle.querySelector(".nav-toggle__label") || toggle;
  // Иконка «бургер ↔ крестик» перетекает через <morph-icon> (assets/js/icons.js).
  // Если модуль не загрузился, иконка просто остаётся бургером, меню работает.
  const icon = toggle.querySelector("morph-icon");
  const ICON_MENU = "M4 5h16M4 12h16M4 19h16";
  const ICON_CLOSE = "M18 6 6 18M6 6l12 12";
  const setOpen = (open) => {
    nav.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    label.textContent = open ? "Закрыть" : "Меню";
    if (icon) icon.setAttribute("icon", open ? ICON_CLOSE : ICON_MENU);
  };
  const isOpen = () => toggle.getAttribute("aria-expanded") === "true";

  toggle.addEventListener("click", () => setOpen(!isOpen()));
  nav.addEventListener("click", (e) => {
    if (e.target.closest("a")) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) {
      setOpen(false);
      toggle.focus();
    }
  });
  document.addEventListener("click", (e) => {
    if (isOpen() && !nav.contains(e.target) && !toggle.contains(e.target)) setOpen(false);
  });
}

// Текущий год в подвале (в HTML тоже вписан год на случай, если скрипт не загрузится)
document.querySelectorAll("[data-year]").forEach((el) => {
  el.textContent = new Date().getFullYear();
});

// Окно-шторка: <dialog class="sheet" id="…">, открывает кнопка с aria-controls="…" и aria-haspopup="dialog".
// Закрывается кнопкой [data-close], по Esc и кликом по затемнению, всегда с анимацией.
// Фокус при открытии на заголовке окна, а не на «Закрыть»: на телефоне у кнопки не появляется рамка.
document.querySelectorAll("dialog.sheet").forEach((sheet) => {
  if (typeof sheet.showModal !== "function") return;
  const openers = document.querySelectorAll(`[aria-controls="${sheet.id}"]`);
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  let opener = null;
  let closing = false;
  let afterClose = null;

  const open = async (button) => {
    if (sheet.open) return;
    opener = button;
    const title = sheet.querySelector(".sheet__title");
    if (title) { title.tabIndex = -1; title.autofocus = true; }
    sheet.querySelector(".sheet__body")?.scrollTo(0, 0);
    sheet.classList.remove("is-closing");
    sheet.showModal();
    document.documentElement.classList.add("has-sheet");
    // Самый тяжёлый кадр (окно встаёт поверх страницы) проходит без движения, выезд начинается через два кадра:
    // так ни один кадр анимации не теряется
    await nextFrame();
    await nextFrame();
    if (sheet.open) sheet.classList.add("is-open");
  };

  const close = () => {
    if (!sheet.open || closing) return;
    closing = true;
    sheet.classList.add("is-closing");
    sheet.classList.remove("is-open");
    const duration = parseFloat(getComputedStyle(sheet).getPropertyValue("--duration-sheet-out")) || 320;
    setTimeout(() => {
      closing = false;
      sheet.close();
    }, duration);
  };

  openers.forEach((button) => button.addEventListener("click", () => open(button)));
  sheet.addEventListener("click", (e) => {
    // Ссылка на раздел страницы внутри окна: сначала окно уезжает, потом страница листается к разделу
    const link = e.target.closest('a[href^="#"][data-close]');
    if (link) {
      e.preventDefault();
      afterClose = () => {
        document.querySelector(link.hash)?.scrollIntoView();
        history.replaceState(null, "", link.hash);
      };
    }
    if (e.target.closest("[data-close]") || !e.target.closest(".sheet__panel")) close();
  });
  sheet.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  sheet.addEventListener("close", () => {
    sheet.classList.remove("is-open", "is-closing");
    document.documentElement.classList.remove("has-sheet");
    if (afterClose) { afterClose(); afterClose = null; }
    else opener?.focus({ preventScroll: true });
  });
});
