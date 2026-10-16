// SYNC // 50 — Главный движок игры (Studio Broadcast & Tactile Brutalist Edition)
import {
  CATEGORIES,
  JOKERS,
  RANDOM_EVENTS,
  QUIZ_QUESTIONS,
  BLUFF_PROMPTS,
  WAVELENGTH_CARDS,
  CASE_SCENARIOS,
  CASE_MUTATORS
} from '../data/content.js';
import { sfx } from './audio.js';
import { aiClient } from './ai.js';
import { P2PRoomManager } from './p2p.js';

const STATE_STORAGE_KEY = 'sync50_game_state_v2';

const DEFAULT_PLAYERS = [
  { id: 'p1', name: 'Алекс', role: 'dev', score: 0, streak: 0, jokers: ['fifty', 'double', 'ally', 'pass', 'crowd', 'ai_hint'], peerId: null },
  { id: 'p2', name: 'Разработчик 2', role: 'dev', score: 0, streak: 0, jokers: ['fifty', 'double', 'ally', 'pass', 'crowd', 'ai_hint'], peerId: null },
  { id: 'p3', name: 'Разработчик 3', role: 'dev', score: 0, streak: 0, jokers: ['fifty', 'double', 'ally', 'pass', 'crowd', 'ai_hint'], peerId: null },
  { id: 'p4', name: 'Менеджер 1', role: 'mgr', score: 0, streak: 0, jokers: ['fifty', 'double', 'ally', 'pass', 'crowd', 'ai_hint'], peerId: null },
  { id: 'p5', name: 'Менеджер 2', role: 'mgr', score: 0, streak: 0, jokers: ['fifty', 'double', 'ally', 'pass', 'crowd', 'ai_hint'], peerId: null },
  { id: 'p6', name: 'Менеджер 3', role: 'mgr', score: 0, streak: 0, jokers: ['fifty', 'double', 'ally', 'pass', 'crowd', 'ai_hint'], peerId: null }
];

class PartySyncApp {
  constructor() {
    this.isClientController = false;
    this.clientRoomCode = null;
    this.clientSelectedPlayerId = localStorage.getItem('sync50_client_pid') || null;
    this.hostSyncedState = null;

    this.state = this.loadState() || this.createInitialState();
    this.timerInterval = null;
    this.speechRecognition = null;
    this.toastMessage = null;
    this.toastTimeout = null;

    this.p2p = new P2PRoomManager({
      onPlayerJoin: (peerId, profile) => this.handlePeerJoin(peerId, profile),
      onPlayerAction: (peerId, action) => this.handlePeerAction(peerId, action),
      onHostStateUpdate: (remoteState) => this.handleRemoteState(remoteState),
      onStatusChange: (status, info) => this.handleP2PStatus(status, info)
    });

    this.checkUrlForRoom();
    this.render();
  }

  showToast(msg) {
    this.toastMessage = msg;
    if (this.toastTimeout) clearTimeout(this.toastTimeout);
    const toastEl = document.getElementById('studio-toast');
    if (toastEl) {
      toastEl.textContent = msg;
      toastEl.classList.remove('hidden');
    } else {
      this.render();
    }
    this.toastTimeout = setTimeout(() => {
      this.toastMessage = null;
      const el = document.getElementById('studio-toast');
      if (el) el.classList.add('hidden');
    }, 3200);
  }

  // Генерирует детерминированную карту 50 клеток для партии
  buildBoardSchedule(totalTurns, mode) {
    const schedule = [];
    for (let t = 1; t <= totalTurns; t++) {
      if (mode === 'quiz') {
        // Чистые 50 вопросов, где каждый 3-й ход — спец-ивент внутри вопроса
        if (t % 3 === 0) {
          const ev = RANDOM_EVENTS[(Math.floor(t / 3) - 1) % RANDOM_EVENTS.length];
          schedule.push({ turn: t, act: 'quiz', eventId: ev.id, label: ev.title });
        } else {
          schedule.push({ turn: t, act: 'quiz', eventId: null, label: 'ВОПРОС' });
        }
      } else if (mode === 'show') {
        // Большое шоу: 50 клеток с чередованием вопросов, ивентов, блефа, спектра и ИИ-кейсов
        if (t % 10 === 0) {
          schedule.push({ turn: t, act: 'case', eventId: null, label: 'БОСС-КЕЙС' });
        } else if (t % 7 === 0) {
          schedule.push({ turn: t, act: 'wavelength', eventId: null, label: 'СПЕКТР' });
        } else if (t % 5 === 0) {
          schedule.push({ turn: t, act: 'bluff', eventId: null, label: 'БЛЕФ-РАУНД' });
        } else if (t % 3 === 0) {
          const ev = RANDOM_EVENTS[(Math.floor(t / 3) - 1) % RANDOM_EVENTS.length];
          schedule.push({ turn: t, act: 'quiz', eventId: ev.id, label: ev.title });
        } else {
          schedule.push({ turn: t, act: 'quiz', eventId: null, label: 'ВОПРОС' });
        }
      } else {
        schedule.push({ turn: t, act: mode, eventId: null, label: mode.toUpperCase() });
      }
    }
    return schedule;
  }

  createInitialState() {
    const schedule = this.buildBoardSchedule(50, 'quiz');
    return {
      screen: 'lobby', // 'lobby' | 'game' | 'podium'
      gameMode: 'quiz', // 'quiz' (50 вопросов + ивенты) | 'show' (полный микс) | 'bluff' | 'wavelength' | 'case'
      currentAct: 'quiz',
      totalTurnsTarget: 50,
      turnNumber: 1,
      activePlayerIndex: 0,
      boardSchedule: schedule,
      players: JSON.parse(JSON.stringify(DEFAULT_PLAYERS)),
      usedQuestionIds: [],
      usedBluffIds: [],
      usedWavelengthIndices: [],
      usedCaseIds: [],
      customQuestions: [],

      // Состояние текущего хода Квиза (без логических дыр)
      quiz: {
        currentQuestion: null,
        hiddenOptions: [],
        selectedOption: null,
        revealed: false,
        timedOut: false,
        activeMultiplier: 1,
        usedDoubleThisTurn: false,
        usedAnyHintThisTurn: false,
        betsLocked: false, // Блокируется после 50/50, опроса или подсказки
        pendingJokerTargetMode: null, // 'ally' | 'pass' — когда игрок выбирает цель джокера
        allyPlayerId: null,
        passedFromPlayerId: null,
        aiHintText: null,
        crowdVotes: {}, // playerId -> optionIndex
        showCrowdPollPanel: false,
        sideBets: {}, // playerId -> 'pass' | 'fail'
        currentEvent: null,

        // Состояние для Ивента VAULT (3 контейнера)
        vaultBoxes: [], // [{ label: 'ALPHA', type: 'points', val: 350 }, ...]
        vaultPickedIndex: null,
        vaultResolved: false,
        vaultResultText: null,

        // Состояние для Ивента AUCTION (Аукцион вслепую)
        auctionResolved: false,
        auctionHighestBid: 100,
        auctionLeaderId: null,

        // Состояние для Ивента DUEL 1v1
        duelOpponentId: null,
        duelAnswers: {}, // playerId -> optionIndex (скрыто до ответа обоих)
        duelResolved: false,
        duelResultText: null,

        // Состояние для Ивента DILEMMA (Сделка или Кража)
        dilemmaPartnerId: null,
        dilemmaChoices: {}, // playerId -> 'coop' | 'betray' (скрыто до ответа обоих)
        dilemmaResolved: false,
        dilemmaResultText: null,

        // Состояние для Ивента ALL_PLAY (Общий штурм — отвечают все 6)
        allPlayAnswers: {}, // playerId -> optionIndex (скрыто до вскрытия)

        timerSeconds: 45,
        timerMax: 45,
        timerRunning: false
      },

      // Состояние хода «Правдоруб (Блеф)»
      bluff: {
        currentItem: null,
        phase: 'collect', // 'collect' | 'vote' | 'reveal'
        maskInputs: true, // Скрывает вводимый текст точками на общем экране Discord
        submittedBluffs: {}, // playerId -> text
        choices: [], // [{ id, text, authorIds: [], isTruth: false }]
        votes: {}, // playerId -> choiceId (скрыто до reveal)
        resultLog: []
      },

      // Состояние хода «Спектр (На одной волне)»
      wavelength: {
        card: null,
        targetValue: 50,
        peekTarget: false,
        clueText: '',
        teamGuess: 50,
        sideVotes: {}, // playerId -> 'left' | 'right'
        revealed: false,
        resultSummary: null
      },

      // Состояние хода «Кейс-Баттл с ИИ»
      caseBattle: {
        scenario: null,
        mutator: '',
        answerText: '',
        isJudging: false,
        verdictData: null,
        votedPeerIds: [] // Чтобы один и тот же игрок не накручивал лайки бесконечно
      }
    };
  }

  loadState() {
    try {
      const raw = localStorage.getItem(STATE_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.players) && parsed.players.length >= 2 && parsed.boardSchedule) {
          return parsed;
        }
      }
    } catch (e) {}
    return null;
  }

  saveState() {
    if (this.isClientController) return;
    try {
      localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(this.state));
    } catch (e) {}
    this.broadcastToPeers();
  }

  checkUrlForRoom() {
    const params = new URLSearchParams(window.location.search);
    const room = params.get('room');
    if (room && room.trim().length >= 3) {
      this.isClientController = true;
      this.clientRoomCode = room.trim().toUpperCase();
    }
  }

  // --- P2P МУЛЬТИПЛЕЕР ---
  async startHostP2P() {
    sfx.play('click');
    const code = await this.p2p.initHost(this.p2p.roomCode);
    if (code) {
      this.showToast(`Комната ${code} открыта. Ссылка скопирована при клике на код.`);
      this.render();
    }
  }

  handleP2PStatus(status, info) {
    this.p2pStatus = { status, info };
    this.render();
  }

  handlePeerJoin(peerId, profile) {
    sfx.play('joker');
    let targetPlayer = null;
    if (profile.slotId) {
      targetPlayer = this.state.players.find((p) => p.id === profile.slotId);
    }
    if (!targetPlayer && profile.name) {
      targetPlayer = this.state.players.find(
        (p) => p.name.trim().toLowerCase() === profile.name.trim().toLowerCase()
      );
    }
    if (!targetPlayer) {
      targetPlayer = this.state.players.find((p) => !p.peerId);
    }

    if (targetPlayer) {
      targetPlayer.peerId = peerId;
      if (profile.name) targetPlayer.name = profile.name.trim();
      if (profile.role) targetPlayer.role = profile.role;
    } else {
      this.state.players.push({
        id: `p_${Date.now().toString(36)}`,
        name: profile.name || `Игрок ${this.state.players.length + 1}`,
        role: profile.role || 'dev',
        score: 0,
        streak: 0,
        jokers: ['fifty', 'double', 'ally', 'pass', 'crowd', 'ai_hint'],
        peerId
      });
    }
    this.saveState();
    this.render();
  }

  handlePeerAction(peerId, action) {
    const player = this.state.players.find((p) => p.peerId === peerId || p.id === action.playerId);
    if (!player) return;

    const activePlayer = this.getActivePlayer();
    const qState = this.state.quiz;
    const evType = qState.currentEvent?.type;

    if (action.kind === 'QUIZ_ANSWER' && !qState.revealed) {
      if (evType === 'all_play') {
        this.submitAllPlayAnswer(player.id, action.optionIndex);
      } else if (evType === 'duel' && (player.id === activePlayer.id || player.id === qState.duelOpponentId)) {
        this.submitDuelAnswer(player.id, action.optionIndex);
      } else if (activePlayer.id === player.id) {
        this.selectQuizOption(action.optionIndex);
      }
    } else if (action.kind === 'SIDE_BET' && activePlayer.id !== player.id && !qState.revealed && !qState.betsLocked) {
      this.setSideBet(player.id, action.bet);
    } else if (action.kind === 'CROWD_VOTE' && activePlayer.id !== player.id && !qState.revealed) {
      qState.crowdVotes[player.id] = action.optionIndex;
      this.saveState();
      this.render();
    } else if (action.kind === 'DILEMMA_CHOICE' && !qState.dilemmaResolved) {
      if (player.id === activePlayer.id || player.id === qState.dilemmaPartnerId) {
        this.setDilemmaChoice(player.id, action.choice);
      }
    } else if (action.kind === 'SUBMIT_BLUFF' && this.state.bluff.phase === 'collect') {
      this.submitPlayerBluff(player.id, action.text);
    } else if (action.kind === 'VOTE_BLUFF' && this.state.bluff.phase === 'vote') {
      this.voteBluffChoice(player.id, action.choiceId);
    } else if (action.kind === 'WAVELENGTH_SIDE' && !this.state.wavelength.revealed && activePlayer.id !== player.id) {
      this.state.wavelength.sideVotes[player.id] = action.dir;
      this.saveState();
      this.render();
    }
  }

  broadcastToPeers() {
    if (!this.p2p || !this.p2p.roomCode) return;
    const activePlayer = this.getActivePlayer();
    const qState = this.state.quiz;
    const hideQuestionForAuction = qState.currentEvent?.type === 'auction' && !qState.auctionResolved;

    this.p2p.broadcastState({
      screen: this.state.screen,
      currentAct: this.state.currentAct,
      turnNumber: this.state.turnNumber,
      activePlayerId: activePlayer?.id,
      players: this.state.players.map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        score: p.score,
        jokers: p.jokers,
        peerId: p.peerId
      })),
      quiz: qState.currentQuestion
        ? {
            question: hideQuestionForAuction ? 'АУКЦИОН ВСЛЕПУЮ: Торги за вопрос идут на главном экране' : qState.currentQuestion.question,
            options: hideQuestionForAuction ? [] : qState.currentQuestion.options,
            hiddenOptions: qState.hiddenOptions,
            revealed: qState.revealed,
            betsLocked: qState.betsLocked,
            sideBets: qState.sideBets,
            showCrowdPollPanel: qState.showCrowdPollPanel,
            eventType: qState.currentEvent?.type || null,
            duelOpponentId: qState.duelOpponentId,
            dilemmaPartnerId: qState.dilemmaPartnerId
          }
        : null,
      bluff: this.state.bluff.currentItem
        ? {
            prompt: this.state.bluff.currentItem.prompt,
            phase: this.state.bluff.phase,
            choices: this.state.bluff.choices.map((c) => ({ id: c.id, text: c.text, authorIds: c.authorIds })),
            submittedIds: Object.keys(this.state.bluff.submittedBluffs),
            votedIds: Object.keys(this.state.bluff.votes)
          }
        : null,
      wavelength: this.state.wavelength.card
        ? {
            left: this.state.wavelength.card.left,
            right: this.state.wavelength.card.right,
            targetValue: this.state.wavelength.targetValue,
            teamGuess: this.state.wavelength.teamGuess,
            revealed: this.state.wavelength.revealed,
            sideVotes: this.state.wavelength.sideVotes
          }
        : null
    });
  }

  handleRemoteState(remoteState) {
    this.hostSyncedState = remoteState;
    this.render();
  }

  // --- БАЗОВЫЕ МЕТОДЫ ПАРТИИ ---
  getActivePlayer() {
    return this.state.players[this.state.activePlayerIndex] || this.state.players[0];
  }

  getTeamScores() {
    const devScore = this.state.players
      .filter((p) => p.role === 'dev')
      .reduce((acc, p) => acc + p.score, 0);
    const mgrScore = this.state.players
      .filter((p) => p.role === 'mgr')
      .reduce((acc, p) => acc + p.score, 0);
    return { devScore, mgrScore };
  }

  adjustScore(playerId, delta) {
    const p = this.state.players.find((pl) => pl.id === playerId);
    if (p) {
      p.score += delta;
      sfx.play('click');
      this.saveState();
      this.render();
    }
  }

  startNewGame() {
    sfx.play('fanfare');
    this.state.screen = 'game';
    this.state.turnNumber = 1;
    this.state.activePlayerIndex = 0;
    this.state.boardSchedule = this.buildBoardSchedule(this.state.totalTurnsTarget, this.state.gameMode);
    this.state.players.forEach((p) => {
      p.score = 0;
      p.streak = 0;
      p.jokers = ['fifty', 'double', 'ally', 'pass', 'crowd', 'ai_hint'];
    });
    this.prepareTurnFromSchedule();
  }

  switchActManual(newAct) {
    sfx.play('click');
    this.state.currentAct = newAct;
    this.prepareTurn(newAct, null);
  }

  nextTurn() {
    sfx.play('click');
    this.stopTimer();

    if (this.state.turnNumber >= this.state.totalTurnsTarget) {
      this.finishGame();
      return;
    }

    this.state.turnNumber += 1;
    this.state.activePlayerIndex = (this.state.activePlayerIndex + 1) % this.state.players.length;
    this.prepareTurnFromSchedule();
  }

  prepareTurnFromSchedule() {
    const cell = this.state.boardSchedule[this.state.turnNumber - 1] || {
      turn: this.state.turnNumber,
      act: this.state.gameMode === 'show' ? 'quiz' : this.state.gameMode,
      eventId: null
    };
    this.state.currentAct = cell.act;
    const forcedEvent = cell.eventId ? RANDOM_EVENTS.find((e) => e.id === cell.eventId) || null : null;
    this.prepareTurn(cell.act, forcedEvent);
  }

  prepareTurn(act, eventObj = null) {
    this.stopTimer();

    if (act === 'quiz') {
      const pool = [...this.state.customQuestions, ...QUIZ_QUESTIONS];
      let available = pool.filter((q) => !this.state.usedQuestionIds.includes(q.id));
      if (available.length === 0) {
        this.state.usedQuestionIds = [];
        available = pool;
      }
      const picked = available[Math.floor(Math.random() * available.length)];
      this.state.usedQuestionIds.push(picked.id);

      if (eventObj) sfx.play('event');

      // Подготовка 3 сейфов для ивента VAULT
      const vaultOutcomes = [
        { type: 'points', val: 350, title: '+350 ОЧКОВ' },
        { type: 'mult', val: 2, title: 'МНОЖИТЕЛЬ ×2' },
        { type: 'trap', val: -100, title: 'ЛОВУШКА -100' }
      ].sort(() => Math.random() - 0.5);

      const vaultBoxes = ['ALPHA', 'BETA', 'GAMMA'].map((label, i) => ({
        label,
        ...vaultOutcomes[i]
      }));

      const tMax = eventObj?.type === 'blitz' ? 15 : 45;

      this.state.quiz = {
        currentQuestion: picked,
        hiddenOptions: [],
        selectedOption: null,
        revealed: false,
        timedOut: false,
        activeMultiplier: eventObj?.type === 'steal_leader' ? 1.5 : 1,
        usedDoubleThisTurn: false,
        usedAnyHintThisTurn: false,
        betsLocked: false,
        pendingJokerTargetMode: null,
        allyPlayerId: null,
        passedFromPlayerId: null,
        aiHintText: null,
        crowdVotes: {},
        showCrowdPollPanel: false,
        sideBets: {},
        currentEvent: eventObj,

        vaultBoxes,
        vaultPickedIndex: null,
        vaultResolved: false,
        vaultResultText: null,

        auctionResolved: false,
        auctionHighestBid: 150,
        auctionLeaderId: this.getActivePlayer().id,

        duelOpponentId: null,
        duelAnswers: {},
        duelResolved: false,
        duelResultText: null,

        dilemmaPartnerId: null,
        dilemmaChoices: {},
        dilemmaResolved: false,
        dilemmaResultText: null,

        allPlayAnswers: {},

        timerSeconds: tMax,
        timerMax: tMax,
        timerRunning: false
      };

      // Если выпал Турбо-Блиц (15 сек) — автоматически запускаем таймер!
      if (eventObj?.type === 'blitz') {
        this.startTimer();
      }
    } else if (act === 'bluff') {
      let available = BLUFF_PROMPTS.filter((b) => !this.state.usedBluffIds.includes(b.id));
      if (available.length === 0) {
        this.state.usedBluffIds = [];
        available = BLUFF_PROMPTS;
      }
      const picked = available[Math.floor(Math.random() * available.length)];
      this.state.usedBluffIds.push(picked.id);

      this.state.bluff = {
        currentItem: picked,
        phase: 'collect',
        maskInputs: true,
        submittedBluffs: {},
        choices: [],
        votes: {},
        resultLog: []
      };
    } else if (act === 'wavelength') {
      let availIdx = WAVELENGTH_CARDS.map((_, i) => i).filter(
        (i) => !this.state.usedWavelengthIndices.includes(i)
      );
      if (availIdx.length === 0) {
        this.state.usedWavelengthIndices = [];
        availIdx = WAVELENGTH_CARDS.map((_, i) => i);
      }
      const idx = availIdx[Math.floor(Math.random() * availIdx.length)];
      this.state.usedWavelengthIndices.push(idx);

      this.state.wavelength = {
        card: WAVELENGTH_CARDS[idx],
        targetValue: Math.floor(Math.random() * 84) + 8,
        peekTarget: false,
        clueText: '',
        teamGuess: 50,
        sideVotes: {},
        revealed: false,
        resultSummary: null
      };
    } else if (act === 'case') {
      let available = CASE_SCENARIOS.filter((c) => !this.state.usedCaseIds.includes(c.id));
      if (available.length === 0) {
        this.state.usedCaseIds = [];
        available = CASE_SCENARIOS;
      }
      const picked = available[Math.floor(Math.random() * available.length)];
      this.state.usedCaseIds.push(picked.id);
      const mutator = CASE_MUTATORS[Math.floor(Math.random() * CASE_MUTATORS.length)];

      this.state.caseBattle = {
        scenario: picked,
        mutator,
        answerText: '',
        isJudging: false,
        verdictData: null,
        votedPeerIds: []
      };
    }

    this.saveState();
    this.render();
  }

  // --- ЖЕЛЕЗОБЕТОННАЯ ЛОГИКА КВИЗА, ДЖОКЕРОВ И ИВЕНТОВ ---
  triggerManualEvent(eventId = null) {
    sfx.play('event');
    const ev = eventId
      ? RANDOM_EVENTS.find((e) => e.id === eventId)
      : RANDOM_EVENTS[Math.floor(Math.random() * RANDOM_EVENTS.length)];
    if (!ev) return;

    this.prepareTurn('quiz', ev);
  }

  setSideBet(playerId, betType) {
    const qState = this.state.quiz;
    if (qState.revealed || qState.betsLocked) {
      this.showToast('Приём ставок зала уже закрыт (была использована подсказка или дан ответ).');
      return;
    }
    sfx.play('click');
    if (qState.sideBets[playerId] === betType) {
      delete qState.sideBets[playerId];
    } else {
      qState.sideBets[playerId] = betType;
    }
    this.saveState();
    this.render();
  }

  // Инициация Джокера (с проверкой условий и выбором цели для ALLY / PASS)
  async initiateJoker(jokerId) {
    const player = this.getActivePlayer();
    const qState = this.state.quiz;
    const q = qState.currentQuestion;
    if (!player || !q || qState.revealed) return;
    if (!player.jokers.includes(jokerId)) return;

    // Блокируем джокеры во время нерешённого аукциона
    if (qState.currentEvent?.type === 'auction' && !qState.auctionResolved) {
      this.showToast('Сначала завершите торги аукциона!');
      return;
    }

    if (jokerId === 'double') {
      if (qState.usedAnyHintThisTurn) {
        this.showToast('Нельзя включить Ва-Банк ×2 после использования подсказок!');
        return;
      }
      sfx.play('joker');
      player.jokers = player.jokers.filter((j) => j !== 'double');
      qState.activeMultiplier *= 2;
      qState.usedDoubleThisTurn = true;
      this.saveState();
      this.render();
      return;
    }

    if (jokerId === 'ally' || jokerId === 'pass') {
      sfx.play('click');
      qState.pendingJokerTargetMode = qState.pendingJokerTargetMode === jokerId ? null : jokerId;
      this.render();
      return;
    }

    if (jokerId === 'fifty') {
      sfx.play('joker');
      player.jokers = player.jokers.filter((j) => j !== 'fifty');
      qState.usedAnyHintThisTurn = true;
      qState.betsLocked = true; // Закрываем новые ставки зрителей
      const wrongIndices = [0, 1, 2, 3].filter((i) => i !== q.answer);
      wrongIndices.sort(() => Math.random() - 0.5);
      qState.hiddenOptions = wrongIndices.slice(0, 2);
      this.saveState();
      this.render();
      return;
    }

    if (jokerId === 'crowd') {
      sfx.play('joker');
      player.jokers = player.jokers.filter((j) => j !== 'crowd');
      qState.usedAnyHintThisTurn = true;
      qState.betsLocked = true;
      qState.showCrowdPollPanel = true;
      this.saveState();
      this.render();
      return;
    }

    if (jokerId === 'ai_hint') {
      sfx.play('joker');
      player.jokers = player.jokers.filter((j) => j !== 'ai_hint');
      qState.usedAnyHintThisTurn = true;
      qState.betsLocked = true;
      qState.aiHintText = 'Запрос к Оракулу...';
      this.render();
      const hint = await aiClient.generateHint(q);
      qState.aiHintText = hint;
      this.saveState();
      this.render();
    }
  }

  confirmJokerTarget(targetPlayerId) {
    const player = this.getActivePlayer();
    const qState = this.state.quiz;
    const mode = qState.pendingJokerTargetMode;
    if (!mode || !targetPlayerId) return;

    const targetPlayer = this.state.players.find((p) => p.id === targetPlayerId);
    if (!targetPlayer || targetPlayer.id === player.id) return;

    sfx.play('joker');
    player.jokers = player.jokers.filter((j) => j !== mode);
    qState.pendingJokerTargetMode = null;
    qState.usedAnyHintThisTurn = true;
    qState.betsLocked = true;

    if (mode === 'ally') {
      qState.allyPlayerId = targetPlayer.id;
      qState.timerSeconds += 20;
      qState.timerMax = Math.max(qState.timerMax, qState.timerSeconds);
      this.showToast(`${targetPlayer.name} призван в Консилиум (+20с к таймеру)!`);
    } else if (mode === 'pass') {
      qState.passedFromPlayerId = player.id;
      const newIdx = this.state.players.findIndex((p) => p.id === targetPlayer.id);
      if (newIdx !== -1) {
        this.state.activePlayerIndex = newIdx;
        // Удаляем ставку нового отвечающего из пула зрителей, чтобы он не ставил сам на себя
        delete qState.sideBets[targetPlayer.id];
        qState.timerSeconds = 30;
        qState.timerMax = 30;
        this.showToast(`Вопрос принудительно передан игроку ${targetPlayer.name}!`);
      }
    }

    this.saveState();
    this.render();
  }

  // --- ЛОГИКА СПЕЦ-ИВЕНТОВ В КВИЗЕ ---
  // 1. Сейфы (VAULT)
  pickVaultBox(boxIndex) {
    const qState = this.state.quiz;
    if (qState.vaultResolved) return;
    const activePlayer = this.getActivePlayer();

    qState.vaultResolved = true;
    qState.vaultPickedIndex = boxIndex;

    if (boxIndex === -1) {
      activePlayer.score += 100;
      sfx.play('correct');
      qState.vaultResultText = `${activePlayer.name} отказался от риска и забрал гарантированные +100 очков.`;
    } else {
      const box = qState.vaultBoxes[boxIndex];
      if (box.type === 'points') {
        activePlayer.score += box.val;
        sfx.play('correct');
        qState.vaultResultText = `Сейф ${box.label}: внутри оказалось +${box.val} очков для ${activePlayer.name}!`;
      } else if (box.type === 'mult') {
        qState.activeMultiplier *= box.val;
        sfx.play('joker');
        qState.vaultResultText = `Сейф ${box.label}: активирован множитель ×2 на текущий вопрос!`;
      } else {
        activePlayer.score += box.val;
        sfx.play('wrong');
        qState.vaultResultText = `Сейф ${box.label}: сработала ловушка (${box.val} очков)!`;
      }
    }
    this.saveState();
    this.render();
  }

  // 2. Аукцион вслепую (AUCTION)
  placeAuctionBid(playerId, amount) {
    const qState = this.state.quiz;
    if (qState.auctionResolved) return;
    sfx.play('click');
    qState.auctionLeaderId = playerId;
    qState.auctionHighestBid = amount;
    this.saveState();
    this.render();
  }

  lockAuctionWinner() {
    const qState = this.state.quiz;
    if (qState.auctionResolved) return;
    sfx.play('reveal');
    qState.auctionResolved = true;
    const winnerIdx = this.state.players.findIndex((p) => p.id === qState.auctionLeaderId);
    if (winnerIdx !== -1) {
      this.state.activePlayerIndex = winnerIdx;
      delete qState.sideBets[qState.auctionLeaderId];
    }
    this.saveState();
    this.render();
  }

  // 3. Дуэль 1 на 1 (DUEL)
  selectDuelOpponent(opponentId) {
    const qState = this.state.quiz;
    if (qState.duelOpponentId) return;
    sfx.play('event');
    qState.duelOpponentId = opponentId;
    delete qState.sideBets[opponentId];
    this.saveState();
    this.render();
  }

  submitDuelAnswer(playerId, optionIndex) {
    const qState = this.state.quiz;
    if (qState.revealed) return;
    sfx.play('click');
    qState.duelAnswers[playerId] = optionIndex;

    const activePlayer = this.getActivePlayer();
    const oppId = qState.duelOpponentId;

    // Если оба дуэлянта зафиксировали выбор — сразу вскрываем результат!
    if (
      oppId &&
      typeof qState.duelAnswers[activePlayer.id] === 'number' &&
      typeof qState.duelAnswers[oppId] === 'number'
    ) {
      this.resolveDuelOutcome();
    } else {
      this.saveState();
      this.render();
    }
  }

  resolveDuelOutcome() {
    this.stopTimer();
    const qState = this.state.quiz;
    const q = qState.currentQuestion;
    const p1 = this.getActivePlayer();
    const p2 = this.state.players.find((p) => p.id === qState.duelOpponentId);
    if (!p1 || !p2) return;

    const a1 = qState.duelAnswers[p1.id];
    const a2 = qState.duelAnswers[p2.id];
    const p1Right = a1 === q.answer;
    const p2Right = a2 === q.answer;

    qState.revealed = true;
    qState.duelResolved = true;
    qState.selectedOption = a1;

    if (p1Right && p2Right) {
      p1.score += 300;
      p2.score += 300;
      sfx.play('correct');
      qState.duelResultText = `Оба дуэлянта (${p1.name} и ${p2.name}) ответили верно и получают по +300 очков!`;
    } else if (p1Right && !p2Right) {
      p1.score += 400;
      p2.score -= 100;
      sfx.play('fanfare');
      qState.duelResultText = `Чистая победа ${p1.name}! Он получает +300 за вопрос и забирает 100 очков у ${p2.name}!`;
    } else if (!p1Right && p2Right) {
      p2.score += 400;
      p1.score -= 100;
      sfx.play('fanfare');
      qState.duelResultText = `Перехват! ${p2.name} выигрывает дуэль (+300 за вопрос и +100 со счёта ${p1.name})!`;
    } else {
      sfx.play('wrong');
      qState.duelResultText = `Оба дуэлянта промахнулись! Очки остаются на месте.`;
    }

    this.resolveSideBets(p1Right);
    this.saveState();
    this.render();
  }

  // 4. Дилемма узника (DILEMMA) — с выбором партнёра и маскировкой до ответа обоих
  selectDilemmaPartner(partnerId) {
    const qState = this.state.quiz;
    if (qState.dilemmaPartnerId) return;
    sfx.play('click');
    qState.dilemmaPartnerId = partnerId;
    this.saveState();
    this.render();
  }

  setDilemmaChoice(playerId, choice) {
    const qState = this.state.quiz;
    if (qState.dilemmaResolved) return;
    sfx.play('click');
    qState.dilemmaChoices[playerId] = choice;

    const activePlayer = this.getActivePlayer();
    const partnerId = qState.dilemmaPartnerId;

    if (partnerId && qState.dilemmaChoices[activePlayer.id] && qState.dilemmaChoices[partnerId]) {
      const c1 = qState.dilemmaChoices[activePlayer.id];
      const c2 = qState.dilemmaChoices[partnerId];
      const partner = this.state.players.find((p) => p.id === partnerId);
      qState.dilemmaResolved = true;

      if (c1 === 'coop' && c2 === 'coop') {
        activePlayer.score += 200;
        if (partner) partner.score += 200;
        sfx.play('correct');
        qState.dilemmaResultText = `СДЕЛКА СОСТОЯЛАСЬ: ${activePlayer.name} и ${partner?.name} получают по +200 очков.`;
      } else if (c1 === 'betray' && c2 === 'coop') {
        activePlayer.score += 350;
        if (partner) partner.score -= 100;
        sfx.play('joker');
        qState.dilemmaResultText = `ПЕРЕХВАТ БАНКА: ${activePlayer.name} выбрал КРАЖУ (+350), а ${partner?.name} доверился (-100).`;
      } else if (c1 === 'coop' && c2 === 'betray') {
        activePlayer.score -= 100;
        if (partner) partner.score += 350;
        sfx.play('joker');
        qState.dilemmaResultText = `ПЕРЕХВАТ БАНКА: ${partner?.name} выбрал КРАЖУ (+350), а ${activePlayer.name} доверился (-100).`;
      } else {
        activePlayer.score -= 150;
        if (partner) partner.score -= 150;
        sfx.play('wrong');
        qState.dilemmaResultText = `ВЗАИМНЫЙ САБОТАЖ: Оба нажали КРАЖА — банк сгорел, оба теряют по -150 очков.`;
      }
    }
    this.saveState();
    this.render();
  }

  // 5. Общий штурм (ALL_PLAY) — отвечают все 6 игроков вслепую
  submitAllPlayAnswer(playerId, optionIndex) {
    const qState = this.state.quiz;
    if (qState.revealed) return;
    sfx.play('click');
    qState.allPlayAnswers[playerId] = optionIndex;
    this.saveState();
    this.render();
  }

  revealAllPlayOutcome() {
    this.stopTimer();
    const qState = this.state.quiz;
    const q = qState.currentQuestion;
    qState.revealed = true;
    qState.selectedOption = q.answer;

    let winnersCount = 0;
    this.state.players.forEach((p) => {
      if (qState.allPlayAnswers[p.id] === q.answer) {
        p.score += 250;
        winnersCount++;
      }
    });

    sfx.play(winnersCount > 0 ? 'correct' : 'wrong');
    if (winnersCount > 0 && window.confetti) {
      window.confetti({ particleCount: 50, spread: 65, origin: { y: 0.7 } });
    }
    this.saveState();
    this.render();
  }

  // Стандартный ответ на вопрос (или после Аукциона / Блица / Экспроприации)
  selectQuizOption(index) {
    const qState = this.state.quiz;
    if (qState.revealed) return;

    // Если активен Аукцион и ещё не закрыты торги — блокируем
    if (qState.currentEvent?.type === 'auction' && !qState.auctionResolved) {
      this.showToast('Сначала зафиксируйте победителя аукциона!');
      return;
    }

    this.stopTimer();

    const q = qState.currentQuestion;
    const activePlayer = this.getActivePlayer();
    const isCorrect = index === q.answer;

    qState.selectedOption = index;
    qState.revealed = true;

    const isAuction = qState.currentEvent?.type === 'auction';
    let rewardPoints = isAuction
      ? qState.auctionHighestBid * qState.activeMultiplier
      : Math.round(q.points * qState.activeMultiplier);

    if (qState.currentEvent?.type === 'blitz' && isCorrect) {
      rewardPoints += qState.currentEvent.bonus || 250;
    }

    if (isCorrect) {
      sfx.play('correct');
      activePlayer.score += rewardPoints;
      activePlayer.streak = (activePlayer.streak || 0) + 1;

      if (activePlayer.streak >= 3) {
        activePlayer.score += 100;
      }

      if (qState.allyPlayerId) {
        const ally = this.state.players.find((p) => p.id === qState.allyPlayerId);
        if (ally) ally.score += 150;
      }

      if (qState.currentEvent?.type === 'steal_leader') {
        const sorted = [...this.state.players].sort((a, b) => b.score - a.score);
        const leader = sorted[0];
        if (leader && leader.id !== activePlayer.id) {
          leader.score -= 150;
          activePlayer.score += 150;
        }
      }

      if (window.confetti) {
        window.confetti({ particleCount: 55, spread: 60, origin: { y: 0.7 } });
      }
    } else {
      sfx.play('wrong');
      activePlayer.streak = 0;

      if (isAuction) {
        activePlayer.score -= qState.auctionHighestBid;
      } else if (qState.usedDoubleThisTurn) {
        // Честный штраф -50% от базовой стоимости вопроса при промахе на Ва-Банке
        activePlayer.score -= Math.round(q.points / 2);
      } else if (qState.passedFromPlayerId) {
        // Штраф за промах по переведённому вопросу
        activePlayer.score -= 100;
      }
    }

    this.resolveSideBets(isCorrect);
    this.saveState();
    this.render();
  }

  handleQuizTimeout() {
    const qState = this.state.quiz;
    if (qState.revealed) return;
    this.stopTimer();
    sfx.play('wrong');

    const q = qState.currentQuestion;
    const activePlayer = this.getActivePlayer();

    qState.timedOut = true;
    qState.revealed = true;
    qState.selectedOption = -1;
    activePlayer.streak = 0;

    if (qState.currentEvent?.type === 'auction' && qState.auctionResolved) {
      activePlayer.score -= qState.auctionHighestBid;
    } else if (qState.usedDoubleThisTurn && q) {
      activePlayer.score -= Math.round(q.points / 2);
    } else if (qState.passedFromPlayerId) {
      activePlayer.score -= 100;
    }

    this.resolveSideBets(false);
    this.showToast(`ВРЕМЯ ВЫШЛО! Игрок ${activePlayer.name} не успел дать ответ.`);
    this.saveState();
    this.render();
  }

  resolveSideBets(isCorrect) {
    const qState = this.state.quiz;
    for (const [pid, bet] of Object.entries(qState.sideBets)) {
      const voter = this.state.players.find((p) => p.id === pid);
      if (!voter) continue;
      if ((bet === 'pass' && isCorrect) || (bet === 'fail' && !isCorrect)) {
        voter.score += 100;
      } else {
        voter.score -= 50;
      }
    }
  }

  // --- ЛОГИКА РЕЖИМА 2: ПРАВДОРУБ (БЛЕФ БЕЗ СПОЙЛЕРОВ) ---
  submitPlayerBluff(playerId, text) {
    if (!text || !text.trim()) return;
    sfx.play('click');
    this.state.bluff.submittedBluffs[playerId] = text.trim();
    this.saveState();
    this.render();
  }

  startBluffVoting(useQuickDecoys = false) {
    sfx.play('reveal');
    const item = this.state.bluff.currentItem;
    const choices = [];

    choices.push({
      id: 'truth',
      text: item.truth,
      authorIds: [],
      isTruth: true
    });

    for (const [pid, text] of Object.entries(this.state.bluff.submittedBluffs)) {
      const clean = text.trim();
      if (!clean) continue;
      if (clean.toLowerCase() === item.truth.toLowerCase()) {
        // Если кто-то случайно вписал точную правду — начисляем ему бонус +300 сразу!
        const p = this.state.players.find((pl) => pl.id === pid);
        if (p) p.score += 300;
        continue;
      }
      const existing = choices.find((c) => c.text.toLowerCase() === clean.toLowerCase());
      if (existing) {
        existing.authorIds.push(pid);
      } else {
        choices.push({
          id: `bluff_${pid}`,
          text: clean,
          authorIds: [pid],
          isTruth: false
        });
      }
    }

    const minChoices = useQuickDecoys ? 5 : Math.max(4, choices.length + 1);
    for (const decoy of item.decoyBluffs) {
      if (choices.length >= minChoices) break;
      if (!choices.some((c) => c.text.toLowerCase() === decoy.toLowerCase())) {
        choices.push({
          id: `decoy_${choices.length}`,
          text: decoy,
          authorIds: [],
          isTruth: false
        });
      }
    }

    choices.sort(() => Math.random() - 0.5);
    this.state.bluff.choices = choices;
    this.state.bluff.phase = 'vote';
    this.saveState();
    this.render();
  }

  voteBluffChoice(playerId, choiceId) {
    const chosen = this.state.bluff.choices.find((c) => c.id === choiceId);
    if (!chosen) return;

    // Запрет голосовать за свой собственный блеф!
    if (chosen.authorIds.includes(playerId)) {
      this.showToast('Нельзя голосовать за собственный блеф — выберите другой вариант!');
      return;
    }

    sfx.play('click');
    this.state.bluff.votes[playerId] = choiceId;
    this.saveState();
    this.render();
  }

  revealBluffResults() {
    sfx.play('fanfare');
    this.state.bluff.phase = 'reveal';
    const logs = [];

    for (const [voterId, choiceId] of Object.entries(this.state.bluff.votes)) {
      const voter = this.state.players.find((p) => p.id === voterId);
      const chosen = this.state.bluff.choices.find((c) => c.id === choiceId);
      if (!voter || !chosen) continue;

      if (chosen.isTruth) {
        voter.score += 400;
        logs.push(`${voter.name} вычислил настоящую правду (+400)`);
      } else if (chosen.authorIds.length > 0) {
        chosen.authorIds.forEach((authorId) => {
          if (authorId !== voterId) {
            const author = this.state.players.find((p) => p.id === authorId);
            if (author) {
              author.score += 300;
              logs.push(`${voter.name} попался на ложь игрока ${author.name} (+300 для ${author.name})`);
            }
          }
        });
      } else {
        logs.push(`${voter.name} попался на ловушку системы`);
      }
    }

    this.state.bluff.resultLog = logs;
    if (window.confetti) {
      window.confetti({ particleCount: 50, spread: 70, origin: { y: 0.65 } });
    }
    this.saveState();
    this.render();
  }

  // --- ЛОГИКА РЕЖИМА 3: СПЕКТР (WAVELENGTH БЕЗ СПОЙЛЕРОВ НА СТРИМЕ) ---
  copyWavelengthTargetToClipboard() {
    const w = this.state.wavelength;
    const activePlayer = this.getActivePlayer();
    const secretMsg = `[SYNC // 50] Секретная мишень для ${activePlayer.name}: ${w.targetValue}% (Шкала: 0% «${w.card.left}» — 100% «${w.card.right}»)`;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(secretMsg);
      sfx.play('joker');
      this.showToast(`Секретная мишень скопирована в буфер (на экране НЕ показана)! Отправьте Ctrl+V игроку ${activePlayer.name} в личку Discord.`);
    }
  }

  revealWavelength() {
    const w = this.state.wavelength;
    if (w.revealed) return;
    w.revealed = true;

    const diff = Math.abs(w.targetValue - w.teamGuess);
    const activePlayer = this.getActivePlayer();

    let telepathPts = 0;
    let teamPts = 0;
    let zoneName = 'Мимо цели';

    if (diff <= 4) {
      telepathPts = 400;
      teamPts = 200;
      zoneName = 'ТОЧНО В ЯБЛОЧКО (±4%)';
    } else if (diff <= 10) {
      telepathPts = 300;
      teamPts = 150;
      zoneName = 'БЛИЖНЯЯ ЗОНА (±10%)';
    } else if (diff <= 18) {
      telepathPts = 150;
      teamPts = 100;
      zoneName = 'СРЕДНЯЯ ЗОНА (±18%)';
    }

    if (telepathPts > 0) {
      sfx.play('correct');
      activePlayer.score += telepathPts;
      this.state.players
        .filter((p) => p.id !== activePlayer.id)
        .forEach((p) => {
          p.score += teamPts;
        });
      if (window.confetti && telepathPts >= 300) {
        window.confetti({ particleCount: 60, spread: 70, origin: { y: 0.6 } });
      }
    } else {
      sfx.play('wrong');
    }

    // Бонус за ставку ЛЕВЕЕ / ПРАВЕЕ (если не попали идеально в яблочко ±2%)
    let sideWinners = [];
    if (diff > 2) {
      const actualDir = w.targetValue < w.teamGuess ? 'left' : 'right';
      for (const [pid, guessedDir] of Object.entries(w.sideVotes)) {
        if (guessedDir === actualDir) {
          const p = this.state.players.find((pl) => pl.id === pid);
          if (p) {
            p.score += 150;
            sideWinners.push(p.name);
          }
        }
      }
    }

    w.resultSummary = {
      diff,
      zoneName,
      telepathPts,
      teamPts,
      sideWinners
    };

    this.saveState();
    this.render();
  }

  // --- ЛОГИКА РЕЖИМА 4: КЕЙС-БАТТЛ С ИИ ---
  rerollMutator() {
    sfx.play('click');
    this.state.caseBattle.mutator = CASE_MUTATORS[Math.floor(Math.random() * CASE_MUTATORS.length)];
    this.saveState();
    this.render();
  }

  toggleVoiceDictation() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      this.showToast('Голосовой ввод Web Speech API поддерживается в Chrome / Edge.');
      return;
    }

    if (this.speechRecognition) {
      this.speechRecognition.stop();
      this.speechRecognition = null;
      this.render();
      return;
    }

    const rec = new SpeechRec();
    rec.lang = 'ru-RU';
    rec.continuous = true;
    rec.interimResults = false;

    rec.onresult = (event) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          transcript += event.results[i][0].transcript + ' ';
        }
      }
      this.state.caseBattle.answerText = (this.state.caseBattle.answerText + ' ' + transcript).trim();
      const textarea = document.getElementById('case-answer-input');
      if (textarea) textarea.value = this.state.caseBattle.answerText;
    };

    rec.onend = () => {
      this.speechRecognition = null;
      this.render();
    };

    this.speechRecognition = rec;
    rec.start();
    this.render();
  }

  async judgeCurrentCase() {
    const textInput = document.getElementById('case-answer-input');
    if (textInput) {
      this.state.caseBattle.answerText = textInput.value.trim();
    }
    if (!this.state.caseBattle.answerText) {
      this.state.caseBattle.answerText = 'Устный ответ озвучен в голосовом канале Discord.';
    }

    this.state.caseBattle.isJudging = true;
    this.render();

    const activePlayer = this.getActivePlayer();
    const roleLabel = activePlayer.role === 'dev' ? 'Программист' : 'Менеджер';
    const res = await aiClient.judgeCaseAnswer(
      this.state.caseBattle.scenario,
      this.state.caseBattle.mutator,
      activePlayer.name,
      roleLabel,
      this.state.caseBattle.answerText
    );

    this.state.caseBattle.isJudging = false;
    this.state.caseBattle.verdictData = res;
    activePlayer.score += Number(res.score) || 300;
    sfx.play('fanfare');
    if (window.confetti) {
      window.confetti({ particleCount: 55, spread: 65, origin: { y: 0.65 } });
    }
    this.saveState();
    this.render();
  }

  toggleCasePeerVote(voterId) {
    const cb = this.state.caseBattle;
    const activePlayer = this.getActivePlayer();
    if (voterId === activePlayer.id) return;

    sfx.play('click');
    if (cb.votedPeerIds.includes(voterId)) {
      cb.votedPeerIds = cb.votedPeerIds.filter((id) => id !== voterId);
      activePlayer.score -= 50;
    } else {
      cb.votedPeerIds.push(voterId);
      activePlayer.score += 50;
    }
    this.saveState();
    this.render();
  }

  // --- ТАЙМЕР С РЕАЛЬНЫМ ИСТЕЧЕНИЕМ ВРЕМЕНИ ---
  startTimer() {
    this.stopTimer();
    this.state.quiz.timerRunning = true;
    this.timerInterval = setInterval(() => {
      if (this.state.quiz.timerSeconds > 1) {
        this.state.quiz.timerSeconds -= 1;
        sfx.play(this.state.quiz.timerSeconds <= 5 ? 'urgent_tick' : 'tick');
        const timerEl = document.getElementById('quiz-timer-val');
        const barEl = document.getElementById('quiz-timer-bar');
        if (timerEl) timerEl.textContent = `${String(this.state.quiz.timerSeconds).padStart(2, '0')}s`;
        if (barEl) {
          const pct = Math.max(0, (this.state.quiz.timerSeconds / (this.state.quiz.timerMax || 45)) * 100);
          barEl.style.width = `${pct}%`;
        }
      } else {
        this.state.quiz.timerSeconds = 0;
        this.handleQuizTimeout();
      }
    }, 1000);
  }

  toggleTimer() {
    if (this.state.quiz.timerRunning) {
      this.stopTimer();
      this.render();
    } else {
      this.startTimer();
      this.render();
    }
  }

  stopTimer() {
    this.state.quiz.timerRunning = false;
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  finishGame() {
    this.stopTimer();
    sfx.play('fanfare');
    this.state.screen = 'podium';
    if (window.confetti) {
      window.confetti({ particleCount: 120, spread: 100, origin: { y: 0.5 } });
    }
    this.saveState();
    this.render();
  }

  // --- НАСТРОЙКИ YANDEX CLOUD AI ---
  openAiModal() {
    document.getElementById('ai-modal')?.classList.remove('hidden');
  }

  closeAiModal() {
    document.getElementById('ai-modal')?.classList.add('hidden');
  }

  async saveAndTestAiConfig() {
    const apiKey = document.getElementById('yc-api-key')?.value || '';
    const folderId = document.getElementById('yc-folder-id')?.value || '';
    const model = document.getElementById('yc-model')?.value || 'yandexgpt/latest';
    const customEndpoint = document.getElementById('yc-custom-ep')?.value || '';

    aiClient.saveConfig({ apiKey, folderId, model, customEndpoint });
    const statusEl = document.getElementById('yc-status-msg');
    if (statusEl) {
      statusEl.innerHTML = `<span class="text-zinc-300 font-mono-code">Проверка соединения с YandexGPT...</span>`;
    }

    if (!apiKey.trim()) {
      if (statusEl) statusEl.innerHTML = `<span class="text-amber-400">Ключ очищен. Используется встроенная база (150+ карточек).</span>`;
      this.render();
      return;
    }

    try {
      const reply = await aiClient.complete('Ответь одним коротким предложением.', 'Проверка связи со студией.', 0.5);
      if (statusEl) {
        statusEl.innerHTML = `<span class="text-emerald-400 font-mono-code">СОЕДИНЕНИЕ УСТАНОВЛЕНО: «${this.escapeHtml(reply)}»</span>`;
      }
      sfx.play('correct');
    } catch (err) {
      if (statusEl) {
        statusEl.innerHTML = `<span class="text-amber-400">Ключ сохранён в localStorage, но прямой браузерный запрос заблокирован CORS (${this.escapeHtml(
          err.message
        )}). Запустите в терминале: <code>node yandex-bridge.mjs</code></span>`;
      }
    }
  }

  async generateAiPackFromModal() {
    const topicInput = document.getElementById('ai-topic-input');
    const topic = topicInput?.value?.trim() || 'Технологии, игры, кино и переговоры';
    const statusEl = document.getElementById('yc-status-msg');

    if (!aiClient.isConfigured()) {
      if (statusEl) statusEl.innerHTML = `<span class="text-rose-400">Сначала укажите API-ключ Yandex Cloud выше.</span>`;
      return;
    }

    try {
      if (statusEl) statusEl.innerHTML = `<span class="text-zinc-300 font-mono-code">Генерация 5 вопросов по теме «${this.escapeHtml(topic)}»...</span>`;
      const newQuestions = await aiClient.generateCustomQuestions(topic, 5);
      if (newQuestions.length > 0) {
        this.state.customQuestions = [...newQuestions, ...this.state.customQuestions];
        this.saveState();
        sfx.play('fanfare');
        if (statusEl) {
          statusEl.innerHTML = `<span class="text-emerald-400 font-mono-code">ГОТОВО: +${newQuestions.length} новых вопросов добавлены в начало очереди!</span>`;
        }
      }
    } catch (err) {
      if (statusEl) {
        statusEl.innerHTML = `<span class="text-rose-400">Ошибка: ${this.escapeHtml(err.message)}</span>`;
      }
    }
  }

  // --- РЕНДЕРИНГ STUDIO BROADCAST UI ---
  render() {
    const root = document.getElementById('app-root');
    if (!root) return;

    if (this.isClientController) {
      root.innerHTML = this.renderClientControllerView();
      this.bindClientEvents();
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    root.innerHTML = `
      <div class="min-h-screen flex flex-col">
        ${this.renderHeader()}
        <div id="studio-toast" class="${
          this.toastMessage ? '' : 'hidden'
        } fixed bottom-5 right-5 z-50 bg-[#facc15] text-black font-mono-code font-bold text-xs px-4 py-3 border-2 border-black shadow-[4px_4px_0px_#000]">
          ${this.escapeHtml(this.toastMessage || '')}
        </div>
        <main class="flex-1 max-w-[1360px] w-full mx-auto px-4 sm:px-6 py-6">
          ${
            this.state.screen === 'lobby'
              ? this.renderLobby()
              : this.state.screen === 'podium'
              ? this.renderPodium()
              : this.renderGameScreen()
          }
        </main>
        ${this.renderAiSettingsModal()}
      </div>
    `;

    this.bindHostEvents();
    if (window.lucide) window.lucide.createIcons();
  }

  renderHeader() {
    const { devScore, mgrScore } = this.getTeamScores();
    const aiReady = aiClient.isConfigured();
    const roomUrl = this.p2p.roomCode
      ? `${window.location.origin}${window.location.pathname}?room=${this.p2p.roomCode}`
      : '';

    return `
      <header class="border-b border-zinc-800 bg-[#09090b] sticky top-0 z-30">
        <div class="max-w-[1360px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <button id="btn-home-logo" class="flex items-center gap-3 text-left group">
            <div class="px-2.5 py-1.5 bg-[#facc15] text-black font-display font-black text-sm tracking-tight border border-black shadow-[2px_2px_0px_#fff]">
              SYNC // 50
            </div>
            <div class="hidden sm:block">
              <div class="font-mono-code font-bold text-xs text-zinc-200 tracking-wider uppercase">
                BROADCAST GAME DECK
              </div>
              <div class="text-[11px] text-zinc-500 font-mono-code">3 DEV vs 3 MGR • DISCORD EDITION</div>
            </div>
          </button>

          <!-- Командный счёт -->
          <div class="hidden md:flex items-center border border-zinc-800 bg-[#121215] divide-x divide-zinc-800 font-mono-code text-xs">
            <div class="px-3.5 py-1.5 flex items-center gap-2">
              <span class="w-2 h-2 bg-blue-500"></span>
              <span class="text-zinc-400">DEV TEAM:</span>
              <strong class="text-white text-sm">${devScore}</strong>
            </div>
            <div class="px-3.5 py-1.5 flex items-center gap-2">
              <span class="w-2 h-2 bg-rose-500"></span>
              <span class="text-zinc-400">MGR TEAM:</span>
              <strong class="text-white text-sm">${mgrScore}</strong>
            </div>
          </div>

          <div class="flex items-center gap-2">
            ${
              this.p2p.roomCode
                ? `<button id="btn-copy-room" data-url="${roomUrl}" class="btn-tactile px-3 py-1.5 bg-emerald-950/80 border-emerald-500/60 text-emerald-300 text-xs font-mono-code flex items-center gap-2">
                    <span class="w-2 h-2 bg-emerald-400"></span>
                    ROOM: <strong>${this.p2p.roomCode}</strong> [${this.p2p.connections.size}]
                    <i data-lucide="copy" class="w-3.5 h-3.5"></i>
                  </button>`
                : `<button id="btn-start-p2p" class="btn-tactile px-3 py-1.5 bg-[#18181c] hover:bg-zinc-800 text-zinc-200 text-xs font-mono-code flex items-center gap-1.5">
                    <i data-lucide="radio" class="w-3.5 h-3.5 text-[#facc15]"></i>
                    <span class="hidden sm:inline">P2P ПУЛЬТЫ</span>
                  </button>`
            }

            <button id="btn-open-ai" class="btn-tactile px-3 py-1.5 ${
              aiReady ? 'bg-blue-950/80 border-blue-500/60 text-blue-200' : 'bg-[#18181c] text-zinc-300'
            } text-xs font-mono-code flex items-center gap-1.5">
              <i data-lucide="terminal" class="w-3.5 h-3.5 ${aiReady ? 'text-blue-400' : 'text-zinc-400'}"></i>
              <span class="hidden sm:inline">${aiReady ? 'YANDEX GPT: ON' : 'YANDEX API'}</span>
            </button>

            <button id="btn-toggle-sound" class="btn-tactile p-2 bg-[#18181c] hover:bg-zinc-800 text-zinc-300" title="Звук">
              <i data-lucide="${sfx.muted ? 'volume-x' : 'volume-2'}" class="w-4 h-4"></i>
            </button>
          </div>
        </div>
      </header>
    `;
  }

  renderLobby() {
    const modes = [
      {
        id: 'quiz',
        code: 'MODE 01 // TACTICAL 50',
        title: '50 Вопросов: Тактический Режим',
        badge: 'ОСНОВНОЙ РЕЖИМ',
        desc: 'Поочерёдная игра на 50 ходов с полным набором рабочих механик: рынок ставок зала (Prediction Pool), 6 тактических джокеров с выбором цели и 7 интерактивных спец-событий (Аукцион вслепую, Дуэль 1v1, Дилемма узника, Три сейфа, Общий штурм).'
      },
      {
        id: 'show',
        code: 'MODE 02 // BROADCAST MIX',
        title: 'Комбинированный Марафон (Все 4 формата на одной доске)',
        badge: 'МИКС',
        desc: 'На треке из 50 ходов автоматически чередуются: тактические вопросы, раунды «Правдоруб» (блеф), «Спектр» (Wavelength) и «Кейс-Баттл» с ИИ-судьёй.'
      },
      {
        id: 'bluff',
        code: 'MODE 03 // BLUFF CLUB',
        title: 'Правдоруб (Блеф-раунды)',
        badge: 'FIBBAGE',
        desc: 'Реальные исторические и техно-факты с пропуском. Ввод блефов защищён маскировкой от подсматривания на стриме в Discord (+400 за правду, +300 за каждого пойманного коллегу).'
      },
      {
        id: 'wavelength',
        code: 'MODE 04 // SPECTRUM',
        title: 'Спектр (На одной волне)',
        badge: 'КОМАНДНЫЙ',
        desc: 'Телепат получает секретную координату в буфер обмена (без засвета на экране стрима) и даёт ассоциацию между двумя полюсами. Команда настраивает ползунок.'
      },
      {
        id: 'case',
        code: 'MODE 05 // AI ARBITER',
        title: 'Кейс-Баттл (Кризис + Мутатор)',
        badge: 'YANDEX GPT',
        desc: 'Рабочие и жизненные катастрофы с обязательным секретным условием. Голосовой ввод речи и вердикт от нейросети + голосование зала.'
      }
    ];

    return `
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start reveal-stage">
        <!-- Левая панель: Ростер из 6 игроков -->
        <div class="lg:col-span-5 studio-panel p-6">
          <div class="flex items-center justify-between pb-4 mb-4 border-b border-zinc-800">
            <div>
              <div class="font-mono-code text-[11px] text-[#facc15] uppercase tracking-wider">ROSTER // 6 PLAYERS</div>
              <h2 class="font-display font-bold text-lg text-white mt-0.5">Состав участников</h2>
            </div>
            <button id="btn-add-player" class="btn-tactile px-3 py-1.5 bg-[#18181c] hover:bg-zinc-800 text-xs font-mono-code text-zinc-200 flex items-center gap-1.5">
              <i data-lucide="plus" class="w-3.5 h-3.5"></i> СЛОТ
            </button>
          </div>

          <div class="space-y-2">
            ${this.state.players
              .map(
                (p, idx) => `
              <div class="flex items-center gap-2.5 p-2.5 bg-[#18181c] border border-zinc-800">
                <span class="w-6 text-center font-mono-code text-xs text-zinc-500 font-bold">0${idx + 1}</span>
                <input
                  type="text"
                  data-player-name="${p.id}"
                  value="${this.escapeHtml(p.name)}"
                  class="flex-1 bg-transparent border-b border-transparent focus:border-[#facc15] focus:outline-none text-sm font-semibold text-white py-0.5"
                  placeholder="Имя игрока"
                />
                <button
                  data-toggle-role="${p.id}"
                  class="px-2.5 py-1 font-mono-code text-[11px] font-bold border transition ${
                    p.role === 'dev'
                      ? 'bg-blue-950/70 border-blue-500/50 text-blue-300'
                      : 'bg-rose-950/70 border-rose-500/50 text-rose-300'
                  }"
                  title="Переключить роль DEV / MGR"
                >
                  ${p.role === 'dev' ? 'DEV' : 'MGR'}
                </button>
                ${
                  this.state.players.length > 2
                    ? `<button data-remove-player="${p.id}" class="p-1 text-zinc-600 hover:text-rose-400 transition">
                        <i data-lucide="x" class="w-4 h-4"></i>
                      </button>`
                    : ''
                }
              </div>
            `
              )
              .join('')}
          </div>

          <div class="mt-5 pt-4 border-t border-zinc-800 flex items-center justify-between text-xs font-mono-code text-zinc-400">
            <span>ДИСТАНЦИЯ МАТЧА:</span>
            <div class="flex items-center gap-1.5">
              ${[18, 30, 50]
                .map(
                  (num) => `
                <button data-set-turns="${num}" class="px-3 py-1 font-bold border transition ${
                    this.state.totalTurnsTarget === num
                      ? 'bg-[#facc15] text-black border-black'
                      : 'bg-[#18181c] text-zinc-400 border-zinc-800 hover:border-zinc-600'
                  }">${num} ХОДОВ</button>
              `
                )
                .join('')}
            </div>
          </div>
        </div>

        <!-- Правая панель: Режимы игры -->
        <div class="lg:col-span-7 studio-panel p-6">
          <div class="pb-4 mb-4 border-b border-zinc-800">
            <div class="font-mono-code text-[11px] text-[#facc15] uppercase tracking-wider">SELECT FORMAT</div>
            <h2 class="font-display font-bold text-lg text-white mt-0.5">Конфигурация стола</h2>
          </div>

          <div class="space-y-2.5">
            ${modes
              .map((m) => {
                const active = this.state.gameMode === m.id;
                return `
                <div
                  data-select-mode="${m.id}"
                  class="cursor-pointer p-4 border transition ${
                    active
                      ? 'bg-[#18181c] border-2 border-[#facc15] shadow-[4px_4px_0px_#facc15]'
                      : 'bg-[#121215] border-zinc-800 hover:border-zinc-600'
                  }"
                >
                  <div class="flex items-center justify-between gap-2">
                    <span class="font-mono-code text-[11px] ${active ? 'text-[#facc15]' : 'text-zinc-500'} font-bold">${m.code}</span>
                    <span class="font-mono-code text-[10px] px-2 py-0.5 border ${
                      active ? 'bg-[#facc15] text-black border-black font-bold' : 'bg-zinc-900 text-zinc-400 border-zinc-800'
                    }">${m.badge}</span>
                  </div>
                  <div class="font-display font-bold text-base text-white mt-1">${m.title}</div>
                  <p class="text-xs text-zinc-400 mt-1 leading-relaxed">${m.desc}</p>
                </div>
              `;
              })
              .join('')}
          </div>

          <div class="mt-6 flex flex-wrap items-center gap-3">
            <button id="btn-start-game" class="btn-tactile flex-1 py-3.5 px-6 bg-[#facc15] hover:bg-yellow-300 text-black font-display font-extrabold text-sm uppercase tracking-wider flex items-center justify-center gap-2">
              НАЧАТЬ НОВУЮ ПАРТИЮ
              <i data-lucide="arrow-right" class="w-4 h-4"></i>
            </button>

            ${
              this.state.turnNumber > 1
                ? `<button id="btn-resume-game" class="btn-tactile py-3.5 px-5 bg-[#18181c] hover:bg-zinc-800 text-white font-mono-code font-bold text-xs flex items-center gap-2">
                    ПРОДОЛЖИТЬ [ХОД ${this.state.turnNumber}/${this.state.totalTurnsTarget}]
                  </button>`
                : ''
            }
          </div>
        </div>
      </div>
    `;
  }

  renderBoardTrack() {
    const schedule = this.state.boardSchedule || [];
    const currentTurn = this.state.turnNumber;
    const startIdx = Math.max(0, currentTurn - 2);
    const slice = schedule.slice(startIdx, startIdx + 7);

    return `
      <div class="studio-panel p-3 flex flex-wrap items-center justify-between gap-3">
        <!-- Лента клеток 50 ходов -->
        <div class="flex items-center gap-1.5 overflow-x-auto py-0.5">
          ${slice
            .map((cell) => {
              const isCurrent = cell.turn === currentTurn;
              const isPast = cell.turn < currentTurn;
              const isSpecial = Boolean(cell.eventId || cell.act !== 'quiz');
              return `
                <div class="px-2.5 py-1 border font-mono-code text-[11px] flex items-center gap-1.5 shrink-0 ${
                  isCurrent
                    ? 'bg-[#facc15] text-black border-black font-extrabold'
                    : isPast
                    ? 'bg-zinc-950 text-zinc-600 border-zinc-900 line-through'
                    : isSpecial
                    ? 'bg-zinc-900 text-amber-300 border-amber-500/40'
                    : 'bg-[#18181c] text-zinc-400 border-zinc-800'
                }">
                  <span>#${String(cell.turn).padStart(2, '0')}</span>
                  <span>${cell.label}</span>
                </div>
              `;
            })
            .join('')}
        </div>

        <!-- Быстрое переключение режима хода и управление -->
        <div class="flex items-center gap-1.5 ml-auto">
          ${[
            { id: 'quiz', label: 'ВОПРОС' },
            { id: 'bluff', label: 'БЛЕФ' },
            { id: 'wavelength', label: 'СПЕКТР' },
            { id: 'case', label: 'ИИ-КЕЙС' }
          ]
            .map(
              (tab) => `
            <button
              data-switch-act="${tab.id}"
              class="px-2.5 py-1 font-mono-code text-[11px] font-bold border transition ${
                this.state.currentAct === tab.id
                  ? 'bg-white text-black border-white'
                  : 'bg-[#18181c] text-zinc-400 border-zinc-800 hover:text-white'
              }"
            >${tab.label}</button>
          `
            )
            .join('')}
          <button id="btn-to-lobby" class="px-2.5 py-1 bg-[#18181c] border border-zinc-800 hover:border-zinc-600 font-mono-code text-[11px] text-zinc-400 hover:text-white">
            ЛОББИ
          </button>
          <button id="btn-end-game" class="px-2.5 py-1 bg-zinc-900 border border-zinc-700 hover:border-[#facc15] font-mono-code text-[11px] text-[#facc15]">
            ФИНАЛ
          </button>
        </div>
      </div>
    `;
  }

  renderGameScreen() {
    return `
      <div class="space-y-5">
        <!-- Табло 6 игроков -->
        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
          ${this.state.players
            .map((p, idx) => {
              const isTurn = idx === this.state.activePlayerIndex;
              return `
                <div
                  data-make-active="${idx}"
                  class="cursor-pointer p-3 transition relative ${
                    isTurn ? 'player-slot-active' : 'studio-card hover:border-zinc-600'
                  }"
                  title="Кликните, чтобы передать ход этому игроку"
                >
                  <div class="flex items-center justify-between gap-1">
                    <span class="font-mono-code text-[10px] px-1.5 py-0.5 font-bold ${
                      p.role === 'dev' ? 'bg-blue-950 text-blue-300 border border-blue-500/40' : 'bg-rose-950 text-rose-300 border border-rose-500/40'
                    }">
                      ${p.role === 'dev' ? 'DEV' : 'MGR'}
                    </span>
                    <span class="font-mono-code text-[10px] ${isTurn ? 'text-[#facc15] font-bold' : 'text-zinc-500'}">
                      ${isTurn ? 'АКТИВНЫЙ ХОД' : `СЛОТ 0${idx + 1}`}
                    </span>
                  </div>

                  <div class="font-bold text-sm text-white truncate mt-2">${this.escapeHtml(p.name)}</div>

                  <div class="mt-2 pt-2 border-t border-zinc-800/80 flex items-baseline justify-between">
                    <div class="font-mono-code font-extrabold text-xl ${
                      p.score > 0 ? 'text-emerald-400' : p.score < 0 ? 'text-rose-400' : 'text-zinc-200'
                    }">${p.score}</div>
                    <div class="flex items-center gap-1">
                      <button data-score-minus="${p.id}" class="w-5 h-5 bg-zinc-900 hover:bg-rose-950 border border-zinc-700 text-zinc-400 hover:text-white font-mono-code text-xs flex items-center justify-center" title="-50">-</button>
                      <button data-score-plus="${p.id}" class="w-5 h-5 bg-zinc-900 hover:bg-emerald-950 border border-zinc-700 text-zinc-400 hover:text-white font-mono-code text-xs flex items-center justify-center" title="+50">+</button>
                    </div>
                  </div>

                  <div class="mt-1.5 flex items-center justify-between font-mono-code text-[10px] text-zinc-500">
                    <span>ДЖОКЕРЫ: ${p.jokers.length}/6</span>
                    ${p.streak >= 2 ? `<span class="text-[#facc15]">СТРИК ×${p.streak}</span>` : ''}
                  </div>
                </div>
              `;
            })
            .join('')}
        </div>

        ${this.renderBoardTrack()}

        ${
          this.state.currentAct === 'quiz'
            ? this.renderQuizAct()
            : this.state.currentAct === 'bluff'
            ? this.renderBluffAct()
            : this.state.currentAct === 'wavelength'
            ? this.renderWavelengthAct()
            : this.renderCaseAct()
        }
      </div>
    `;
  }

  // --- РЕНДЕР РЕЖИМА 1: КВИЗ 2.0 С ПОЛНОЙ ЛОГИКОЙ ---
  renderQuizAct() {
    const qState = this.state.quiz;
    const q = qState.currentQuestion;
    if (!q) return '';

    const activePlayer = this.getActivePlayer();
    const cat = CATEGORIES[q.category] || CATEGORIES.weird_world;
    const ev = qState.currentEvent;

    // Если активен Аукцион и торги ещё не закрыты — скрываем вопрос и варианты!
    const hideForAuction = ev?.type === 'auction' && !qState.auctionResolved;
    // Если активна Дуэль и ещё не выбран соперник — сначала просим выбрать соперника!
    const waitForDuelOpponent = ev?.type === 'duel' && !qState.duelOpponentId;
    // Если Общий Штурм — отвечают все 6 игроков в спец-блоке
    const isAllPlay = ev?.type === 'all_play';
    const isDuelActive = ev?.type === 'duel' && qState.duelOpponentId;

    const effectivePoints =
      ev?.type === 'auction' && qState.auctionResolved
        ? qState.auctionHighestBid * qState.activeMultiplier
        : Math.round(q.points * qState.activeMultiplier);

    const timerPct = Math.max(0, (qState.timerSeconds / (qState.timerMax || 45)) * 100);

    return `
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start reveal-stage">
        <!-- Левая колонка: Сцена вопроса и спец-ивента (8 колонок) -->
        <div class="lg:col-span-8 space-y-4">
          ${ev ? this.renderEventPanel(ev) : ''}

          <div class="studio-panel p-6 sm:p-8 relative">
            <!-- Полоска таймера сверху карточки -->
            <div class="w-full h-1.5 bg-zinc-900 mb-6 overflow-hidden">
              <div id="quiz-timer-bar" class="h-full bg-[#facc15] transition-all duration-300" style="width: ${timerPct}%"></div>
            </div>

            <!-- Мета-шапка вопроса -->
            <div class="flex flex-wrap items-center justify-between gap-3 mb-6">
              <div class="flex items-center gap-2.5">
                <span class="w-8 h-8 bg-[#facc15] text-black font-mono-code font-extrabold text-xs flex items-center justify-center">
                  ${String(this.state.turnNumber).padStart(2, '0')}
                </span>
                <span class="h-2 w-8 accent-bar-grow" style="background: ${cat.color}"></span>
                <span class="font-mono-code text-xs font-bold uppercase tracking-wider text-zinc-300">
                  ${cat.name}
                </span>
                <span class="px-2.5 py-0.5 bg-zinc-900 border border-zinc-700 font-mono-code text-xs font-bold text-[#facc15]">
                  +${effectivePoints} PTS
                </span>
                ${
                  qState.usedDoubleThisTurn
                    ? `<span class="px-2 py-0.5 bg-rose-950 border border-rose-500 text-rose-300 font-mono-code text-[11px] font-bold">ВА-БАНК ×2 (ШТРАФ -${Math.round(
                        q.points / 2
                      )})</span>`
                    : ''
                }
              </div>

              <!-- Управление ивентом и таймером -->
              <div class="flex items-center gap-2">
                <select id="select-manual-event" class="bg-[#18181c] border border-zinc-700 text-zinc-300 font-mono-code text-xs px-2.5 py-1.5 focus:outline-none focus:border-[#facc15]">
                  <option value="">+ СПЕЦ-СОБЫТИЕ НА ХОД...</option>
                  ${RANDOM_EVENTS.map(
                    (e) => `<option value="${e.id}" ${ev?.id === e.id ? 'selected' : ''}>${e.title}</option>`
                  ).join('')}
                </select>

                <button id="btn-quiz-timer" class="btn-tactile px-3 py-1.5 font-mono-code text-xs font-bold flex items-center gap-1.5 ${
                  qState.timerRunning
                    ? 'bg-rose-600 text-white border-rose-400'
                    : 'bg-[#18181c] text-zinc-200'
                }">
                  <i data-lucide="${qState.timerRunning ? 'pause' : 'play'}" class="w-3.5 h-3.5"></i>
                  <span id="quiz-timer-val">${String(qState.timerSeconds).padStart(2, '0')}s</span>
                </button>
              </div>
            </div>

            ${
              hideForAuction
                ? `<div class="p-8 border-2 border-dashed border-zinc-700 bg-zinc-950/60 text-center space-y-2 my-4">
                    <div class="font-mono-code text-xs text-[#facc15] uppercase">ВОПРОС ЗАСЕКРЕЧЕН ДО ОКОНЧАНИЯ ТОРГОВ</div>
                    <div class="font-display font-bold text-lg text-white">Категория лота: ${cat.name}</div>
                    <p class="text-xs text-zinc-400">Сделайте ставки в блоке аукциона выше и нажмите «ОТКРЫТЬ ВОПРОС ПОБЕДИТЕЛЮ».</p>
                  </div>`
                : waitForDuelOpponent
                ? `<div class="p-8 border-2 border-dashed border-zinc-700 bg-zinc-950/60 text-center space-y-2 my-4">
                    <div class="font-mono-code text-xs text-[#facc15] uppercase">ОЖИДАНИЕ ВЫБОРА СОПЕРНИКА ДЛЯ ДУЭЛИ</div>
                    <p class="text-xs text-zinc-400">Выберите оппонента в панели дуэли выше, чтобы открыть вопрос.</p>
                  </div>`
                : `
                  <!-- Текст вопроса -->
                  <h3 class="font-display font-bold text-xl sm:text-2xl text-white leading-snug mb-6">
                    ${this.escapeHtml(q.question)}
                  </h3>

                  ${
                    qState.aiHintText
                      ? `<div class="mb-5 p-4 bg-zinc-900 border-l-4 border-[#facc15] text-xs text-zinc-200 font-mono-code">
                          <strong class="text-[#facc15]">НАВОДКА ОРАКУЛА:</strong> ${this.escapeHtml(qState.aiHintText)}
                        </div>`
                      : ''
                  }

                  ${
                    qState.allyPlayerId
                      ? `<div class="mb-5 p-3 bg-emerald-950/50 border border-emerald-500/50 text-xs font-mono-code text-emerald-300">
                          КОНСИЛИУМ АКТИВЕН: Союзник <strong>${this.escapeHtml(
                            this.state.players.find((p) => p.id === qState.allyPlayerId)?.name || ''
                          )}</strong> помогает советом (+150 очков при успехе).
                        </div>`
                      : ''
                  }

                  <!-- Панель опроса Discord (если нажат джокер Опрос Discord) -->
                  ${qState.showCrowdPollPanel && !qState.revealed ? this.renderCrowdPollInteractive() : ''}

                  <!-- Панель выбора для ОБЩЕГО ШТУРМА (отвечают все 6) или ДУЭЛИ 1v1 -->
                  ${isAllPlay && !qState.revealed ? this.renderAllPlayInteractive() : ''}
                  ${isDuelActive && !qState.revealed ? this.renderDuelInteractive() : ''}

                  <!-- Карточки вариантов A, B, C, D -->
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    ${q.options
                      .map((opt, idx) => {
                        const letters = ['A', 'B', 'C', 'D'];
                        const isHidden = qState.hiddenOptions.includes(idx);
                        const isRevealed = qState.revealed;
                        const isCorrect = idx === q.answer;
                        const isSelected = idx === qState.selectedOption;

                        let styleClass = 'studio-card-interactive text-zinc-100';
                        if (isHidden) {
                          styleClass = 'opacity-15 pointer-events-none bg-zinc-950 border border-zinc-900';
                        } else if (isRevealed) {
                          if (isCorrect) {
                            styleClass = 'bg-emerald-950/90 border-2 border-emerald-400 text-white shadow-[4px_4px_0px_#10b981]';
                          } else if (isSelected && !isCorrect) {
                            styleClass = 'bg-rose-950/90 border-2 border-rose-500 text-rose-100';
                          } else {
                            styleClass = 'opacity-45 bg-zinc-950 border border-zinc-800';
                          }
                        }

                        // Голоса из опроса зала
                        const pollVoters = Object.entries(qState.crowdVotes)
                          .filter(([, vIdx]) => vIdx === idx)
                          .map(([pid]) => this.state.players.find((p) => p.id === pid)?.name)
                          .filter(Boolean);

                        // Для дуэли или общего штурма блокируем прямой клик по карточке до вскрытия, чтобы не спалить ответ
                        const disableDirectClick = isHidden || isRevealed || isAllPlay || isDuelActive;

                        return `
                          <button
                            data-quiz-option="${idx}"
                            ${disableDirectClick ? 'disabled' : ''}
                            class="p-4 text-left flex items-start gap-3.5 ${styleClass}"
                          >
                            <span class="w-8 h-8 bg-zinc-900 border border-zinc-700 font-mono-code font-extrabold text-xs flex items-center justify-center shrink-0 ${
                              isRevealed && isCorrect ? 'bg-emerald-400 text-black border-black' : 'text-[#facc15]'
                            }">
                              ${letters[idx]}
                            </span>
                            <div class="flex-1">
                              <div class="font-medium text-sm sm:text-base leading-snug">${this.escapeHtml(opt)}</div>
                              ${
                                pollVoters.length > 0
                                  ? `<div class="mt-2 font-mono-code text-[11px] text-blue-400">ГОЛОС ЗАЛА: ${pollVoters.join(', ')}</div>`
                                  : ''
                              }
                            </div>
                          </button>
                        `;
                      })
                      .join('')}
                  </div>
                `
            }

            <!-- Разбор ответа и переход хода -->
            ${
              qState.revealed
                ? `<div class="mt-6 p-5 bg-zinc-900 border-2 ${
                    qState.selectedOption === q.answer ? 'border-emerald-500' : 'border-rose-500'
                  } reveal-stage">
                    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div class="space-y-1">
                        <div class="font-mono-code text-xs font-extrabold uppercase ${
                          qState.timedOut
                            ? 'text-rose-400'
                            : qState.selectedOption === q.answer
                            ? 'text-emerald-400'
                            : 'text-rose-400'
                        }">
                          ${
                            qState.timedOut
                              ? 'ВРЕМЯ ИСТЕКЛО (ПРОМАХ)'
                              : qState.duelResultText
                              ? qState.duelResultText
                              : qState.selectedOption === q.answer
                              ? 'ТОЧНОЕ ПОПАДАНИЕ'
                              : 'ОШИБКА'
                          }
                        </div>
                        <p class="text-sm text-zinc-200 leading-relaxed">${this.escapeHtml(q.explanation)}</p>
                      </div>
                      <button id="btn-next-turn" class="btn-tactile px-6 py-3.5 bg-[#facc15] hover:bg-yellow-300 text-black font-display font-extrabold text-xs uppercase shrink-0 flex items-center gap-2">
                        СЛЕДУЮЩИЙ ХОД
                        <i data-lucide="arrow-right" class="w-4 h-4"></i>
                      </button>
                    </div>
                  </div>`
                : ''
            }
          </div>
        </div>

        <!-- Правая колонка: Тактические Джокеры + Prediction Market Card (4 колонки) -->
        <div class="lg:col-span-4 space-y-4">
          ${this.renderJokerDeck(activePlayer)}
          ${this.renderPredictionMarketCard(activePlayer)}
        </div>
      </div>
    `;
  }

  renderJokerDeck(activePlayer) {
    const qState = this.state.quiz;
    const targetMode = qState.pendingJokerTargetMode;
    const otherPlayers = this.state.players.filter((p) => p.id !== activePlayer.id);

    return `
      <div class="studio-panel p-5">
        <div class="flex items-center justify-between pb-3 mb-3 border-b border-zinc-800">
          <div>
            <div class="font-mono-code text-[10px] text-zinc-500 uppercase">TACTICAL DECK</div>
            <h4 class="font-display font-bold text-sm text-white">Джокеры: ${this.escapeHtml(activePlayer.name)}</h4>
          </div>
          <span class="font-mono-code text-xs font-bold text-[#facc15]">${activePlayer.jokers.length}/6</span>
        </div>

        ${
          targetMode
            ? `<div class="mb-3 p-3 bg-zinc-900 border border-[#facc15] space-y-2 reveal-stage">
                <div class="font-mono-code text-xs text-[#facc15] font-bold">
                  ${
                    targetMode === 'ally'
                      ? 'ВЫБЕРИТЕ СОЮЗНИКА ДЛЯ КОНСИЛИУМА (+150 ЕМУ ПРИ УСПЕХЕ):'
                      : 'ВЫБЕРИТЕ КОМУ ПЕРЕДАТЬ ЭТОТ ВОПРОС:'
                  }
                </div>
                <div class="grid grid-cols-1 gap-1.5">
                  ${otherPlayers
                    .map(
                      (op) => `
                    <button data-confirm-joker-target="${op.id}" class="p-2 bg-[#18181c] hover:bg-zinc-800 border border-zinc-700 text-left font-mono-code text-xs text-white flex items-center justify-between">
                      <span>${this.escapeHtml(op.name)} (${op.role.toUpperCase()})</span>
                      <span class="text-zinc-400">${op.score} PTS</span>
                    </button>
                  `
                    )
                    .join('')}
                </div>
                <button id="btn-cancel-joker-target" class="w-full py-1 text-[11px] font-mono-code text-zinc-400 hover:text-white">ОТМЕНА</button>
              </div>`
            : ''
        }

        <div class="grid grid-cols-2 gap-2">
          ${JOKERS.map((jk) => {
            const hasJoker = activePlayer.jokers.includes(jk.id);
            const disabledByHint = jk.id === 'double' && qState.usedAnyHintThisTurn;
            const isDisabled = !hasJoker || qState.revealed || disabledByHint;

            return `
              <button
                data-use-joker="${jk.id}"
                ${isDisabled ? 'disabled' : ''}
                class="p-3 text-left border transition ${
                  !isDisabled
                    ? 'bg-[#18181c] border-zinc-700 hover:border-[#facc15] text-white'
                    : 'bg-zinc-950 border-zinc-900 text-zinc-600 opacity-40 cursor-not-allowed'
                }"
              >
                <div class="flex items-center justify-between font-mono-code text-xs font-extrabold">
                  <span class="${!isDisabled ? 'text-[#facc15]' : 'text-zinc-600'}">[${jk.code}]</span>
                  <i data-lucide="${jk.icon}" class="w-3.5 h-3.5"></i>
                </div>
                <div class="font-bold text-xs mt-1">${jk.name}</div>
                <div class="text-[10px] text-zinc-400 mt-0.5 leading-tight">${jk.desc}</div>
              </button>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  // Адаптированный компонент Prediction Market Card из 21st.dev (isaiahbjork/prediction-market-card)
  renderPredictionMarketCard(activePlayer) {
    const qState = this.state.quiz;
    const otherPlayers = this.state.players.filter((p) => p.id !== activePlayer.id);

    const yesVoters = otherPlayers.filter((p) => qState.sideBets[p.id] === 'pass');
    const noVoters = otherPlayers.filter((p) => qState.sideBets[p.id] === 'fail');
    const totalBets = yesVoters.length + noVoters.length;
    const yesPct = totalBets === 0 ? 50 : Math.round((yesVoters.length / totalBets) * 100);
    const noPct = 100 - yesPct;
    const totalPool = totalBets * 100;

    return `
      <div class="studio-panel p-5 space-y-4">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="px-2 py-0.5 bg-amber-500 text-black font-mono-code font-extrabold text-[10px] uppercase">
              LIVE BET POOL
            </span>
            <span class="font-mono-code text-[11px] text-zinc-400">
              ${qState.betsLocked || qState.revealed ? 'СТАВКИ ЗАКРЫТЫ' : 'ПРИЁМ СТАВОК ОТКРЫТ'}
            </span>
          </div>
          <span class="font-mono-code text-xs font-bold text-[#facc15]">BANK: ${totalPool} PTS</span>
        </div>

        <!-- Процентная шкала со скошенным разделителем из 21st.dev Prediction Market Card -->
        <div class="space-y-1.5">
          <div class="flex items-center justify-between font-mono-code">
            <div>
              <div class="text-[10px] text-zinc-400 uppercase">ВЕРЮ (ОТВЕТИТ)</div>
              <div class="text-lg font-extrabold text-emerald-400">${yesPct}%</div>
            </div>
            <div class="text-right">
              <div class="text-[10px] text-zinc-400 uppercase">СОМНЕВАЮСЬ (ОШИБЁТСЯ)</div>
              <div class="text-lg font-extrabold text-rose-400">${noPct}%</div>
            </div>
          </div>

          <div class="relative h-3 bg-rose-600 overflow-hidden border border-black">
            <div
              class="absolute top-0 left-0 h-full bg-emerald-500 transition-all duration-300"
              style="width: ${yesPct}%"
            ></div>
            <div
              class="absolute top-0 h-[150%] -top-[25%] w-2 bg-[#121215]"
              style="left: ${yesPct}%; transform: translateX(-50%) skewX(-18deg)"
            ></div>
          </div>

          <div class="flex justify-between font-mono-code text-[10px] text-zinc-500">
            <span>УСПЕХ: +100 / ПРОМАХ: -50</span>
            <span>${totalBets} ИЗ ${otherPlayers.length} ПОСТАВИЛИ</span>
          </div>
        </div>

        <!-- Кнопки ставок для каждого из 5 зрителей -->
        <div class="space-y-1.5 pt-2 border-t border-zinc-800">
          ${otherPlayers
            .map((p) => {
              const bet = qState.sideBets[p.id];
              const locked = qState.revealed || qState.betsLocked;
              return `
                <div class="flex items-center justify-between gap-2 p-2 bg-[#18181c] border border-zinc-800">
                  <span class="text-xs font-semibold text-zinc-200 truncate">${this.escapeHtml(p.name)}</span>
                  <div class="flex items-center gap-1">
                    <button
                      data-side-bet="${p.id}:pass"
                      ${locked ? 'disabled' : ''}
                      class="px-2.5 py-1 font-mono-code text-[10px] font-bold border transition ${
                        bet === 'pass'
                          ? 'bg-emerald-500 text-black border-black'
                          : 'bg-zinc-900 text-zinc-400 border-zinc-700 hover:text-white'
                      } ${locked ? 'opacity-50 cursor-not-allowed' : ''}"
                    >ВЕРЮ ↗</button>
                    <button
                      data-side-bet="${p.id}:fail"
                      ${locked ? 'disabled' : ''}
                      class="px-2.5 py-1 font-mono-code text-[10px] font-bold border transition ${
                        bet === 'fail'
                          ? 'bg-rose-500 text-white border-black'
                          : 'bg-zinc-900 text-zinc-400 border-zinc-700 hover:text-white'
                      } ${locked ? 'opacity-50 cursor-not-allowed' : ''}"
                    >ФОЛ ↘</button>
                  </div>
                </div>
              `;
            })
            .join('')}
        </div>
      </div>
    `;
  }

  renderCrowdPollInteractive() {
    const qState = this.state.quiz;
    const activePlayer = this.getActivePlayer();
    const otherPlayers = this.state.players.filter((p) => p.id !== activePlayer.id);
    const letters = ['A', 'B', 'C', 'D'];

    return `
      <div class="mb-5 p-4 bg-zinc-900 border border-blue-500/60 space-y-3 reveal-stage">
        <div class="flex items-center justify-between">
          <span class="font-mono-code text-xs font-bold text-blue-400 uppercase">ОПРОС DISCORD: МНЕНИЕ ЗАЛА</span>
          <span class="font-mono-code text-[11px] text-zinc-400">Отметьте версии коллег</span>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          ${otherPlayers
            .map((p) => {
              const voted = qState.crowdVotes[p.id];
              return `
                <div class="flex items-center justify-between p-2 bg-[#121215] border border-zinc-800">
                  <span class="text-xs font-medium text-zinc-200 truncate">${this.escapeHtml(p.name)}</span>
                  <div class="flex gap-1">
                    ${letters
                      .map(
                        (ltr, idx) => `
                      <button
                        data-crowd-poll="${p.id}:${idx}"
                        class="w-6 h-6 font-mono-code text-xs font-bold border ${
                          voted === idx
                            ? 'bg-blue-500 text-white border-blue-300'
                            : 'bg-zinc-900 text-zinc-400 border-zinc-700 hover:text-white'
                        }"
                      >${ltr}</button>
                    `
                      )
                      .join('')}
                  </div>
                </div>
              `;
            })
            .join('')}
        </div>
      </div>
    `;
  }

  renderAllPlayInteractive() {
    const qState = this.state.quiz;
    const letters = ['A', 'B', 'C', 'D'];
    const answeredCount = Object.keys(qState.allPlayAnswers).length;

    return `
      <div class="mb-6 p-4 bg-zinc-900 border-2 border-[#facc15] space-y-3">
        <div class="flex items-center justify-between">
          <span class="font-mono-code text-xs font-extrabold text-[#facc15] uppercase">
            ОБЩИЙ ШТУРМ: ОТВЕЧАЮТ ВСЕ 6 ИГРОКОВ (ВЫБОРЫ СКРЫТЫ ДО ВСКРЫТИЯ)
          </span>
          <span class="font-mono-code text-xs text-zinc-300">${answeredCount} / ${this.state.players.length} ГОТОВЫ</span>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          ${this.state.players
            .map((p) => {
              const hasAnswered = typeof qState.allPlayAnswers[p.id] === 'number';
              return `
                <div class="flex items-center justify-between p-2.5 bg-[#121215] border border-zinc-800">
                  <span class="text-xs font-bold text-white truncate">${this.escapeHtml(p.name)}</span>
                  ${
                    hasAnswered
                      ? `<div class="flex items-center gap-2">
                          <span class="font-mono-code text-[11px] text-emerald-400">ОТВЕТ ЗАФИКСИРОВАН [СКРЫТО]</span>
                          <button data-allplay-reset="${p.id}" class="text-[10px] font-mono-code text-zinc-500 hover:text-white underline">Сброс</button>
                        </div>`
                      : `<div class="flex gap-1">
                          ${letters
                            .map(
                              (ltr, idx) => `
                            <button
                              data-allplay-pick="${p.id}:${idx}"
                              class="w-7 h-7 font-mono-code text-xs font-bold bg-zinc-900 hover:bg-[#facc15] hover:text-black border border-zinc-700 text-zinc-300"
                            >${ltr}</button>
                          `
                            )
                            .join('')}
                        </div>`
                  }
                </div>
              `;
            })
            .join('')}
        </div>
        <button id="btn-allplay-reveal" class="btn-tactile w-full py-2.5 bg-[#facc15] text-black font-display font-extrabold text-xs uppercase">
          ВСКРЫТЬ ОТВЕТЫ ВСЕХ УЧАСТНИКОВ (+250 КАЖДОМУ УГАДАВШЕМУ)
        </button>
      </div>
    `;
  }

  renderDuelInteractive() {
    const qState = this.state.quiz;
    const p1 = this.getActivePlayer();
    const p2 = this.state.players.find((p) => p.id === qState.duelOpponentId);
    if (!p2) return '';
    const letters = ['A', 'B', 'C', 'D'];

    return `
      <div class="mb-6 p-4 bg-zinc-900 border-2 border-rose-500 space-y-3">
        <div class="font-mono-code text-xs font-extrabold text-rose-400 uppercase">
          ДУЭЛЬ 1 НА 1: ${this.escapeHtml(p1.name)} VS ${this.escapeHtml(p2.name)} (ВЫБОРЫ СКРЫТЫ ДО ОТВЕТА ОБОИХ)
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          ${[p1, p2]
            .map((duelist) => {
              const locked = typeof qState.duelAnswers[duelist.id] === 'number';
              return `
                <div class="p-3 bg-[#121215] border border-zinc-800 flex items-center justify-between">
                  <span class="text-xs font-bold text-white">${this.escapeHtml(duelist.name)}</span>
                  ${
                    locked
                      ? `<span class="font-mono-code text-xs text-emerald-400 font-bold">ОТВЕТ ПРИНЯТ [СКРЫТО]</span>`
                      : `<div class="flex gap-1.5">
                          ${letters
                            .map(
                              (ltr, idx) => `
                            <button
                              data-duel-pick="${duelist.id}:${idx}"
                              class="w-7 h-7 font-mono-code text-xs font-bold bg-zinc-900 hover:bg-rose-500 hover:text-white border border-zinc-700 text-zinc-200"
                            >${ltr}</button>
                          `
                            )
                            .join('')}
                        </div>`
                  }
                </div>
              `;
            })
            .join('')}
        </div>
      </div>
    `;
  }

  renderEventPanel(ev) {
    const qState = this.state.quiz;
    const activePlayer = this.getActivePlayer();
    const otherPlayers = this.state.players.filter((p) => p.id !== activePlayer.id);

    return `
      <div class="studio-panel p-5 border-l-4 border-l-[#facc15] space-y-3 reveal-stage">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="px-2 py-0.5 bg-[#facc15] text-black font-mono-code font-extrabold text-[10px]">
              ${ev.code}
            </span>
            <h4 class="font-display font-bold text-base text-white">${ev.title}</h4>
          </div>
        </div>
        <p class="text-xs text-zinc-300 leading-relaxed">${ev.desc}</p>

        ${
          ev.type === 'box'
            ? qState.vaultResolved
              ? `<div class="p-3 bg-zinc-900 border border-zinc-700 space-y-2">
                  <div class="font-mono-code text-xs font-bold text-[#facc15]">${this.escapeHtml(qState.vaultResultText)}</div>
                  <div class="grid grid-cols-3 gap-2 text-[11px] font-mono-code">
                    ${qState.vaultBoxes
                      .map(
                        (b, i) => `
                      <div class="p-2 border ${
                        qState.vaultPickedIndex === i
                          ? 'bg-zinc-800 border-[#facc15] text-white'
                          : 'bg-zinc-950 border-zinc-800 text-zinc-500'
                      }">
                        СЕЙФ ${b.label}: <strong>${b.title}</strong>
                      </div>
                    `
                      )
                      .join('')}
                  </div>
                </div>`
              : `<div class="flex flex-wrap items-center gap-2 pt-1">
                  ${qState.vaultBoxes
                    .map(
                      (b, i) => `
                    <button data-vault-pick="${i}" class="btn-tactile px-4 py-2 bg-[#18181c] hover:bg-zinc-800 text-xs font-mono-code font-bold text-[#facc15]">
                      ВСКРЫТЬ СЕЙФ [${b.label}]
                    </button>
                  `
                    )
                    .join('')}
                  <button data-vault-pick="-1" class="btn-tactile px-4 py-2 bg-zinc-900 text-xs font-mono-code text-zinc-300">
                    ОТКАЗАТЬСЯ (+100 ГАРАНТИРОВАННО)
                  </button>
                </div>`
            : ''
        }

        ${
          ev.type === 'auction' && !qState.auctionResolved
            ? `<div class="p-3.5 bg-zinc-900 border border-zinc-700 space-y-3">
                <div class="flex items-center justify-between font-mono-code text-xs">
                  <span class="text-zinc-400">ЛИДЕР ТОРГОВ: <strong class="text-white">${this.escapeHtml(
                    this.state.players.find((p) => p.id === qState.auctionLeaderId)?.name || ''
                  )}</strong></span>
                  <span class="text-[#facc15] font-extrabold text-sm">СТАВКА: ${qState.auctionHighestBid} PTS</span>
                </div>
                <div class="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                  ${this.state.players
                    .map(
                      (p) => `
                    <div class="p-2 bg-[#121215] border border-zinc-800 flex items-center justify-between gap-1">
                      <span class="text-xs font-semibold text-zinc-200 truncate">${this.escapeHtml(p.name)}</span>
                      <button
                        data-auction-bid="${p.id}:${Math.min(500, qState.auctionHighestBid + 50)}"
                        class="px-2 py-1 bg-zinc-800 hover:bg-[#facc15] hover:text-black font-mono-code text-[10px] font-bold text-[#facc15]"
                      >${Math.min(500, qState.auctionHighestBid + 50)}</button>
                    </div>
                  `
                    )
                    .join('')}
                </div>
                <button id="btn-auction-lock" class="btn-tactile w-full py-2.5 bg-[#facc15] text-black font-display font-extrabold text-xs uppercase">
                  ПРОДАНО ИГРОКУ ${this.escapeHtml(
                    this.state.players.find((p) => p.id === qState.auctionLeaderId)?.name || ''
                  )} ЗА ${qState.auctionHighestBid} PTS — ОТКРЫТЬ ВОПРОС!
                </button>
              </div>`
            : ''
        }

        ${
          ev.type === 'duel' && !qState.duelOpponentId
            ? `<div class="p-3 bg-zinc-900 border border-zinc-700 space-y-2">
                <div class="font-mono-code text-xs text-rose-400 font-bold">
                  ${this.escapeHtml(activePlayer.name)}, ВЫБЕРИТЕ СОПЕРНИКА ДЛЯ ДУЭЛИ 1 НА 1:
                </div>
                <div class="flex flex-wrap gap-2">
                  ${otherPlayers
                    .map(
                      (op) => `
                    <button data-duel-opponent="${op.id}" class="btn-tactile px-3 py-1.5 bg-[#18181c] hover:bg-rose-950 font-mono-code text-xs text-white">
                      ВЫЗВАТЬ: ${this.escapeHtml(op.name)} (${op.score} PTS)
                    </button>
                  `
                    )
                    .join('')}
                </div>
              </div>`
            : ''
        }

        ${
          ev.type === 'dilemma'
            ? !qState.dilemmaPartnerId
              ? `<div class="p-3 bg-zinc-900 border border-zinc-700 space-y-2">
                  <div class="font-mono-code text-xs text-[#facc15] font-bold">
                    ВЫБЕРИТЕ НАПАРНИКА ДЛЯ СДЕЛКИ / ДИЛЕММЫ:
                  </div>
                  <div class="flex flex-wrap gap-2">
                    ${otherPlayers
                      .map(
                        (op) => `
                      <button data-dilemma-partner="${op.id}" class="btn-tactile px-3 py-1.5 bg-[#18181c] hover:bg-zinc-800 font-mono-code text-xs text-white">
                        ${this.escapeHtml(op.name)} (${op.score} PTS)
                      </button>
                    `
                      )
                      .join('')}
                  </div>
                </div>`
              : qState.dilemmaResolved
              ? `<div class="p-3 bg-zinc-900 border border-zinc-700 font-mono-code text-xs font-bold text-[#facc15]">
                  ${this.escapeHtml(qState.dilemmaResultText)}
                </div>`
              : `<div class="p-3 bg-zinc-900 border border-zinc-700 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  ${[activePlayer, this.state.players.find((p) => p.id === qState.dilemmaPartnerId)]
                    .filter(Boolean)
                    .map((participant) => {
                      const chosen = Boolean(qState.dilemmaChoices[participant.id]);
                      return `
                        <div class="p-2.5 bg-[#121215] border border-zinc-800 flex items-center justify-between">
                          <span class="text-xs font-bold text-white">${this.escapeHtml(participant.name)}:</span>
                          ${
                            chosen
                              ? `<span class="font-mono-code text-xs text-emerald-400 font-bold">РЕШЕНИЕ ПРИНЯТО [СКРЫТО]</span>`
                              : `<div class="flex gap-1.5">
                                  <button data-dilemma="${participant.id}:coop" class="px-2.5 py-1 bg-zinc-800 hover:bg-emerald-600 font-mono-code text-xs text-zinc-200 font-bold">СДЕЛКА</button>
                                  <button data-dilemma="${participant.id}:betray" class="px-2.5 py-1 bg-zinc-800 hover:bg-rose-600 font-mono-code text-xs text-zinc-200 font-bold">КРАЖА</button>
                                </div>`
                          }
                        </div>
                      `;
                    })
                    .join('')}
                </div>`
            : ''
        }
      </div>
    `;
  }

  // --- РЕНДЕР РЕЖИМА 2: ПРАВДОРУБ (FIBBAGE С ЗАЩИТОЙ ЭКРАНА) ---
  renderBluffAct() {
    const bState = this.state.bluff;
    const item = bState.currentItem;
    if (!item) return '';

    return `
      <div class="studio-panel p-6 sm:p-8 max-w-4xl mx-auto space-y-6 reveal-stage">
        <div class="flex flex-wrap items-center justify-between gap-2 pb-4 border-b border-zinc-800">
          <div class="flex items-center gap-2">
            <span class="px-2.5 py-1 bg-[#facc15] text-black font-mono-code font-extrabold text-xs">
              BLUFF // ${item.category.toUpperCase()}
            </span>
          </div>
          <span class="font-mono-code text-xs text-zinc-400">
            ПРАВДА: +400 PTS • КАЖДЫЙ ПОЙМАННЫЙ В ЛОВУШКУ КОЛЛЕГА: +300 PTS
          </span>
        </div>

        <h3 class="font-display font-bold text-xl sm:text-2xl text-white leading-relaxed">
          ${this.escapeHtml(item.prompt)}
        </h3>

        ${
          bState.phase === 'collect'
            ? `
          <div class="space-y-4">
            <div class="p-4 bg-[#18181c] border border-zinc-800 space-y-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="font-mono-code text-xs text-zinc-300 font-bold">
                  ПРИЁМ ЛОЖНЫХ ВЕРСИЙ ИГРОКОВ (ВВОД С ПУЛЬТОВ ИЛИ ВРУЧНУЮ):
                </span>
                <button id="btn-toggle-bluff-mask" class="px-2.5 py-1 bg-zinc-900 border border-zinc-700 font-mono-code text-[11px] text-[#facc15]">
                  ${bState.maskInputs ? 'РЕЖИМ СТРИМА: БУКВЫ СКРЫТЫ (••••)' : 'БУКВЫ ВИДНЫ'}
                </button>
              </div>

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                ${this.state.players
                  .map((p) => {
                    const submitted = Boolean(bState.submittedBluffs[p.id]);
                    return `
                      <div class="flex items-center justify-between gap-2 p-2.5 bg-[#121215] border border-zinc-800">
                        <span class="text-xs font-bold text-white w-28 truncate">${this.escapeHtml(p.name)}:</span>
                        ${
                          submitted
                            ? `<div class="flex items-center gap-2">
                                <span class="font-mono-code text-xs text-emerald-400 font-bold">ПРИНЯТО [СКРЫТО]</span>
                                <button data-bluff-clear="${p.id}" class="text-[10px] font-mono-code text-zinc-500 hover:text-white underline">Изменить</button>
                              </div>`
                            : `<input
                                type="${bState.maskInputs ? 'password' : 'text'}"
                                data-bluff-input="${p.id}"
                                placeholder="Вписать блеф + Enter"
                                class="flex-1 bg-zinc-900 border border-zinc-700 focus:border-[#facc15] focus:outline-none px-2.5 py-1 text-xs text-white font-mono-code"
                              />`
                        }
                      </div>
                    `;
                  })
                  .join('')}
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-3">
              <button id="btn-bluff-start-vote" class="btn-tactile px-6 py-3.5 bg-[#facc15] text-black font-display font-extrabold text-xs uppercase">
                ПЕРЕМЕШАТЬ ВЕРСИИ И ПЕРЕЙТИ К ГОЛОСОВАНИЮ
              </button>
              <button id="btn-bluff-quick" class="btn-tactile px-4 py-3.5 bg-[#18181c] hover:bg-zinc-800 text-zinc-200 font-mono-code text-xs font-bold">
                БЫСТРЫЙ РЕЖИМ НА 1 ЭКРАНЕ (5 ГОТОВЫХ ВАРИАНТОВ БЕЗ ВВОДА)
              </button>
            </div>
          </div>
        `
            : ''
        }

        ${
          bState.phase === 'vote'
            ? `
          <div class="space-y-4 reveal-stage">
            <div class="font-mono-code text-xs font-bold text-[#facc15] uppercase">
              ФАЗА ГОЛОСОВАНИЯ: КАЖДЫЙ ИГРОК ВЫБИРАЕТ ВАРИАНТ, КОТОРЫЙ СЧИТАЕТ ПРАВДОЙ
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              ${bState.choices
                .map(
                  (c, idx) => `
                <div class="p-4 bg-[#18181c] border border-zinc-700 flex flex-col justify-between gap-3">
                  <div class="flex items-start gap-3">
                    <span class="w-7 h-7 bg-zinc-900 border border-zinc-700 text-[#facc15] font-mono-code font-extrabold text-xs flex items-center justify-center shrink-0">
                      0${idx + 1}
                    </span>
                    <div class="font-semibold text-base text-white">${this.escapeHtml(c.text)}</div>
                  </div>
                  <div class="flex flex-wrap gap-1.5 pt-2 border-t border-zinc-800">
                    ${this.state.players
                      .map((p) => {
                        const votedThis = bState.votes[p.id] === c.id;
                        return `
                          <button
                            data-bluff-vote="${p.id}:${c.id}"
                            class="px-2 py-1 font-mono-code text-[10px] font-bold border transition ${
                              votedThis
                                ? 'bg-[#facc15] text-black border-black'
                                : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-white'
                            }"
                          >${this.escapeHtml(p.name)}</button>
                        `;
                      })
                      .join('')}
                  </div>
                </div>
              `
                )
                .join('')}
            </div>

            <button id="btn-bluff-reveal" class="btn-tactile w-full py-3.5 bg-emerald-500 hover:bg-emerald-400 text-black font-display font-extrabold text-xs uppercase">
              ВСКРЫТЬ НАСТОЯЩИЙ ФАКТ И АВТОРОВ ЛЖИ
            </button>
          </div>
        `
            : ''
        }

        ${
          bState.phase === 'reveal'
            ? `
          <div class="space-y-4 reveal-stage">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              ${bState.choices
                .map((c) => {
                  const voters = Object.entries(bState.votes)
                    .filter(([, cid]) => cid === c.id)
                    .map(([pid]) => this.state.players.find((p) => p.id === pid)?.name)
                    .filter(Boolean);
                  const authors = c.authorIds
                    .map((aid) => this.state.players.find((p) => p.id === aid)?.name)
                    .filter(Boolean);

                  return `
                    <div class="p-4 border-2 ${
                      c.isTruth
                        ? 'bg-emerald-950/60 border-emerald-400'
                        : authors.length > 0
                        ? 'bg-rose-950/40 border-rose-500/60'
                        : 'bg-zinc-950 border-zinc-800 opacity-60'
                    }">
                      <div class="font-mono-code text-[11px] font-extrabold uppercase mb-1 ${
                        c.isTruth ? 'text-emerald-400' : 'text-rose-400'
                      }">
                        ${
                          c.isTruth
                            ? 'НАСТОЯЩАЯ ПРАВДА (+400 PTS)'
                            : authors.length > 0
                            ? `ЛОЖЬ ИГРОКА: ${authors.join(', ')} (+300 ЗА КАЖДОГО)`
                            : 'ЛОВУШКА СИСТЕМЫ'
                        }
                      </div>
                      <div class="font-bold text-base text-white">${this.escapeHtml(c.text)}</div>
                      <div class="mt-2 font-mono-code text-xs text-zinc-300">
                        ${voters.length > 0 ? `ПОВЕРИЛИ: ${voters.join(', ')}` : 'Никто не выбрал'}
                      </div>
                    </div>
                  `;
                })
                .join('')}
            </div>

            <div class="p-5 bg-zinc-900 border border-zinc-700 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div class="space-y-1">
                <div class="font-mono-code text-xs text-[#facc15] font-bold uppercase">ИСТОРИЧЕСКАЯ СПРАВКА:</div>
                <p class="text-sm text-zinc-200 leading-relaxed">${this.escapeHtml(item.fact)}</p>
              </div>
              <button id="btn-next-turn" class="btn-tactile px-6 py-3.5 bg-[#facc15] text-black font-display font-extrabold text-xs uppercase shrink-0 flex items-center gap-2">
                СЛЕДУЮЩИЙ ХОД
                <i data-lucide="arrow-right" class="w-4 h-4"></i>
              </button>
            </div>
          </div>
        `
            : ''
        }
      </div>
    `;
  }

  // --- РЕНДЕР РЕЖИМА 3: СПЕКТР (WAVELENGTH БЕЗ ЗАСВЕТА НА СТРИМЕ) ---
  renderWavelengthAct() {
    const w = this.state.wavelength;
    if (!w.card) return '';
    const activePlayer = this.getActivePlayer();

    return `
      <div class="studio-panel p-6 sm:p-8 max-w-4xl mx-auto space-y-6 reveal-stage">
        <div class="flex flex-wrap items-center justify-between gap-2 pb-4 border-b border-zinc-800">
          <span class="px-2.5 py-1 bg-[#facc15] text-black font-mono-code font-extrabold text-xs uppercase">
            SPECTRUM // ${w.card.category}
          </span>
          <span class="font-mono-code text-xs text-zinc-300">
            НАВОДЧИК (ТЕЛЕПАТ): <strong class="text-[#facc15]">${this.escapeHtml(activePlayer.name)}</strong>
          </span>
        </div>

        <!-- Два полюса шкалы -->
        <div class="grid grid-cols-2 gap-4">
          <div class="p-4 bg-[#18181c] border-l-4 border-l-blue-500 border border-zinc-800">
            <div class="font-mono-code text-xs text-blue-400 font-bold">0% [ЛЕВЫЙ ПОЛЮС]</div>
            <div class="font-display font-bold text-lg text-white mt-1">${this.escapeHtml(w.card.left)}</div>
          </div>
          <div class="p-4 bg-[#18181c] border-r-4 border-r-emerald-500 border border-zinc-800 text-right">
            <div class="font-mono-code text-xs text-emerald-400 font-bold">100% [ПРАВЫЙ ПОЛЮС]</div>
            <div class="font-display font-bold text-lg text-white mt-1">${this.escapeHtml(w.card.right)}</div>
          </div>
        </div>

        <!-- Безопасная передача секретной координаты без засвета на стриме -->
        <div class="p-4 bg-zinc-900 border border-zinc-700 flex flex-wrap items-center justify-between gap-3">
          <div class="text-xs text-zinc-300 font-mono-code">
            ${
              w.peekTarget || w.revealed
                ? `<span class="text-[#facc15] font-extrabold text-sm">СЕКРЕТНАЯ МИШЕНЬ: ${w.targetValue}%</span>`
                : `КАК ПЕРЕДАТЬ МИШЕНЬ ИГРОКУ ${this.escapeHtml(activePlayer.name).toUpperCase()} БЕЗ СПОЙЛЕРА НА СТРИМЕ:`
            }
          </div>
          ${
            !w.revealed
              ? `<div class="flex flex-wrap gap-2">
                  <button id="btn-wavelength-copy" class="btn-tactile px-3.5 py-2 bg-[#facc15] text-black font-mono-code text-xs font-extrabold flex items-center gap-1.5">
                    <i data-lucide="clipboard-copy" class="w-3.5 h-3.5"></i>
                    СКОПИРОВАТЬ МИШЕНЬ В БУФЕР (БЕЗ ПОКАЗА)
                  </button>
                  <button id="btn-wavelength-peek" class="btn-tactile px-3 py-2 bg-[#18181c] text-zinc-300 font-mono-code text-xs">
                    ${w.peekTarget ? 'СКРЫТЬ С ЭКРАНА' : 'ПОКАЗАТЬ НА ЭКРАНЕ'}
                  </button>
                </div>`
              : ''
          }
        </div>

        <!-- Шкала и ползунок команды -->
        <div class="p-6 bg-[#18181c] border border-zinc-800 space-y-5">
          <div class="flex items-center justify-between font-mono-code">
            <span class="text-xs text-zinc-400 uppercase">КООРДИНАТА КОМАНДЫ:</span>
            <span id="wavelength-guess-label" class="font-extrabold text-2xl text-[#facc15]">${w.teamGuess}%</span>
          </div>

          <input
            id="wavelength-slider-input"
            type="range"
            min="0"
            max="100"
            value="${w.teamGuess}"
            ${w.revealed ? 'disabled' : ''}
            class="spectrum-slider"
          />

          ${
            w.revealed && w.resultSummary
              ? `<div class="p-4 bg-zinc-900 border-2 border-emerald-400 space-y-1 reveal-stage">
                  <div class="font-mono-code text-xs text-emerald-400 font-extrabold uppercase">${w.resultSummary.zoneName}</div>
                  <div class="font-display font-bold text-lg text-white">
                    Мишень: ${w.targetValue}% • Ответ команды: ${w.teamGuess}% (Отклонение: ${w.resultSummary.diff}%)
                  </div>
                  <div class="font-mono-code text-xs text-zinc-300">
                    Наводчик: +${w.resultSummary.telepathPts} PTS • Команда: по +${w.resultSummary.teamPts} PTS
                    ${
                      w.resultSummary.sideWinners.length > 0
                        ? ` • Бонус за сторону (+150): ${w.resultSummary.sideWinners.join(', ')}`
                        : ''
                    }
                  </div>
                </div>`
              : ''
          }

          <!-- Индивидуальные ставки зрителей Левее / Правее -->
          <div class="pt-4 border-t border-zinc-800">
            <div class="font-mono-code text-xs text-zinc-400 mb-2.5">
              СТАВКИ ОСТАЛЬНЫХ ИГРОКОВ (+150 PTS): ГДЕ НАСТОЯЩИЙ ЦЕНТР МИШЕНИ ОТНОСИТЕЛЬНО ПОЛЗУНКА?
            </div>
            <div class="grid grid-cols-2 sm:grid-cols-5 gap-2">
              ${this.state.players
                .filter((p) => p.id !== activePlayer.id)
                .map((p) => {
                  const sv = w.sideVotes[p.id];
                  return `
                    <div class="p-2.5 bg-[#121215] border border-zinc-800 space-y-2">
                      <div class="text-xs font-bold text-white truncate">${this.escapeHtml(p.name)}</div>
                      <div class="grid grid-cols-2 gap-1">
                        <button
                          data-wave-side="${p.id}:left"
                          ${w.revealed ? 'disabled' : ''}
                          class="py-1 font-mono-code text-[10px] font-bold border ${
                            sv === 'left'
                              ? 'bg-blue-500 text-white border-black'
                              : 'bg-zinc-900 text-zinc-400 border-zinc-800'
                          }"
                        >◄ ЛЕВЕЕ</button>
                        <button
                          data-wave-side="${p.id}:right"
                          ${w.revealed ? 'disabled' : ''}
                          class="py-1 font-mono-code text-[10px] font-bold border ${
                            sv === 'right'
                              ? 'bg-emerald-500 text-black border-black'
                              : 'bg-zinc-900 text-zinc-400 border-zinc-800'
                          }"
                        >ПРАВЕЕ ►</button>
                      </div>
                    </div>
                  `;
                })
                .join('')}
            </div>
          </div>
        </div>

        <div class="flex justify-end">
          ${
            !w.revealed
              ? `<button id="btn-wavelength-reveal" class="btn-tactile w-full py-3.5 bg-[#facc15] text-black font-display font-extrabold text-xs uppercase">
                  ВСКРЫТЬ МИШЕНЬ И РАССЧИТАТЬ ТОЧНОСТЬ
                </button>`
              : `<button id="btn-next-turn" class="btn-tactile px-6 py-3.5 bg-[#facc15] text-black font-display font-extrabold text-xs uppercase flex items-center gap-2">
                  СЛЕДУЮЩИЙ ХОД
                  <i data-lucide="arrow-right" class="w-4 h-4"></i>
                </button>`
          }
        </div>
      </div>
    `;
  }

  // --- РЕНДЕР РЕЖИМА 4: КЕЙС-БАТТЛ С ИИ ---
  renderCaseAct() {
    const cb = this.state.caseBattle;
    if (!cb.scenario) return '';
    const activePlayer = this.getActivePlayer();
    const otherPlayers = this.state.players.filter((p) => p.id !== activePlayer.id);

    return `
      <div class="studio-panel p-6 sm:p-8 max-w-4xl mx-auto space-y-6 reveal-stage">
        <div class="flex flex-wrap items-center justify-between gap-2 pb-4 border-b border-zinc-800">
          <span class="px-2.5 py-1 bg-[#facc15] text-black font-mono-code font-extrabold text-xs uppercase">
            AI CASE ARBITER
          </span>
          <span class="font-mono-code text-xs text-zinc-300">
            ОТВЕЧАЕТ: <strong class="text-white">${this.escapeHtml(activePlayer.name)}</strong> [${activePlayer.role.toUpperCase()}]
          </span>
        </div>

        <div class="space-y-2">
          <h3 class="font-display font-bold text-xl sm:text-2xl text-white">${this.escapeHtml(cb.scenario.title)}</h3>
          <p class="text-base text-zinc-200 leading-relaxed">${this.escapeHtml(cb.scenario.situation)}</p>
          <p class="font-mono-code text-xs text-[#facc15]">${this.escapeHtml(cb.scenario.roleHint)}</p>
        </div>

        <!-- Мутатор -->
        <div class="p-4 bg-[#18181c] border-l-4 border-l-rose-500 border border-zinc-800 flex items-center justify-between gap-4">
          <div>
            <div class="font-mono-code text-[10px] text-rose-400 font-bold uppercase">ОБЯЗАТЕЛЬНОЕ УСЛОВИЕ-МУТАТОР:</div>
            <div class="font-bold text-sm text-white mt-0.5">${this.escapeHtml(cb.mutator)}</div>
          </div>
          <button id="btn-reroll-mutator" class="btn-tactile px-3 py-1.5 bg-zinc-900 text-xs font-mono-code text-zinc-300 shrink-0">
            СМЕНИТЬ УСЛОВИЕ
          </button>
        </div>

        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <label class="font-mono-code text-xs text-zinc-400">ТЕЗИСЫ ОТВЕТА ИГРОКА:</label>
            <button id="btn-voice-dictate" class="btn-tactile px-3 py-1 font-mono-code text-xs font-bold flex items-center gap-1.5 ${
              this.speechRecognition ? 'bg-rose-600 text-white' : 'bg-[#18181c] text-[#facc15]'
            }">
              <i data-lucide="mic" class="w-3.5 h-3.5"></i>
              ${this.speechRecognition ? 'ЗАПИСЬ ИДЁТ (СТОП)' : 'ГОЛОСОВОЙ ВВОД (RU)'}
            </button>
          </div>
          <textarea
            id="case-answer-input"
            rows="3"
            placeholder="Запишите ключевую идею ответа игрока или включите микрофон..."
            class="w-full bg-[#18181c] border border-zinc-700 focus:border-[#facc15] focus:outline-none p-4 text-sm text-white"
          >${this.escapeHtml(cb.answerText)}</textarea>
        </div>

        ${
          cb.verdictData
            ? `<div class="p-5 bg-zinc-900 border-2 border-[#facc15] space-y-4 reveal-stage">
                <div class="flex items-center justify-between">
                  <span class="px-2.5 py-1 bg-[#facc15] text-black font-mono-code font-extrabold text-xs uppercase">
                    ВЕРДИКТ: ${this.escapeHtml(cb.verdictData.highlight)}
                  </span>
                  <span class="font-mono-code font-extrabold text-xl text-emerald-400">+${cb.verdictData.score} PTS</span>
                </div>
                <p class="text-sm text-zinc-200 leading-relaxed">${this.escapeHtml(cb.verdictData.verdict)}</p>

                <div class="pt-3 border-t border-zinc-800 space-y-2">
                  <div class="font-mono-code text-xs text-zinc-400">ОДОБРЕНИЕ КОЛЛЕГ (+50 PTS ОТ КАЖДОГО ИГРОКА):</div>
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <div class="flex flex-wrap gap-1.5">
                      ${otherPlayers
                        .map((p) => {
                          const liked = cb.votedPeerIds.includes(p.id);
                          return `
                            <button
                              data-case-vote="${p.id}"
                              class="px-3 py-1 font-mono-code text-xs font-bold border ${
                                liked
                                  ? 'bg-emerald-500 text-black border-black'
                                  : 'bg-[#18181c] text-zinc-400 border-zinc-700 hover:text-white'
                              }"
                            >+50 ОТ ${this.escapeHtml(p.name)}</button>
                          `;
                        })
                        .join('')}
                    </div>
                    <button id="btn-next-turn" class="btn-tactile px-6 py-3 bg-[#facc15] text-black font-display font-extrabold text-xs uppercase flex items-center gap-2">
                      СЛЕДУЮЩИЙ ХОД
                      <i data-lucide="arrow-right" class="w-4 h-4"></i>
                    </button>
                  </div>
                </div>
              </div>`
            : `<button id="btn-judge-case" ${cb.isJudging ? 'disabled' : ''} class="btn-tactile w-full py-3.5 bg-[#facc15] text-black font-display font-extrabold text-xs uppercase">
                ${cb.isJudging ? 'АНАЛИЗ ОТВЕТА НЕЙРОСЕТЬЮ...' : 'ВЫНЕСТИ ВЕРДИКТ И НАЧИСЛИТЬ ОЧКИ'}
              </button>`
        }
      </div>
    `;
  }

  renderPodium() {
    const sorted = [...this.state.players].sort((a, b) => b.score - a.score);
    const { devScore, mgrScore } = this.getTeamScores();
    const winningTeam =
      devScore > mgrScore ? 'DEV TEAM (ПРОГЕРЫ)' : mgrScore > devScore ? 'MGR TEAM (МЕНЕДЖЕРЫ)' : 'РАВНЫЙ СЧЁТ';

    return `
      <div class="studio-panel p-8 max-w-3xl mx-auto space-y-6 reveal-stage">
        <div class="border-b border-zinc-800 pb-4 flex items-center justify-between">
          <div>
            <div class="font-mono-code text-xs text-[#facc15] font-bold uppercase">FINAL STANDINGS</div>
            <h2 class="font-display font-black text-2xl sm:text-3xl text-white mt-1">
              ПОБЕДИТЕЛЬ: ${this.escapeHtml(sorted[0]?.name || '')}
            </h2>
          </div>
          <div class="text-right font-mono-code text-xs">
            <div class="text-zinc-400">КОМАНДНЫЙ ЗАЧЁТ:</div>
            <div class="text-[#facc15] font-bold">${winningTeam} (${devScore} : ${mgrScore})</div>
          </div>
        </div>

        <div class="space-y-2">
          ${sorted
            .map(
              (p, i) => `
            <div class="flex items-center justify-between p-4 border ${
              i === 0 ? 'bg-[#18181c] border-2 border-[#facc15]' : 'bg-[#121215] border-zinc-800'
            }">
              <div class="flex items-center gap-3">
                <span class="font-mono-code font-extrabold text-sm w-8 text-center ${
                  i === 0 ? 'text-[#facc15]' : 'text-zinc-500'
                }">#0${i + 1}</span>
                <div>
                  <div class="font-bold text-white">${this.escapeHtml(p.name)}</div>
                  <div class="font-mono-code text-[10px] text-zinc-400">${p.role.toUpperCase()}</div>
                </div>
              </div>
              <div class="font-mono-code font-extrabold text-xl text-emerald-400">${p.score} PTS</div>
            </div>
          `
            )
            .join('')}
        </div>

        <div class="pt-4 flex justify-end">
          <button id="btn-restart-lobby" class="btn-tactile px-6 py-3.5 bg-[#facc15] text-black font-display font-extrabold text-xs uppercase">
            ВЕРНУТЬСЯ В ЛОББИ
          </button>
        </div>
      </div>
    `;
  }

  renderAiSettingsModal() {
    const cfg = aiClient.config;
    return `
      <div id="ai-modal" class="hidden fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
        <div class="studio-panel max-w-xl w-full p-6 space-y-5 border-2 border-zinc-700 reveal-stage">
          <div class="flex items-center justify-between pb-3 border-b border-zinc-800">
            <div>
              <div class="font-mono-code text-[10px] text-[#facc15] uppercase">PRIVATE CREDENTIALS</div>
              <h3 class="font-display font-bold text-base text-white">Настройки Yandex Cloud API</h3>
            </div>
            <button id="btn-close-ai" class="p-1.5 bg-zinc-900 border border-zinc-700 text-zinc-400 hover:text-white">
              <i data-lucide="x" class="w-4 h-4"></i>
            </button>
          </div>

          <div class="p-3.5 bg-zinc-900 border border-zinc-800 text-xs text-zinc-300 font-mono-code leading-relaxed">
            Ключ сохраняется исключительно в <code>localStorage</code> вашего браузера (в GitHub ничего не передаётся).
            Для обхода браузерного CORS при работе с <code>github.io</code> запустите локально: <code>node yandex-bridge.mjs</code>
          </div>

          <div class="space-y-3">
            <div>
              <label class="block font-mono-code text-xs text-zinc-400 mb-1">API-KEY (ИЛИ IAM-ТОКЕН):</label>
              <input id="yc-api-key" type="password" value="${this.escapeHtml(cfg.apiKey)}" placeholder="AQVN..." class="w-full bg-[#18181c] border border-zinc-700 px-3.5 py-2 text-sm text-white font-mono-code focus:border-[#facc15] focus:outline-none" />
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label class="block font-mono-code text-xs text-zinc-400 mb-1">FOLDER ID:</label>
                <input id="yc-folder-id" type="text" value="${this.escapeHtml(cfg.folderId)}" placeholder="b1g..." class="w-full bg-[#18181c] border border-zinc-700 px-3.5 py-2 text-sm text-white font-mono-code focus:border-[#facc15] focus:outline-none" />
              </div>
              <div>
                <label class="block font-mono-code text-xs text-zinc-400 mb-1">МОДЕЛЬ:</label>
                <select id="yc-model" class="w-full bg-[#18181c] border border-zinc-700 px-3 py-2 text-sm text-white font-mono-code focus:border-[#facc15] focus:outline-none">
                  <option value="yandexgpt/latest" ${cfg.model === 'yandexgpt/latest' ? 'selected' : ''}>yandexgpt/latest</option>
                  <option value="yandexgpt-lite/latest" ${cfg.model === 'yandexgpt-lite/latest' ? 'selected' : ''}>yandexgpt-lite/latest</option>
                </select>
              </div>
            </div>
            <div>
              <label class="block font-mono-code text-xs text-zinc-400 mb-1">CUSTOM PROXY / WORKER URL (ОПЦИОНАЛЬНО):</label>
              <input id="yc-custom-ep" type="text" value="${this.escapeHtml(cfg.customEndpoint || '')}" placeholder="По умолчанию http://127.0.0.1:31337/v1/chat/completions" class="w-full bg-[#18181c] border border-zinc-700 px-3.5 py-2 text-xs text-white font-mono-code focus:border-[#facc15] focus:outline-none" />
            </div>
          </div>

          <button id="btn-save-ai" class="btn-tactile w-full py-2.5 bg-[#facc15] text-black font-mono-code font-extrabold text-xs uppercase">
            СОХРАНИТЬ И ПРОВЕРИТЬ СОЕДИНЕНИЕ
          </button>

          <div class="pt-4 border-t border-zinc-800 space-y-2">
            <label class="block font-mono-code text-xs text-zinc-300 font-bold">
              СГЕНЕРИРОВАТЬ +5 ВОПРОСОВ ПО ЛЮБОЙ ТЕМЕ В КОЛОДУ:
            </label>
            <div class="flex gap-2">
              <input id="ai-topic-input" type="text" placeholder="Тема: архитектура, кино, видеоигры..." class="flex-1 bg-[#18181c] border border-zinc-700 px-3.5 py-2 text-xs text-white focus:border-[#facc15] focus:outline-none" />
              <button id="btn-gen-ai-pack" class="btn-tactile px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-[#facc15] font-mono-code font-bold text-xs shrink-0">
                ГЕНЕРИРОВАТЬ
              </button>
            </div>
          </div>

          <div id="yc-status-msg" class="text-xs min-h-[20px]"></div>
        </div>
      </div>
    `;
  }

  // --- МОБИЛЬНЫЙ / ВТОРОЙ ЭКРАН ПУЛЬТА ИГРОКА (P2P CLIENT VIEW) ---
  renderClientControllerView() {
    if (!this.hostSyncedState) {
      return `
        <div class="min-h-screen flex items-center justify-center p-4">
          <div class="studio-panel max-w-md w-full p-6 space-y-4">
            <div class="font-mono-code text-xs text-[#facc15]">ROOM CODE // ${this.escapeHtml(this.clientRoomCode)}</div>
            <h2 class="font-display font-bold text-xl text-white">Подключение пульта</h2>
            <div class="space-y-3">
              <input id="client-name-input" type="text" placeholder="Ваше имя (как в таблице)" class="w-full bg-[#18181c] border border-zinc-700 px-4 py-3 text-sm text-white" />
              <select id="client-role-input" class="w-full bg-[#18181c] border border-zinc-700 px-4 py-3 text-sm text-white font-mono-code">
                <option value="dev">DEV (Программист)</option>
                <option value="mgr">MGR (Менеджер)</option>
              </select>
              <button id="btn-client-join" class="btn-tactile w-full py-3.5 bg-[#facc15] text-black font-display font-extrabold text-xs uppercase">
                ПОДКЛЮЧИТЬСЯ К СТОЛУ
              </button>
            </div>
          </div>
        </div>
      `;
    }

    const hs = this.hostSyncedState;
    const me =
      hs.players?.find((p) => p.peerId === this.p2p.peer?.id) ||
      hs.players?.find((p) => p.id === this.clientSelectedPlayerId) ||
      hs.players?.[0];
    const isMyTurn = me && hs.activePlayerId === me.id;

    return `
      <div class="min-h-screen max-w-md mx-auto p-4 flex flex-col gap-4">
        <div class="studio-panel p-4 flex items-center justify-between">
          <div>
            <div class="font-mono-code text-[10px] text-zinc-400">ИГРОК:</div>
            <select id="client-switch-slot" class="bg-transparent font-bold text-base text-white focus:outline-none">
              ${(hs.players || [])
                .map(
                  (p) => `<option value="${p.id}" class="bg-zinc-900" ${me?.id === p.id ? 'selected' : ''}>${this.escapeHtml(p.name)}</option>`
                )
                .join('')}
            </select>
          </div>
          <div class="text-right font-mono-code">
            <div class="text-[10px] text-zinc-400">СЧЁТ:</div>
            <div class="font-extrabold text-xl text-emerald-400">${me ? me.score : 0} PTS</div>
          </div>
        </div>

        ${
          hs.currentAct === 'quiz' && hs.quiz
            ? `
          <div class="studio-panel p-5 space-y-4">
            <div class="font-mono-code text-xs font-extrabold uppercase ${isMyTurn ? 'text-[#facc15]' : 'text-zinc-400'}">
              ${
                hs.quiz.eventType === 'all_play'
                  ? 'ОБЩИЙ ШТУРМ: ВЫБЕРИТЕ ВАШ ОТВЕТ'
                  : isMyTurn
                  ? 'ВАШ ХОД: ВЫБЕРИТЕ ВАРИАНТ ОТВЕТА'
                  : 'ХОД КОЛЛЕГИ: СДЕЛАЙТЕ СТАВКУ ИЛИ ПРОГОЛОСУЙТЕ В ОПРОСЕ'
              }
            </div>
            <div class="text-sm font-semibold text-white">${this.escapeHtml(hs.quiz.question)}</div>
            <div class="grid grid-cols-1 gap-2">
              ${(hs.quiz.options || [])
                .map(
                  (opt, idx) => `
                <button data-client-quiz-opt="${idx}" class="p-3.5 bg-[#18181c] hover:bg-zinc-800 border border-zinc-700 text-left text-xs font-semibold text-white">
                  <strong class="text-[#facc15] font-mono-code mr-2">[${['A', 'B', 'C', 'D'][idx]}]</strong> ${this.escapeHtml(opt)}
                </button>
              `
                )
                .join('')}
            </div>
            ${
              !isMyTurn && !hs.quiz.betsLocked && !hs.quiz.revealed
                ? `<div class="pt-3 border-t border-zinc-800 grid grid-cols-2 gap-2">
                    <button data-client-bet="pass" class="py-2.5 bg-emerald-950 border border-emerald-500 text-emerald-300 font-mono-code text-xs font-bold">ВЕРЮ (+100)</button>
                    <button data-client-bet="fail" class="py-2.5 bg-rose-950 border border-rose-500 text-rose-300 font-mono-code text-xs font-bold">ФОЛ (+100)</button>
                  </div>`
                : ''
            }
          </div>
        `
            : ''
        }

        ${
          hs.currentAct === 'bluff' && hs.bluff
            ? `
          <div class="studio-panel p-5 space-y-4">
            <div class="text-sm font-semibold text-white">${this.escapeHtml(hs.bluff.prompt)}</div>
            ${
              hs.bluff.phase === 'collect'
                ? `<div class="space-y-2">
                    <input id="client-bluff-text" type="text" placeholder="Впишите правдоподобную ложь..." class="w-full bg-[#18181c] border border-zinc-700 px-3.5 py-2.5 text-sm text-white" />
                    <button id="btn-client-send-bluff" class="btn-tactile w-full py-3 bg-[#facc15] text-black font-mono-code font-extrabold text-xs">ОТПРАВИТЬ БЛЕФ</button>
                  </div>`
                : `<div class="space-y-2">
                    ${hs.bluff.choices
                      .map(
                        (c) => `
                      <button data-client-bluff-vote="${c.id}" class="w-full p-3 bg-[#18181c] border border-zinc-700 text-left text-xs font-bold text-white">
                        ${this.escapeHtml(c.text)}
                      </button>
                    `
                      )
                      .join('')}
                  </div>`
            }
          </div>
        `
            : ''
        }

        ${
          hs.currentAct === 'wavelength' && hs.wavelength
            ? `
          <div class="studio-panel p-5 space-y-4 text-center">
            <div class="font-mono-code text-xs text-zinc-300">${this.escapeHtml(hs.wavelength.left)} ◄───► ${this.escapeHtml(
                hs.wavelength.right
              )}</div>
            ${
              isMyTurn
                ? `<div class="p-4 bg-zinc-900 border-2 border-[#facc15] text-[#facc15] font-mono-code font-extrabold text-lg">
                    ВАША СЕКРЕТНАЯ МИШЕНЬ: ${hs.wavelength.targetValue}%
                  </div>`
                : `<div class="grid grid-cols-2 gap-2">
                    <button data-client-wave="left" class="py-3 bg-blue-950 border border-blue-500 font-mono-code text-xs font-bold text-blue-200">◄ МИШЕНЬ ЛЕВЕЕ</button>
                    <button data-client-wave="right" class="py-3 bg-emerald-950 border border-emerald-500 font-mono-code text-xs font-bold text-emerald-200">МИШЕНЬ ПРАВЕЕ ►</button>
                  </div>`
            }
          </div>
        `
            : ''
        }
      </div>
    `;
  }

  // --- ПРИВЯЗКА СОБЫТИЙ DOM ---
  bindHostEvents() {
    document.getElementById('btn-home-logo')?.addEventListener('click', () => {
      this.stopTimer();
      this.state.screen = 'lobby';
      this.render();
    });

    document.getElementById('btn-toggle-sound')?.addEventListener('click', () => {
      sfx.toggleMute();
      this.render();
    });

    document.getElementById('btn-open-ai')?.addEventListener('click', () => this.openAiModal());
    document.getElementById('btn-close-ai')?.addEventListener('click', () => this.closeAiModal());
    document.getElementById('btn-save-ai')?.addEventListener('click', () => this.saveAndTestAiConfig());
    document.getElementById('btn-gen-ai-pack')?.addEventListener('click', () => this.generateAiPackFromModal());

    document.getElementById('btn-start-p2p')?.addEventListener('click', () => this.startHostP2P());
    document.getElementById('btn-copy-room')?.addEventListener('click', (e) => {
      const url = e.currentTarget.getAttribute('data-url');
      if (url && navigator.clipboard) {
        navigator.clipboard.writeText(url);
        sfx.play('joker');
        this.showToast(`Ссылка на пульты скопирована: ${url}`);
      }
    });

    // Лобби
    document.querySelectorAll('[data-player-name]').forEach((inp) => {
      inp.addEventListener('input', (e) => {
        const pid = e.target.getAttribute('data-player-name');
        const pl = this.state.players.find((p) => p.id === pid);
        if (pl) {
          pl.name = e.target.value;
          this.saveState();
        }
      });
    });

    document.querySelectorAll('[data-toggle-role]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const pid = e.currentTarget.getAttribute('data-toggle-role');
        const pl = this.state.players.find((p) => p.id === pid);
        if (pl) {
          pl.role = pl.role === 'dev' ? 'mgr' : 'dev';
          sfx.play('click');
          this.saveState();
          this.render();
        }
      });
    });

    document.querySelectorAll('[data-remove-player]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const pid = e.currentTarget.getAttribute('data-remove-player');
        if (this.state.players.length > 2) {
          this.state.players = this.state.players.filter((p) => p.id !== pid);
          sfx.play('click');
          this.saveState();
          this.render();
        }
      });
    });

    document.getElementById('btn-add-player')?.addEventListener('click', () => {
      sfx.play('click');
      const role =
        this.state.players.filter((p) => p.role === 'dev').length <=
        this.state.players.filter((p) => p.role === 'mgr').length
          ? 'dev'
          : 'mgr';
      this.state.players.push({
        id: `p_${Date.now()}`,
        name: `Игрок ${this.state.players.length + 1}`,
        role,
        score: 0,
        streak: 0,
        jokers: ['fifty', 'double', 'ally', 'pass', 'crowd', 'ai_hint'],
        peerId: null
      });
      this.saveState();
      this.render();
    });

    document.querySelectorAll('[data-set-turns]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        this.state.totalTurnsTarget = Number(e.currentTarget.getAttribute('data-set-turns'));
        this.state.boardSchedule = this.buildBoardSchedule(this.state.totalTurnsTarget, this.state.gameMode);
        sfx.play('click');
        this.saveState();
        this.render();
      });
    });

    document.querySelectorAll('[data-select-mode]').forEach((card) => {
      card.addEventListener('click', (e) => {
        const mode = e.currentTarget.getAttribute('data-select-mode');
        this.state.gameMode = mode;
        this.state.boardSchedule = this.buildBoardSchedule(this.state.totalTurnsTarget, mode);
        sfx.play('click');
        this.saveState();
        this.render();
      });
    });

    document.getElementById('btn-start-game')?.addEventListener('click', () => this.startNewGame());
    document.getElementById('btn-resume-game')?.addEventListener('click', () => {
      sfx.play('click');
      this.state.screen = 'game';
      this.render();
    });

    // Табло игроков и навигация
    document.querySelectorAll('[data-make-active]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-score-minus]') || e.target.closest('[data-score-plus]')) return;
        this.state.activePlayerIndex = Number(e.currentTarget.getAttribute('data-make-active'));
        sfx.play('click');
        this.saveState();
        this.render();
      });
    });

    document.querySelectorAll('[data-score-minus]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.adjustScore(e.currentTarget.getAttribute('data-score-minus'), -50);
      });
    });

    document.querySelectorAll('[data-score-plus]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.adjustScore(e.currentTarget.getAttribute('data-score-plus'), 50);
      });
    });

    document.querySelectorAll('[data-switch-act]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        this.switchActManual(e.currentTarget.getAttribute('data-switch-act'));
      });
    });

    document.getElementById('btn-to-lobby')?.addEventListener('click', () => {
      this.stopTimer();
      this.state.screen = 'lobby';
      this.render();
    });

    document.getElementById('btn-end-game')?.addEventListener('click', () => this.finishGame());
    document.getElementById('btn-restart-lobby')?.addEventListener('click', () => {
      this.state.screen = 'lobby';
      this.render();
    });

    // Квиз и Джокеры
    document.querySelectorAll('[data-quiz-option]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const idx = Number(e.currentTarget.getAttribute('data-quiz-option'));
        this.selectQuizOption(idx);
      });
    });

    document.querySelectorAll('[data-use-joker]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        this.initiateJoker(e.currentTarget.getAttribute('data-use-joker'));
      });
    });

    document.querySelectorAll('[data-confirm-joker-target]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        this.confirmJokerTarget(e.currentTarget.getAttribute('data-confirm-joker-target'));
      });
    });

    document.getElementById('btn-cancel-joker-target')?.addEventListener('click', () => {
      this.state.quiz.pendingJokerTargetMode = null;
      this.render();
    });

    document.querySelectorAll('[data-side-bet]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const [pid, bet] = e.currentTarget.getAttribute('data-side-bet').split(':');
        this.setSideBet(pid, bet);
      });
    });

    document.querySelectorAll('[data-crowd-poll]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const [pid, idx] = e.currentTarget.getAttribute('data-crowd-poll').split(':');
        sfx.play('click');
        this.state.quiz.crowdVotes[pid] = Number(idx);
        this.saveState();
        this.render();
      });
    });

    document.getElementById('select-manual-event')?.addEventListener('change', (e) => {
      const evId = e.target.value;
      if (evId) this.triggerManualEvent(evId);
    });

    document.getElementById('btn-quiz-timer')?.addEventListener('click', () => this.toggleTimer());

    // Ивенты в Квизе
    document.querySelectorAll('[data-vault-pick]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        this.pickVaultBox(Number(e.currentTarget.getAttribute('data-vault-pick')));
      });
    });

    document.querySelectorAll('[data-auction-bid]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const [pid, amt] = e.currentTarget.getAttribute('data-auction-bid').split(':');
        this.placeAuctionBid(pid, Number(amt));
      });
    });

    document.getElementById('btn-auction-lock')?.addEventListener('click', () => this.lockAuctionWinner());

    document.querySelectorAll('[data-duel-opponent]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        this.selectDuelOpponent(e.currentTarget.getAttribute('data-duel-opponent'));
      });
    });

    document.querySelectorAll('[data-duel-pick]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const [pid, idx] = e.currentTarget.getAttribute('data-duel-pick').split(':');
        this.submitDuelAnswer(pid, Number(idx));
      });
    });

    document.querySelectorAll('[data-dilemma-partner]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        this.selectDilemmaPartner(e.currentTarget.getAttribute('data-dilemma-partner'));
      });
    });

    document.querySelectorAll('[data-dilemma]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const [pid, choice] = e.currentTarget.getAttribute('data-dilemma').split(':');
        this.setDilemmaChoice(pid, choice);
      });
    });

    document.querySelectorAll('[data-allplay-pick]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const [pid, idx] = e.currentTarget.getAttribute('data-allplay-pick').split(':');
        this.submitAllPlayAnswer(pid, Number(idx));
      });
    });

    document.querySelectorAll('[data-allplay-reset]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const pid = e.currentTarget.getAttribute('data-allplay-reset');
        delete this.state.quiz.allPlayAnswers[pid];
        this.render();
      });
    });

    document.getElementById('btn-allplay-reveal')?.addEventListener('click', () => this.revealAllPlayOutcome());
    document.getElementById('btn-next-turn')?.addEventListener('click', () => this.nextTurn());

    // Правдоруб (Блеф)
    document.getElementById('btn-toggle-bluff-mask')?.addEventListener('click', () => {
      this.state.bluff.maskInputs = !this.state.bluff.maskInputs;
      this.render();
    });

    document.querySelectorAll('[data-bluff-input]').forEach((inp) => {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const pid = e.currentTarget.getAttribute('data-bluff-input');
          this.submitPlayerBluff(pid, e.currentTarget.value);
        }
      });
      inp.addEventListener('blur', (e) => {
        const pid = e.currentTarget.getAttribute('data-bluff-input');
        if (e.currentTarget.value.trim()) {
          this.submitPlayerBluff(pid, e.currentTarget.value);
        }
      });
    });

    document.querySelectorAll('[data-bluff-clear]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const pid = e.currentTarget.getAttribute('data-bluff-clear');
        delete this.state.bluff.submittedBluffs[pid];
        this.render();
      });
    });

    document.getElementById('btn-bluff-start-vote')?.addEventListener('click', () => this.startBluffVoting(false));
    document.getElementById('btn-bluff-quick')?.addEventListener('click', () => this.startBluffVoting(true));

    document.querySelectorAll('[data-bluff-vote]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const [pid, cid] = e.currentTarget.getAttribute('data-bluff-vote').split(':');
        this.voteBluffChoice(pid, cid);
      });
    });

    document.getElementById('btn-bluff-reveal')?.addEventListener('click', () => this.revealBluffResults());

    // Спектр (Wavelength)
    document.getElementById('btn-wavelength-copy')?.addEventListener('click', () =>
      this.copyWavelengthTargetToClipboard()
    );
    document.getElementById('btn-wavelength-peek')?.addEventListener('click', () => {
      sfx.play('click');
      this.state.wavelength.peekTarget = !this.state.wavelength.peekTarget;
      this.render();
    });

    const waveSlider = document.getElementById('wavelength-slider-input');
    waveSlider?.addEventListener('input', (e) => {
      this.state.wavelength.teamGuess = Number(e.target.value);
      const lbl = document.getElementById('wavelength-guess-label');
      if (lbl) lbl.textContent = `${this.state.wavelength.teamGuess}%`;
    });
    waveSlider?.addEventListener('change', () => this.saveState());

    document.querySelectorAll('[data-wave-side]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const [pid, dir] = e.currentTarget.getAttribute('data-wave-side').split(':');
        sfx.play('click');
        this.state.wavelength.sideVotes[pid] = dir;
        this.saveState();
        this.render();
      });
    });

    document.getElementById('btn-wavelength-reveal')?.addEventListener('click', () => this.revealWavelength());

    // Кейс-баттл
    document.getElementById('btn-reroll-mutator')?.addEventListener('click', () => this.rerollMutator());
    document.getElementById('btn-voice-dictate')?.addEventListener('click', () => this.toggleVoiceDictation());
    document.getElementById('btn-judge-case')?.addEventListener('click', () => this.judgeCurrentCase());

    document.querySelectorAll('[data-case-vote]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        this.toggleCasePeerVote(e.currentTarget.getAttribute('data-case-vote'));
      });
    });
  }

  bindClientEvents() {
    document.getElementById('btn-client-join')?.addEventListener('click', async () => {
      const name = document.getElementById('client-name-input')?.value?.trim() || 'Игрок';
      const role = document.getElementById('client-role-input')?.value || 'dev';
      await this.p2p.joinRoom(this.clientRoomCode, { name, role });
    });

    document.getElementById('client-switch-slot')?.addEventListener('change', (e) => {
      this.clientSelectedPlayerId = e.target.value;
      localStorage.setItem('sync50_client_pid', this.clientSelectedPlayerId);
      this.render();
    });

    const getMyId = () => {
      const hs = this.hostSyncedState;
      const byPeer = hs?.players?.find((p) => p.peerId === this.p2p.peer?.id);
      return byPeer?.id || this.clientSelectedPlayerId || hs?.players?.[0]?.id;
    };

    document.querySelectorAll('[data-client-quiz-opt]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const optionIndex = Number(e.currentTarget.getAttribute('data-client-quiz-opt'));
        const hs = this.hostSyncedState;
        const myId = getMyId();
        if (
          hs?.activePlayerId === myId ||
          hs?.quiz?.eventType === 'all_play' ||
          (hs?.quiz?.eventType === 'duel' && hs?.quiz?.duelOpponentId === myId)
        ) {
          this.p2p.sendActionToHost({ kind: 'QUIZ_ANSWER', playerId: myId, optionIndex });
        } else {
          this.p2p.sendActionToHost({ kind: 'CROWD_VOTE', playerId: myId, optionIndex });
        }
      });
    });

    document.querySelectorAll('[data-client-bet]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const bet = e.currentTarget.getAttribute('data-client-bet');
        this.p2p.sendActionToHost({ kind: 'SIDE_BET', playerId: getMyId(), bet });
      });
    });

    document.getElementById('btn-client-send-bluff')?.addEventListener('click', () => {
      const text = document.getElementById('client-bluff-text')?.value?.trim();
      if (text) this.p2p.sendActionToHost({ kind: 'SUBMIT_BLUFF', playerId: getMyId(), text });
    });

    document.querySelectorAll('[data-client-bluff-vote]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const choiceId = e.currentTarget.getAttribute('data-client-bluff-vote');
        this.p2p.sendActionToHost({ kind: 'VOTE_BLUFF', playerId: getMyId(), choiceId });
      });
    });

    document.querySelectorAll('[data-client-wave]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const dir = e.currentTarget.getAttribute('data-client-wave');
        this.p2p.sendActionToHost({ kind: 'WAVELENGTH_SIDE', playerId: getMyId(), dir });
      });
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
  window.partySyncApp = new PartySyncApp();
});
