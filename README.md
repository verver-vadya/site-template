# site-template

Шаблон для новых простых сайтов (лендинг, визитка, до ~5 страниц): чистый HTML, CSS и немного JS, без сборки.

Что уже есть:
- адаптивная вёрстка от мобильной версии, токены дизайна (цвета, шрифты, отступы) в начале `assets/css/style.css`;
- шрифт Manrope с кириллицей, лежит в репозитории (без Google Fonts и других CDN), лицензия OFL в `assets/fonts/`;
- мобильное меню, ссылка «перейти к содержимому», видимый фокус;
- `title`, `description`, Open Graph, favicon, `robots.txt`, `sitemap.xml`, страница 404;
- публикация превью на GitHub Pages через GitHub Actions;
- шаблон pull request со скриншотами 375 / 768 / 1280.

## Новый сайт из шаблона

1. На GitHub: **Use this template → Create a new repository**, имя `site-<название>`.
2. Заменить `example.ru`, тексты, токены в `:root`, favicon и `assets/img/og.jpg` (1200×630).
3. Settings → Pages → Source: **GitHub Actions**.

## Запуск локально

Сборки нет, нужен любой статический сервер:

```bash
python3 -m http.server 8000
# или
npx serve .
```

Открыть http://localhost:8000.

## Публикация

- **Превью**: автоматически на GitHub Pages после пуша в `main` (`https://<логин>.github.io/<репозиторий>/`).
- **Боевой сайт**: загрузить файлы на российский хостинг (Timeweb, Beget, Reg.ru) по FTP/SFTP или в Yandex Object Storage. Только после явного согласия владельца.

## Изображения

Фото и иллюстрации хранить в `assets/img/` в WebP или AVIF, с `width`/`height`, `alt` и `loading="lazy"` (кроме первого экрана). Не ссылаться на картинки со сторонних сайтов.
