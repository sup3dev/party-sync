// Модуль интеграции с Yandex Cloud API (YandexGPT)
// Ключ хранится ТОЛЬКО в localStorage браузера ведущего (не попадает в Git)

const STORAGE_KEY = 'party_sync_yc_config';

export class YandexAIClient {
  constructor() {
    this.config = this.loadConfig();
  }

  loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return {
      apiKey: '',
      folderId: '',
      model: 'yandexgpt/latest',
      bridgeUrl: 'http://127.0.0.1:31337/v1/chat/completions',
      customEndpoint: ''
    };
  }

  saveConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
  }

  isConfigured() {
    return Boolean(this.config.apiKey && this.config.apiKey.trim().length > 5);
  }

  async complete(systemPrompt, userPrompt, temperature = 0.7) {
    if (!this.isConfigured()) {
      throw new Error('API-ключ Yandex Cloud не настроен');
    }

    const apiKey = this.config.apiKey.trim();
    const folderId = this.config.folderId.trim();
    const modelName = this.config.model || 'yandexgpt/latest';
    const modelUri = folderId ? `gpt://${folderId}/${modelName}` : modelName;

    const openAiPayload = {
      model: modelUri,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature,
      max_tokens: 1500
    };

    const nativePayload = {
      modelUri,
      completionOptions: {
        stream: false,
        temperature,
        maxTokens: '1500'
      },
      messages: [
        { role: 'system', text: systemPrompt },
        { role: 'user', text: userPrompt }
      ]
    };

    const endpointsToTry = [];

    // 1. Если задан кастомный эндпоинт/воркер
    if (this.config.customEndpoint && this.config.customEndpoint.trim()) {
      endpointsToTry.push({
        url: this.config.customEndpoint.trim(),
        type: 'openai',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Api-Key ${apiKey}`,
          ...(folderId ? { 'x-folder-id': folderId } : {})
        }
      });
    }

    // 2. Локальный мост yandex-bridge.mjs (обходит браузерный CORS на 100%)
    endpointsToTry.push({
      url: this.config.bridgeUrl || 'http://127.0.0.1:31337/v1/chat/completions',
      type: 'bridge',
      headers: {
        'Content-Type': 'application/json',
        'X-Yandex-Key': apiKey,
        'X-Folder-Id': folderId
      }
    });

    // 3. Прямой OpenAI-совместимый эндпоинт Yandex Cloud
    endpointsToTry.push({
      url: 'https://llm.api.cloud.yandex.net/v1/chat/completions',
      type: 'openai',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey.startsWith('t1.') ? `Bearer ${apiKey}` : `Api-Key ${apiKey}`,
        ...(folderId ? { 'x-folder-id': folderId } : {})
      }
    });

    // 4. Классический Foundation Models эндпоинт
    endpointsToTry.push({
      url: 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
      type: 'native',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey.startsWith('t1.') ? `Bearer ${apiKey}` : `Api-Key ${apiKey}`,
        ...(folderId ? { 'x-folder-id': folderId } : {})
      }
    });

    let lastError = null;
    for (const ep of endpointsToTry) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), ep.type === 'bridge' ? 6000 : 15000);

        const body = ep.type === 'native' ? nativePayload : openAiPayload;
        const res = await fetch(ep.url, {
          method: 'POST',
          headers: ep.headers,
          body: JSON.stringify(body),
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`HTTP ${res.status}: ${errText.slice(0, 160)}`);
        }

        const data = await res.json();
        // Разбор ответа OpenAI или Yandex Native формата
        if (data.choices?.[0]?.message?.content) {
          return data.choices[0].message.content.trim();
        }
        if (data.result?.alternatives?.[0]?.message?.text) {
          return data.result.alternatives[0].message.text.trim();
        }
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error('Не удалось связаться с YandexGPT (проверьте ключ или запустите локальный мост yandex-bridge.mjs для обхода CORS)');
  }

  extractJson(text) {
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const firstBracket = cleaned.indexOf('[');
    const firstBrace = cleaned.indexOf('{');
    if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
      const lastBracket = cleaned.lastIndexOf(']');
      return JSON.parse(cleaned.slice(firstBracket, lastBracket + 1));
    }
    if (firstBrace !== -1) {
      const lastBrace = cleaned.lastIndexOf('}');
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    }
    return JSON.parse(cleaned);
  }

  async generateCustomQuestions(topic, count = 5) {
    const sys = `Ты — главный редактор увлекательной вечерней викторины для дружной команды из 6 коллег (3 менеджера и 3 программиста).
Генерируй небанальные, остроумные и познавательные вопросы, где ответ можно вычислить смекалкой или удивиться крутому факту.
Верни СТРОГО валидный JSON-массив из ${count} объектов без markdown-обёрток:
[
  {
    "category": "tech_biz",
    "points": 250,
    "question": "Текст вопроса?",
    "options": ["Вариант 1", "Вариант 2", "Вариант 3", "Вариант 4"],
    "answer": 0,
    "hint": "Тонкая подсказка без прямого ответа",
    "explanation": "Короткий интересный факт почему это так"
  }
]`;
    const usr = `Сгенерируй ${count} крутых вопросов по теме: «${topic}». Перемешай индекс правильного ответа (answer от 0 до 3).`;
    const raw = await this.complete(sys, usr, 0.75);
    const parsed = this.extractJson(raw);
    return Array.isArray(parsed) ? parsed.map((q, idx) => ({
      id: `ai_${Date.now()}_${idx}`,
      category: q.category || 'weird_world',
      points: Number(q.points) || 250,
      question: q.question,
      options: Array.isArray(q.options) && q.options.length === 4 ? q.options : ['Да', 'Нет', 'Возможно', 'Секрет'],
      answer: typeof q.answer === 'number' ? q.answer : 0,
      hint: q.hint || 'Прислушайся к интуиции!',
      explanation: q.explanation || 'Сгенерировано нейросетью YandexGPT!',
      isAi: true
    })) : [];
  }

  async generateHint(questionObj) {
    if (!this.isConfigured()) {
      return questionObj.hint || 'Присмотрись к самому неожиданному, но логичному варианту!';
    }
    try {
      const sys = 'Ты — остроумный ведущий интеллектуального шоу. Дай короткую (1-2 предложения) красивую подсказку-намёк к вопросу, НЕ называя правильный ответ напрямую.';
      const usr = `Вопрос: ${questionObj.question}\nПравильный ответ (НЕ называй его вслух!): ${questionObj.options[questionObj.answer]}`;
      return await this.complete(sys, usr, 0.7);
    } catch (e) {
      return questionObj.hint || 'Интуиция подсказывает отбросить самый скучный вариант!';
    }
  }

  async judgeCaseAnswer(scenario, mutator, playerName, playerRole, answerText) {
    if (!this.isConfigured()) {
      // Встроенный умный фоллбэк-арбитр, если играют без ключа
      const words = answerText.trim().split(/\s+/).length;
      const baseScore = Math.min(480, Math.max(220, words * 18 + Math.floor(Math.random() * 90)));
      const compliments = [
        `План от ${playerName} звучит так дерзко, что совет директоров уже готовит бонус!`,
        `Идеальный баланс менеджерской дипломатии и инженерной смекалки!`,
        `Мутатор обыгран элегантно — конкуренты в панике записывают каждое слово.`,
        `Такой антикризисный манёвр войдёт в золотой фонд вечерних созвонов!`
      ];
      return {
        score: Math.round(baseScore / 10) * 10,
        verdict: compliments[Math.floor(Math.random() * compliments.length)],
        highlight: 'Засчитано единогласным решением алгоритма!'
      };
    }

    try {
      const sys = `Ты — харизматичный, дружелюбный и остроумный ИИ-судья вечернего шоу для команды из 3 менеджеров и 3 программистов.
Оцени ответ игрока на кризисный кейс с учётом его секретного условия-мутатора.
Верни СТРОГО JSON без markdown:
{
  "score": число от 150 до 500 (кратно 10),
  "verdict": "Остроумный разбор ответа в 2-3 предложениях с добрым юмором",
  "highlight": "Короткий титул за этот ответ (3-5 слов)"
}`;
      const usr = `Игрок: ${playerName} (${playerRole})
Ситуация: ${scenario.title} — ${scenario.situation}
Секретное условие-мутатор: ${mutator}
Ответ игрока: "${answerText}"`;
      const raw = await this.complete(sys, usr, 0.8);
      return this.extractJson(raw);
    } catch (e) {
      return {
        score: 350,
        verdict: `Нейросеть так впечатлилась планом ${playerName}, что выписала 350 очков за нестандартный подход!`,
        highlight: 'Мастер импровизации'
      };
    }
  }
}

export const aiClient = new YandexAIClient();
