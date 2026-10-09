// Формы с атрибутом data-form: проверка ввода на русском и честная отправка.
// «Спасибо» показываем только после ответа сервера; при ошибке данные остаются в полях.
// Без JS форма отправляется обычным POST, а браузер сам проверяет обязательные поля.

const TIMEOUT_MS = 15000;

const TEXT = {
  required: "Заполните это поле",
  checkbox: "Отметьте этот пункт",
  phone: "Нужен номер из 10 цифр после +7 или 8",
  email: "Проверьте адрес почты: в нём должны быть @ и домен, например name@mail.ru",
  tooShort: (n) => `Нужно хотя бы ${n} ${plural(n, ["символ", "символа", "символов"])}`,
  invalidSummary: "Проверьте выделенные поля",
  sending: "Отправляем…",
  success: "Заявка отправлена. Мы свяжемся с вами по указанному телефону.",
  offline: "Нет подключения к интернету. Данные сохранены: проверьте сеть и нажмите «Отправить» ещё раз.",
  timeout: "Сервер не ответил вовремя. Данные сохранены, попробуйте отправить ещё раз.",
  network: "Не удалось связаться с сервером. Данные сохранены, попробуйте ещё раз через минуту.",
  server: "Сервер не принял заявку. Данные сохранены, попробуйте ещё раз через минуту.",
  notConfigured: "Форма ещё не подключена к приёму заявок. Свяжитесь с нами по телефону или почте.",
};

const pluralRules = new Intl.PluralRules("ru");
function plural(n, [one, few, many]) {
  const form = pluralRules.select(n);
  return form === "one" ? one : form === "few" ? few : many;
}

function phoneDigits(value) {
  let digits = value.replace(/\D/g, "");
  if (digits.length === 11 && (digits[0] === "7" || digits[0] === "8")) digits = digits.slice(1);
  return digits;
}

function validateField(input) {
  const value = input.type === "checkbox" ? "" : input.value.trim();
  if (input.required) {
    if (input.type === "checkbox" ? !input.checked : value === "") {
      return input.dataset.errorRequired || (input.type === "checkbox" ? TEXT.checkbox : TEXT.required);
    }
  }
  if (value === "") return "";
  if (input.dataset.validate === "phone" && phoneDigits(value).length !== 10) return TEXT.phone;
  if (input.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return TEXT.email;
  if (input.minLength > 0 && value.length < input.minLength) return TEXT.tooShort(input.minLength);
  return "";
}

function errorElement(input) {
  const id = `${input.id}-error`;
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("p");
    el.className = "field__error";
    el.id = id;
    el.hidden = true;
    input.closest(".field").append(el);
  }
  return el;
}

function showError(input, message) {
  const el = errorElement(input);
  const describedBy = (input.getAttribute("aria-describedby") || "").split(" ").filter((id) => id && id !== el.id);
  if (message) {
    el.textContent = message;
    el.hidden = false;
    input.setAttribute("aria-invalid", "true");
    describedBy.unshift(el.id);
  } else {
    el.textContent = "";
    el.hidden = true;
    input.removeAttribute("aria-invalid");
  }
  if (describedBy.length) input.setAttribute("aria-describedby", describedBy.join(" "));
  else input.removeAttribute("aria-describedby");
}

function initForm(form) {
  form.noValidate = true; // проверяем сами, с понятными сообщениями
  const fields = [...form.querySelectorAll("input, textarea, select")].filter(
    (el) => el.type !== "hidden" && !el.classList.contains("form__trap") && el.id
  );
  const button = form.querySelector('[type="submit"]');
  const buttonText = button.textContent;
  const status = form.querySelector(".form__status");
  let sending = false;
  // Пока кнопку отправки нажимают, ошибку при уходе из поля не показываем: она сдвинула бы кнопку
  // из-под курсора, и нажатие потерялось бы. Поля всё равно проверит отправка.
  let pressingSubmit = false;
  button.addEventListener("pointerdown", () => {
    pressingSubmit = true;
    document.addEventListener("pointerup", () => setTimeout(() => { pressingSubmit = false; }), { once: true });
  });

  const setStatus = (state, message) => {
    if (!status) return;
    status.dataset.state = state;
    status.textContent = message;
    status.hidden = !message;
  };

  const setBusy = (busy) => {
    sending = busy;
    button.disabled = busy;
    button.setAttribute("aria-busy", String(busy));
    button.textContent = busy ? TEXT.sending : buttonText;
  };

  fields.forEach((input) => {
    // Ошибку показываем, когда человек ушёл из поля, а убираем сразу, как только он её исправил
    input.addEventListener("blur", () => {
      if (pressingSubmit) return;
      if (!input.hasAttribute("aria-invalid") && (input.type === "checkbox" || input.value.trim() === "")) return;
      showError(input, validateField(input));
    });
    input.addEventListener(input.type === "checkbox" ? "change" : "input", () => {
      if (input.hasAttribute("aria-invalid")) showError(input, validateField(input));
    });
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (sending) return; // защита от двойного клика

    let firstInvalid = null;
    fields.forEach((input) => {
      const message = validateField(input);
      showError(input, message);
      if (message && !firstInvalid) firstInvalid = input;
    });
    if (firstInvalid) {
      setStatus("error", TEXT.invalidSummary);
      firstInvalid.focus();
      return;
    }

    if (/YOUR_FORM_ID/.test(form.action)) {
      setStatus("error", TEXT.notConfigured);
      return;
    }
    if (!navigator.onLine) {
      setStatus("error", TEXT.offline);
      return;
    }

    const data = new FormData(form);
    fields
      .filter((input) => input.dataset.validate === "phone")
      .forEach((input) => data.set(input.name, `+7${phoneDigits(input.value)}`));

    setBusy(true);
    setStatus("", "");
    try {
      const response = await fetch(form.action, {
        method: "POST",
        body: data,
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      form.reset();
      setStatus("success", TEXT.success);
    } catch (error) {
      const message =
        error.name === "TimeoutError" ? TEXT.timeout
        : !navigator.onLine ? TEXT.offline
        : error instanceof TypeError ? TEXT.network
        : TEXT.server;
      setStatus("error", message);
    } finally {
      setBusy(false);
      const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
      status?.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
    }
  });
}

document.querySelectorAll("form[data-form]").forEach(initForm);
