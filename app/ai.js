/* ============================================================
   Подключение языковых и графических моделей по ключу пользователя.

   Ключ хранится только в localStorage этого браузера и уходит
   напрямую к выбранному провайдеру — своего сервера у инструмента
   нет, промежуточных узлов тоже. Это же означает, что ключ виден
   любому расширению с доступом к странице: для работы стоит
   заводить отдельный ключ с ограниченным лимитом.

   Три сценария:
     render()   — кадр массинга → фотореалистичная визуализация
     analyze()  — цифры участка + кадр → градостроительная записка
     propose()  — текстовое задание → проектные объёмы (JSON)
   ============================================================ */

const LS = 'massing.ai';

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    models: { text: 'claude-opus-5', image: null },
    can: { analyze: true, propose: true, render: false },
    keyHint: 'sk-ant-…',
    note: 'Claude силён в анализе и генерации объёмов, но изображения не рисует.'
  },
  google: {
    label: 'Google Gemini',
    models: { text: 'gemini-2.5-pro', image: 'gemini-2.5-flash-image' },
    can: { analyze: true, propose: true, render: true },
    keyHint: 'AIza…',
    note: 'Один ключ закрывает и анализ, и фотореалистичный рендер.'
  },
  openai: {
    label: 'OpenAI',
    models: { text: 'gpt-5', image: 'gpt-image-1' },
    can: { analyze: true, propose: true, render: true },
    keyHint: 'sk-…',
    note: 'Рендер идёт через images/edits — кадр переписывается целиком.'
  },
  fal: {
    label: 'fal.ai (только рендер)',
    models: { text: null, image: 'fal-ai/flux/dev/image-to-image' },
    can: { analyze: false, propose: false, render: true },
    keyHint: 'key_id:key_secret',
    note: 'Быстрый image-to-image на FLUX. Анализа и генерации объёмов нет.'
  }
};

export function loadConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(LS) || '{}');
    return { provider: 'google', keys: {}, models: {}, ...c };
  } catch { return { provider: 'google', keys: {}, models: {} }; }
}

export function saveConfig(cfg) {
  localStorage.setItem(LS, JSON.stringify(cfg));
}

export function modelFor(cfg, kind) {
  const p = PROVIDERS[cfg.provider];
  return (cfg.models?.[cfg.provider]?.[kind]) || p.models[kind];
}

const key = (cfg) => (cfg.keys?.[cfg.provider] || '').trim();

async function ensure(res) {
  if (res.ok) return res;
  let detail = '';
  try {
    const j = await res.json();
    detail = j.error?.message || j.message || JSON.stringify(j).slice(0, 300);
  } catch { detail = await res.text().catch(() => ''); }
  throw new Error(`${res.status}: ${detail.slice(0, 400)}`);
}

/* ============================================================
   Фотореалистичная визуализация кадра
   ============================================================ */

const RENDER_STYLES = {
  day: 'ясный день, мягкое солнце, длинные тени, чистое небо с редкими облаками',
  evening: 'закатный час, тёплый низкий свет, в окнах загорается свет, длинные тени',
  night: 'ночь, освещённые улицы и фасады, тёплые окна, влажный асфальт с отражениями',
  winter: 'зима, снег на крышах и газонах, серое небо, холодный рассеянный свет',
  rain: 'после дождя, мокрая мостовая с отражениями, низкие облака, приглушённый свет'
};

const renderPrompt = (styleKey, extra) => `
Это архитектурная объёмно-пространственная модель городского квартала (серый массинг).
Преврати её в фотореалистичную архитектурную визуализацию.

Обязательные условия:
- Полностью сохрани геометрию: положение, габариты, высоту и форму каждого объёма.
- Сохрани точку съёмки, угол камеры и направление теней.
- Не добавляй и не убирай здания, не меняй ширину улиц и линию застройки.
- Добавь материалы фасадов (штукатурка, кирпич, стекло, бетон), окна, кровли,
  уличное озеленение, автомобили, людей — в масштабе и в разумном количестве.
- Освещение и погода: ${RENDER_STYLES[styleKey] || RENDER_STYLES.day}.
- Результат должен выглядеть как профессиональный рендер архитектурного бюро,
  а не как фотография существующего города.
${extra ? '\nДополнительно от автора проекта: ' + extra : ''}`.trim();

export async function render(cfg, imageB64, styleKey, extra, onProgress = () => {}) {
  const p = PROVIDERS[cfg.provider];
  if (!p.can.render) throw new Error(`${p.label} не генерирует изображения — выберите Gemini, OpenAI или fal.ai.`);
  if (!key(cfg)) throw new Error('Не задан API-ключ.');
  onProgress('Отправляем кадр модели…');

  if (cfg.provider === 'google') return renderGemini(cfg, imageB64, styleKey, extra);
  if (cfg.provider === 'openai') return renderOpenAI(cfg, imageB64, styleKey, extra);
  return renderFal(cfg, imageB64, styleKey, extra);
}

async function renderGemini(cfg, b64, styleKey, extra) {
  const model = modelFor(cfg, 'image');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key(cfg))}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { inline_data: { mime_type: 'image/png', data: b64 } },
            { text: renderPrompt(styleKey, extra) }
          ]
        }]
      })
    }
  );
  await ensure(res);
  const json = await res.json();
  const parts = json.candidates?.[0]?.content?.parts || [];
  const img = parts.find(p => p.inline_data || p.inlineData);
  if (!img) {
    const text = parts.map(p => p.text).filter(Boolean).join(' ');
    throw new Error(text ? `Модель вернула текст вместо картинки: ${text.slice(0, 200)}` : 'Модель не вернула изображение.');
  }
  const d = img.inline_data || img.inlineData;
  return `data:${d.mime_type || d.mimeType || 'image/png'};base64,${d.data}`;
}

async function renderOpenAI(cfg, b64, styleKey, extra) {
  const form = new FormData();
  form.append('model', modelFor(cfg, 'image'));
  form.append('prompt', renderPrompt(styleKey, extra));
  form.append('image', b64ToBlob(b64, 'image/png'), 'massing.png');
  form.append('size', 'auto');
  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key(cfg)}` },
    body: form
  });
  await ensure(res);
  const json = await res.json();
  const d = json.data?.[0];
  if (d?.b64_json) return `data:image/png;base64,${d.b64_json}`;
  if (d?.url) return d.url;
  throw new Error('Ответ без изображения.');
}

async function renderFal(cfg, b64, styleKey, extra) {
  const res = await fetch(`https://fal.run/${modelFor(cfg, 'image')}`, {
    method: 'POST',
    headers: { Authorization: `Key ${key(cfg)}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      image_url: `data:image/png;base64,${b64}`,
      prompt: renderPrompt(styleKey, extra),
      strength: 0.62,
      num_inference_steps: 34,
      guidance_scale: 4.5
    })
  });
  await ensure(res);
  const json = await res.json();
  const url = json.images?.[0]?.url || json.image?.url;
  if (!url) throw new Error('Ответ без изображения.');
  return url;
}

function b64ToBlob(b64, mime) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/* ============================================================
   Аналитическая записка
   ============================================================ */

const analysisPrompt = (place, s, extra) => `
Ты — градостроитель-аналитик. Перед тобой объёмная модель участка города
и его расчётные показатели. Напиши разбор среды на русском языке.

Участок: ${place || 'без названия'}
Площадь участка: ${(s.siteArea / 1e4).toFixed(1)} га
Зданий: ${s.count}
Пятно застройки: ${(s.footprint / 1e4).toFixed(2)} га
Плотность застройки (доля пятна): ${(s.coverage * 100).toFixed(0)} %
Коэффициент плотности (FAR): ${s.far.toFixed(2)}
Средняя высота: ${s.avgH.toFixed(1)} м, максимум ${s.maxH.toFixed(0)} м
Доля зданий с высотой из OSM: ${(s.dataShare * 100).toFixed(0)} %

Структура ответа (Markdown, без вступлений и извинений):
## Тип среды
Одна-две фразы: к какому морфотипу относится застройка и почему.
## Что показывают цифры
Разбор плотности, этажности и соотношения застроенного и открытого
пространства. Сравни с типичными значениями для такой среды.
## Планировочная структура
Что видно на модели: рисунок кварталов, дворы, отношение застройки к улице,
проницаемость, фронт улицы.
## Проблемные места
Три-четыре конкретных наблюдения, каждое — с опорой на то, что видно
на изображении или следует из цифр.
## Аналоги
Два-три сопоставимых по морфологии района в мировой практике, с пояснением,
чем именно они сопоставимы.

Оговорись отдельной строкой в конце, если качество данных OSM (доля
восстановленных высот) ограничивает выводы.
${extra ? '\nОсобый интерес автора: ' + extra : ''}`.trim();

export async function analyze(cfg, imageB64, place, stats, extra, onProgress = () => {}) {
  const p = PROVIDERS[cfg.provider];
  if (!p.can.analyze) throw new Error(`${p.label} не подходит для анализа — выберите Claude, Gemini или OpenAI.`);
  if (!key(cfg)) throw new Error('Не задан API-ключ.');
  onProgress('Модель изучает участок…');
  const prompt = analysisPrompt(place, stats, extra);

  if (cfg.provider === 'anthropic') return claudeText(cfg, prompt, imageB64);
  if (cfg.provider === 'google') return geminiText(cfg, prompt, imageB64);
  return openaiText(cfg, prompt, imageB64);
}

async function claudeText(cfg, prompt, b64, schema) {
  const body = {
    model: modelFor(cfg, 'text'),
    max_tokens: 16000,
    output_config: { effort: 'medium' },
    messages: [{
      role: 'user',
      content: [
        ...(b64 ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } }] : []),
        { type: 'text', text: prompt }
      ]
    }]
  };
  if (schema) body.output_config.format = { type: 'json_schema', schema };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key(cfg),
      'anthropic-version': '2023-06-01',
      // Без этого заголовка браузерные запросы к Anthropic блокируются
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  });
  await ensure(res);
  const json = await res.json();
  if (json.stop_reason === 'refusal') throw new Error('Модель отклонила запрос.');
  return (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

async function geminiText(cfg, prompt, b64, schema) {
  const body = {
    contents: [{
      role: 'user',
      parts: [
        ...(b64 ? [{ inline_data: { mime_type: 'image/png', data: b64 } }] : []),
        { text: prompt }
      ]
    }]
  };
  if (schema) body.generationConfig = { response_mime_type: 'application/json', response_schema: schema };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelFor(cfg, 'text')}:generateContent?key=${encodeURIComponent(key(cfg))}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  );
  await ensure(res);
  const json = await res.json();
  return (json.candidates?.[0]?.content?.parts || []).map(p => p.text).filter(Boolean).join('\n').trim();
}

async function openaiText(cfg, prompt, b64, schema) {
  const body = {
    model: modelFor(cfg, 'text'),
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        ...(b64 ? [{ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }] : [])
      ]
    }]
  };
  if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'proposal', schema, strict: true } };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${key(cfg)}` },
    body: JSON.stringify(body)
  });
  await ensure(res);
  const json = await res.json();
  return (json.choices?.[0]?.message?.content || '').trim();
}

/* ============================================================
   Генерация проектных объёмов
   ============================================================ */

const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    reasoning: { type: 'string' },
    buildings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          levels: { type: 'integer' },
          height: { type: 'number' },
          polygon: {
            type: 'array',
            items: { type: 'array', items: { type: 'number' } }
          }
        },
        required: ['name', 'levels', 'height', 'polygon'],
        additionalProperties: false
      }
    }
  },
  required: ['reasoning', 'buildings'],
  additionalProperties: false
};

const proposalPrompt = (brief, site, s, occupied) => `
Ты — архитектор, работающий с объёмно-пространственной моделью участка.
Нужно разместить новые объёмы застройки по заданию автора.

СИСТЕМА КООРДИНАТ (важно):
Плоские метры, начало — центр участка. Ось X направлена на восток,
ось Z — на юг (север соответствует отрицательным Z).
Границы участка: X от ${(-site.width / 2).toFixed(0)} до ${(site.width / 2).toFixed(0)},
Z от ${(-site.height / 2).toFixed(0)} до ${(site.height / 2).toFixed(0)}.

СУЩЕСТВУЮЩАЯ СРЕДА:
${s.count} зданий, плотность застройки ${(s.coverage * 100).toFixed(0)} %,
коэффициент плотности ${s.far.toFixed(2)}, средняя высота ${s.avgH.toFixed(1)} м,
максимум ${s.maxH.toFixed(0)} м.
Пятна существующих зданий, которые нельзя перекрывать (прямоугольные габариты,
формат x1 z1 x2 z2): ${occupied}

ЗАДАНИЕ АВТОРА:
${brief}

ТРЕБОВАНИЯ К ОТВЕТУ:
- Каждый объём — замкнутый многоугольник из 4–12 вершин в порядке обхода,
  координаты в метрах указанной системы.
- Многоугольники не должны пересекать пятна существующих зданий и не должны
  выходить за границы участка.
- Между новыми объёмами оставляй проезды и разрывы не менее 12 м.
- Высоту согласуй с этажностью: height ≈ levels × 3.0 + 1.2.
- Соотноси высоты с существующей средой, если задание не требует контраста.
- В поле reasoning — три-четыре фразы по-русски: как размещены объёмы и почему.
- Никакого текста вне JSON.`.trim();

export async function propose(cfg, brief, site, stats, occupied, onProgress = () => {}) {
  const p = PROVIDERS[cfg.provider];
  if (!p.can.propose) throw new Error(`${p.label} не подходит для генерации объёмов.`);
  if (!key(cfg)) throw new Error('Не задан API-ключ.');
  onProgress('Модель компонует объёмы…');

  const prompt = proposalPrompt(brief, site, stats, occupied);
  let raw;
  if (cfg.provider === 'anthropic') raw = await claudeText(cfg, prompt, null, PROPOSAL_SCHEMA);
  else if (cfg.provider === 'google') raw = await geminiText(cfg, prompt, null, PROPOSAL_SCHEMA);
  else raw = await openaiText(cfg, prompt, null, PROPOSAL_SCHEMA);

  const parsed = parseJSON(raw);
  if (!parsed?.buildings?.length) throw new Error('Модель не вернула ни одного объёма.');
  return parsed;
}

// Модель может обернуть JSON в тройные кавычки или добавить пояснение —
// вытаскиваем первый объект целиком.
function parseJSON(text) {
  try { return JSON.parse(text); } catch { /* ниже */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Ответ модели не разобрать как JSON.');
  return JSON.parse(m[0]);
}
