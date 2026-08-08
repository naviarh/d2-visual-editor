# План: номера строк в редакторе кода D2

Статус: **реализовано** — UI-гуттер, скролл-синк, динамическая ширина; юнит (188/188) и E2E (20/20) зелёные. Этап готов к код-ревью и коммиту.
Ветка: `main` (работа ведётся без коммита до явной просьбы).
Эталон: поведение редакторов кода (VS Code и подобные) — гуттер с номерами слева, синхронизация вертикального скролла с текстом, выравнивание строк по высоте.

## 1. Цель и границы

**Цель.** Добавить в панель «Код D2» (textarea `#out`) гуттер с номерами строк слева от текста. Номера скроллятся синхронно с текстом, выровнены по строкам, шрифт номеров меньше шрифта текста.

**Требования пользователя (зафиксированы).**
- Размер шрифта номеров меньше шрифта текста: текст 12px → номера **10px**.
- Справа от номеров — промежуток до границы **1.5 символа**; толщина границы — **1 символ** (в единицах `ch` шрифта гуттера, 10px monospace).
- Фон области номеров слегка темнее фона текста; цвет границы ещё темнее.
- Номера выравнены **вправо**.
- Гуттер сразу вмещает двузначные номера (до 99) и расширяется на 3 знака (до 999) и 4 (до 9999) по мере роста числа строк.

**Вне скоупа.** Номера в визуальной схеме, сворачивание/раскрытие скрытых строк, брейкпоинты, подсветка активной строки — всё это не требуется.

**Критерий приёмки.**
- Номера строк видны и выровнены по строкам текста; вертикальный скролл textarea синхронно двигает гуттер (и вниз, и вверх, и в самый низ).
- Ширина гуттера подстраивается под число знаков: 2 → 3 → 4 по мере добавления строк.
- `npm test` и `npm run test:ui` остаются зелёными (структура `#out` и id сохранены, E2E-селекторы не ломаются).

## 2. Ключевые ограничения и решения

1. **`#out` — нативный `<textarea wrap="off">`.** Переносов строк нет (один `\n` = одна визуальная строка), значит число строк = `value.split("\n").length`. Гуттер не может быть «внутри» textarea — делаем **флекс-обёртку**: `#editor-wrap { display:flex }`, слева `#line-nums`, справа `#out`.
2. **Выравнивание по строкам.** Текст: `font: 12px/1.5` → высота строки 18px, `padding: 10px 12px`. Гуттер: тот же шрифт-стек, `font-size: 10px`, **`line-height: 18px`**, тот же `padding-top: 10px` и `padding-bottom: 10px` (нижний паддинг нужен, чтобы совпадали `scrollHeight` и выравнивание в самом низу).
3. **Синхронизация скролла.** Гуттер `overflow: hidden`; по событию `scroll` на textarea ставим `lineNums.scrollTop = out.scrollTop`. При совпадении высот содержимого выравнивание держится на всём диапазоне скролла.
4. **Ширина гуттера (цифры).** Число знаков = `max(2, digits(lines))`. Ширина в `ch` (относительно шрифта гуттера 10px): `digits + 1.5 (padding-left) + 1.5 (padding-right) + 1 (border-right)`. При `box-sizing: border-box` это полная ширина элемента. Меняется инлайн-стилем из JS.
5. **Обновление номеров.** Полный ребейл текста гуттера только когда изменилось число строк (оптимизация: не переписывать на каждое нажатие клавиши); скролл-синк — всегда. Вызывается при: `input`-событии, `regenerateTextView()`, `applyCode()`, `pasteFromClipboard()` и при старте (после `regenerateTextView()` на загрузке).

## 3. Изменения

### 3.1 HTML (index.html)

Внутри `#code-panel` оборачиваем textarea в обёртку:

```html
<div id="editor-wrap">
  <div id="line-nums"></div>
  <textarea id="out" spellcheck="false" wrap="off"></textarea>
</div>
```

### 3.2 CSS (index.html)

```css
#editor-wrap { flex: 1; min-height: 0; display: flex; }
#line-nums {
  overflow: hidden; flex: 0 0 auto;
  padding: 10px 1.5ch 10px 0;
  text-align: right;
  font: 10px/18px ui-monospace, "SF Mono", Menlo, monospace;
  color: #8a93a6; background: #eef0f3;
  border-right: 1ch solid #c9cdd6;
  white-space: pre; user-select: none;
}
#out { flex: 1; min-width: 0; width: auto; /* остальное как было */ }
```

Цвета: фон текста `#f6f8fa` → фон гуттера `#eef0f3` (темнее), граница `#c9cdd6` (ещё темнее). Ширина гуттера задаётся из JS инлайн (`Nch`), CSS-минимума нет — JS гарантирует ≥ 4.5ch.

### 3.3 JS (index.html)

```js
let lastLineCount = -1;
function updateLineNumbers() {
  const out = document.getElementById("out");
  const nums = document.getElementById("line-nums");
  const n = out.value.split("\n").length;
  if (n !== lastLineCount) {
    const digits = Math.max(2, String(n).length);
    nums.style.width = (digits + 4) + "ch";
    const parts = [];
    for (let i = 1; i <= n; i++) parts.push(i);
    nums.textContent = parts.join("\n");
    lastLineCount = n;
  }
  nums.scrollTop = out.scrollTop;
}
```

Точки вызова:
- в `regenerateTextView()` после `out.value = text`;
- в начале обработчика `input` на `#out` (строка 1079);
- в `applyCode()` после `outEl.value = text`;
- в `pasteFromClipboard()` после присвоения `outEl.value`;
- подписка `out.addEventListener("scroll", ...)` на скролл-синк (рядом с обработчиком `input`).

## 4. Риски и проверки

- **E2E не ломаются**: id `#out` и его роль сохраняются; селекторы в `test/ui-smoke.test.mjs` работают с `#out` и `#code-panel`, обёртка `#editor-wrap` на них не влияет.
- **Скролл-синк в самом низу**: равенство `scrollHeight` (за счёт `padding-bottom: 10px` с обеих сторон) даёт совпадение `scrollTop` на всём диапазоне.
- **Базовая линия**: разница базовой линии 10px vs 12px в строке 18px ~0.6px — визуально незаметно.
- Проверка: `npm test`, `npm run test:ui`, ручной просмотр в Chrome.
