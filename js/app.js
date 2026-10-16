// Чистый пошаговый движок игры «50 Вопросов» (Один экран — одно действие)
import { CATEGORIES, QUIZ_QUESTIONS, BLUFF_PROMPTS } from '../data/content.js';
import { sfx } from './audio.js';
import { aiClient } from './ai.js';

const STORAGE_KEY = 'party_quiz_clean_v3';

const DEFAULT_PLAYERS = [
  { id: 'p1', name: 'Игрок 1', score: 0, jokers: { fifty: true, double: true, ally: true, pass: true, hint: true } },
  { id: 'p2', name: 'Игрок 2', score: 0, jokers: { fifty: true, double: true, ally: true, pass: true, hint: true } },
  { id: 'p3', name: 'Игрок 3', score: 0, jokers: { fifty: true, double: true, ally: true, pass: true, hint: true } },
  { id: 'p4', name: 'Игрок 4', score: 0, jokers: { fifty: true, double: true, ally: true, pass: true, hint: true } },
  { id: 'p5', name: 'Игрок 5', score: 0, jokers: { fifty: true, double: true, ally: true, pass: true, hint: true } },
  { id: 'p6', name: 'Игрок 6', score: 0, jokers: { fifty: true, double: true, ally: true, pass: true, hint: true } }
];

const EVENT_TYPES = ['boxes', 'auction', 'duel', 'dilemma', 'steal'];

class CleanPartyQuiz {
  constructor() {
    this.state = this.loadState() || this.createInitialState();
    this.buildFullQuestionPool();
    this.render();
  }

  buildFullQuestionPool() {
    // Превращаем также BLUFF_PROMPTS в интересные вопросы про реальные факты, чтобы база была 62 вопроса из коробки
    const convertedBluffs = BLUFF_PROMPTS.map((b, idx) => {
      const opts = [b.truth, ...b.decoyBluffs.slice(0, 3)];
      // Детерминированно перемешаем варианты
      const shift = (idx + 1) % 4;
      const rotated = opts.map((_, i) => opts[(i + shift) % 4]);
      const correctIdx = rotated.indexOf(b.truth);
      return {
        id: `bf_${b.id}`,
        category: 'weird_world',
        points: 250,
        question: b.prompt.replace('______', '[ ... ]'),
        options: rotated,
        answer: correctIdx,
        hint: 'Реальный факт звучит безумнее обычных отговорок.',
        explanation: b.fact
      };
    });
    this.basePool = [...QUIZ_QUESTIONS, ...convertedBluffs];
  }

  createInitialState() {
    return {
      screen: 'lobby', // 'lobby' | 'play' | 'results'
      totalQuestions: 50,
      turn: 1,
      activePlayerIdx: 0,
      players: JSON.parse(JSON.stringify(DEFAULT_PLAYERS)),
      usedIds: [],
      customQuestions: [],

      // Текущий ход всегда находится ровно в ОДНОМ понятном шаге:
      // step: 'event_intro' -> 'question' -> 'answered'
      currentTurn: null
    };
  }

  loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.players) && parsed.players.length >= 2) {
          return parsed;
        }
      }
    } catch (e) {}
    return null;
  }

  saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch (e) {}
  }

  getActivePlayer() {
    return this.state.players[this.state.activePlayerIdx] || this.state.players[0];
  }

  startGame() {
    sfx.play('fanfare');
    this.state.screen = 'play';
    this.state.turn = 1;
    this.state.activePlayerIdx = 0;
    this.state.usedIds = [];
    this.state.players.forEach((p) => {
      p.score = 0;
      p.jokers = { fifty: true, double: true, ally: true, pass: true, hint: true };
    });
    this.setupTurn();
  }

  nextTurn() {
    sfx.play('click');
    if (this.state.turn >= this.state.totalQuestions) {
      this.state.screen = 'results';
      sfx.play('fanfare');
      if (window.confetti) {
        window.confetti({ particleCount: 100, spread: 80, origin: { y: 0.5 } });
      }
      this.saveState();
      this.render();
      return;
    }

    this.state.turn += 1;
    this.state.activePlayerIdx = (this.state.activePlayerIdx + 1) % this.state.players.length;
    this.setupTurn();
  }

  setupTurn() {
    const pool = [...this.state.customQuestions, ...(this.basePool || QUIZ_QUESTIONS)];
    let available = pool.filter((q) => !this.state.usedIds.includes(q.id));
    if (available.length === 0) {
      this.state.usedIds = [];
      available = pool;
    }
    const q = available[Math.floor(Math.random() * available.length)];
    this.state.usedIds.push(q.id);

    // Каждый 4-й ход — ивентовый вопрос!
    let eventType = null;
    if (this.state.turn % 4 === 0) {
      const evIdx = (Math.floor(this.state.turn / 4) - 1) % EVENT_TYPES.length;
      eventType = EVENT_TYPES[evIdx];
      sfx.play('event');
    }

    // 3 шкатулки для ивента 'boxes'
    const boxes = [
      { label: 'Шкатулка 1', effect: 'plus300', text: '+300 очков сразу!' },
      { label: 'Шкатулка 2', effect: 'double', text: 'Очки за вопрос удвоены (×2)!' },
      { label: 'Шкатулка 3', effect: 'minus100', text: 'Ловушка: -100 очков' }
    ].sort(() => Math.random() - 0.5);

    const needsPreStep = eventType === 'boxes' || eventType === 'auction' || eventType === 'duel' || eventType === 'dilemma';

    this.state.currentTurn = {
      question: q,
      eventType, // null | 'boxes' | 'auction' | 'duel' | 'dilemma' | 'steal'
      step: needsPreStep ? 'event_intro' : 'question',

      // Параметры вопроса
      multiplier: 1,
      usedDouble: false,
      usedHintOrFifty: false,
      hiddenOptions: [],
      hintText: null,
      allyPlayerId: null,
      passedFromId: null,
      selectingTargetFor: null, // 'ally' | 'pass'

      // Результат ответа
      selectedOption: null,
      outcomeTitle: '',
      outcomeDeltaText: '',

      // Данные ивентов
      boxes,
      pickedBoxIdx: null,
      boxResultMsg: null,

      auctionPrice: 400,

      duelOpponentId: null,
      duelFirstAnswer: null,
      duelSecondAnswer: null,

      dilemmaPartnerId: null,
      dilemmaFirstChoice: null, // 'coop' | 'betray'
      dilemmaResultMsg: null
    };

    this.saveState();
    this.render();
  }

  // --- ОБРАБОТКА ПОШАГОВЫХ ИВЕНТОВ ПЕРЕД ВОПРОСОМ ---
  // 1. Три шкатулки
  pickBox(idx) {
    const ct = this.state.currentTurn;
    const player = this.getActivePlayer();
    if (ct.boxResultMsg) return;

    if (idx === -1) {
      player.score += 100;
      sfx.play('correct');
      ct.boxResultMsg = `${player.name} забирает надёжные +100 очков без риска.`;
    } else {
      ct.pickedBoxIdx = idx;
      const b = ct.boxes[idx];
      if (b.effect === 'plus300') {
        player.score += 300;
        sfx.play('correct');
        ct.boxResultMsg = `Отлично! В шкатулке лежало +300 очков для ${player.name}!`;
      } else if (b.effect === 'double') {
        ct.multiplier = 2;
        sfx.play('joker');
        ct.boxResultMsg = `В шкатулке усилитель! Стоимость вопроса удвоена (×2).`;
      } else {
        player.score -= 100;
        sfx.play('wrong');
        ct.boxResultMsg = `Ловушка! ${player.name} теряет 100 очков.`;
      }
    }
    this.saveState();
    this.render();
  }

  // 2. Аукцион (кто забирает вопрос за 400 очков)
  pickAuctionBuyer(playerId) {
    const ct = this.state.currentTurn;
    sfx.play('joker');
    if (playerId) {
      const idx = this.state.players.findIndex((p) => p.id === playerId);
      if (idx !== -1) {
        this.state.activePlayerIdx = idx;
        ct.multiplier = 2; // Вопрос за двойные очки, но с риском
        ct.usedDouble = true;
      }
    }
    ct.step = 'question';
    this.saveState();
    this.render();
  }

  // 3. Дуэль 1 на 1
  pickDuelOpponent(opponentId) {
    const ct = this.state.currentTurn;
    sfx.play('event');
    ct.duelOpponentId = opponentId;
    ct.step = 'question';
    this.saveState();
    this.render();
  }

  // 4. Сделка или Подстава (Дилемма)
  pickDilemmaPartner(partnerId) {
    const ct = this.state.currentTurn;
    sfx.play('click');
    ct.dilemmaPartnerId = partnerId;
    this.saveState();
    this.render();
  }

  submitDilemmaChoice(choice) {
    const ct = this.state.currentTurn;
    const p1 = this.getActivePlayer();
    const p2 = this.state.players.find((p) => p.id === ct.dilemmaPartnerId);
    if (!p2) return;

    sfx.play('click');
    if (!ct.dilemmaFirstChoice) {
      ct.dilemmaFirstChoice = choice;
      this.saveState();
      this.render();
      return;
    }

    const c1 = ct.dilemmaFirstChoice;
    const c2 = choice;

    if (c1 === 'coop' && c2 === 'coop') {
      p1.score += 200;
      p2.score += 200;
      sfx.play('correct');
      ct.dilemmaResultMsg = `Оба выбрали «Довериться»! ${p1.name} и ${p2.name} получают по +200 очков.`;
    } else if (c1 === 'betray' && c2 === 'coop') {
      p1.score += 350;
      p2.score -= 100;
      sfx.play('joker');
      ct.dilemmaResultMsg = `${p1.name} выбрал «Забрать всё» и уносит +350 очков, а ${p2.name} теряет 100!`;
    } else if (c1 === 'coop' && c2 === 'betray') {
      p1.score -= 100;
      p2.score += 350;
      sfx.play('joker');
      ct.dilemmaResultMsg = `${p2.name} выбрал «Забрать всё» и уносит +350 очков, а ${p1.name} теряет 100!`;
    } else {
      p1.score -= 150;
      p2.score -= 150;
      sfx.play('wrong');
      ct.dilemmaResultMsg = `Оба нажали «Забрать всё»! Банк сгорел, оба теряют по 150 очков.`;
    }

    this.saveState();
    this.render();
  }

  // --- ДЖОКЕРЫ ---
  async useJoker(type) {
    const ct = this.state.currentTurn;
    const player = this.getActivePlayer();
    const q = ct.question;
    if (!player.jokers[type] || ct.step !== 'question') return;

    if (type === 'fifty') {
      sfx.play('joker');
      player.jokers.fifty = false;
      ct.usedHintOrFifty = true;
      const wrongs = [0, 1, 2, 3].filter((i) => i !== q.answer).sort(() => Math.random() - 0.5);
      ct.hiddenOptions = wrongs.slice(0, 2);
    } else if (type === 'double') {
      if (ct.usedHintOrFifty) return;
      sfx.play('joker');
      player.jokers.double = false;
      ct.multiplier *= 2;
      ct.usedDouble = true;
    } else if (type === 'hint') {
      sfx.play('joker');
      player.jokers.hint = false;
      ct.usedHintOrFifty = true;
      ct.hintText = 'Загружаем подсказку...';
      this.render();
      ct.hintText = await aiClient.generateHint(q);
    } else if (type === 'ally' || type === 'pass') {
      sfx.play('click');
      ct.selectingTargetFor = ct.selectingTargetFor === type ? null : type;
    }

    this.saveState();
    this.render();
  }

  confirmJokerTarget(targetId) {
    const ct = this.state.currentTurn;
    const player = this.getActivePlayer();
    const target = this.state.players.find((p) => p.id === targetId);
    if (!target) return;

    const mode = ct.selectingTargetFor;
    ct.selectingTargetFor = null;
    sfx.play('joker');

    if (mode === 'ally') {
      player.jokers.ally = false;
      ct.usedHintOrFifty = true;
      ct.allyPlayerId = target.id;
    } else if (mode === 'pass') {
      player.jokers.pass = false;
      ct.passedFromId = player.id;
      const newIdx = this.state.players.findIndex((p) => p.id === target.id);
      if (newIdx !== -1) {
        this.state.activePlayerIdx = newIdx;
      }
    }

    this.saveState();
    this.render();
  }

  // --- ОТВЕТ НА ВОПРОС ---
  answerQuestion(optionIdx) {
    const ct = this.state.currentTurn;
    const q = ct.question;
    const player = this.getActivePlayer();
    if (ct.step !== 'question') return;

    // Если это Дуэль 1 на 1 — сначала отвечает первый дуэлянт, затем второй!
    if (ct.eventType === 'duel' && ct.duelOpponentId) {
      if (ct.duelFirstAnswer === null) {
        sfx.play('click');
        ct.duelFirstAnswer = optionIdx;
        this.saveState();
        this.render();
        return;
      }

      ct.duelSecondAnswer = optionIdx;
      const opp = this.state.players.find((p) => p.id === ct.duelOpponentId);
      const p1Right = ct.duelFirstAnswer === q.answer;
      const p2Right = ct.duelSecondAnswer === q.answer;

      ct.selectedOption = ct.duelFirstAnswer;
      ct.step = 'answered';

      if (p1Right && p2Right) {
        player.score += 300;
        if (opp) opp.score += 300;
        sfx.play('correct');
        ct.outcomeTitle = 'Оба дуэлянта ответили верно!';
        ct.outcomeDeltaText = `${player.name} и ${opp?.name} получают по +300 очков`;
      } else if (p1Right && !p2Right) {
        player.score += 400;
        if (opp) opp.score -= 100;
        sfx.play('fanfare');
        ct.outcomeTitle = `Победа ${player.name} в дуэли!`;
        ct.outcomeDeltaText = `${player.name} получает +300 и забирает 100 очков у ${opp?.name}`;
      } else if (!p1Right && p2Right) {
        if (opp) opp.score += 400;
        player.score -= 100;
        sfx.play('fanfare');
        ct.outcomeTitle = `Победа ${opp?.name} в дуэли!`;
        ct.outcomeDeltaText = `${opp?.name} получает +300 и забирает 100 очков у ${player.name}`;
      } else {
        sfx.play('wrong');
        ct.outcomeTitle = 'Оба дуэлянта ошиблись';
        ct.outcomeDeltaText = 'Очки не изменились';
      }

      this.saveState();
      this.render();
      return;
    }

    // Обычный ответ
    ct.selectedOption = optionIdx;
    ct.step = 'answered';
    const isCorrect = optionIdx === q.answer;
    const pts = Math.round(q.points * ct.multiplier);

    if (isCorrect) {
      sfx.play('correct');
      player.score += pts;
      let extraNotes = [`+${pts} для ${player.name}`];

      if (ct.allyPlayerId) {
        const ally = this.state.players.find((p) => p.id === ct.allyPlayerId);
        if (ally) {
          ally.score += 150;
          extraNotes.push(`+150 союзнику (${ally.name})`);
        }
      }

      if (ct.eventType === 'steal') {
        const sorted = [...this.state.players].sort((a, b) => b.score - a.score);
        const leader = sorted[0];
        if (leader && leader.id !== player.id) {
          leader.score -= 150;
          player.score += 150;
          extraNotes.push(`украдено 150 у лидера (${leader.name})`);
        }
      }

      ct.outcomeTitle = 'Правильный ответ!';
      ct.outcomeDeltaText = extraNotes.join(' · ');

      if (window.confetti) {
        window.confetti({ particleCount: 45, spread: 60, origin: { y: 0.7 } });
      }
    } else {
      sfx.play('wrong');
      ct.outcomeTitle = 'Неверно';
      if (ct.usedDouble) {
        const penalty = Math.round(q.points / 2);
        player.score -= penalty;
        ct.outcomeDeltaText = `Штраф за риск (×2): -${penalty} очков`;
      } else if (ct.passedFromId) {
        player.score -= 100;
        ct.outcomeDeltaText = `Штраф по переданному вопросу: -100 очков`;
      } else {
        ct.outcomeDeltaText = '0 очков за этот ход';
      }
    }

    this.saveState();
    this.render();
  }

  // --- РЕНДЕРИНГ ЧИСТОГО ИНТЕРФЕЙСА ---
  render() {
    const root = document.getElementById('app-root');
    if (!root) return;

    root.innerHTML = `
      <div class="min-h-screen flex flex-col">
        ${this.renderTopBar()}
        <main class="flex-1 flex items-center justify-center px-4 py-8">
          <div class="w-full max-w-2xl">
            ${
              this.state.screen === 'lobby'
                ? this.renderLobby()
                : this.state.screen === 'results'
                ? this.renderResults()
                : this.renderPlayStage()
            }
          </div>
        </main>
        ${this.renderAiModal()}
      </div>
    `;

    this.bindEvents();
    if (window.lucide) window.lucide.createIcons();
  }

  renderTopBar() {
    if (this.state.screen === 'lobby') {
      return `
        <header class="border-b border-[#2a2f3a] bg-[#0f1115]">
          <div class="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
            <div class="font-bold text-base tracking-tight text-white">50 Вопросов</div>
            <div class="flex items-center gap-2">
              <button id="btn-open-ai" class="px-3 py-1.5 rounded-lg bg-[#181b22] hover:bg-[#20242d] border border-[#2a2f3a] text-xs font-medium text-gray-300 flex items-center gap-1.5">
                <i data-lucide="sparkles" class="w-3.5 h-3.5 text-yellow-400"></i>
                Свои вопросы с ИИ
              </button>
              <button id="btn-sound" class="p-2 rounded-lg bg-[#181b22] hover:bg-[#20242d] border border-[#2a2f3a] text-gray-300">
                <i data-lucide="${sfx.muted ? 'volume-x' : 'volume-2'}" class="w-4 h-4"></i>
              </button>
            </div>
          </div>
        </header>
      `;
    }

    return `
      <header class="border-b border-[#2a2f3a] bg-[#0f1115] sticky top-0 z-20">
        <div class="max-w-5xl mx-auto px-4 py-2.5 flex flex-wrap items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <button id="btn-back-lobby" class="px-2.5 py-1 rounded-lg bg-[#181b22] hover:bg-[#20242d] border border-[#2a2f3a] text-xs text-gray-400 hover:text-white">
              ← В меню
            </button>
            <span class="text-xs font-semibold text-gray-400">
              Вопрос <strong class="text-white">${this.state.turn}</strong> из ${this.state.totalQuestions}
            </span>
          </div>

          <!-- Компактная полоска игроков и очков -->
          <div class="flex items-center gap-1.5 flex-wrap">
            ${this.state.players
              .map((p, idx) => {
                const active = idx === this.state.activePlayerIdx;
                return `
                  <div class="px-3 py-1 rounded-full text-xs font-medium flex items-center gap-1.5 transition ${
                    active
                      ? 'bg-yellow-400 text-black font-bold shadow'
                      : 'bg-[#181b22] text-gray-300 border border-[#2a2f3a]'
                  }">
                    <span>${this.escapeHtml(p.name)}</span>
                    <span class="${active ? 'text-black/80' : 'text-yellow-400 font-semibold'}">${p.score}</span>
                  </div>
                `;
              })
              .join('')}
          </div>

          <div class="flex items-center gap-1.5">
            <button id="btn-open-ai" class="p-2 rounded-lg bg-[#181b22] hover:bg-[#20242d] border border-[#2a2f3a] text-gray-300" title="Добавить свои вопросы через YandexGPT">
              <i data-lucide="sparkles" class="w-4 h-4 text-yellow-400"></i>
            </button>
            <button id="btn-sound" class="p-2 rounded-lg bg-[#181b22] hover:bg-[#20242d] border border-[#2a2f3a] text-gray-300" title="Звук">
              <i data-lucide="${sfx.muted ? 'volume-x' : 'volume-2'}" class="w-4 h-4"></i>
            </button>
          </div>
        </div>
      </header>
    `;
  }

  renderLobby() {
    return `
      <div class="card-surface p-6 sm:p-8 space-y-6 fade-in">
        <div>
          <h1 class="text-2xl font-bold text-white">Вечерняя игра в вопросы</h1>
          <p class="text-sm text-gray-400 mt-1">
            Отвечаем по очереди в Discord. У каждого игрока есть джокеры, а каждый 4-й ход выпадает особое событие (шкатулки, дуэль, аукцион или сделка).
          </p>
        </div>

        <div class="space-y-2.5">
          <div class="flex items-center justify-between">
            <label class="text-xs font-semibold uppercase tracking-wider text-gray-400">
              Игроки (${this.state.players.length})
            </label>
            <button id="btn-add-player" class="text-xs font-semibold text-yellow-400 hover:text-yellow-300">
              + Добавить игрока
            </button>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            ${this.state.players
              .map(
                (p, idx) => `
              <div class="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-[#0f1115] border border-[#2a2f3a] focus-within:border-yellow-400">
                <span class="text-xs font-semibold text-gray-500 w-5">${idx + 1}.</span>
                <input
                  type="text"
                  data-player-name="${p.id}"
                  value="${this.escapeHtml(p.name)}"
                  placeholder="Имя игрока"
                  class="flex-1 bg-transparent text-sm font-medium text-white focus:outline-none"
                />
                ${
                  this.state.players.length > 2
                    ? `<button data-remove-player="${p.id}" class="text-gray-500 hover:text-red-400">
                        <i data-lucide="x" class="w-4 h-4"></i>
                      </button>`
                    : ''
                }
              </div>
            `
              )
              .join('')}
          </div>
        </div>

        <div class="flex items-center justify-between pt-2 border-t border-[#2a2f3a]">
          <span class="text-sm text-gray-400">Количество вопросов в партии:</span>
          <div class="flex gap-1.5">
            ${[20, 35, 50]
              .map(
                (n) => `
              <button
                data-set-total="${n}"
                class="px-3.5 py-1.5 rounded-lg text-xs font-semibold border transition ${
                  this.state.totalQuestions === n
                    ? 'bg-yellow-400 text-black border-yellow-400'
                    : 'bg-[#0f1115] text-gray-400 border-[#2a2f3a] hover:text-white'
                }"
              >${n}</button>
            `
              )
              .join('')}
          </div>
        </div>

        <div class="flex flex-col sm:flex-row gap-3 pt-2">
          <button id="btn-start" class="flex-1 py-3.5 px-6 rounded-xl bg-yellow-400 hover:bg-yellow-300 text-black font-bold text-base transition">
            Начать игру
          </button>
          ${
            this.state.currentTurn && this.state.turn > 1
              ? `<button id="btn-resume" class="py-3.5 px-5 rounded-xl bg-[#0f1115] hover:bg-[#20242d] border border-[#2a2f3a] text-white font-semibold text-sm transition">
                  Продолжить (Вопрос ${this.state.turn})
                </button>`
              : ''
          }
        </div>
      </div>
    `;
  }

  renderPlayStage() {
    const ct = this.state.currentTurn;
    if (!ct) return '';

    if (ct.step === 'event_intro') {
      return this.renderEventIntroStep(ct);
    }

    return this.renderQuestionStep(ct);
  }

  // Экран пошагового ивента ПЕРЕД вопросом (только одно действие на экране!)
  renderEventIntroStep(ct) {
    const player = this.getActivePlayer();
    const others = this.state.players.filter((p) => p.id !== player.id);
    const cat = CATEGORIES[ct.question.category] || CATEGORIES.weird_world;

    if (ct.eventType === 'boxes') {
      return `
        <div class="card-surface p-6 sm:p-8 space-y-6 text-center fade-in">
          <div class="inline-block px-3 py-1 rounded-full bg-yellow-400/15 text-yellow-400 text-xs font-semibold">
            Особое событие · Три шкатулки
          </div>
          <h2 class="text-2xl font-bold text-white">
            Ход игрока ${this.escapeHtml(player.name)}
          </h2>
          <p class="text-sm text-gray-400 max-w-md mx-auto">
            Перед вопросом вы можете выбрать одну из трёх закрытых шкатулок (внутри: <strong>+300 очков</strong>, <strong>удвоение вопроса ×2</strong> или <strong>ловушка -100</strong>) либо забрать +100 очков без риска.
          </p>

          ${
            ct.boxResultMsg
              ? `<div class="p-4 rounded-xl bg-[#0f1115] border border-yellow-400/40 text-base font-semibold text-yellow-300">
                  ${this.escapeHtml(ct.boxResultMsg)}
                </div>
                <button id="btn-proceed-question" class="w-full py-3.5 rounded-xl bg-yellow-400 hover:bg-yellow-300 text-black font-bold text-sm">
                  Перейти к вопросу →
                </button>`
              : `<div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  ${ct.boxes
                    .map(
                      (b, i) => `
                    <button data-pick-box="${i}" class="option-btn p-5 text-center space-y-2">
                      <i data-lucide="package" class="w-7 h-7 text-yellow-400 mx-auto"></i>
                      <div class="font-bold text-sm text-white">${b.label}</div>
                    </button>
                  `
                    )
                    .join('')}
                </div>
                <button data-pick-box="-1" class="text-xs text-gray-400 hover:text-white underline">
                  Отказаться от шкатулок и забрать надёжные +100 очков
                </button>`
          }
        </div>
      `;
    }

    if (ct.eventType === 'auction') {
      return `
        <div class="card-surface p-6 sm:p-8 space-y-6 text-center fade-in">
          <div class="inline-block px-3 py-1 rounded-full bg-yellow-400/15 text-yellow-400 text-xs font-semibold">
            Особое событие · Вопрос с повышенной ставкой
          </div>
          <h2 class="text-2xl font-bold text-white">Тема вопроса: «${cat.name}»</h2>
          <p class="text-sm text-gray-400 max-w-md mx-auto">
            Кто из игроков готов перекупить этот вопрос вслепую за <strong>двойные очки (+${ct.question.points * 2})</strong>, но со штрафом <strong>-${Math.round(ct.question.points / 2)}</strong> при ошибке?
          </p>

          <div class="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            ${this.state.players
              .map(
                (p) => `
              <button data-auction-take="${p.id}" class="option-btn p-3.5 font-semibold text-sm text-white">
                Отвечает ${this.escapeHtml(p.name)}
              </button>
            `
              )
              .join('')}
          </div>

          <button data-auction-take="" class="text-xs text-gray-400 hover:text-white underline">
            Никто не рискует — оставить обычный вопрос для ${this.escapeHtml(player.name)}
          </button>
        </div>
      `;
    }

    if (ct.eventType === 'duel') {
      return `
        <div class="card-surface p-6 sm:p-8 space-y-6 text-center fade-in">
          <div class="inline-block px-3 py-1 rounded-full bg-red-500/15 text-red-400 text-xs font-semibold">
            Особое событие · Дуэль 1 на 1
          </div>
          <h2 class="text-2xl font-bold text-white">
            ${this.escapeHtml(player.name)}, кого вызываешь на дуэль?
          </h2>
          <p class="text-sm text-gray-400 max-w-md mx-auto">
            Вы оба ответите на один и тот же вопрос из категории «${cat.name}». Кто ответит верно — получит <strong>+300 очков</strong> (и заберёт 100 очков у соперника, если тот ошибётся).
          </p>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            ${others
              .map(
                (op) => `
              <button data-duel-target="${op.id}" class="option-btn p-4 flex items-center justify-between text-white">
                <span class="font-semibold text-sm">${this.escapeHtml(op.name)}</span>
                <span class="text-xs text-gray-400">${op.score} очков</span>
              </button>
            `
              )
              .join('')}
          </div>
        </div>
      `;
    }

    if (ct.eventType === 'dilemma') {
      const partner = this.state.players.find((p) => p.id === ct.dilemmaPartnerId);
      return `
        <div class="card-surface p-6 sm:p-8 space-y-6 text-center fade-in">
          <div class="inline-block px-3 py-1 rounded-full bg-yellow-400/15 text-yellow-400 text-xs font-semibold">
            Особое событие · Сделка или Подстава
          </div>

          ${
            !partner
              ? `
                <h2 class="text-2xl font-bold text-white">${this.escapeHtml(player.name)}, выбери напарника для сделки</h2>
                <p class="text-sm text-gray-400 max-w-md mx-auto">
                  Если оба нажмёте «Довериться» — получите по +200 очков. Если один нажмёт «Забрать всё» — он получит +350, а второй потеряет 100. Если оба нажмут «Забрать всё» — оба потеряют по 150!
                </p>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  ${others
                    .map(
                      (op) => `
                    <button data-dilemma-target="${op.id}" class="option-btn p-4 flex items-center justify-between text-white">
                      <span class="font-semibold text-sm">${this.escapeHtml(op.name)}</span>
                      <span class="text-xs text-gray-400">${op.score} очков</span>
                    </button>
                  `
                    )
                    .join('')}
                </div>
              `
              : ct.dilemmaResultMsg
              ? `
                <h2 class="text-xl font-bold text-white">Итог сделки</h2>
                <div class="p-4 rounded-xl bg-[#0f1115] border border-yellow-400/40 text-base font-semibold text-yellow-300">
                  ${this.escapeHtml(ct.dilemmaResultMsg)}
                </div>
                <button id="btn-proceed-question" class="w-full py-3.5 rounded-xl bg-yellow-400 hover:bg-yellow-300 text-black font-bold text-sm">
                  Перейти к вопросу →
                </button>
              `
              : `
                <h2 class="text-xl font-bold text-white">
                  Выбирает: ${this.escapeHtml(!ct.dilemmaFirstChoice ? player.name : partner.name)}
                </h2>
                <p class="text-xs text-gray-400">
                  ${
                    !ct.dilemmaFirstChoice
                      ? 'Первый выбор скрыт — второй участник не увидит, что вы нажали.'
                      : `Решение игрока ${this.escapeHtml(player.name)} засекречено. Теперь отвечает ${this.escapeHtml(partner.name)}!`
                  }
                </p>
                <div class="grid grid-cols-2 gap-3 pt-2">
                  <button data-dilemma-act="coop" class="option-btn p-5 text-center border-emerald-500/40 hover:border-emerald-400">
                    <div class="font-bold text-base text-emerald-400">Довериться</div>
                    <div class="text-xs text-gray-400 mt-1">По +200 обоим</div>
                  </button>
                  <button data-dilemma-act="betray" class="option-btn p-5 text-center border-red-500/40 hover:border-red-400">
                    <div class="font-bold text-base text-red-400">Забрать всё</div>
                    <div class="text-xs text-gray-400 mt-1">+350 себе, -100 напарнику</div>
                  </button>
                </div>
              `
          }
        </div>
      `;
    }

    return '';
  }

  // Основная карточка вопроса (чистая, без боковых панелей)
  renderQuestionStep(ct) {
    const q = ct.question;
    const player = this.getActivePlayer();
    const others = this.state.players.filter((p) => p.id !== player.id);
    const cat = CATEGORIES[q.category] || CATEGORIES.weird_world;
    const isAnswered = ct.step === 'answered';
    const isDuel = ct.eventType === 'duel' && ct.duelOpponentId;
    const duelOpponent = isDuel ? this.state.players.find((p) => p.id === ct.duelOpponentId) : null;
    const pts = Math.round(q.points * ct.multiplier);

    return `
      <div class="card-surface p-6 sm:p-8 space-y-6 fade-in">
        <!-- Верхняя строка карточки: Кто отвечает + Категория + Стоимость -->
        <div class="flex flex-wrap items-center justify-between gap-2 pb-4 border-b border-[#2a2f3a]">
          <div>
            <div class="text-xs text-gray-400">${cat.name}</div>
            <div class="text-base font-bold text-white mt-0.5">
              ${
                isDuel
                  ? ct.duelFirstAnswer === null
                    ? `Дуэль (1/2) · Сначала отвечает: <span class="text-yellow-400">${this.escapeHtml(player.name)}</span>`
                    : `Дуэль (2/2) · Теперь отвечает: <span class="text-yellow-400">${this.escapeHtml(duelOpponent?.name || '')}</span>`
                  : `Отвечает: <span class="text-yellow-400">${this.escapeHtml(player.name)}</span>`
              }
            </div>
          </div>

          <div class="flex items-center gap-2">
            ${
              ct.eventType === 'steal'
                ? `<span class="px-2.5 py-1 rounded-lg bg-red-500/15 text-red-300 text-xs font-semibold">Охота на лидера (+150 у 1 места)</span>`
                : ''
            }
            <span class="px-3 py-1 rounded-lg bg-yellow-400/15 text-yellow-400 font-bold text-sm">
              +${isDuel ? 300 : pts} очков
            </span>
          </div>
        </div>

        <!-- Текст вопроса -->
        <h2 class="text-xl sm:text-2xl font-bold text-white leading-snug">
          ${this.escapeHtml(q.question)}
        </h2>

        <!-- Плашка подсказки или союзника (показывается только если активированы) -->
        ${
          ct.hintText
            ? `<div class="p-3.5 rounded-xl bg-[#0f1115] border border-yellow-400/30 text-sm text-yellow-200">
                <strong>Подсказка:</strong> ${this.escapeHtml(ct.hintText)}
              </div>`
            : ''
        }
        ${
          ct.allyPlayerId
            ? `<div class="p-3 rounded-xl bg-[#0f1115] border border-emerald-500/30 text-xs text-emerald-300">
                Помощь друга: <strong>${this.escapeHtml(
                  this.state.players.find((p) => p.id === ct.allyPlayerId)?.name || ''
                )}</strong> подсказывает в голосовом чате (+150 ему при верном ответе).
              </div>`
            : ''
        }

        <!-- 4 крупные кнопки ответов -->
        <div class="grid grid-cols-1 gap-3">
          ${q.options
            .map((opt, idx) => {
              const letters = ['A', 'B', 'C', 'D'];
              const isHidden = ct.hiddenOptions.includes(idx);

              let btnClass = 'option-btn text-white';
              if (isHidden) {
                btnClass = 'opacity-15 pointer-events-none bg-[#0f1115] border border-[#2a2f3a] rounded-xl';
              } else if (isAnswered) {
                if (idx === q.answer) {
                  btnClass = 'bg-emerald-500/20 border-2 border-emerald-400 text-white rounded-xl';
                } else if (idx === ct.selectedOption || idx === ct.duelSecondAnswer) {
                  btnClass = 'bg-red-500/20 border-2 border-red-400 text-red-100 rounded-xl';
                } else {
                  btnClass = 'opacity-40 bg-[#0f1115] border border-[#2a2f3a] rounded-xl';
                }
              }

              return `
                <button
                  data-answer-idx="${idx}"
                  ${isHidden || isAnswered ? 'disabled' : ''}
                  class="p-4 text-left flex items-center gap-3.5 ${btnClass}"
                >
                  <span class="w-8 h-8 rounded-lg bg-[#0f1115] border border-[#2a2f3a] font-bold text-xs flex items-center justify-center shrink-0 ${
                    isAnswered && idx === q.answer ? 'bg-emerald-400 text-black border-emerald-400' : 'text-yellow-400'
                  }">
                    ${letters[idx]}
                  </span>
                  <span class="text-sm sm:text-base font-medium leading-snug">${this.escapeHtml(opt)}</span>
                </button>
              `;
            })
            .join('')}
        </div>

        <!-- Выбор игрока, если нажат джокер «Помощь друга» или «Передать вопрос» -->
        ${
          ct.selectingTargetFor && !isAnswered
            ? `<div class="p-4 rounded-xl bg-[#0f1115] border border-yellow-400/50 space-y-2.5 fade-in">
                <div class="text-xs font-semibold text-yellow-400">
                  ${
                    ct.selectingTargetFor === 'ally'
                      ? 'Кого зовём на помощь (+150 очков ему, если ответите верно)?'
                      : 'Кому принудительно передаём этот вопрос?'
                  }
                </div>
                <div class="flex flex-wrap gap-2">
                  ${others
                    .map(
                      (op) => `
                    <button data-joker-target="${op.id}" class="px-3.5 py-2 rounded-lg bg-[#181b22] hover:bg-yellow-400 hover:text-black border border-[#2a2f3a] text-xs font-semibold text-white transition">
                      ${this.escapeHtml(op.name)}
                    </button>
                  `
                    )
                    .join('')}
                </div>
              </div>`
            : ''
        }

        <!-- Нижняя панель: либо Джокеры (пока думает), либо Объяснение + кнопка «Дальше» (после ответа) -->
        ${
          !isAnswered && !isDuel
            ? `
              <div class="pt-4 border-t border-[#2a2f3a] space-y-2">
                <div class="text-[11px] font-medium text-gray-500">Джокеры игрока ${this.escapeHtml(player.name)} (по 1 разу за игру):</div>
                <div class="flex flex-wrap gap-2">
                  ${[
                    { id: 'fifty', label: '50 / 50', disabled: !player.jokers.fifty },
                    { id: 'double', label: 'Удвоить ×2', disabled: !player.jokers.double || ct.usedHintOrFifty },
                    { id: 'ally', label: 'Помощь друга', disabled: !player.jokers.ally },
                    { id: 'pass', label: 'Передать вопрос', disabled: !player.jokers.pass },
                    { id: 'hint', label: 'Подсказка', disabled: !player.jokers.hint }
                  ]
                    .map(
                      (jk) => `
                    <button
                      data-joker="${jk.id}"
                      ${jk.disabled ? 'disabled' : ''}
                      class="px-3.5 py-2 rounded-xl text-xs font-semibold border transition ${
                        !jk.disabled
                          ? 'bg-[#0f1115] hover:bg-[#20242d] border-[#2a2f3a] hover:border-yellow-400/60 text-gray-200'
                          : 'bg-[#0f1115]/40 border-[#2a2f3a]/40 text-gray-600 line-through cursor-not-allowed'
                      }"
                    >${jk.label}</button>
                  `
                    )
                    .join('')}
                </div>
              </div>
            `
            : ''
        }

        ${
          isAnswered
            ? `
              <div class="pt-4 border-t border-[#2a2f3a] space-y-4 fade-in">
                <div class="p-4 rounded-xl bg-[#0f1115] border ${
                  ct.selectedOption === q.answer || ct.duelSecondAnswer === q.answer
                    ? 'border-emerald-500/40'
                    : 'border-red-500/40'
                }">
                  <div class="flex items-center justify-between mb-1">
                    <span class="font-bold text-sm ${
                      ct.selectedOption === q.answer ? 'text-emerald-400' : 'text-red-400'
                    }">${this.escapeHtml(ct.outcomeTitle)}</span>
                    <span class="text-xs font-semibold text-gray-400">${this.escapeHtml(ct.outcomeDeltaText)}</span>
                  </div>
                  <p class="text-sm text-gray-300 leading-relaxed">${this.escapeHtml(q.explanation)}</p>
                </div>

                <button id="btn-next-turn" class="w-full py-3.5 rounded-xl bg-yellow-400 hover:bg-yellow-300 text-black font-bold text-sm transition">
                  Следующий вопрос →
                </button>
              </div>
            `
            : ''
        }
      </div>
    `;
  }

  renderResults() {
    const sorted = [...this.state.players].sort((a, b) => b.score - a.score);
    return `
      <div class="card-surface p-6 sm:p-8 space-y-6 text-center fade-in">
        <div class="text-xs font-semibold uppercase tracking-wider text-yellow-400">Игра окончена</div>
        <h2 class="text-3xl font-bold text-white">Победитель: ${this.escapeHtml(sorted[0]?.name || '')}</h2>

        <div class="space-y-2 text-left">
          ${sorted
            .map(
              (p, i) => `
            <div class="flex items-center justify-between px-4 py-3 rounded-xl ${
              i === 0 ? 'bg-yellow-400/15 border border-yellow-400/50' : 'bg-[#0f1115] border border-[#2a2f3a]'
            }">
              <div class="flex items-center gap-3">
                <span class="font-bold text-sm w-6 text-gray-400">${i + 1}.</span>
                <span class="font-semibold text-white">${this.escapeHtml(p.name)}</span>
              </div>
              <span class="font-bold text-yellow-400">${p.score} очков</span>
            </div>
          `
            )
            .join('')}
        </div>

        <button id="btn-restart" class="w-full py-3.5 rounded-xl bg-yellow-400 hover:bg-yellow-300 text-black font-bold text-sm">
          Сыграть ещё раз
        </button>
      </div>
    `;
  }

  renderAiModal() {
    const cfg = aiClient.config;
    return `
      <div id="ai-modal" class="hidden fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
        <div class="card-surface max-w-lg w-full p-6 space-y-4 fade-in">
          <div class="flex items-center justify-between">
            <h3 class="font-bold text-base text-white">Генератор вопросов через YandexGPT</h3>
            <button id="btn-close-ai" class="text-gray-400 hover:text-white">
              <i data-lucide="x" class="w-5 h-5"></i>
            </button>
          </div>

          <p class="text-xs text-gray-400 leading-relaxed">
            Ключ сохраняется только в вашем браузере (в GitHub не попадает). Если браузер блокирует запрос с GitHub Pages по CORS, запустите локально <code>node yandex-bridge.mjs</code>.
          </p>

          <div class="space-y-2.5">
            <input id="yc-api-key" type="password" value="${this.escapeHtml(cfg.apiKey)}" placeholder="Yandex Cloud API-Key (AQVN...)" class="w-full rounded-xl bg-[#0f1115] border border-[#2a2f3a] px-3.5 py-2.5 text-sm text-white focus:border-yellow-400 focus:outline-none" />
            <input id="yc-folder-id" type="text" value="${this.escapeHtml(cfg.folderId)}" placeholder="Folder ID (b1g...)" class="w-full rounded-xl bg-[#0f1115] border border-[#2a2f3a] px-3.5 py-2.5 text-sm text-white focus:border-yellow-400 focus:outline-none" />
          </div>

          <div class="pt-2 border-t border-[#2a2f3a] space-y-2">
            <label class="text-xs font-semibold text-gray-300">Сгенерировать 5 вопросов по вашей теме:</label>
            <div class="flex gap-2">
              <input id="ai-topic-input" type="text" placeholder="Например: кино 2000-х, видеоигры, курьёзы..." class="flex-1 rounded-xl bg-[#0f1115] border border-[#2a2f3a] px-3.5 py-2 text-sm text-white focus:border-yellow-400 focus:outline-none" />
              <button id="btn-gen-ai" class="px-4 py-2 rounded-xl bg-yellow-400 hover:bg-yellow-300 text-black font-bold text-xs shrink-0">
                Создать
              </button>
            </div>
          </div>

          <div id="yc-status-msg" class="text-xs text-gray-300 min-h-[18px]"></div>
        </div>
      </div>
    `;
  }

  bindEvents() {
    document.getElementById('btn-sound')?.addEventListener('click', () => {
      sfx.toggleMute();
      this.render();
    });

    document.getElementById('btn-back-lobby')?.addEventListener('click', () => {
      this.state.screen = 'lobby';
      this.render();
    });

    document.getElementById('btn-open-ai')?.addEventListener('click', () => {
      document.getElementById('ai-modal')?.classList.remove('hidden');
    });

    document.getElementById('btn-close-ai')?.addEventListener('click', () => {
      document.getElementById('ai-modal')?.classList.add('hidden');
    });

    document.getElementById('btn-gen-ai')?.addEventListener('click', async () => {
      const apiKey = document.getElementById('yc-api-key')?.value || '';
      const folderId = document.getElementById('yc-folder-id')?.value || '';
      const topic = document.getElementById('ai-topic-input')?.value?.trim() || 'Интересные факты, кино и игры';
      const statusEl = document.getElementById('yc-status-msg');

      aiClient.saveConfig({ apiKey, folderId });
      if (!aiClient.isConfigured()) {
        if (statusEl) statusEl.textContent = 'Укажите API-ключ Yandex Cloud выше.';
        return;
      }

      try {
        if (statusEl) statusEl.textContent = 'Генерируем 5 вопросов через YandexGPT...';
        const qs = await aiClient.generateCustomQuestions(topic, 5);
        this.state.customQuestions = [...qs, ...this.state.customQuestions];
        this.saveState();
        sfx.play('correct');
        if (statusEl) statusEl.textContent = `Готово! Добавлено ${qs.length} новых вопросов в игру.`;
      } catch (err) {
        if (statusEl) statusEl.textContent = `Ошибка: ${err.message}`;
      }
    });

    // Лобби
    document.querySelectorAll('[data-player-name]').forEach((inp) => {
      inp.addEventListener('input', (e) => {
        const pid = e.target.getAttribute('data-player-name');
        const p = this.state.players.find((pl) => pl.id === pid);
        if (p) {
          p.name = e.target.value;
          this.saveState();
        }
      });
    });

    document.querySelectorAll('[data-remove-player]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const pid = e.currentTarget.getAttribute('data-remove-player');
        if (this.state.players.length > 2) {
          this.state.players = this.state.players.filter((p) => p.id !== pid);
          this.saveState();
          this.render();
        }
      });
    });

    document.getElementById('btn-add-player')?.addEventListener('click', () => {
      this.state.players.push({
        id: `p_${Date.now()}`,
        name: `Игрок ${this.state.players.length + 1}`,
        score: 0,
        jokers: { fifty: true, double: true, ally: true, pass: true, hint: true }
      });
      this.saveState();
      this.render();
    });

    document.querySelectorAll('[data-set-total]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        this.state.totalQuestions = Number(e.currentTarget.getAttribute('data-set-total'));
        this.saveState();
        this.render();
      });
    });

    document.getElementById('btn-start')?.addEventListener('click', () => this.startGame());
    document.getElementById('btn-resume')?.addEventListener('click', () => {
      this.state.screen = 'play';
      this.render();
    });

    // Ивенты перед вопросом
    document.querySelectorAll('[data-pick-box]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        this.pickBox(Number(e.currentTarget.getAttribute('data-pick-box')));
      });
    });

    document.getElementById('btn-proceed-question')?.addEventListener('click', () => {
      sfx.play('click');
      this.state.currentTurn.step = 'question';
      this.saveState();
      this.render();
    });

    document.querySelectorAll('[data-auction-take]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        this.pickAuctionBuyer(e.currentTarget.getAttribute('data-auction-take'));
      });
    });

    document.querySelectorAll('[data-duel-target]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        this.pickDuelOpponent(e.currentTarget.getAttribute('data-duel-target'));
      });
    });

    document.querySelectorAll('[data-dilemma-target]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        this.pickDilemmaPartner(e.currentTarget.getAttribute('data-dilemma-target'));
      });
    });

    document.querySelectorAll('[data-dilemma-act]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        this.submitDilemmaChoice(e.currentTarget.getAttribute('data-dilemma-act'));
      });
    });

    // Ответ на вопрос и джокеры
    document.querySelectorAll('[data-answer-idx]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        this.answerQuestion(Number(e.currentTarget.getAttribute('data-answer-idx')));
      });
    });

    document.querySelectorAll('[data-joker]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        this.useJoker(e.currentTarget.getAttribute('data-joker'));
      });
    });

    document.querySelectorAll('[data-joker-target]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        this.confirmJokerTarget(e.currentTarget.getAttribute('data-joker-target'));
      });
    });

    document.getElementById('btn-next-turn')?.addEventListener('click', () => this.nextTurn());
    document.getElementById('btn-restart')?.addEventListener('click', () => {
      this.state.screen = 'lobby';
      this.render();
    });
  }

  escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.cleanPartyQuiz = new CleanPartyQuiz();
});
