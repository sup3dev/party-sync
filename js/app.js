// Вечерняя игра на 6 человек в Discord — Чистый фокус + 4 типа раундов + Барабан событий
import { CATEGORIES, WHEEL_EVENTS, QUIZ_QUESTIONS } from '../data/content.js';
import { sfx } from './audio.js';
import { aiClient } from './ai.js';

const STORAGE_KEY = 'party_quiz_v4';

const DEFAULT_PLAYERS = [
  { id: 'p1', name: 'Алекс', score: 0, streak: 0, jokers: { fifty: true, double: true, ally: true, pass: true, hint: true } },
  { id: 'p2', name: 'Игрок 2', score: 0, streak: 0, jokers: { fifty: true, double: true, ally: true, pass: true, hint: true } },
  { id: 'p3', name: 'Игрок 3', score: 0, streak: 0, jokers: { fifty: true, double: true, ally: true, pass: true, hint: true } },
  { id: 'p4', name: 'Игрок 4', score: 0, streak: 0, jokers: { fifty: true, double: true, ally: true, pass: true, hint: true } },
  { id: 'p5', name: 'Игрок 5', score: 0, streak: 0, jokers: { fifty: true, double: true, ally: true, pass: true, hint: true } },
  { id: 'p6', name: 'Игрок 6', score: 0, streak: 0, jokers: { fifty: true, double: true, ally: true, pass: true, hint: true } }
];

class PartyQuizGame {
  constructor() {
    this.state = this.loadState() || this.createInitialState();
    this.wheelSpinning = false;
    this.render();
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
      p.streak = 0;
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
        window.confetti({ particleCount: 110, spread: 80, origin: { y: 0.5 } });
      }
      this.saveState();
      this.render();
      return;
    }

    this.state.turn += 1;
    this.state.activePlayerIdx = (this.state.activePlayerIdx + 1) % this.state.players.length;
    this.setupTurn();
  }

  prepareQuestionInstance(rawQ) {
    const q = JSON.parse(JSON.stringify(rawQ));
    const activePlayer = this.getActivePlayer();
    const others = this.state.players.filter((p) => p.id !== activePlayer.id);

    // Если вопрос типа 'choice' (4 варианта) — перемешиваем варианты, чтобы правильный ответ не был всегда первым!
    if ((!q.type || q.type === 'choice') && Array.isArray(q.options) && q.options.length === 4) {
      const correctText = q.options[q.answer];
      const indices = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
      q.options = indices.map((i) => q.options[i]);
      q.answer = q.options.indexOf(correctText);
      q.type = 'choice';
    }

    // Если вопрос типа 'social' (про конкретного коллегу за столом) — выбираем случайного коллегу!
    if (q.type === 'social') {
      const targetColleague = others[Math.floor(Math.random() * others.length)] || activePlayer;
      q.socialTargetId = targetColleague.id;
      q.socialTargetName = targetColleague.name;
      q.question = q.question.replaceAll('{TARGET}', targetColleague.name);
      if (q.hint) q.hint = q.hint.replaceAll('{TARGET}', targetColleague.name);
    }

    return q;
  }

  setupTurn() {
    const pool = [...this.state.customQuestions, ...QUIZ_QUESTIONS];
    let available = pool.filter((q) => !this.state.usedIds.includes(q.id));
    if (available.length === 0) {
      this.state.usedIds = [];
      available = pool;
    }
    const rawPicked = available[Math.floor(Math.random() * available.length)];
    this.state.usedIds.push(rawPicked.id);
    const q = this.prepareQuestionInstance(rawPicked);

    // Каждый 4-й ход — Барабан Событий!
    const isWheelTurn = this.state.turn % 4 === 0;
    const evObj = isWheelTurn
      ? WHEEL_EVENTS[(Math.floor(this.state.turn / 4) - 1) % WHEEL_EVENTS.length]
      : null;

    const boxes = [
      { label: 'Шкатулка №1', effect: 'plus300', title: '+300 очков' },
      { label: 'Шкатулка №2', effect: 'double', title: 'Удвоение вопроса ×2' },
      { label: 'Шкатулка №3', effect: 'minus100', title: 'Ловушка -100 очков' }
    ].sort(() => Math.random() - 0.5);

    const midSlider = q.type === 'slider' ? Math.round(((q.min + q.max) / 2) / q.step) * q.step : 50;

    this.state.currentTurn = {
      question: q,
      eventObj: evObj, // null или объект из WHEEL_EVENTS
      wheelSpun: false,
      // Шаги: 'wheel' -> 'event_action' -> 'question' -> 'social_verify' -> 'answered'
      step: isWheelTurn ? 'wheel' : 'question',

      multiplier: 1,
      usedDouble: false,
      usedHintOrFifty: false,
      hiddenOptions: [],
      hintText: null,
      allyPlayerId: null,
      passedFromId: null,
      selectingTargetFor: null, // 'ally' | 'pass'

      // Для ползунка ('slider')
      sliderValue: midSlider,

      // Для социального вопроса ('social')
      socialGuessedIdx: null,
      socialActualIdx: null,

      // Для обычного ответа
      selectedOption: null,
      isWin: false,
      outcomeTitle: '',
      outcomeDeltaText: '',

      // Данные ивентов
      boxes,
      pickedBoxIdx: null,
      boxResultMsg: null,

      duelOpponentId: null,
      duelFirstAnswer: null,
      duelSecondAnswer: null,

      dilemmaPartnerId: null,
      dilemmaFirstChoice: null,
      dilemmaResultMsg: null
    };

    this.saveState();
    this.render();
  }

  // --- БАРАБАН СОБЫТИЙ ---
  spinEventWheel() {
    if (this.wheelSpinning) return;
    this.wheelSpinning = true;
    const ct = this.state.currentTurn;
    const slotTextEl = document.getElementById('wheel-slot-title');
    const spinBtn = document.getElementById('btn-spin-wheel');
    if (spinBtn) spinBtn.disabled = true;

    let ticks = 0;
    const totalTicks = 14;
    const interval = setInterval(() => {
      sfx.play('tick');
      const randomEv = WHEEL_EVENTS[ticks % WHEEL_EVENTS.length];
      if (slotTextEl) {
        slotTextEl.textContent = randomEv.title;
      }
      ticks++;
      if (ticks >= totalTicks) {
        clearInterval(interval);
        this.wheelSpinning = false;
        sfx.play('event');
        ct.wheelSpun = true;
        // Если событие 'steal' (Охота на лидера), оно не требует отдельного пред-шага — сразу к вопросу после показа!
        this.saveState();
        this.render();
      }
    }, 85);
  }

  proceedFromWheel() {
    const ct = this.state.currentTurn;
    sfx.play('click');
    if (ct.eventObj?.id === 'steal') {
      ct.step = 'question';
    } else {
      ct.step = 'event_action';
      // Если выпал социальный или ползунковый вопрос на Дуэль — заменим на чёткий вопрос с выбором для честной дуэли
      if (ct.eventObj?.id === 'duel' && ct.question.type !== 'choice' && ct.question.type !== 'truth') {
        const choicePool = QUIZ_QUESTIONS.filter((q) => q.type === 'choice');
        ct.question = this.prepareQuestionInstance(choicePool[Math.floor(Math.random() * choicePool.length)]);
      }
    }
    this.saveState();
    this.render();
  }

  // --- ИВЕНТЫ ПЕРЕД ВОПРОСОМ ---
  pickBox(idx) {
    const ct = this.state.currentTurn;
    const player = this.getActivePlayer();
    if (ct.boxResultMsg) return;
    ct.pickedBoxIdx = idx;

    if (idx === -1) {
      player.score += 100;
      sfx.play('correct');
      ct.boxResultMsg = `${player.name} забирает надёжные +100 очков без риска.`;
    } else {
      const b = ct.boxes[idx];
      if (b.effect === 'plus300') {
        player.score += 300;
        sfx.play('correct');
        ct.boxResultMsg = `Удача! В шкатулке лежало +300 очков для ${player.name}!`;
      } else if (b.effect === 'double') {
        ct.multiplier = 2;
        sfx.play('joker');
        ct.boxResultMsg = `Усилитель! Очки за этот вопрос удвоены (×2)!`;
      } else {
        player.score -= 100;
        sfx.play('wrong');
        ct.boxResultMsg = `Ловушка! ${player.name} теряет 100 очков.`;
      }
    }
    this.saveState();
    this.render();
  }

  pickAuctionBuyer(playerId) {
    const ct = this.state.currentTurn;
    sfx.play('joker');
    if (playerId) {
      const idx = this.state.players.findIndex((p) => p.id === playerId);
      if (idx !== -1) {
        this.state.activePlayerIdx = idx;
        ct.multiplier = 2;
        ct.usedDouble = true;
      }
    }
    ct.step = 'question';
    this.saveState();
    this.render();
  }

  pickDuelOpponent(opponentId) {
    const ct = this.state.currentTurn;
    sfx.play('event');
    ct.duelOpponentId = opponentId;
    ct.step = 'question';
    this.saveState();
    this.render();
  }

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
      ct.dilemmaResultMsg = `Оба выбрали «Поделить»! ${p1.name} и ${p2.name} получают по +200 очков.`;
    } else if (c1 === 'betray' && c2 === 'coop') {
      p1.score += 350;
      p2.score -= 100;
      sfx.play('joker');
      ct.dilemmaResultMsg = `${p1.name} нажал «Украсть» (+350 себе), а доверчивый ${p2.name} теряет 100!`;
    } else if (c1 === 'coop' && c2 === 'betray') {
      p1.score -= 100;
      p2.score += 350;
      sfx.play('joker');
      ct.dilemmaResultMsg = `${p2.name} нажал «Украсть» (+350 себе), а доверчивый ${p1.name} теряет 100!`;
    } else {
      p1.score -= 150;
      p2.score -= 150;
      sfx.play('wrong');
      ct.dilemmaResultMsg = `Оба нажали «Украсть»! Банк сгорел, оба теряют по 150 очков.`;
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
      if (q.type !== 'choice') return;
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
      ct.hintText = 'Подсказка загружается...';
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

  // --- ОТВЕТЫ НА ВСЕ 4 ТИПА ВОПРОСОВ ---
  // Тип 3: Ползунок интуиции ('slider')
  submitSliderGuess() {
    const ct = this.state.currentTurn;
    const q = ct.question;
    const player = this.getActivePlayer();
    if (ct.step !== 'question') return;

    const diff = Math.abs(ct.sliderValue - q.correctValue);
    ct.step = 'answered';

    let baseAward = 0;
    if (diff <= q.tolerancePerfect) {
      baseAward = 350;
      ct.outcomeTitle = `Точно в яблочко! Правильный ответ: ${q.correctValue}${q.unit}`;
    } else if (diff <= q.toleranceGood) {
      baseAward = 200;
      ct.outcomeTitle = `Очень близко! Правильный ответ: ${q.correctValue}${q.unit}`;
    } else {
      baseAward = 0;
      ct.outcomeTitle = `Мимо! Правильный ответ: ${q.correctValue}${q.unit} (ваш ответ: ${ct.sliderValue}${q.unit})`;
    }

    if (baseAward > 0) {
      const totalPts = Math.round(baseAward * ct.multiplier);
      player.score += totalPts;
      player.streak = (player.streak || 0) + 1;
      ct.isWin = true;
      sfx.play('correct');
      let notes = [`+${totalPts} для ${player.name}`];

      if (player.streak >= 3) {
        player.score += 100;
        notes.push(`+100 за серию ×${player.streak}`);
      }
      if (ct.allyPlayerId) {
        const ally = this.state.players.find((p) => p.id === ct.allyPlayerId);
        if (ally) {
          ally.score += 150;
          notes.push(`+150 союзнику (${ally.name})`);
        }
      }
      if (ct.eventObj?.id === 'steal') {
        const leader = [...this.state.players].sort((a, b) => b.score - a.score)[0];
        if (leader && leader.id !== player.id) {
          leader.score -= 150;
          player.score += 150;
          notes.push(`украдено 150 у лидера (${leader.name})`);
        }
      }
      ct.outcomeDeltaText = notes.join(' · ');
      if (window.confetti) window.confetti({ particleCount: 50, spread: 60, origin: { y: 0.7 } });
    } else {
      player.streak = 0;
      ct.isWin = false;
      sfx.play('wrong');
      if (ct.usedDouble) {
        player.score -= 125;
        ct.outcomeDeltaText = 'Штраф за удвоение: -125 очков';
      } else if (ct.passedFromId) {
        player.score -= 100;
        ct.outcomeDeltaText = 'Штраф по переданному вопросу: -100 очков';
      } else {
        ct.outcomeDeltaText = '0 очков';
      }
    }

    this.saveState();
    this.render();
  }

  // Тип 1, 2 и 4: Клик по варианту ответа
  answerQuestion(optionIdx) {
    const ct = this.state.currentTurn;
    const q = ct.question;
    const player = this.getActivePlayer();

    // Если это социальный вопрос про коллегу ('social'):
    // Сначала отвечает активный игрок (делает ставку на коллегу), а затем сам коллега подтверждает свой реальный выбор!
    if (q.type === 'social') {
      if (ct.step === 'question') {
        sfx.play('click');
        ct.socialGuessedIdx = optionIdx;
        ct.step = 'social_verify';
        this.saveState();
        this.render();
        return;
      }
      if (ct.step === 'social_verify') {
        ct.socialActualIdx = optionIdx;
        ct.selectedOption = ct.socialGuessedIdx;
        q.answer = optionIdx; // Реальный ответ коллеги становится правильным ответом!
        ct.step = 'answered';

        const matched = ct.socialGuessedIdx === ct.socialActualIdx;
        const targetColleague = this.state.players.find((p) => p.id === q.socialTargetId);
        const pts = Math.round(q.points * ct.multiplier);

        if (matched) {
          sfx.play('fanfare');
          player.score += pts;
          player.streak = (player.streak || 0) + 1;
          if (targetColleague && targetColleague.id !== player.id) {
            targetColleague.score += 100;
          }
          ct.isWin = true;
          ct.outcomeTitle = `Полный синхрон! Вы прочитали мысли ${q.socialTargetName}!`;
          ct.outcomeDeltaText = `+${pts} для ${player.name} и +100 для ${q.socialTargetName}`;
          if (window.confetti) window.confetti({ particleCount: 55, spread: 65, origin: { y: 0.7 } });
        } else {
          sfx.play('wrong');
          player.streak = 0;
          ct.isWin = false;
          ct.outcomeTitle = `Не угадал! ${q.socialTargetName} выбрал другой вариант`;
          ct.outcomeDeltaText = '0 очков';
        }
        this.saveState();
        this.render();
        return;
      }
    }

    if (ct.step !== 'question') return;

    // Если активна Дуэль 1 на 1
    if (ct.eventObj?.id === 'duel' && ct.duelOpponentId) {
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
        ct.isWin = true;
        sfx.play('correct');
        ct.outcomeTitle = 'Оба дуэлянта ответили верно!';
        ct.outcomeDeltaText = `${player.name} и ${opp?.name} получают по +300 очков`;
      } else if (p1Right && !p2Right) {
        player.score += 400;
        if (opp) opp.score -= 100;
        ct.isWin = true;
        sfx.play('fanfare');
        ct.outcomeTitle = `Победа ${player.name} в дуэли!`;
        ct.outcomeDeltaText = `+300 за вопрос и +100 со счёта ${opp?.name}`;
      } else if (!p1Right && p2Right) {
        if (opp) opp.score += 400;
        player.score -= 100;
        ct.isWin = false;
        sfx.play('fanfare');
        ct.outcomeTitle = `Победа ${opp?.name} в дуэли!`;
        ct.outcomeDeltaText = `${opp?.name} получает +300 и забирает 100 очков у ${player.name}`;
      } else {
        ct.isWin = false;
        sfx.play('wrong');
        ct.outcomeTitle = 'Оба дуэлянта промахнулись';
        ct.outcomeDeltaText = 'Счёт не изменился';
      }

      this.saveState();
      this.render();
      return;
    }

    // Обычный вопрос ('choice' или 'truth')
    ct.selectedOption = optionIdx;
    ct.step = 'answered';
    const isCorrect = optionIdx === q.answer;
    const pts = Math.round(q.points * ct.multiplier);

    if (isCorrect) {
      sfx.play('correct');
      player.score += pts;
      player.streak = (player.streak || 0) + 1;
      ct.isWin = true;
      let extraNotes = [`+${pts} для ${player.name}`];

      if (player.streak >= 3) {
        player.score += 100;
        extraNotes.push(`+100 за серию ×${player.streak}`);
      }

      if (ct.allyPlayerId) {
        const ally = this.state.players.find((p) => p.id === ct.allyPlayerId);
        if (ally) {
          ally.score += 150;
          extraNotes.push(`+150 союзнику (${ally.name})`);
        }
      }

      if (ct.eventObj?.id === 'steal') {
        const sorted = [...this.state.players].sort((a, b) => b.score - a.score);
        const leader = sorted[0];
        if (leader && leader.id !== player.id) {
          leader.score -= 150;
          player.score += 150;
          extraNotes.push(`украдено 150 у лидера (${leader.name})`);
        }
      }

      ct.outcomeTitle = 'Точно в цель!';
      ct.outcomeDeltaText = extraNotes.join(' · ');

      if (window.confetti) {
        window.confetti({ particleCount: 45, spread: 60, origin: { y: 0.7 } });
      }
    } else {
      sfx.play('wrong');
      player.streak = 0;
      ct.isWin = false;
      ct.outcomeTitle = 'Промах';
      if (ct.usedDouble) {
        const penalty = Math.round(q.points / 2);
        player.score -= penalty;
        ct.outcomeDeltaText = `Штраф за удвоение: -${penalty} очков`;
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

  // --- РЕНДЕРИНГ ---
  render() {
    const root = document.getElementById('app-root');
    if (!root) return;

    root.innerHTML = `
      <div class="min-h-screen flex flex-col">
        ${this.renderTopBar()}
        <main class="flex-1 flex items-center justify-center px-4 py-6 sm:py-10">
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
        <header class="border-b border-[#2a3246] bg-[#0b0d13]/90 backdrop-blur">
          <div class="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
            <div class="flex items-center gap-2.5">
              <div class="w-8 h-8 rounded-lg bg-yellow-400 text-black font-title font-extrabold text-sm flex items-center justify-center">50</div>
              <span class="font-title font-bold text-sm sm:text-base text-white">Вечерний Квиз</span>
            </div>
            <div class="flex items-center gap-2">
              <button id="btn-open-ai" class="px-3.5 py-2 rounded-xl bg-[#151923] hover:bg-[#1c2230] border border-[#2a3246] text-xs font-semibold text-gray-200 flex items-center gap-1.5 transition">
                <i data-lucide="sparkles" class="w-3.5 h-3.5 text-yellow-400"></i>
                Сгенерировать тему с ИИ
              </button>
              <button id="btn-sound" class="p-2 rounded-xl bg-[#151923] hover:bg-[#1c2230] border border-[#2a3246] text-gray-300">
                <i data-lucide="${sfx.muted ? 'volume-x' : 'volume-2'}" class="w-4 h-4"></i>
              </button>
            </div>
          </div>
        </header>
      `;
    }

    const nextWheelIn = 4 - (this.state.turn % 4);

    return `
      <header class="border-b border-[#2a3246] bg-[#0b0d13]/95 backdrop-blur sticky top-0 z-20">
        <div class="max-w-5xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <button id="btn-back-lobby" class="px-3 py-1.5 rounded-xl bg-[#151923] hover:bg-[#1c2230] border border-[#2a3246] text-xs font-medium text-gray-400 hover:text-white transition">
              ← Меню
            </button>
            <div>
              <div class="font-num text-xs font-bold text-white">
                ХОД ${this.state.turn} <span class="text-gray-500">/ ${this.state.totalQuestions}</span>
              </div>
              <div class="text-[11px] text-gray-400">
                ${
                  this.state.turn % 4 === 0
                    ? '<span class="text-yellow-400 font-semibold">★ Барабан событий!</span>'
                    : `До барабана событий: ${nextWheelIn} ${nextWheelIn === 1 ? 'ход' : 'хода'}`
                }
              </div>
            </div>
          </div>

          <!-- Плашки игроков с очками и сериями -->
          <div class="flex items-center gap-1.5 flex-wrap">
            ${this.state.players
              .map((p, idx) => {
                const active = idx === this.state.activePlayerIdx;
                return `
                  <div class="px-3 py-1.5 rounded-xl text-xs flex items-center gap-2 transition ${
                    active
                      ? 'bg-yellow-400 text-black font-extrabold shadow-lg shadow-yellow-400/15 scale-105'
                      : 'bg-[#151923] text-gray-300 border border-[#2a3246]'
                  }">
                    <span>${this.escapeHtml(p.name)}</span>
                    <span class="font-num ${active ? 'text-black' : 'text-yellow-400 font-bold'}">${p.score}</span>
                    ${
                      p.streak >= 2
                        ? `<span class="px-1.5 py-0.2 rounded bg-orange-500 text-white font-num text-[10px] font-bold" title="Серия ответов подряд">×${p.streak}</span>`
                        : ''
                    }
                  </div>
                `;
              })
              .join('')}
          </div>

          <div class="flex items-center gap-1.5">
            <button id="btn-open-ai" class="p-2 rounded-xl bg-[#151923] hover:bg-[#1c2230] border border-[#2a3246] text-gray-300" title="Сгенерировать вопросы с YandexGPT">
              <i data-lucide="sparkles" class="w-4 h-4 text-yellow-400"></i>
            </button>
            <button id="btn-sound" class="p-2 rounded-xl bg-[#151923] hover:bg-[#1c2230] border border-[#2a3246] text-gray-300">
              <i data-lucide="${sfx.muted ? 'volume-x' : 'volume-2'}" class="w-4 h-4"></i>
            </button>
          </div>
        </div>
      </header>
    `;
  }

  renderLobby() {
    return `
      <div class="game-stage-card p-6 sm:p-9 space-y-6 stage-enter">
        <div class="space-y-2">
          <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-yellow-400/10 border border-yellow-400/30 text-yellow-400 text-xs font-semibold">
            Локальная сессия в вашем браузере
          </div>
          <h1 class="font-title text-2xl sm:text-3xl font-extrabold text-white">50 Вопросов для Discord</h1>
          <p class="text-sm text-gray-400 leading-relaxed">
            Внутри 4 формата карточек: вопросы с подвохом, «Правда или Вымысел», «Ползунок интуиции» и вопросы про ваших коллег за столом + Барабан событий каждый 4-й ход.
          </p>
        </div>

        <div class="space-y-3">
          <div class="flex items-center justify-between">
            <span class="text-xs font-bold uppercase tracking-wider text-gray-400">
              Игроки за столом (${this.state.players.length})
            </span>
            <button id="btn-add-player" class="text-xs font-bold text-yellow-400 hover:text-yellow-300">
              + Добавить игрока
            </button>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            ${this.state.players
              .map(
                (p, idx) => `
              <div class="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-[#0b0d13] border border-[#2a3246] focus-within:border-yellow-400">
                <span class="font-num text-xs font-bold text-gray-500 w-5">${idx + 1}.</span>
                <input
                  type="text"
                  data-player-name="${p.id}"
                  value="${this.escapeHtml(p.name)}"
                  placeholder="Имя игрока"
                  class="flex-1 bg-transparent text-sm font-semibold text-white focus:outline-none"
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

        <div class="flex items-center justify-between pt-3 border-t border-[#2a3246]">
          <span class="text-sm font-medium text-gray-400">Длина партии:</span>
          <div class="flex gap-2">
            ${[20, 35, 50]
              .map(
                (n) => `
              <button
                data-set-total="${n}"
                class="px-4 py-1.5 rounded-xl font-num text-xs font-bold border transition ${
                  this.state.totalQuestions === n
                    ? 'bg-yellow-400 text-black border-yellow-400'
                    : 'bg-[#0b0d13] text-gray-400 border-[#2a3246] hover:text-white'
                }"
              >${n} ходов</button>
            `
              )
              .join('')}
          </div>
        </div>

        <div class="flex flex-col sm:flex-row gap-3 pt-2">
          <button id="btn-start" class="tactile-gold-btn flex-1 py-4 px-6 text-base font-title">
            Начать игру
          </button>
          ${
            this.state.currentTurn && this.state.turn > 1
              ? `<button id="btn-resume" class="tactile-option py-4 px-5 text-white font-semibold text-sm">
                  Продолжить (Ход ${this.state.turn})
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

    if (ct.step === 'wheel') {
      return this.renderWheelStep(ct);
    }
    if (ct.step === 'event_action') {
      return this.renderEventActionStep(ct);
    }

    return this.renderQuestionCard(ct);
  }

  // Шаг 1 на каждом 4-м ходе: Барабан Событий!
  renderWheelStep(ct) {
    const player = this.getActivePlayer();
    const ev = ct.eventObj;

    return `
      <div class="game-stage-card p-6 sm:p-9 text-center space-y-6 stage-enter">
        <div class="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-yellow-400/15 text-yellow-400 text-xs font-bold uppercase tracking-wider">
          ★ Событие ${this.state.turn}-го хода
        </div>

        <h2 class="font-title text-2xl sm:text-3xl font-extrabold text-white">
          Барабан событий для ${this.escapeHtml(player.name)}
        </h2>

        <!-- Табло слот-машины -->
        <div class="p-7 rounded-2xl bg-[#0b0d13] border-2 ${
          ct.wheelSpun ? 'border-yellow-400 shadow-lg shadow-yellow-400/10' : 'border-[#2a3246]'
        } max-w-md mx-auto space-y-2">
          <div class="text-xs font-semibold text-gray-500 uppercase tracking-widest">
            ${ct.wheelSpun ? 'ВЫПАЛ СЕКТОР:' : 'НАЖМИТЕ КНОПКУ НИЖЕ'}
          </div>
          <div id="wheel-slot-title" class="font-title text-2xl sm:text-3xl font-black text-yellow-400 py-2">
            ${ct.wheelSpun ? ev.title : '???'}
          </div>
          ${
            ct.wheelSpun
              ? `<p class="text-sm text-gray-300 leading-relaxed pt-1">${this.escapeHtml(ev.desc)}</p>`
              : ''
          }
        </div>

        ${
          !ct.wheelSpun
            ? `<button id="btn-spin-wheel" class="tactile-gold-btn px-8 py-4 text-base font-title">
                Крутить барабан!
              </button>`
            : `<button id="btn-wheel-proceed" class="tactile-gold-btn w-full py-4 text-sm font-title">
                Продолжить →
              </button>`
        }
      </div>
    `;
  }

  // Шаг 2: Интерактив выпавшего события
  renderEventActionStep(ct) {
    const player = this.getActivePlayer();
    const others = this.state.players.filter((p) => p.id !== player.id);
    const evId = ct.eventObj?.id;
    const cat = CATEGORIES[ct.question.category] || CATEGORIES.wild_cases;

    if (evId === 'boxes') {
      return `
        <div class="game-stage-card p-6 sm:p-9 space-y-6 text-center stage-enter">
          <div class="inline-block px-3 py-1 rounded-full bg-yellow-400/15 text-yellow-400 text-xs font-bold">
            Три шкатулки
          </div>
          <h2 class="font-title text-2xl font-bold text-white">
            ${this.escapeHtml(player.name)}, выбери одну шкатулку
          </h2>
          <p class="text-sm text-gray-400 max-w-md mx-auto">
            Внутри спрятаны: <strong>+300 очков</strong>, <strong>удвоение вопроса ×2</strong> и <strong>ловушка -100 очков</strong>.
          </p>

          ${
            ct.boxResultMsg
              ? `<div class="p-4 rounded-xl bg-[#0b0d13] border border-yellow-400/50 text-base font-bold text-yellow-300">
                  ${this.escapeHtml(ct.boxResultMsg)}
                </div>
                <div class="grid grid-cols-3 gap-2.5 text-xs">
                  ${ct.boxes
                    .map(
                      (b, i) => `
                    <div class="p-3 rounded-xl border ${
                      ct.pickedBoxIdx === i
                        ? 'bg-yellow-400/15 border-yellow-400 text-white font-bold'
                        : 'bg-[#0b0d13] border-[#2a3246] text-gray-500'
                    }">
                      <div>${b.label}</div>
                      <div class="mt-1">${b.title}</div>
                    </div>
                  `
                    )
                    .join('')}
                </div>
                <button id="btn-proceed-question" class="tactile-gold-btn w-full py-4 text-sm font-title">
                  Перейти к вопросу →
                </button>`
              : `<div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  ${ct.boxes
                    .map(
                      (b, i) => `
                    <button data-pick-box="${i}" class="tactile-option p-6 text-center space-y-2">
                      <i data-lucide="gift" class="w-8 h-8 text-yellow-400 mx-auto"></i>
                      <div class="font-bold text-sm text-white">${b.label}</div>
                    </button>
                  `
                    )
                    .join('')}
                </div>
                <button data-pick-box="-1" class="text-xs text-gray-400 hover:text-white underline">
                  Не рисковать и забрать гарантированные +100 очков
                </button>`
          }
        </div>
      `;
    }

    if (evId === 'auction') {
      return `
        <div class="game-stage-card p-6 sm:p-9 space-y-6 text-center stage-enter">
          <div class="inline-block px-3 py-1 rounded-full bg-emerald-500/15 text-emerald-400 text-xs font-bold">
            Перекуп вслепую
          </div>
          <h2 class="font-title text-2xl font-bold text-white">Тема: «${cat.name}»</h2>
          <p class="text-sm text-gray-400 max-w-md mx-auto">
            Кто из 6 игроков готов забрать этот вопрос вслепую за <strong>двойные очки (+${ct.question.points * 2})</strong> со штрафом при ошибке?
          </p>

          <div class="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            ${this.state.players
              .map(
                (p) => `
              <button data-auction-take="${p.id}" class="tactile-option p-4 font-bold text-sm text-white">
                ${this.escapeHtml(p.name)}
              </button>
            `
              )
              .join('')}
          </div>

          <button data-auction-take="" class="text-xs text-gray-400 hover:text-white underline">
            Никто не перекупает — отвечает ${this.escapeHtml(player.name)} в обычном режиме
          </button>
        </div>
      `;
    }

    if (evId === 'duel') {
      return `
        <div class="game-stage-card p-6 sm:p-9 space-y-6 text-center stage-enter">
          <div class="inline-block px-3 py-1 rounded-full bg-red-500/15 text-red-400 text-xs font-bold">
            Дуэль 1 на 1
          </div>
          <h2 class="font-title text-2xl font-bold text-white">
            ${this.escapeHtml(player.name)}, выбери соперника для дуэли
          </h2>
          <p class="text-sm text-gray-400 max-w-md mx-auto">
            Оба ответите на один вопрос. Победитель забирает <strong>+300 очков</strong> и списывает 100 очков у проигравшего!
          </p>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            ${others
              .map(
                (op) => `
              <button data-duel-target="${op.id}" class="tactile-option p-4 flex items-center justify-between text-white">
                <span class="font-bold text-sm">${this.escapeHtml(op.name)}</span>
                <span class="font-num text-xs text-yellow-400">${op.score} очк.</span>
              </button>
            `
              )
              .join('')}
          </div>
        </div>
      `;
    }

    if (evId === 'dilemma') {
      const partner = this.state.players.find((p) => p.id === ct.dilemmaPartnerId);
      return `
        <div class="game-stage-card p-6 sm:p-9 space-y-6 text-center stage-enter">
          <div class="inline-block px-3 py-1 rounded-full bg-purple-500/15 text-purple-400 text-xs font-bold">
            Сделка или Подстава
          </div>

          ${
            !partner
              ? `
                <h2 class="font-title text-2xl font-bold text-white">${this.escapeHtml(player.name)}, выбери напарника</h2>
                <p class="text-sm text-gray-400 max-w-md mx-auto">
                  Оба выбирают: «Поделить» (+200 обоим) или «Украсть» (+350 себе, -100 напарнику). Если оба нажали «Украсть» — оба теряют по 150!
                </p>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  ${others
                    .map(
                      (op) => `
                    <button data-dilemma-target="${op.id}" class="tactile-option p-4 flex items-center justify-between text-white">
                      <span class="font-bold text-sm">${this.escapeHtml(op.name)}</span>
                      <span class="font-num text-xs text-yellow-400">${op.score} очк.</span>
                    </button>
                  `
                    )
                    .join('')}
                </div>
              `
              : ct.dilemmaResultMsg
              ? `
                <h2 class="font-title text-xl font-bold text-white">Развязка сделки</h2>
                <div class="p-4 rounded-xl bg-[#0b0d13] border border-yellow-400/50 text-base font-bold text-yellow-300">
                  ${this.escapeHtml(ct.dilemmaResultMsg)}
                </div>
                <button id="btn-proceed-question" class="tactile-gold-btn w-full py-4 text-sm font-title">
                  Перейти к вопросу →
                </button>
              `
              : `
                <h2 class="font-title text-xl font-bold text-white">
                  Сейчас выбирает: <span class="text-yellow-400">${this.escapeHtml(
                    !ct.dilemmaFirstChoice ? player.name : partner.name
                  )}</span>
                </h2>
                <p class="text-xs text-gray-400">
                  ${
                    !ct.dilemmaFirstChoice
                      ? 'Ваш выбор скроется сразу после клика.'
                      : `Выбор игрока ${this.escapeHtml(player.name)} засекречен! Слово за ${this.escapeHtml(partner.name)}.`
                  }
                </p>
                <div class="grid grid-cols-2 gap-3 pt-2">
                  <button data-dilemma-act="coop" class="tactile-option p-5 text-center">
                    <div class="font-bold text-base text-emerald-400">Поделить</div>
                    <div class="text-xs text-gray-400 mt-1">+200 обоим</div>
                  </button>
                  <button data-dilemma-act="betray" class="tactile-option p-5 text-center">
                    <div class="font-bold text-base text-red-400">Украсть</div>
                    <div class="text-xs text-gray-400 mt-1">+350 себе, -100 другу</div>
                  </button>
                </div>
              `
          }
        </div>
      `;
    }

    return '';
  }

  // Главная карточка вопроса (поддерживает 4 разных формата: choice, truth, slider, social)
  renderQuestionCard(ct) {
    const q = ct.question;
    const player = this.getActivePlayer();
    const others = this.state.players.filter((p) => p.id !== player.id);
    const cat = CATEGORIES[q.category] || CATEGORIES.wild_cases;
    const isAnswered = ct.step === 'answered';
    const isSocialVerify = ct.step === 'social_verify';
    const isDuel = ct.eventObj?.id === 'duel' && ct.duelOpponentId;
    const duelOpponent = isDuel ? this.state.players.find((p) => p.id === ct.duelOpponentId) : null;
    const pts = Math.round(q.points * ct.multiplier);

    const typeBadges = {
      choice: { label: cat.name, color: 'text-indigo-300 bg-indigo-500/15 border-indigo-500/30' },
      truth: { label: 'Правда или Вымысел', color: 'text-amber-300 bg-amber-500/15 border-amber-500/30' },
      slider: { label: 'Ползунок интуиции', color: 'text-cyan-300 bg-cyan-500/15 border-cyan-500/30' },
      social: { label: `Чтение мыслей · ${q.socialTargetName || 'Коллега'}`, color: 'text-pink-300 bg-pink-500/15 border-pink-500/30' }
    };
    const badge = typeBadges[q.type || 'choice'] || typeBadges.choice;

    return `
      <div class="game-stage-card p-6 sm:p-9 space-y-6 stage-enter">
        <!-- Шапка карточки -->
        <div class="flex flex-wrap items-center justify-between gap-2 pb-4 border-b border-[#2a3246]">
          <div class="space-y-1">
            <span class="inline-block px-2.5 py-0.5 rounded-md border text-[11px] font-bold ${badge.color}">
              ${badge.label}
            </span>
            <div class="text-base font-bold text-white pt-0.5">
              ${
                isSocialVerify
                  ? `Слово за <span class="text-pink-400">${this.escapeHtml(q.socialTargetName)}</span>: какой вариант про тебя правда?`
                  : isDuel
                  ? ct.duelFirstAnswer === null
                    ? `Дуэль (1/2) · Отвечает: <span class="text-yellow-400">${this.escapeHtml(player.name)}</span>`
                    : `Дуэль (2/2) · Отвечает: <span class="text-yellow-400">${this.escapeHtml(duelOpponent?.name || '')}</span>`
                  : `Отвечает: <span class="text-yellow-400">${this.escapeHtml(player.name)}</span>`
              }
            </div>
          </div>

          <div class="flex items-center gap-2">
            ${
              ct.eventObj?.id === 'steal'
                ? `<span class="px-2.5 py-1 rounded-lg bg-orange-500/15 border border-orange-500/30 text-orange-300 text-xs font-bold">Охота на лидера</span>`
                : ''
            }
            <span class="px-3.5 py-1.5 rounded-xl bg-yellow-400/15 border border-yellow-400/30 text-yellow-400 font-num font-bold text-sm">
              +${isDuel ? 300 : q.type === 'slider' ? 350 * ct.multiplier : pts}
            </span>
          </div>
        </div>

        <!-- Сам вопрос -->
        <h2 class="text-xl sm:text-2xl font-bold text-white leading-snug">
          ${this.escapeHtml(q.question)}
        </h2>

        ${
          ct.hintText
            ? `<div class="p-4 rounded-xl bg-[#0b0d13] border border-yellow-400/40 text-sm text-yellow-200">
                <strong>Подсказка:</strong> ${this.escapeHtml(ct.hintText)}
              </div>`
            : ''
        }

        ${
          ct.allyPlayerId
            ? `<div class="p-3.5 rounded-xl bg-[#0b0d13] border border-emerald-500/40 text-xs text-emerald-300">
                Помощь друга: <strong>${this.escapeHtml(
                  this.state.players.find((p) => p.id === ct.allyPlayerId)?.name || ''
                )}</strong> помогает советом в Discord (+150 ему при успехе).
              </div>`
            : ''
        }

        ${
          isSocialVerify
            ? `<div class="p-3.5 rounded-xl bg-pink-500/10 border border-pink-500/30 text-xs text-pink-200">
                Ставка игрока <strong>${this.escapeHtml(player.name)}</strong> принята и засекречена! Теперь <strong>${this.escapeHtml(
                q.socialTargetName
              )}</strong> выбирает свой настоящий ответ:
              </div>`
            : ''
        }

        <!-- КОНТЕНТ В ЗАВИСИМОСТИ ОТ ТИПА КАРТОЧКИ -->
        ${
          q.type === 'slider'
            ? this.renderSliderBody(ct, q, isAnswered)
            : this.renderOptionsBody(ct, q, isAnswered)
        }

        <!-- Выбор цели джокера (если нажали «Помощь друга» или «Передать вопрос») -->
        ${
          ct.selectingTargetFor && !isAnswered
            ? `<div class="p-4 rounded-xl bg-[#0b0d13] border border-yellow-400/50 space-y-2.5 stage-enter">
                <div class="text-xs font-bold text-yellow-400">
                  ${
                    ct.selectingTargetFor === 'ally'
                      ? 'Кого берём в союзники на этот вопрос (+150 очков ему при верном ответе)?'
                      : 'Кому передаём этот вопрос?'
                  }
                </div>
                <div class="flex flex-wrap gap-2">
                  ${others
                    .map(
                      (op) => `
                    <button data-joker-target="${op.id}" class="px-3.5 py-2 rounded-xl bg-[#151923] hover:bg-yellow-400 hover:text-black border border-[#2a3246] text-xs font-bold text-white transition">
                      ${this.escapeHtml(op.name)}
                    </button>
                  `
                    )
                    .join('')}
                </div>
              </div>`
            : ''
        }

        <!-- Нижняя панель: Джокеры ИЛИ Разбор ответа -->
        ${
          !isAnswered && !isSocialVerify && !isDuel
            ? `
              <div class="pt-4 border-t border-[#2a3246] space-y-2">
                <div class="text-[11px] font-semibold text-gray-500">
                  Джокеры игрока ${this.escapeHtml(player.name)}:
                </div>
                <div class="flex flex-wrap gap-2">
                  ${[
                    ...(q.type === 'choice' ? [{ id: 'fifty', label: '50 / 50', disabled: !player.jokers.fifty }] : []),
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
                      class="px-3.5 py-2 rounded-xl text-xs font-bold border transition ${
                        !jk.disabled
                          ? 'bg-[#0b0d13] hover:bg-[#1c2230] border-[#2a3246] hover:border-yellow-400 text-gray-200'
                          : 'bg-[#0b0d13]/40 border-[#2a3246]/30 text-gray-600 line-through cursor-not-allowed'
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
              <div class="pt-4 border-t border-[#2a3246] space-y-4 stage-enter">
                <div class="p-4 rounded-xl bg-[#0b0d13] border ${
                  ct.isWin ? 'border-emerald-500/50' : 'border-red-500/50'
                }">
                  <div class="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                    <span class="font-bold text-sm ${ct.isWin ? 'text-emerald-400' : 'text-red-400'}">
                      ${this.escapeHtml(ct.outcomeTitle)}
                    </span>
                    <span class="font-num text-xs font-bold text-yellow-400">
                      ${this.escapeHtml(ct.outcomeDeltaText)}
                    </span>
                  </div>
                  <p class="text-sm text-gray-300 leading-relaxed">${this.escapeHtml(q.explanation)}</p>
                </div>

                <button id="btn-next-turn" class="tactile-gold-btn w-full py-4 text-sm font-title">
                  Следующий ход →
                </button>
              </div>
            `
            : ''
        }
      </div>
    `;
  }

  renderSliderBody(ct, q, isAnswered) {
    return `
      <div class="p-6 rounded-2xl bg-[#0b0d13] border border-[#2a3246] space-y-5">
        <div class="flex items-baseline justify-between">
          <span class="text-xs font-bold uppercase tracking-wider text-gray-400">Ваш ответ на шкале:</span>
          <div class="font-num text-3xl font-extrabold text-yellow-400">
            <span id="slider-live-val">${ct.sliderValue}</span><span class="text-lg text-gray-400">${q.unit}</span>
          </div>
        </div>

        <input
          id="intuition-slider-input"
          type="range"
          min="${q.min}"
          max="${q.max}"
          step="${q.step}"
          value="${ct.sliderValue}"
          ${isAnswered ? 'disabled' : ''}
          class="intuition-slider"
        />

        <div class="flex justify-between font-num text-xs text-gray-500">
          <span>Мин: ${q.min}${q.unit}</span>
          <span>Точно (±${q.tolerancePerfect}): +350 · Близко (±${q.toleranceGood}): +200</span>
          <span>Макс: ${q.max}${q.unit}</span>
        </div>

        ${
          !isAnswered
            ? `<button id="btn-submit-slider" class="tactile-gold-btn w-full py-3.5 text-sm font-title">
                Зафиксировать ответ
              </button>`
            : ''
        }
      </div>
    `;
  }

  renderOptionsBody(ct, q, isAnswered) {
    const letters = ['A', 'B', 'C', 'D'];
    return `
      <div class="grid grid-cols-1 gap-3">
        ${q.options
          .map((opt, idx) => {
            const isHidden = ct.hiddenOptions.includes(idx);

            let btnClass = 'tactile-option text-white';
            if (isHidden) {
              btnClass = 'opacity-15 pointer-events-none bg-[#0b0d13] border border-[#2a3246] rounded-2xl';
            } else if (isAnswered) {
              if (idx === q.answer) {
                btnClass = 'bg-emerald-500/20 border-2 border-emerald-400 text-white rounded-2xl';
              } else if (idx === ct.selectedOption || idx === ct.duelSecondAnswer) {
                btnClass = 'bg-red-500/20 border-2 border-red-400 text-red-100 rounded-2xl';
              } else {
                btnClass = 'opacity-40 bg-[#0b0d13] border border-[#2a3246] rounded-2xl';
              }
            }

            return `
              <button
                data-answer-idx="${idx}"
                ${isHidden || isAnswered ? 'disabled' : ''}
                class="p-4 text-left flex items-center gap-3.5 ${btnClass}"
              >
                <span class="w-8 h-8 rounded-xl bg-[#0b0d13] border border-[#2a3246] font-num font-bold text-xs flex items-center justify-center shrink-0 ${
                  isAnswered && idx === q.answer ? 'bg-emerald-400 text-black border-emerald-400' : 'text-yellow-400'
                }">
                  ${q.type === 'truth' ? (idx === 0 ? '✓' : '✕') : letters[idx]}
                </span>
                <span class="text-sm sm:text-base font-medium leading-snug">${this.escapeHtml(opt)}</span>
              </button>
            `;
          })
          .join('')}
      </div>
    `;
  }

  renderResults() {
    const sorted = [...this.state.players].sort((a, b) => b.score - a.score);
    return `
      <div class="game-stage-card p-6 sm:p-9 space-y-6 text-center stage-enter">
        <div class="text-xs font-bold uppercase tracking-wider text-yellow-400">Финал игры</div>
        <h2 class="font-title text-3xl font-extrabold text-white">Победитель: ${this.escapeHtml(sorted[0]?.name || '')}</h2>

        <div class="space-y-2.5 text-left">
          ${sorted
            .map(
              (p, i) => `
            <div class="flex items-center justify-between px-4 py-3.5 rounded-xl ${
              i === 0 ? 'bg-yellow-400/15 border-2 border-yellow-400' : 'bg-[#0b0d13] border border-[#2a3246]'
            }">
              <div class="flex items-center gap-3">
                <span class="font-num font-bold text-sm w-6 text-gray-400">#${i + 1}</span>
                <span class="font-bold text-white">${this.escapeHtml(p.name)}</span>
              </div>
              <span class="font-num font-extrabold text-lg text-yellow-400">${p.score} очк.</span>
            </div>
          `
            )
            .join('')}
        </div>

        <button id="btn-restart" class="tactile-gold-btn w-full py-4 text-sm font-title">
          Сыграть ещё партию
        </button>
      </div>
    `;
  }

  renderAiModal() {
    const cfg = aiClient.config;
    return `
      <div id="ai-modal" class="hidden fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
        <div class="game-stage-card max-w-lg w-full p-6 space-y-4 stage-enter">
          <div class="flex items-center justify-between">
            <h3 class="font-title font-bold text-base text-white">Свои вопросы с YandexGPT</h3>
            <button id="btn-close-ai" class="text-gray-400 hover:text-white">
              <i data-lucide="x" class="w-5 h-5"></i>
            </button>
          </div>

          <p class="text-xs text-gray-400 leading-relaxed">
            Ключ хранится только в вашем браузере (никто по ссылке на GitHub его не видит). Для обхода CORS при вызове с GitHub Pages запустите локально <code>node yandex-bridge.mjs</code>.
          </p>

          <div class="space-y-2.5">
            <input id="yc-api-key" type="password" value="${this.escapeHtml(cfg.apiKey)}" placeholder="Yandex Cloud API-Key (AQVN...)" class="w-full rounded-xl bg-[#0b0d13] border border-[#2a3246] px-3.5 py-2.5 text-sm text-white focus:border-yellow-400 focus:outline-none" />
            <input id="yc-folder-id" type="text" value="${this.escapeHtml(cfg.folderId)}" placeholder="Folder ID (b1g...)" class="w-full rounded-xl bg-[#0b0d13] border border-[#2a3246] px-3.5 py-2.5 text-sm text-white focus:border-yellow-400 focus:outline-none" />
          </div>

          <div class="pt-2 border-t border-[#2a3246] space-y-2">
            <label class="text-xs font-semibold text-gray-300">Какую тему добавить в игру (+5 вопросов):</label>
            <div class="flex gap-2">
              <input id="ai-topic-input" type="text" placeholder="Например: мемы, кино, CS2, истории из жизни..." class="flex-1 rounded-xl bg-[#0b0d13] border border-[#2a3246] px-3.5 py-2 text-sm text-white focus:border-yellow-400 focus:outline-none" />
              <button id="btn-gen-ai" class="tactile-gold-btn px-4 py-2 text-xs">
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
      const topic = document.getElementById('ai-topic-input')?.value?.trim() || 'Кино, игры и забавные факты';
      const statusEl = document.getElementById('yc-status-msg');

      aiClient.saveConfig({ apiKey, folderId });
      if (!aiClient.isConfigured()) {
        if (statusEl) statusEl.textContent = 'Сначала укажите API-ключ Yandex Cloud.';
        return;
      }

      try {
        if (statusEl) statusEl.textContent = 'Генерируем 5 вопросов через YandexGPT...';
        const qs = await aiClient.generateCustomQuestions(topic, 5);
        this.state.customQuestions = [...qs, ...this.state.customQuestions];
        this.saveState();
        sfx.play('correct');
        if (statusEl) statusEl.textContent = `Готово! Добавлено ${qs.length} вопросов в колоду.`;
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
        streak: 0,
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

    // Барабан событий
    document.getElementById('btn-spin-wheel')?.addEventListener('click', () => this.spinEventWheel());
    document.getElementById('btn-wheel-proceed')?.addEventListener('click', () => this.proceedFromWheel());

    // Ивенты
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

    // Ползунок интуиции
    const sliderEl = document.getElementById('intuition-slider-input');
    sliderEl?.addEventListener('input', (e) => {
      this.state.currentTurn.sliderValue = Number(e.target.value);
      const valEl = document.getElementById('slider-live-val');
      if (valEl) valEl.textContent = String(this.state.currentTurn.sliderValue);
    });
    document.getElementById('btn-submit-slider')?.addEventListener('click', () => this.submitSliderGuess());

    // Варианты ответа и джокеры
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
  window.partyQuizGame = new PartyQuizGame();
});
