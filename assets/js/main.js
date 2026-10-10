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
