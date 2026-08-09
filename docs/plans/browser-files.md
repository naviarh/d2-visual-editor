# План: Файлы в браузере — рабочий файл реализации (часть 2)

Статус: **реализовано** (этапы 1–7; `npm test` 241/241, `npm run test:ui` 46/46). Расхождения реализации от плана — в §9.1.
Родительский план: `docs/plans/undo-redo-and-browser-files.md` (§4–§7, часть 2). Этот файл — самодостаточный подробный план реализации; читать вместе с родительским.
Дата: 2026-08-09

---

## 0. Итог анализа текущего кода (на что опираемся)

Проверено по факту (не по памяти):

| Что | Где | Замечание для реализации |
|---|---|---|
| Модалка | `openEditDialog` `index.html:999`, разметка `index.html:179-188` | Статичные `#modal-overlay/#modal-box/#modal-title/#modal-input/#modal-actions/#modal-ok/#modal-cancel`. Перетаскивание по `#modal-title` — `index.html:235` (глобальный `pointerdown`). Enter/Escape — `keydown` на `#modal-input` c `stopPropagation()` (гасит глобальный `keydown` `index.html:1615`) |
| `saveState` | `index.html:475` | Строит payload v:1 инлайн — **вынести в `graphPayload()`** |
| `loadState` | `index.html:492` | Содержит валидацию (`v:1`, массивы `nodes`/`edges`, `typeof n.id`) — **вынести в `validateState(data)`** |
| `applyGraph` | `index.html:324` | `nodes.clear()+set`, `edges.push(...)`, `order`, `idCounter`. Нужен обёрточный `applyState(g)` |
| `applyViewport` | `index.html:620` | Ставит `viewport` + transform + `queueSave` — годится для восстановления из файла |
| `currentGraph` | `index.html:296` | Нормализация `v:2`. **Не используется** для файлов (payload файла — как в автосохранении, `v:1`) |
| Меню «Копировать» | `index.html:131-141`, обработчик `1269-1282` | Пункты `import`/`export` удалить, добавить `open-browser`/`save-browser`/`import-file`/`export-file`/`export-d2` |
| Скрытый input файла | `index.html:145` | `accept` дополнить `.dd2` |
| `exportD2` | `index.html:1336` | Вся механика picker+fallback — вынести в общий `downloadCode(content, ext, base)` |
| `downloadBlob` | `index.html:1535` | Готовый fallback-скачивание — переиспользуем |
| `toStandardD2` | **отсутствует** в `js/d2-serialize.js` (API: 401-404) | Добавить: `serializeClean(graph, {refText})` |
| `saveUiPrefs`/`UI_KEY` | `index.html:1572`/`276` | Есть; добавим `currentFile` |
| `exportName` | `index.html:273`, чтение `1603-1613` | Остаётся «последнее имя экспорта»; `downloadCode` сам заменяет расширение |
| Старт | `index.html:1732-1741` | `loadState()` → `seed()` → `history` → `applyViewport` → `render` → `regenerateTextView` → rAF `fitView`. При желании перевести на `applyState` (критерий: поведение не меняется) |
| `snapshotState/liveState/pushIfChanged` | `index.html:340-352` | Сохранение/открытие файла — **не** undo/redo: историю не трогаем (кроме `clearHistory` при открытии) |
| E2E, зависимые от меню | `test/ui-smoke.test.mjs:322` (`deepEqual` порядка пунктов), `393` (`data-act="import"`), `428/470/478/498` (`data-act="export"`) | **Обновить обязательно** при перестройке меню |
| E2E-хелпер `freshPage` | `test/ui-history.test.mjs:8` | `evaluateOnNewDocument(localStorage.clear)` чистит и при reload — для теста персистентности нужен init-флаг (см. §7.2) |

---

## 1. Уточнения и решения (отличия от черновика родительского плана)

Черновик в целом реализуем; четыре момента сделаем иначе — иначе будет некорректно или хрупко:

1. **Никаких вложенных модалок на одном оверлее.** `confirmDialog` поверх открытой `#files-modal` перезапишет её содержимое (оверлей один). Поэтому:
   - подтверждение **перезаписи** — инлайн-фаза внутри `#save-modal` (как и в черновике, §4.4);
   - подтверждение **удаления файла** — инлайн-фаза внутри `#files-modal` (в черновике §4.5 звался `confirmDialog` — это расхождение, документированное здесь);
   - `confirmDialog` остаётся обёрткой `showModal` и используется только там, где **никакая модалка ещё не открыта** — «База файлов браузера недоступна…» из «Открыть из браузера» (список ещё не показан).
   - Если «База недоступна» всплывает из «Сохранить» (модалка сохранения уже открыта) — это инлайн-фаза того же окна, не отдельный `confirmDialog`.
2. **`toStandardD2`** — функция `js/d2-serialize.js` с сигнатурой `toStandardD2(graph, refText)` → `serializeClean(graph, { refText })`. Второй аргумент — строка, не объект-опции (как в черновике §5.1). Юнит-покрытие: равенство `serializeClean`, отсутствие `# --- @d2pos`, CLI-паритет.
3. **`#fileLabel`** («Файл: name» в `.outbar`) — **реализуем сразу**, а не опционально: дёшево, помогает E2E-ассертам и UX. Скрыт, пока `currentFile === null`.
4. **Хелпер `freshPage`** в новых E2E — чистит localStorage/IDB **только при первой навигации** (флаг в `sessionStorage`), чтобы тест персистентности (save → reload → файл в списке) работал.

Остальное — как в родительском плане (§4.1–§4.10): IndexedDB `d2editor`/store `files`/keyPath `name`; запись `{name, v:1, graph, savedAt, size}`; payload `v:1`; `currentFile` в `d2editor:ui:v1`; статусы «Сохранено в браузер: …»/«Открыт: …».

### 1.1 Правки по итогам перепроверки плана (2026-08-09)

План сверен с кодом повторно; найденные ошибки учтены в §3–§8. Сводно:

1. **`idbRequest` (§4) — битый эскиз**: в ветке `fn.length === 2` `resolve` регистрируется на `tx.oncomplete`, который ниже перетирается общим `tx.oncomplete`; `req;` — no-op; в `fileList` возврат `fn` (маппинг записей) отбрасывается — `resolve` берёт `req.result`. Заменяется единым чистым `idbOp(db, mode, cb)` (см. §4).
2. **`fileReset` (деструктивный путь) зависает**: `deleteDatabase` блокируется, если кэш соединения из `dbFiles()` ещё открыт (типично при ошибке транзакции — store отсутствует). → в `dbFiles` держим `dbHandle`, `fileReset` сначала `dbHandle.close()`. Иначе `handleIdbDown` рекурсирует бесконечно.
3. **`handleIdbDown` — бесконечная рекурсия** при устойчивом сбое `fileReset`. → ограничиваем число попыток (2), при исчерпании `false`.
4. **`setContent` (innerHTML) для сообщений с именами файлов** — XSS/поломка разметки при имени с `<`/`"`. → в `session` два метода: `setText(str)` (textContent) для сообщений/подтверждений и `setContent(html)` (raw, только список файлов). Добавляется `escAttr` (у `esc` нет экранирования `"`).
5. **E2E «IDB недоступна» (§8.2, сценарий 10) противоречит сам себе**: фейк на **один** вызов + «повторное сохранение → снова инлайн» несовместимы (второй вызов уйдёт на реальный API). → фейк на **первые два** вызова: первое сохранение → инлайн → «Отмена»; второе → снова инлайн → «Пересоздать базу файлов» → успех.
6. **`data-act="export"` в ui-smoke — 5 вхождений, не 4**: план забыл строку 520 (фолбэк-скачивание без picker). Обновлять строки 428/470/478/498/520.
7. **`npm run test:ui` не запускает новый файл** — в package.json скрипт перечисляет `ui-smoke`+`ui-history` явно. → добавить `test/ui-files.test.mjs` (новый §8.5).
8. **`graphPayload` хранит `edges` ссылкой** — при первом открытии базы `put` откладывается (микро-макро-таск), зазор потенциально опасен. → `edges: edges.map(e => ({...e}))`; вывод JSON идентичен `saveState` (глубокая сериализация), поведение не меняется.
9. Мелочи: `escHtml` в проекте нет (только `esc`); `fillStorageLine` считал `free` и не использовал (формат не финализирован); `modalOk`/`modalCancel`-консты устареют после динамических кнопок; CSS под `#modal-content`/`.file-row`/`#files-list`/`#fileLabel` отсутствует.

---

## 2. Сводно: файлы, которые меняются/создаются

| Файл | Изменение |
|---|---|
| `index.html` | `graphPayload()`, `validateState()`, `applyState()`, IDB-хелперы, `showModal` + `confirmDialog` + `saveModal` + `filesModal`, `currentFile` + `#fileLabel`, перестройка меню, `downloadCode`, `import-file`/`export-file`/`export-d2`, обработка недоступной базы |
| `js/d2-serialize.js` | +`toStandardD2` в API |
| `test/serialize.test.mjs` (или `cli-parity`) | юнит: `toStandardD2` === `serializeClean`, нет маркеров, CLI-паритет |
| `test/ui-files.test.mjs` (**новый**) | E2E «Файлы в браузере» (§7.2) |
| `test/ui-smoke.test.mjs` | обновить: порядок пунктов меню, `data-act` import→`import-file`, export→`export-d2` |
| `AGENTS.md`, `docs/architecture.md`, `docs/development.md`, статус родительского плана | документация (§8) |

---

## 3. Инфраструктура payload и `applyState`

### 3.1 `graphPayload()`

Вынести из `saveState` (index.html:475-490) — **идентичный вывод**:

```js
function graphPayload() {
  return {
    v: 1,
    nodes: [...nodes.values()].map((n) => ({ ...n, children: n.children.slice() })),
    edges: edges.map((e) => ({ ...e })),
    idCounter, viewport, order, showComments
  };
}
function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(graphPayload())); } catch (e) {}
}
```

- `edges` — копия элементов (`{...e}`), **не** ссылка на живой массив: между `graphPayload()` и `filePut` есть асинхронный зазор (первое открытие IDB), копия исключает мутацию в этот промежуток. JSON-вывод идентичен прежнему `saveState` (глубокая сериализация), поэтому инлайн-код автосохранения просто заменяется вызовом — поведение не меняется.
- `size` для записи файла: `JSON.stringify(graphPayload()).length` — вычислять **до** `filePut` (см. §4), одним вызовом, чтобы не расходиться.

### 3.2 `validateState(data)`

Вынести проверки из `loadState`:

```js
function validateState(data) {
  if (!data || data.v !== 1 || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) return false;
  for (const n of data.nodes) if (!n || typeof n.id !== "string") return false;
  return true;
}
```

`loadState` после валидации применяет данные в живые структуры — этот код и станет телом `applyState`.

### 3.3 `applyState(g)` — единая замена состояния

Общая для «открыть файл» и (опционально) для старта. Возвращает `true`/`false`.

```js
function applyState(g) {
  if (!validateState(g)) return false;
  nodes.clear();
  for (const n of g.nodes) nodes.set(n.id, { ...n, children: n.children || [] });
  edges.length = 0;
  edges.push(...g.edges);
  order = (Array.isArray(g.order) && g.order.length) ? g.order.slice() : D2S.defaultOrder(currentGraph());
  if (Number.isFinite(g.idCounter)) idCounter = g.idCounter;
  if (g.viewport && Number.isFinite(g.viewport.x)) applyViewport({ ...g.viewport });
  if (typeof g.showComments === "boolean") showComments = g.showComments;
  selectedId = null; selectedEdgeId = null; edgeSrc = null; groupParent = null;
  render();
  regenerateTextView();
  updateUndoUI();
  return true;
}
```

- `applyViewport` сам делает transform + `queueSave`; `render()` — `queueSave`/`queueGen`. Автосохранение сессии перепишется → reload восстановит открытый файл (поведение из родительского плана §4.5).
- `regenerateTextView()` берёт `refText` из текущего `#out.value` — несохранённый неслитый текст в textarea будет **заменён** (осознанная семантика явной команды, аналогично undo).
- **Старт** (опциональный рефакторинг, строго эквивалентный): вместо ручной раскидки `loadState` → `if (!validateState(data)) seed()` → `history` → `applyViewport` → `render` → `regenerateTextView` → rAF `fitView()` при `!restored` вызвать `applyState(data)`. Внимание: `applyState` делает `render()` → `queueSave` при старте (безвредно). Если рефакторинг делает поведение иным в любом тесте — откатить к текущему виду (критерий — все E2E).

---

## 4. IDB-хелперы (в `index.html`; IDB — браузерный API, в чистые модули не выносим)

БД `d2editor`, версия `1`, store `files` (`keyPath: "name"`, `autoIncrement: false`). Запись: `{ name, v: 1, graph, savedAt, size }`.

```js
const DB_NAME = "d2editor";
const DB_STORE = "files";
let dbPromise = null;
let dbHandle = null;   // текущее открытое соединение (для close перед deleteDatabase)

function dbFiles() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE))
        req.result.createObjectStore(DB_STORE, { keyPath: "name" });
    };
    req.onsuccess = () => { dbHandle = req.result; resolve(req.result); };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => { dbPromise = null; reject(new Error("blocked")); };
  });
  return dbPromise;
}

// Единый helper одной транзакции. cb(os) должен вернуть IDBRequest (или
// undefined для чисто-записных операций — тогда resolve на oncomplete).
// resolve с результатом request'а или undefined на успешном завершении;
// reject на ошибке транзакции, abort, исключении в cb или NotFoundError
// (перехватывается при взятии objectStore).
function idbOp(db, mode, cb) {
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(DB_STORE, mode); }
    catch (e) { reject(e); return; }        // NotFoundError (повреждённая схема)
    let os;
    try { os = tx.objectStore(DB_STORE); }
    catch (e) { reject(e); return; }
    let settled = false;
    const onError = (e) => { if (!settled) { settled = true; reject(e); } };
    tx.onerror = () => onError(tx.error || new Error("idb tx error"));
    tx.onabort = () => onError(tx.error || new Error("idb tx aborted"));
    tx.oncomplete = () => { if (!settled) { settled = true; resolve(undefined); } };
    let req;
    try { req = cb(os); }
    catch (e) { onError(e); return; }
    if (req && typeof req.onsuccess === "function") {
      req.onsuccess = () => { if (!settled) { settled = true; resolve(req.result); } };
    }
  });
}

function fileList() {
  return dbFiles().then((db) => idbOp(db, "readonly", (os) => os.getAll()))
    .then((list) => (list || [])
      .map((rec) => ({ name: rec.name, savedAt: rec.savedAt, v: rec.v, size: rec.size }))
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)));
}
function fileGet(name) { return dbFiles().then((db) => idbOp(db, "readonly", (os) => os.get(name))); }
function filePut(name, g) {
  const size = JSON.stringify(g).length;
  return dbFiles().then((db) => idbOp(db, "readwrite", (os) => {
    os.put({ name, v: 1, graph: g, savedAt: Date.now(), size });
  }));
}
function fileDelete(name) { return dbFiles().then((db) => idbOp(db, "readwrite", (os) => os.delete(name))); }
function fileReset() {
  if (dbHandle) { try { dbHandle.close(); } catch (e) {} dbHandle = null; }
  dbPromise = null;
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("blocked"));
  }).then(() => dbFiles()).then(() => {});
}
```

Замечания:
- **Единый источник ошибок** — любой reject из `dbFiles()` (open/onerror/onblocked) и из транзакции (в т.ч. `NotFoundError` от отсутствующего store) обрабатывается одинаково: команда показывает состояние «База файлов браузера недоступна…» (§6). Так `store absent` из черновика §4.9 попадает в тот же поток автоматически.
- `dbPromise` сбрасывается в `null` при сбое **открытия** (не транзакции) — следующая операция пробует открыть заново (черновик §4.9: ошибка может быть временной).
- **`fileReset()` закрывает открытое соединение** (`dbHandle.close()`) **до** `deleteDatabase` — иначе `deleteDatabase` получает `blocked` (соединение из кэша `dbFiles` открыто) и `handleIdbDown` зацикливается. Это единственная деструктивная операция, только по явному выбору пользователя.

---

## 5. Каркас модалок `showModal` + обёртки

### 5.1 Контракт

Разметка остаётся существующей (`#modal-overlay`/`#modal-box`/`#modal-title`/`#modal-input`/`#modal-actions`). Добавляется **один новый элемент** — контейнер произвольного содержимого:

```html
<div id="modal-content" hidden></div>
```

между `#modal-input` и `#modal-actions` (скрыт в режиме ввода и подтверждений-без-тела).

```js
const session = showModal({
  title: "…",
  showInput: "value" | null,          // строка — показать input с префиллом; null — без input
  buttons: [{ label, primary?, id?, onClick? }],
  behavior: { allowOverlayClose, allowEscapeClose, onEnter?, onEscape? }
});
session.close(result);                // закрыть; разрешает session.closed
await session.closed;                 // Promise<result | null>
```

Методы `session` (меняют окно **без закрытия** — фазы):
- `setTitle(t)`
- `setShowInput(v)` — показать/скрыть `#modal-input`; **значение input сохраняется** между фазами
- `setText(str)` — заполнить `#modal-content` **текстом** (`textContent`; безопасно для пользовательских строк: имена файлов, названия диаграмм), показать его и скрыть input; `null` — наоборот (вернуть фазу ввода)
- `setContent(html)` — заполнить `#modal-content` **сырым HTML** (только список файлов; все подставляемые значения через `escAttr`), показать его и скрыть input
- `setButtons(list)` — пересобрать `#modal-actions` (кнопки создаются динамически)
- `setBehavior(partial)` — обновить `allowOverlayClose/allowEscapeClose/onEnter/onEscape`
- `close(result)` — скрыть оверлей, снять слушатели, resolve `closed`

Внутренние гарантии (обязательные, иначе ломаются существующие E2E и хоткеи):
- **Кнопки создаются с сохранением id**: primary-кнопка получает `id="modal-ok"`, единственная отменяющая — `id="modal-cancel"` (тесты кликают по `#modal-ok`/`#modal-cancel`). Консты `modalOk`/`modalCancel` (index.html:217-218) ссылаются на статичные кнопки — после перестройки `#modal-actions` они устареют, удалить консты (использовались только в `openEditDialog`).
- **Перетаскивание по заголовку** — глобальный обработчик `modalTitle pointerdown` (index.html:235) не трогаем; при открытии повторяем clamp-код из `openEditDialog` (index.html:1001-1005) для уже сдвинутого окна.
- **Клавиши**: пока модалка открыта, `document.addEventListener("keydown", onKey, true)` (capture) с `stopPropagation()` — гасит глобальный `keydown` (window, index.html:1615): undo-хоткеи и Escape-сброс выделения не срабатывают под модалкой. `stopPropagation` не отменяет default-action, поэтому ввод в `#modal-input` работает. Enter → `onEnter` (или primary-кнопка), Escape → по `behavior` (приоритет `onEscape`, затем `allowEscapeClose`). Capture-фаза ловит клавиши даже при фокусе вне input (например, в `#files-modal`).
- **Оверлей**: клик по `#modal-overlay` (не по `#modal-box`) → `allowOverlayClose ? close(null) : (onEscape || noop)`.
- **Одиночная сессия**: при вызове `showModal` во время открытой другой сессии — предыдущая сначала `close(null)` (защита от «висящих» слушателей).

### 5.2 `openEditDialog` — тонкая обёртка (поведение не меняется)

```js
function openEditDialog(opts) {
  return new Promise((resolve) => {
    const s = showModal({
      title: opts.title,
      showInput: opts.value || "",
      buttons: [
        { label: "Отмена", id: "modal-cancel", onClick: () => s.close(null) },
        { label: "OK", primary: true, id: "modal-ok", onClick: () => s.close(modalInput.value) }
      ],
      behavior: { allowOverlayClose: true, allowEscapeClose: true, onEnter: () => s.close(modalInput.value) }
    });
    s.closed.then(resolve);
  });
}
```

Текущая семантика сохраняется: Enter=OK, Escape/overlay=null, focus+select в input. **Всё существующее** (rename, edge label, addBlock) работает без изменений.

### 5.3 `confirmDialog(message, opts)`

Только когда модалки ещё нет. Без input; Enter=ok, Escape=cancel, overlay=Escape.

```js
function confirmDialog(message, { okLabel = "OK", cancelLabel = "Отмена", title = "Подтверждение" } = {}) {
  return new Promise((resolve) => {
    const s = showModal({
      title, showInput: null,
      buttons: [
        { label: cancelLabel, id: "modal-cancel", onClick: () => s.close("cancel") },
        { label: okLabel, primary: true, id: "modal-ok", onClick: () => s.close("ok") }
      ],
      behavior: { allowOverlayClose: false, allowEscapeClose: true, onEnter: () => s.close("ok") }
    });
    s.setText(message);
    s.closed.then(resolve);
  });
}
```

---

## 6. «База файлов недоступна» — единая обработка

Один маршрут для всех сбоев IDB (open/onerror/onblocked/NotFoundError store/deleteDatabase blocked). Вспомогательная функция:

```js
async function handleIdbDown() {
  const res = await confirmDialog(
    "База файлов браузера недоступна (повреждена или заблокирована). Пересоздание удалит сохранённые файлы.",
    { okLabel: "Пересоздать базу файлов", title: "База файлов браузера недоступна" }
  );
  if (res !== "ok") return false;
  try { await fileReset(); } catch (e) { return retryIdbDown(1); }  // блокировка deleteDatabase → снова модалка
  return true;    // база пересоздана; вызывающий повторяет исходную команду
}
async function retryIdbDown(attempt) {   // защита от бесконечной рекурсии
  if (attempt >= 2) return false;
  return handleIdbDown();
}
```

Использование:
- **«Открыть из браузера»**: `const ok = await withIdb(() => fileList());` — `fileList()` бросает → `handleIdbDown()` (модалки ещё нет — `confirmDialog` уместен); при «Пересоздать» и успехе — повторно открыть список. При «Отмена» — ничего (схема, undo/redo, автосохранение работают).
- **«Сохранить в браузер»**: внутри открытого `#save-modal` сбой `dbFiles()`/`filePut` → **инлайн-фаза того же окна**: `setContent("База файлов браузера недоступна …")`, кнопки «Отмена»/«Пересоздать базу файлов». «Пересоздать» → `fileReset()` → при успехе вернуться в фазу ввода имени (повторить команду), при сбое — снова инлайн-сообщение. «Отмена» — закрыть окно.
- Ошибка **транзакции при существующей базе** (не открытие) — инлайн «Не удалось сохранить файл в браузере.» в том же окне (черновик §4.4 п.6).

---

## 7. UI и команды

### 7.1 Меню «Копировать» (разметка + обработчик)

Новый порядок (черновик §5.1):

```html
<button role="menuitem" data-act="paste">Вставить</button>
<button role="menuitem" data-act="replace">Заменить</button>
<div class="menu-sep"></div>
<button role="menuitem" data-act="open-browser">Открыть из браузера</button>
<button role="menuitem" data-act="save-browser">Сохранить в браузер</button>
<button role="menuitem" data-act="import-file">Импорт из файла (D2)</button>
<button role="menuitem" data-act="export-file">Экспорт в файл</button>
<button role="menuitem" data-act="export-d2">Экспорт в D2</button>
<div class="menu-sep"></div>
<button role="menuitem" data-act="export-svg">Экспорт в SVG</button>
<button role="menuitem" data-act="export-drawio">Экспорт в Draw.io</button>
<button role="menuitem" data-act="export-mermaid">Экспорт в Mermaid</button>
<button role="menuitem" data-act="import-mermaid">Импорт из Mermaid</button>
```

`accept` у `#import-file`: `.txt,.d2,.dd2,text/plain`.

Обработчик (заменяет index.html:1269-1282):

```js
else if (act === "open-browser") openFileListModal();
else if (act === "save-browser") saveToBrowser();
else if (act === "import-file") importFile.click();
else if (act === "export-file") exportDd2();
else if (act === "export-d2") exportStandardD2();
```

Пункты `import`/`export` удаляются; `exportD2()` переименовывается/распиливается (см. §7.3).

### 7.2 `downloadCode(content, ext, base)` — общая механика скачивания

Вынести из `exportD2` (index.html:1336-1376), параметризовать расширением. `ext` — с точкой (`.dd2`/`.d2`). `base` — желаемое имя без расширения.

```js
async function downloadCode(content, ext, base) {
  base = base || exportName || currentFile || "diagram";
  const bare = base.replace(/\.[^./\\]+$/, "") || "diagram";
  const suggested = bare + ext;
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: suggested,
        types: [{ description: "Диаграмма D2", accept: { "application/x-d2": [ext] } }],
        excludeAcceptAllOption: true
      });
      let name = handle.name;
      if (!name.toLowerCase().endsWith(ext)) {
        const fixed = (name.replace(/\.[^./\\]+$/, "") || "diagram") + ext;
        try { await handle.move(fixed); name = fixed; } catch (e) {}
      }
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return name;
    } catch (e) {
      if (e.name !== "AbortError") setStatus("Не удалось экспортировать файл", false);
      return null;
    }
  }
  const name = suggested;
  downloadBlob(content, "text/plain;charset=utf-8", name);
  return name;
}

async function exportFile(content, ext) {          // общий хвост для export-file / export-d2
  const name = await downloadCode(content, ext);
  if (!name) return;
  exportName = name;
  saveUiPrefs({ exportName });
  setStatus("Экспортировано в " + name, true);
  setTimeout(() => { document.getElementById("outStatus").textContent = ""; }, 1500);
}

function exportDd2() {        // «Экспорт в файл» — аннотированный .dd2
  exportFile(D2S.serializeAnnotated(currentGraph(), { refText: outEl.value }), ".dd2");
}
function exportStandardD2() { // «Экспорт в D2» — стандарт без маркеров
  exportFile(D2S.toStandardD2(currentGraph(), outEl.value), ".d2");
}
```

- `exportName` после экспорта хранит итоговое имя **с** расширением; при следующем экспорте `downloadCode` срежет любое расширение и подставит нужное (`diagram.dd2` → следующий `.d2` → `diagram.d2`). Существующие E2E «экспорт запоминает имя» сохраняют смысл (переключаются на `data-act="export-d2"`).
- `svgFileName()` (index.html:1531) уже срезает расширение — `exportName` с `.dd2`/`.d2` ей не мешает.
- Экспорт **не** трогает `currentFile` и undo-историю.

### 7.3 `toStandardD2` в `js/d2-serialize.js`

```js
function toStandardD2(graph, refText) {
  return serializeClean(graph, { refText: refText || null });
}
// api: toStandardD2: toStandardD2
```

Документировать в API-комментарии: единая точка «приведения к стандарту D2» (сюда в будущем — нормализация `dir`, слияние дублей рёбер и т.п.; черновик §5.1).

### 7.4 `currentFile` + `#fileLabel`

- `let currentFile = null;` рядом с `exportName` (index.html:273).
- Чтение при старте (блок index.html:1603-1613): `if (ui && typeof ui.currentFile === "string") currentFile = ui.currentFile;`
- Разметка в `.outbar` (после splitbtn, до `#btnPos`): `<span id="fileLabel" hidden></span>`.
- Функция `updateFileLabel()`: `fileLabel.textContent = "Файл: " + currentFile; fileLabel.hidden = !currentFile;`
- Вызов: при старте (после чтения префа) и после успешного сохранения/открытия.

### 7.5 Сохранение — `#save-modal` (одна сессия `showModal`, фазы)

```js
async function saveToBrowser() {
  const s = showModal({
    title: "Сохранить в браузер",
    showInput: currentFile || "diagram",
    buttons: [
      { label: "Отмена", id: "modal-cancel", onClick: () => s.close(null) },
      { label: "Сохранить", primary: true, id: "modal-ok", onClick: () => doSave() }
    ],
    behavior: { allowOverlayClose: true, allowEscapeClose: true, onEnter: () => doSave() }
  });

  const toInput = () => {
    s.setTitle("Сохранить в браузер");
    s.setText(null);
    s.setShowInput(true);
    s.setButtons([
      { label: "Отмена", id: "modal-cancel", onClick: () => s.close(null) },
      { label: "Сохранить", primary: true, id: "modal-ok", onClick: () => doSave() }
    ]);
    s.setBehavior({ allowOverlayClose: true, allowEscapeClose: true, onEnter: () => doSave() });
    modalInput.focus(); modalInput.select();
  };
  const toIdbDown = () => { /* инлайн: сообщение «База недоступна…», кнопки Отмена / Пересоздать (см. §6) */ };

  async function doSave() {
    const name = modalInput.value.trim();
    if (!name) { s.setText("Введите имя диаграммы"); return; }
    let list;
    try { list = await fileList(); }
    catch (e) { return toIdbDown(); }
    if (!list.some((f) => f.name === name)) return commit(name);
    // существует → фаза подтверждения (окно не закрывается); имя — через setText (безопасно)
    s.setText('Диаграмма с именем "' + name + '" уже существует.');
    s.setShowInput(false);
    s.setButtons([
      { label: "Отмена", id: "modal-cancel", onClick: toInput },
      { label: "Заменить", primary: true, id: "modal-ok", onClick: () => commit(name) }
    ]);
    s.setBehavior({ allowOverlayClose: false, allowEscapeClose: false, onEscape: toInput });
  }

  async function commit(name) {
    try { await filePut(name, graphPayload()); }
    catch (e) { s.setText("Не удалось сохранить файл в браузере"); return; }
    currentFile = name;
    saveUiPrefs({ currentFile });
    updateFileLabel();
    s.close(true);
    setStatus("Сохранено в браузер: " + name, true);
  }
}
```

Инварианты (черновик §4.4 + §1 решения):
- пустое имя → инлайн «Введите имя диаграммы», окно не закрывается;
- существующее имя → инлайн «Диаграмма с именем "name" уже существует.» + «Заменить»/«Отмена»; «Отмена»/Escape/overlay → возврат в фазу ввода, **поле сохраняет значение**;
- Escape/overlay в фазе ввода — `close(null)`;
- ошибки IDB — инлайн-фазы (см. §6).

### 7.6 Открытие — `#files-modal`

```js
async function openFileListModal() {
  let list;
  try { list = await fileList(); }
  catch (e) { if (await handleIdbDown()) return openFileListModal(); return; }

  const s = showModal({
    title: "Открыть из браузера",
    showInput: null,
    buttons: [{ label: "Закрыть", id: "modal-cancel", onClick: () => s.close(null) }],
    behavior: { allowOverlayClose: true, allowEscapeClose: true }
  });
  renderFileList(s, list);
  s.closed.then(() => {});
}

function renderFileList(s, list) {
  if (!list.length) s.setText("Нет сохранённых файлов");
  else {
    const rows = list.map((f) =>
      '<div class="file-row" data-name="' + escAttr(f.name) + '">' +
        '<span class="file-info">' + esc(f.name) + " · " + new Date(f.savedAt).toLocaleString() + "</span>" +
        '<button data-open="1">Открыть</button><button data-del="1">Удалить</button>' +
      "</div>").join("");
    s.setContent('<div id="files-list">' + rows + '<div id="files-storage"></div></div>');
  }
  // делегирование по клику внутри #modal-content (единое для всех фаз)
  // storage-строка — асинхронно (§7.7)
}

async function refreshList(s) {   // после удаления/перезаписи — свежий список в той же сессии
  let list;
  try { list = await fileList(); }
  catch (e) { return s.close(null); }
  renderFileList(s, list);
}
```

- **Открыть**: `fileGet(name)` → `validateState(rec.graph)` → `applyState(rec.graph)` → `D2HIST.clearHistory(history)` → `updateUndoUI()` → `currentFile = name` → `saveUiPrefs({currentFile})` → `updateFileLabel()` → `s.close()` → `setStatus("Открыт: " + name, true)`. Битая запись → `setStatus("Файл повреждён и пропущен", false)` и список остаётся открытым (запись можно удалить).
- **Удалить**: инлайн-фаза той же сессии: `setText('Удалить файл "' + name + '" из браузера?')`, кнопки «Отмена»/«Удалить»; «Удалить» → `fileDelete(name)` (try/catch → статус ошибки) → `refreshList(s)` (перерисовать по свежему `fileList()`).
- Фазы смены контента перезапускают делегирование кликов (или единое делегирование на постоянном контейнере `#modal-content`).

### 7.7 Строка занятого места

```js
function bytesText(n) {
  if (n < 1024) return n + " Б";
  if (n < 1048576) return (n / 1024).toFixed(1) + " КБ";
  return (n / 1048576).toFixed(1) + " МБ";
}
async function fillStorageLine() {
  const el = document.getElementById("files-storage");
  if (!el) return;
  const files = await fileList().catch(() => null);
  if (files) el.textContent = "Файлы: " + files.length + ", занято " + bytesText(files.reduce((a, f) => a + (f.size || 0), 0));
  let est = null;
  try { if (navigator.storage && navigator.storage.estimate) est = await navigator.storage.estimate(); } catch (e) {}
  if (est && Number.isFinite(est.quota) && Number.isFinite(est.usage)) {
    const free = Math.max(0, est.quota - est.usage);
    el.textContent += " · Занято " + bytesText(est.usage) + " из " + bytesText(est.quota)
      + " (свободно " + bytesText(free) + ")";
  }
}
```

Фолбэк: `estimate` недоступен/бросил/`quota: null` → остаётся только счётчик «Файлы: N, занято X».

---

## 8. Тесты

### 8.1 Юнит — `js/d2-serialize.js` (`test/serialize.test.mjs` + CLI)

- `toStandardD2(graph, refText)` === `serializeClean(graph, { refText })`.
- `toStandardD2` не содержит `# --- @d2pos` (и legacy `# @d2pos`), когда вход аннотированный.
- Паритет: в `test/cli-parity.test.mjs` прогнать `toStandardD2(граф с маркерами)` через `d2 validate`/рендер — как существующие CLI-случаи.

### 8.2 E2E — новый `test/ui-files.test.mjs`

Хелперы: общие для ui-тестов (скопировать из `ui-history.test.mjs`). Ключевое отличие `freshPage` — **init-флаг**:

```js
async function freshPage(browser, uiPrefs) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((p) => {
    if (!sessionStorage.getItem("__d2init")) {          // чистим только при первой навигации
      sessionStorage.setItem("__d2init", "1");
      localStorage.clear();
      if (p) localStorage.setItem("d2editor:ui:v1", JSON.stringify(p));
    }
  }, uiPrefs || null);
  await page.goto(URL);
  await page.waitForSelector("#out");
  await new Promise((r) => setTimeout(r, 300));
  return page;
}
```

Плюс принудительная очистка IDB перед тестом (страховка, если браузер переиспользуется между тестами одного файла):

```js
async function clearIdb(page) {
  await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.deleteDatabase("d2editor");
    r.onsuccess = r.onerror = r.onblocked = () => res();
  }));
}
```

Сценарии (каждый в отдельном `test`, свежий `puppeteer.launch`):

1. **Сохранение**: «Сохранить в браузер» → префилл «diagram»; ввести «schema1» → «Сохранить» → статус «Сохранено в браузер: schema1»; модалка закрыта.
2. **Префилл `currentFile`**: после сохранения повторно открыть сохранение → поле содержит «schema1» (и метка `#fileLabel` = «Файл: schema1»).
3. **Пустое имя**: очистить поле → «Сохранить» → окно осталось + «Введите имя диаграммы»; Escape закрывает.
4. **Перезапись без закрытия**: сохранить «schema1» ещё раз → появилось «Диаграмма с именем "schema1" уже существует.» + кнопки «Заменить»/«Отмена»; «Отмена» → возврат к вводу, **поле сохранило «schema1»**; снова «Сохранить» → «Заменить» → закрылось, статус «Сохранено в браузер: schema1».
5. **Открытие восстанавливает состояние**: сохранить схему (записать `# --- @d2pos`-позиции), изменить схему (добавить блок / сдвинуть drag), «Открыть из браузера» → «Открыть» → ноды/рёбра/textarea вернулись к сохранённому виду; `#btnUndo` disabled (история очищена); статус «Открыт: schema1».
6. **Список**: пустая база → «Нет сохранённых файлов»; после двух сохранений — две строки, порядок по `savedAt` desc; кнопки «Открыть»/«Удалить» в каждой.
7. **Удаление**: «Удалить» → инлайн-подтверждение → «Удалить» → строка исчезла; список перерисован.
8. **Персистентность**: сохранить → `page.reload()` (freshPage-флаг не чистит localStorage/IDB) → «Открыть из браузера» → файл в списке; автосохранение session восстановило содержимое.
9. **Строка занятого места**: после сохранений в `#files-storage` есть «Файлы: N, занято X»; при стабе `navigator.storage.estimate = () => Promise.reject()` — счётчик остаётся, части «· Занято … из …» нет; при стабе `estimate = async () => ({quota: 1e9, usage: 5})` — есть «· Занято … из … (свободно …)».
10. **IDB недоступна (эмуляция)**: `evaluateOnNewDocument` подменяет `indexedDB.open` — **первые два** вызова фейковые (объект-запрос, у которого срабатывает `onerror`), дальше реальный API (иначе «повторное сохранение → снова инлайн» и «Пересоздать → успех» не уживаются в одном тесте). «Сохранить в браузер» → «Сохранить» → инлайн «База файлов браузера недоступна…» + «Пересоздать базу файлов»/«Отмена»; «Отмена» → модалка закрылась, схема и автосохранение работают; **повторное сохранение** → снова инлайн; «Пересоздать базу файлов» → `fileReset()` (close соединения нет — open не удался; `deleteDatabase` успешен) → `dbFiles()` реальным API создаёт чистую базу → повторная команда: сохранение успешно («Сохранено в браузер»).
    Эмуляция фейкового open (важно для E2E):
    ```js
    await page.evaluateOnNewDocument(() => {
      const realOpen = indexedDB.open.bind(indexedDB);
      let failures = 2;
      indexedDB.open = (...args) => {
        if (failures > 0) {
          failures--;
          const req = {};
          setTimeout(() => { if (req.onerror) req.onerror({ target: req }); }, 0);
          return req;
        }
        return realOpen(...args);
      };
    });
    ```
11. **Импорт из файла (D2)**: `data-act="import-file"` + `waitForFileChooser`; аннотированный `.dd2` с `# --- @d2pos` → textarea содержит маркеры, блоки встали по позициям; `.txt` (чистый D2) и `.d2` → работает; бинарный файл → статус «Не удалось прочитать файл», содержимое не изменилось.
12. **Экспорт в файл (`.dd2`)**: стаб `showSaveFilePicker` (как в ui-smoke) → содержимое, записанное в fake-`write`, содержит `# --- @d2pos`; `suggestedName` = «diagram.dd2».
13. **Экспорт в D2 (`.d2`)**: тот же стаб → содержимое **без** маркеров; `suggestedName` = «diagram.d2»; после экспорта с вводом «myfile» без расширения → статус «Экспортировано в myfile.d2», `exportName` сохранён в ui-prefs.

### 8.3 Правки существующих E2E (`test/ui-smoke.test.mjs`)

- Строка 322: новый порядок —
  `["paste","replace","open-browser","save-browser","import-file","export-file","export-d2","export-svg","export-drawio","export-mermaid","import-mermaid"]`.
- Строка 393: `data-act="import"` → `data-act="import-file"`.
- Строки 428/470/478/498/**520**: `data-act="export"` → `data-act="export-d2"` (всего **5** вхождений; семантика `.d2`, статусы, `suggestedName` и запоминание имени сохраняются).
- Проверить, что стабы `export-drawio`/`export-mermaid`/`import-mermaid` по-прежнему показывают «в разработке».

### 8.5 `package.json`

`npm run test:ui` перечисляет файлы явно (`node --test test/ui-smoke.test.mjs test/ui-history.test.mjs`) — добавить новый файл:

```json
"test:ui": "node --test test/ui-smoke.test.mjs test/ui-history.test.mjs test/ui-files.test.mjs"
```

### 8.4 Регресс

- `npm test` — юнит + CLI-паритет (skip без `d2` в PATH).
- `npm run test:ui` — все E2E (smoke + history + files).

---

## 9. Документация

Выполнено (см. разделы):
- `AGENTS.md`: §1 — меню (новые пункты, `#fileLabel`, `currentFile`), §2 карта (`toStandardD2` в `d2-serialize`), счётчики тестов (240/45).
- `docs/architecture.md`: разделы «Модальные диалоги» и «Файлы в браузере» (IndexedDB-схема, `showModal`, `applyState`, `downloadCode`, `handleIdbDown`).
- `docs/development.md`: покрытие (юнит `toStandardD2`, E2E `ui-files`), ловушки (init-флаг `sessionStorage` в E2E, одиночная модалка, `#modal-ok`/`#modal-cancel` id, эмуляция IDB-сбоя, `req.onsuccess`).
- `docs/plans/undo-redo-and-browser-files.md`: статус части 2 → ✅; расхождения — в §9.1.
- `docs/plans/browser-files.md`: статус → ✅/реализовано.

## 9.1 Расхождения реализации с планом

Зафиксировано для истории; на поведение не влияют, перечислены, чтобы план не вводил в заблуждение:

- `applyState(g)` дополнительно восстанавливает `history` — стек undo/redo очищается через `D2HIST.clearHistory` при открытии файла (в плане об этом явно не сказано; сценарий §8.2 п.5 «история очищена» требовал этого).
- `retryIdbDown` лимитирован (ограничение рекурсии, §1.1 п.2–3).
- `import-file` имеет `accept=".d2,.txt,.dd2,text/plain"` (в плане §8.2 п.11 — «.txt (чистый D2) и .d2»; `.dd2` добавлен как аннотированный формат, см. §7.1).
- `openStoredFile` вызывает `validateState` → `applyState` и обновляет `lastGraphText` так, чтобы textarea и статусы были консистентны сразу (тест «открытие восстанавливает граф/текст»).
- **Список файлов в окне сохранения** (пользовательская доработка после реализации): под полем имени показывается тот же список, что в открытии, но строки без кнопки «Открыть» (кнопка «Удалить» + inline-подтверждение работают, диалог не закрывается). Сообщения фаз — в `#save-hint` над списком (список остаётся видимым). Модалки расширены до 500px. База, падающая уже при открытии окна сохранения, ведёт сразу в фазу «база недоступна» (первоначальный план обрабатывал сбой только по клику «Сохранить»).

---

## 10. Порядок работ (этапы + критерии)

1. **Инфраструктура**: `graphPayload()`/`validateState()`/`applyState()`; `toStandardD2` + юнит. Критерий: `npm test` (юнит) зелёный.
2. **`showModal` + обёртки**: рефакторинг `openEditDialog` на каркас (поведение идентично), `confirmDialog`. Критерий: существующие E2E smoke (модалка, drag, rename, addBlock) зелёные.
3. **IDB-хелперы + `downloadCode` + меню**: хелперы, `currentFile`/`#fileLabel`, перестройка меню, `import-file`/`export-file`/`export-d2`, правки ui-smoke. Критерий: ui-smoke зелёный.
4. **`#save-modal` + `#files-modal` + «база недоступна»**: фазы, storage-строка, `handleIdbDown`. Критерий: E2E `ui-files` зелёные.
5. **Документация** (§9). Критерий: `npm test` и `npm run test:ui` зелёные, статусы планов обновлены.

---

## 11. Риски и открытые вопросы

- **`navigator.storage.estimate()` на `file://`** — в системном Chrome работает (подтверждено в черновике), но может вернуть `quota: null` в приватном режиме → фолбэк уже предусмотрен (§7.7).
- **Перетаскивание модалки при длинном списке `#files-modal`** — заголовок остаётся драгабельным (глобальный обработчик), контент скроллится через `overflow-y` (`#files-list` `max-height`, добавлен CSS; см. §1.1 п.9).
- **`deleteDatabase` blocked** — устранён `dbHandle.close()` в `fileReset`; на случай упорной блокировки `retryIdbDown` ограничивает рекурсию (§6, §1.1 п.2–3).
- **Одиночная сессия `showModal`** — залог отсутствия вложенных оверлеев; если понадобится «модалка поверх модалки» позже — потребуется стек, сейчас осознанно не делаем.
- **`file://` и другие браузеры** (не Chrome) — IDB может быть недоступен; путь `handleIdbDown` покрывает.
- **Имена файлов** — любые непустые строки после `.trim()` (ключи IDB); в HTML вставляются только через `setText`/`escAttr`. Поле `size` приблизительное (длина JSON) — осознанно.
- **Совместимость `applyState` с будущей «частью 2»** — формат файла совпадает с автосохранением (`v:1`), поэтому файлы можно открывать в любой сборке с этой же валидацией.
- **`showModal` и ввод**: capture-`keydown` с `stopPropagation` не отменяет default-action, ввод в `#modal-input` работает; при необходимости Enter не должен `preventDefault`-ить, когда нет `onEnter` (§5.1, §1.1 п.9).
