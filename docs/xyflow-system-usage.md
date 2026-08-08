# @xyflow/system в проекте: возможности и правила использования

Справочник для ИИ-агентов и разработчиков: что из `@xyflow/system` уже используется, что можно взять вместо самописного кода, а что использовать не стоит. Сверено с фактическим содержимым локальной UMD-сборки (см. ниже) и кодом `index.html`.

## 1. Как подключено

- Версия: **`@xyflow/system` 0.0.79** (последний стабильный dist-tag `latest` на момент вендоринга).
- Локальная UMD-сборка: `vendor/xyflow-system-0.0.79.umd.js` (99 215 байт, самодостаточна — без `import` и внешних зависимостей). Подключается в `index.html` (стр. 187) вместо CDN; приложение открывается как `file://` без сборки и **без интернета**.
- Глобал: `window.XYFlowSystem`. В `index.html` (стр. 197): `const XYF = window.XYFlowSystem;`.
- Это vanilla-ядро @xyflow (не React): вьюпорт/pan-zoom, геометрия рёбер, хэндлы, контроллеры драга/ресайза/миникарты. React-обвязка `@xyflow/react` в проект **не** включается и не нужна.
- UMD можно `require()` и из CommonJS, но библиотека DOM-ориентированная — используется **только в `index.html` (UI-слой)**. В `js/*` (ES5 UMD, без DOM) XYF не подключается.
- Всего экспортов: **94**. Полный список и сигнатуры легко получить:
  ```bash
  node -e "const m=require('./vendor/xyflow-system-0.0.79.umd.js'); console.log(Object.keys(m).sort().join('\n'))"
  ```
- Обновление версии: скачать с unpkg новый `dist/umd/index.js`, положить в `vendor/` (имя файла с версией), обновить ссылку в `index.html`, `AGENTS.md`, `docs/README.md`, прогнать `npm test` и `npm run test:ui`.

## 2. Что уже используется (весь фактический API вызовов)

| Символ | Использование |
|---|---|
| `XYF.Position` | `edgeGeometry` (стр. 614–618, 626–633): стороны анкоровки и сдвиг inset |
| `XYF.getSmoothStepPath` | `renderEdges` (стр. 704), `buildSVG` (стр. 1326): путь ребра + центр подписи |
| `XYF.XYPanZoom` | стр. 546: контроллер pan/zoom (методы: `update`, `setViewport`, `getViewport`, `scaleTo`, `scaleBy`, `zoomIn`/`zoomOut`/`zoomTo`, `setViewportConstrained`, `setScaleExtent`, `setTranslateExtent`, `syncViewport`, `setClickDistance`, `constrain`, `destroy`, `interpolate`) |
| `XYF.infiniteExtent` | стр. 550: безграничный translateExtent |
| `XYF.PanOnScrollMode` | стр. 561: `Free` (значения `Free`/`Vertical`/`Horizontal`) |

Никаких других экспортов проект сейчас не вызывает.

## 3. Справочник экспортов

### 3.1 Енумы и константы
- `Position`: `{Left:"left", Top:"top", Right:"right", Bottom:"bottom"}`.
- `PanOnScrollMode`: `{Free:"free", Vertical:"vertical", Horizontal:"horizontal"}`.
- `ConnectionLineType`: `{Bezier:"default", Straight:"straight", Step:"step", SmoothStep:"smoothstep", SimpleBezier:"simplebezier"}`.
- `ConnectionMode`: `{Strict:"strict", Loose:"loose"}`.
- `MarkerType`: `{Arrow:"arrow", ArrowClosed:"arrowclosed"}`.
- `SelectionMode`: `{Partial:"partial", Full:"full"}`.
- `ResizeControlVariant`: `{Line:"line", Handle:"handle"}`.
- `XY_RESIZER_HANDLE_POSITIONS`: `["top-left","top-right","bottom-left","bottom-right"]`; `XY_RESIZER_LINE_POSITIONS` — аналогично для линий.
- `infiniteExtent`: `[[null,null],[null,null]]`.
- `elementSelectionKeys`: в этой сборке `["Enter"," ","Escape"]` (не клавиши удаления).
- `oppositePosition`: `{left:"right", right:"left", top:"bottom", bottom:"top"}`.

### 3.2 Геометрия рёбер (чистые функции)
Все пути возвращают `[path, labelX, labelY, offsetX, offsetY]`, функции центров — `[centerX, centerY, offsetX, offsetY]`.
- `getSmoothStepPath({sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius, centerX, centerY, offset, stepPosition})`.
- `getBezierPath({sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, curvature})`.
- `getStraightPath({sourceX, sourceY, targetX, targetY})`.
- `getBezierEdgeCenter({sourceX, sourceY, sourceControlX, sourceControlY, targetControlX, targetControlY, targetX, targetY})`.
- `getEdgeCenter({sourceX, sourceY, targetX, targetY})`.
- `getEdgePosition({sourceNode, targetNode, connectionMode, sourceHandle, targetHandle, width, height})` → позиция ребра или `null`.

### 3.3 Создание и валидация связей
- `addEdge(edgeParams, edges, {getEdgeId, onError})` → новый массив рёбер. **Внимание: дедуплицирует точные дубли** `(source, target, sourceHandle, targetHandle)` — если запись уже есть, ребро не добавляется.
- `getEdgeId({source, sourceHandle, target, targetHandle})` → `xy-edge__…` (формат библиотеки).
- `reconnectEdge(edge, newConnection, edges, {shouldReplaceId, getEdgeId, onError})` → новый массив.
- `getConnectedEdges(nodes, edges)` → рёбра, чей `source`/`target` входит в `nodes`.
- `getIncomers(node, nodes, edges)` / `getOutgoers(node, nodes, edges)` → узлы-источники/цели.
- `getElementsToRemove({nodesToRemove, edgesToRemove, nodes, edges, onBeforeDelete})` → `async`; каскадное удаление (рёбра и потомки по `parentId`).
- `getConnectionStatus(connection)` → `"valid" | "invalid" | null`.
- `initialConnection` — шаблон pending-connection; `updateConnectionLookup(nodes, edges)` — lookup-карта валидации; `handleConnectionChange(params, config, nodes)` — колбэк при изменении.

### 3.4 Вьюпорт, координаты, границы
- `getViewportForBounds(bounds, width, height, minZoom, maxZoom, padding, options)` → `{x, y, zoom}` (вычислить viewport для «подогнанного» вида).
- `fitViewport({nodes, width, height, panZoom, minZoom, maxZoom}, options)` → `async boolean` (уже применяет через panZoom).
- `panBy({delta, panZoom, transform, translateExtent, width, height})` → `async boolean`.
- `getPointerPosition(event, {snapGrid, snapToGrid, transform, containerBounds})` → `{x, y, xSnapped, ySnapped}`.
- `getEventPosition(event, containerBounds?)` → `{x, y}` (клиент → локальные).
- `pointToRendererPoint({x, y}, [x, y, zoom], snapToGrid?, snapGrid?)` / `rendererPointToPoint({x, y}, [x, y, zoom])` — экран ↔ координаты схемы.
- `getNodesBounds(nodes, {nodeLookup, nodeOrigin})` → `{x, y, width, height}`; узлы можно передавать id при наличии `nodeLookup`.
- `getBoundsOfRects(a, b)` → rect; `getBoundsOfBoxes(a, b)` → box `{x, y, x2, y2}`; `getInternalNodesBounds(nodes, {filter})` → rect.
- `getNodesInside(bounds, nodes, [x, y, zoom], strict?, filter?)` → узлы внутри рамки (для выделения).
- `getOverlappingArea(rectA, rectB)` / `getRectsOverlappingArea(x1, y1, w1, h1, x2, y2, w2, h2)` → площадь пересечения.
- `calcAutoPan(mousePos, bounds, autoPanSpeed?, autoPanOnConnect?)` → `[dx, dy]`.
- `getHostForElement(domNode)` → ближайший host-элемент.

### 3.5 Позиции, снап, кламп
- `snapPosition(position, [snapX, snapY])` → снапнутая позиция.
- `clampPosition(position, extent, {width, height}?)` → позиция в пределах extent.
- `clampPositionToParent(position, parent, nodeOrigin, nodeExtent, box)` → кламп к границам родителя.
- `calculateNodePosition({nodeId, nextPosition, nodeLookup, nodeOrigin, nodeExtent, onError})` → позиция с учётом parent-относительности и extent.
- `getNodePositionWithOrigin(node, parent, nodeOrigin)` → абсолютная позиция по origin.
- `evaluateAbsolutePosition(node, size, nodeOrigin, nodeLookup, origin)` → позиция с учётом родителя.
- `updateAbsolutePositions(nodes, nodeLookup)` → пересчёт `internals.positionAbsolute`.

### 3.6 Контроллеры (инстансные, для UI-слоя)
- `XYPanZoom({domNode, minZoom, maxZoom, translateExtent, viewport, onPanZoom, onPanZoomStart, onPanZoomEnd, onDraggingChange})` → контроллер (см. §2 методы).
- `XYDrag({onNodeMouseDown, getStoreItems, onDragStart, onDrag, onDragStop})` → `{update({noDragClassName, handleSelector, domNode, isSelectable, nodeId, nodeClickDistance})}`. d3-drag поверх store-объектов `(nodes, edges, nodeLookup, dragItems)`.
- `XYResizer({domNode, nodeId, getStoreItems, onChange, onEnd})` → `{update({controlPosition, boundaries, keepAspectRatio, …})}` — ресайз-контроллеры.
- `XYMinimap({domNode, panZoom, getTransform, getViewScale})` → `{update({translateExtent, width, height, zoomStep, pannable, zoomable, inversePan})}` — миникарта поверх panZoom.
- `XYHandle` → `{onPointerDown, isValid}` — хэндл-хелперы.

### 3.7 Хэндлы и размеры
- `getHandleBounds(selector, nodeElement, parentBounds, zoom, nodeId)` → массив границ хэндлов из DOM.
- `getHandlePosition(node, handleBounds, position, isMiddle)` → `{x, y}`.
- `getDimensions(domNode)` → `{width, height}` (offsetWidth/Height).
- `getNodeDimensions(node)` → `{width, height}` (measured/width/height/initialWidth).
- `nodeHasDimensions(node)` → bool; `nodeToBox` / `boxToRect` / `rectToBox` / `nodeToRect` — конвертация.

### 3.8 Маркеры стрелок
- `createMarkerIds({edges, markerType})` → `{createEdgeDefaultMarker, createMarkerId}`; `getMarkerId({id, markerType})` → `xyflow__{type}-{id}`. Per-edge уникальные id для React-рендера.

### 3.9 Внутренности узлов/графа (в основном под React-рендер)
- `updateNodeInternals(node, nodeLookup, nodes)`, `adoptUserNodes(nodes, edges)`, `shallowNodeData(node)`, `handleExpandParent(nodes, edges)`, `isManualZIndexMode(node)`, `getElevatedEdgeZIndex(node, edges)`, `isEdgeVisible(source, target)`, `isEdgeBase`, `isNodeBase`, `isInternalNodeBase`, `isRectObject`, `isCoordinateExtent`.

### 3.10 Утилиты
- `isNumeric(v)`, `isMacOs()`, `isMouseEvent(e)`, `areSetsEqual(a, b)`, `areConnectionMapsEqual(a, b)`, `withResolvers()` (полифилл `Promise.withResolvers`).
- `isInputDOMNode(event)` → true, если цель — `input`/`textarea`/`contenteditable`/`.nokey` (см. §4.2).
- `defaultAriaLabelConfig`, `mergeAriaLabelConfig` — aria-конфиг; `errorMessages` — коды ошибок; `createDevWarn` — dev-предупреждения.

## 4. Что можно использовать вместо самописного кода

Карта «текущий самописный код в `index.html` → готовый API XYF» (по убыванию пользы):

1. **`fitView` (стр. 1025–1045)** → `getViewportForBounds(bounds, vw, vh, minZoom, maxZoom, padding)`. Границы по-прежнему считаем обходом `treeOrder()+absPos()+boxSize()` (контейнерная модель XYF не совпадает с нашей), но зум/сдвиг — готовой функцией. (Низкий риск.)
2. **keydown (стр. 1501)** → `XYF.isInputDOMNode(e)` вместо ручной проверки `tagName === "INPUT"/"TEXTAREA"`. (Тривиальная замена.)
3. **Удаление рёбер при удалении ноды (стр. 981–984)** → `XYF.getConnectedEdges([node], edges)`. (Совместимо с плоской моделью; рёбра, трогающие ноду.)
4. **Центр подписи ребра (стр. 711–713, 1354–1363)** — уже берётся из `getSmoothStepPath`. Если понадобится другой стиль пути, у XYF есть `getBezierPath`/`getStraightPath` + `getEdgeCenter`/`getBezierEdgeCenter`/`getEdgePosition` — интерфейс возврата единый.
5. **Будущие фичи (кандидаты, но строго в рамках D2-паритета):**
   - `XYResizer` + `ResizeControlVariant` — ресайз блоков;
   - `XYMinimap` — миникарта поверх `panZoom`;
   - `getNodesInside` + `getOverlappingArea` + `SelectionMode` — выделение рамкой;
   - `snapPosition` — сетка (если появится);
   - `clampPositionToParent` / `calculateNodePosition` — ограничение движения внутри контейнера;
   - `calcAutoPan` — автопан при драге к краю;
   - `panBy` — программный сдвиг.

## 5. Что использовать НЕ стоит

- **`addEdge`** — дедуплицирует точные дубли рёбер, а проект сознательно **не сливает** повторы (инвариант §4 AGENTS; d2 тоже не сливает). Для создания новой стрелки оставляем ручное создание (стр. 856–861).
- **`getEdgeId`** — формат `xy-edge__…`; id-модель проекта плоская и своя (`eN`). Не подходит.
- **`createMarkerIds`/`getMarkerId`** — per-edge уникальные маркеры для React-рендера; у проекта общие маркеры `#arrow`/`#arrow-start` под две стрелки D2 (`markerDefs`, стр. 648–657). Не менять.
- **Внутренности React-рендера**: `adoptUserNodes`, `updateNodeInternals`, `handleExpandParent`, `updateAbsolutePositions`, `shallowNodeData`, `isManualZIndexMode`, `getElevatedEdgeZIndex`, `isEdgeVisible`, `evaluateAbsolutePosition`/`getNodePositionWithOrigin` (опираются на `internals.positionAbsolute`) — к нашей DOM-модели (`absPos`, локальные координаты детей) не применимы без перестройки модели.
- **`getHandleBounds`/`getHandlePosition`/`XYHandle`** — в проекте нет хэндлов: рёбра анкорятся к контуру формы автоматически (`d2-shapes.js`).
- **`getElementsToRemove`** — `async` и завязано на `parentId`-модель и `onBeforeDelete`; наша иерархия — массив `children`. Применять только при будущем пересмотре удаления.
- **`XYDrag`** — требует store-объекты (`getStoreItems`, `nodeLookup`, `dragItems`) и не даёт нашего детекта click/dblclick; самописный `startDrag` (стр. 803–836) проще и полностью покрывает сценарий.

## 6. Ограничения и правила

- XYF — **только в `index.html`** (UI). `js/*` остаются ES5 UMD без DOM и без внешних зависимостей.
- **Офлайн**: единственный источник — `vendor/xyflow-system-0.0.79.umd.js`; не возвращать CDN-ссылку и не добавлять других внешних загрузок.
- Не вводить React/`@xyflow/react` — для текущей архитектуры не нужно.
- Любая новая возможность с использованием XYF обязана сохранять **D2-паритет** (§0 AGENTS) и инварианты §3–4 AGENTS (порядок `order`, `hasPos`, маркер `# --- @d2pos`, плоская id-модель, не-слияние дублей рёбер).
- После изменений: `npm test` (200) и, если трогали UI-поток, `npm run test:ui` (22, нужен системный Chrome).
