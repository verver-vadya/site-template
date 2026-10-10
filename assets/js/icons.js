// Анимированные иконки: <morph-icon> из morphicons (MIT), файлы лежат в assets/vendor/morphicons/.
// Иконка перетекает в новую, когда меняется атрибут icon (строка d от Lucide или Tabler):
//   el.setAttribute("icon", "M18 6 6 18M6 6l12 12");
// Внутри <morph-icon> сразу пишем обычный <svg><path d="…"/></svg>: так иконка видна
// и без JS, а элемент подхватывает её как есть. reduced-motion="user" отключает анимацию,
// если в системе включено «уменьшить движение».
import { defineMorphIcon } from "../vendor/morphicons/element.js";

defineMorphIcon();
