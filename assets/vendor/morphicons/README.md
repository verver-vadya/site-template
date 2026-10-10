# morphicons 1.7.1

Плавное перетекание одной контурной иконки в другую (Lucide, Tabler и т. п.): веб-компонент `<morph-icon>`.
Исходники: https://github.com/guillermolg00/morphicons, npm: https://www.npmjs.com/package/morphicons, лицензия MIT (`LICENSE`).

Здесь только файлы веб-компонента из `dist/` пакета (`element.js` и то, что он импортирует), без сборки и без CDN.
Подключение: `assets/js/icons.js`.

Обновить до новой версии:

```bash
npm pack morphicons@latest
tar xzf morphicons-*.tgz
# заменить файлы в этой папке на package/dist/element.js и все .js, которые он импортирует (имена с хешем меняются)
# поправить версию в заголовке этого файла
rm -rf package morphicons-*.tgz
```
