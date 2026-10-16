// Главный игровой движок «ВЕЧЕРНИЙ СИНК» (Party Sync Show)
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

const STATE_STORAGE_KEY = 'party_sync_game_state_v1';

const DEFAULT_PLAYERS = [
  { id: 'p1', name: 'Алекс', role: 'dev', score: 0, streak: 0, jokers: ['fifty', 'double', 'ally', 'pass', 'crowd', 'ai_hint'], peerId: null },
  { id: 'p2', name: 'Прогер #2', role: 'dev', score: 0, streak: 0, jokers: ['fifty', 'double', 'ally', 'pass', 'crowd', 'ai_hint'], peerId: null },
  { id: 'p3', name: 'Прогер #3', role: 'dev', score: 0, streak: 0, jokers: ['fifty', 'double', 'ally', 'pass', 'crowd', 'ai_hint'], peerId: null },
  { id: 'p4', name: 'Менеджер #1', role: 'mgr', score: 0, streak: 0, jokers: ['fifty', 'double', 'ally', 'pass', 'crowd', 'ai_hint'], peerId: null },
  { id: 'p5', name: 'Менеджер #2', role: 'mgr', score: 0, streak: 0, jokers: ['fifty', 'double', 'ally', 'pass', 'crowd', 'ai_hint'], peerId: null },
  { id: 'p6', name: 'Менеджер #3', role: 'mgr', score: 0, streak: 0, jokers: ['fifty', 'double', 'ally', 'pass', 'crowd', 'ai_hint'], peerId: null }
];

class PartySyncApp {
  constructor() {
    this.isClientController = false;
    this.clientPlayerId = null;
    this.clientRoomCode = null;
    this.hostSyncedState = null;

    this.state = this.loadState() || this.createInitialState();
    this.timerInterval = null;
    this.speechRecognition = null;

    this.p2p = new P2PRoomManager({
      onPlayerJoin: (peerId, profile) => this.handlePeerJoin(peerId, profile),
      onPlayerAction: (peerId, action) => this.handlePeerAction(peerId, action),
      onHostStateUpdate: (remoteState) => this.handleRemoteState(remoteState),
      onStatusChange: (status, info) => this.handleP2PStatus(status, info)
    });

    this.checkUrlForRoom();
    this.render();
  }

  createInitialState() {
    return {
      screen: 'lobby', // 'lobby' | 'game' | ' podium'
      gameMode: 'show', // 'show' | 'quiz' | 'bluff' | 'wavelength' | 'case'
      currentAct: 'quiz', // Текущий активный суб-режим ('quiz' | 'bluff' | 'wavelength' | 'case')
      totalTurnsTarget: 50,
      turnNumber: 1,
      activePlayerIndex: 0,
      players: JSON.parse(JSON.stringify(DEFAULT_PLAYERS)),
      usedQuestionIds: [],
      usedBluffIds: [],
      usedWavelengthIndices: [],
      usedCaseIds: [],
      customQuestions: [],

      // Состояние текущего хода Квиза
      quiz: {
        currentQuestion: null,
        hiddenOptions: [],
        selectedOption: null,
        revealed: false,
        activeMultiplier: 1,
        allyPlayerId: null,
        aiHintText: null,
        crowdVotes: {}, // playerId -> optionIndex
        showCrowdVotes: false,
        sideBets: {}, // playerId -> 'pass' | 'fail'
        currentEvent: null,
        boxResolved: false,
        boxResultText: null,
        dilemmaPartnerId: null,
        dilemmaChoices: {}, // playerId -> 'coop' | 'betray'
        dilemmaResolved: false,
        dilemmaResultText: null,
        timerSeconds: 45,
        timerRunning: false
      },

      // Состояние хода «Правдоруб (Fibbage)»
      bluff: {
        currentItem: null,
        phase: 'collect', // 'collect' | 'vote' | 'reveal'
        submittedBluffs: {}, // playerId -> text
        choices: [], // [{ id, text, authorIds: [], isTruth: false }]
        votes: {}, // playerId -> choiceId
        funnyVotes: {} // playerId -> choiceId
      },

      // Состояние хода «На одной волне (Wavelength)»
      wavelength: {
        card: null,
        targetValue: 50,
        peekTarget: false,
        clueText: '',
        teamGuess: 50,
        sideVotes: {}, // playerId -> 'left' | 'right'
        revealed: false
      },

      // Состояние хода «Кейс-Баттл с ИИ»
      caseBattle: {
        scenario: null,
        mutator: '',
        answerText: '',
        isJudging: false,
        verdictData: null,
        peerLikes: 0
      }
    };
  }

  loadState() {
    try {
      const raw = localStorage.getItem(STATE_STORAGE_KEY);
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
      this.render();
    }
  }

  handleP2PStatus(status, info) {
    this.p2pStatus = { status, info };
    this.render();
  }

  handlePeerJoin(peerId, profile) {
    sfx.play('joker');
    const existingIdx = this.state.players.findIndex(
      (p) => p.id === profile.slotId || p.name.toLowerCase() === (profile.name || '').toLowerCase()
    );
    if (existingIdx !== -1) {
      this.state.players[existingIdx].peerId = peerId;
      if (profile.name) this.state.players[existingIdx].name = profile.name;
      if (profile.role) this.state.players[existingIdx].role = profile.role;
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

    if (action.kind === 'QUIZ_ANSWER' && activePlayer.id === player.id && !this.state.quiz.revealed) {
      this.selectQuizOption(action.optionIndex);
    } else if (action.kind === 'SIDE_BET' && activePlayer.id !== player.id && !this.state.quiz.revealed) {
      this.setSideBet(player.id, action.bet);
    } else if (action.kind === 'CROWD_VOTE' && !this.state.quiz.revealed) {
      this.state.quiz.crowdVotes[player.id] = action.optionIndex;
      this.saveState();
      this.render();
    } else if (action.kind === 'USE_JOKER' && activePlayer.id === player.id && !this.state.quiz.revealed) {
      this.useJoker(action.jokerId);
    } else if (action.kind === 'SUBMIT_BLUFF' && this.state.bluff.phase === 'collect') {
      this.submitPlayerBluff(player.id, action.text);
    } else if (action.kind === 'VOTE_BLUFF' && this.state.bluff.phase === 'vote') {
      this.voteBluffChoice(player.id, action.choiceId);
    } else if (action.kind === 'WAVELENGTH_SIDE' && !this.state.wavelength.revealed && activePlayer.id !== player.id) {
      this.state.wavelength.sideVotes[player.id] = action.dir;
      this.saveState();
      this.render();
    } else if (action.kind === 'WAVELENGTH_SLIDER' && !this.state.wavelength.revealed) {
      this.state.wavelength.teamGuess = Number(action.value);
      this.saveState();
      this.render();
    } else if (action.kind === 'CASE_SUBMIT' && activePlayer.id === player.id) {
      this.state.caseBattle.answerText = action.text;
      this.saveState();
      this.render();
    } else if (action.kind === 'CASE_LIKE') {
      this.addCasePeerLike();
    }
  }

  broadcastToPeers() {
    if (!this.p2p || !this.p2p.roomCode) return;
    const activePlayer = this.getActivePlayer();
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
      quiz: this.state.quiz.currentQuestion
        ? {
            question: this.state.quiz.currentQuestion.question,
            options: this.state.quiz.currentQuestion.options,
            hiddenOptions: this.state.quiz.hiddenOptions,
            revealed: this.state.quiz.revealed,
            sideBets: this.state.quiz.sideBets
          }
        : null,
      bluff: this.state.bluff.currentItem
        ? {
            prompt: this.state.bluff.currentItem.prompt,
            phase: this.state.bluff.phase,
            choices: this.state.bluff.choices.map((c) => ({ id: c.id, text: c.text })),
            submittedIds: Object.keys(this.state.bluff.submittedBluffs),
            votes: this.state.bluff.votes
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
        : null,
      caseBattle: this.state.caseBattle.scenario
        ? {
            title: this.state.caseBattle.scenario.title,
            situation: this.state.caseBattle.scenario.situation,
            mutator: this.state.caseBattle.mutator,
            answerText: this.state.caseBattle.answerText
          }
        : null
    });
  }

  handleRemoteState(remoteState) {
    this.hostSyncedState = remoteState;
    this.render();
  }

  // --- УПРАВЛЕНИЕ ИГРОКАМИ И ХОДАМИ ---
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

  startNewGame(mode = null) {
    sfx.play('fanfare');
    if (mode) this.state.gameMode = mode;
    this.state.screen = 'game';
    this.state.turnNumber = 1;
    this.state.activePlayerIndex = 0;
    this.state.players.forEach((p) => {
      p.score = 0;
      p.streak = 0;
      p.jokers = ['fifty', 'double', 'ally', 'pass', 'crowd', 'ai_hint'];
    });
    this.prepareTurn();
  }

  switchAct(newAct) {
    sfx.play('event');
    this.state.currentAct = newAct;
    this.prepareTurn(false);
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

    // Если выбран режим «Большое Шоу (4 Акта)», автоматически переключаем раунды каждые 6 ходов (1 полный круг из 6 игроков!)
    if (this.state.gameMode === 'show') {
      const cycle = Math.floor((this.state.turnNumber - 1) / this.state.players.length) % 4;
      const acts = ['quiz', 'bluff', 'wavelength', 'case'];
      this.state.currentAct = acts[cycle];
    } else {
      this.state.currentAct = this.state.gameMode;
    }

    this.prepareTurn();
  }

  prepareTurn(autoEvent = true) {
    this.stopTimer();
    const act = this.state.currentAct;

    if (act === 'quiz') {
      const pool = [...this.state.customQuestions, ...QUIZ_QUESTIONS];
      let available = pool.filter((q) => !this.state.usedQuestionIds.includes(q.id));
      if (available.length === 0) {
        this.state.usedQuestionIds = [];
        available = pool;
      }
      const picked = available[Math.floor(Math.random() * available.length)];
      this.state.usedQuestionIds.push(picked.id);

      // Каждые 3 хода в Квизе — яркий Ивент!
      let eventObj = null;
      if (autoEvent && this.state.turnNumber > 1 && this.state.turnNumber % 3 === 0) {
        eventObj = RANDOM_EVENTS[Math.floor(Math.random() * RANDOM_EVENTS.length)];
        sfx.play('event');
      }

      const otherPlayers = this.state.players.filter((p) => p.id !== this.getActivePlayer().id);
      const randomPartner = otherPlayers.length
        ? otherPlayers[Math.floor(Math.random() * otherPlayers.length)].id
        : null;

      this.state.quiz = {
        currentQuestion: picked,
        hiddenOptions: [],
        selectedOption: null,
        revealed: false,
        activeMultiplier: eventObj?.type === 'multiplier' ? eventObj.multiplier : 1,
        allyPlayerId: null,
        aiHintText: null,
        crowdVotes: {},
        showCrowdVotes: false,
        sideBets: {},
        currentEvent: eventObj,
        boxResolved: false,
        boxResultText: null,
        dilemmaPartnerId: randomPartner,
        dilemmaChoices: {},
        dilemmaResolved: false,
        dilemmaResultText: null,
        timerSeconds: eventObj?.type === 'blitz' ? 15 : 45,
        timerRunning: false
      };
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
        submittedBluffs: {},
        choices: [],
        votes: {},
        funnyVotes: {}
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
        targetValue: Math.floor(Math.random() * 84) + 8, // 8..92
        peekTarget: false,
        clueText: '',
        teamGuess: 50,
        sideVotes: {},
        revealed: false
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
        peerLikes: 0
      };
    }

    this.saveState();
    this.render();
  }

  // --- ЛОГИКА РЕЖИМА 1: КВИЗ-РУЛЕТКА 2.0 ---
  triggerManualEvent() {
    sfx.play('event');
    const ev = RANDOM_EVENTS[Math.floor(Math.random() * RANDOM_EVENTS.length)];
    this.state.quiz.currentEvent = ev;
    if (ev.type === 'multiplier') this.state.quiz.activeMultiplier = ev.multiplier;
    if (ev.type === 'blitz') this.state.quiz.timerSeconds = 15;
    this.saveState();
    this.render();
  }

  resolveMysteryBox(takeSafe) {
    const activePlayer = this.getActivePlayer();
    this.state.quiz.boxResolved = true;
    if (takeSafe) {
      activePlayer.score += 150;
      sfx.play('correct');
      this.state.quiz.boxResultText = `${activePlayer.name} забирает надёжные +150 очков!`;
    } else {
      const outcomes = [
        { delta: 400, text: '💎 ДЖЕКПОТ! В Чёрном Ящике лежало +400 очков!' },
        { delta: 250, text: '🔥 Отличный улов! +250 очков из ящика!' },
        { delta: -100, text: '💥 Ловушка мимика! Ящик откусил -100 очков.' },
        { delta: 0, mult: 2, text: '⚡ Усилитель! Стоимость текущего вопроса удвоена (×2)!' }
      ];
      const out = outcomes[Math.floor(Math.random() * outcomes.length)];
      activePlayer.score += out.delta;
      if (out.mult) this.state.quiz.activeMultiplier *= out.mult;
      sfx.play(out.delta >= 0 ? 'joker' : 'wrong');
      this.state.quiz.boxResultText = out.text;
    }
    this.saveState();
    this.render();
  }

  setDilemmaChoice(playerId, choice) {
    sfx.play('click');
    this.state.quiz.dilemmaChoices[playerId] = choice;
    const activePlayer = this.getActivePlayer();
    const partnerId = this.state.quiz.dilemmaPartnerId;

    if (this.state.quiz.dilemmaChoices[activePlayer.id] && this.state.quiz.dilemmaChoices[partnerId]) {
      const c1 = this.state.quiz.dilemmaChoices[activePlayer.id];
      const c2 = this.state.quiz.dilemmaChoices[partnerId];
      const partner = this.state.players.find((p) => p.id === partnerId);
      this.state.quiz.dilemmaResolved = true;

      if (c1 === 'coop' && c2 === 'coop') {
        activePlayer.score += 200;
        if (partner) partner.score += 200;
        sfx.play('correct');
        this.state.quiz.dilemmaResultText = `🤝 Настоящая командная синергия! ${activePlayer.name} и ${partner?.name} получают по +200 очков!`;
      } else if (c1 === 'betray' && c2 === 'coop') {
        activePlayer.score += 350;
        if (partner) partner.score -= 100;
        sfx.play('joker');
        this.state.quiz.dilemmaResultText = `🗡️ Коварный манёвр! ${activePlayer.name} забирает +350 очков, а доверчивый ${partner?.name} теряет 100!`;
      } else if (c1 === 'coop' && c2 === 'betray') {
        activePlayer.score -= 100;
        if (partner) partner.score += 350;
        sfx.play('joker');
        this.state.quiz.dilemmaResultText = `🗡️ Удар в спину! ${partner?.name} уносит +350 очков, оставив ${activePlayer.name} с -100!`;
      } else {
        activePlayer.score -= 150;
        if (partner) partner.score -= 150;
        sfx.play('wrong');
        this.state.quiz.dilemmaResultText = `💀 Оба нажали «Крысить»! Банк сгорел, оба теряют по -150 очков!`;
      }
    }
    this.saveState();
    this.render();
  }

  setSideBet(playerId, betType) {
    sfx.play('click');
    if (this.state.quiz.sideBets[playerId] === betType) {
      delete this.state.quiz.sideBets[playerId];
    } else {
      this.state.quiz.sideBets[playerId] = betType;
    }
    this.saveState();
    this.render();
  }

  async useJoker(jokerId, targetPlayerId = null) {
    const player = this.getActivePlayer();
    const q = this.state.quiz.currentQuestion;
    if (!player || !q || this.state.quiz.revealed) return;
    if (!player.jokers.includes(jokerId)) return;

    if (jokerId === 'fifty') {
      sfx.play('joker');
      player.jokers = player.jokers.filter((j) => j !== 'fifty');
      const wrongIndices = [0, 1, 2, 3].filter((i) => i !== q.answer);
      wrongIndices.sort(() => Math.random() - 0.5);
      this.state.quiz.hiddenOptions = wrongIndices.slice(0, 2);
    } else if (jokerId === 'double') {
      sfx.play('joker');
      player.jokers = player.jokers.filter((j) => j !== 'double');
      this.state.quiz.activeMultiplier *= 2;
    } else if (jokerId === 'crowd') {
      sfx.play('joker');
      player.jokers = player.jokers.filter((j) => j !== 'crowd');
      this.state.quiz.showCrowdVotes = true;
    } else if (jokerId === 'ally') {
      const otherPlayers = this.state.players.filter((p) => p.id !== player.id);
      const chosenId = targetPlayerId || otherPlayers[0]?.id;
      if (chosenId) {
        sfx.play('joker');
        player.jokers = player.jokers.filter((j) => j !== 'ally');
        this.state.quiz.allyPlayerId = chosenId;
      }
    } else if (jokerId === 'pass') {
      const otherPlayers = this.state.players.filter((p) => p.id !== player.id);
      const chosenId = targetPlayerId || otherPlayers[Math.floor(Math.random() * otherPlayers.length)]?.id;
      if (chosenId) {
        sfx.play('joker');
        player.jokers = player.jokers.filter((j) => j !== 'pass');
        const newIdx = this.state.players.findIndex((p) => p.id === chosenId);
        if (newIdx !== -1) {
          this.state.activePlayerIndex = newIdx;
        }
      }
    } else if (jokerId === 'ai_hint') {
      sfx.play('joker');
      player.jokers = player.jokers.filter((j) => j !== 'ai_hint');
      this.state.quiz.aiHintText = '🤖 Нейро-Оракул анализирует вопрос...';
      this.render();
      const hint = await aiClient.generateHint(q);
      this.state.quiz.aiHintText = hint;
    }

    this.saveState();
    this.render();
  }

  selectQuizOption(index) {
    if (this.state.quiz.revealed) return;
    this.stopTimer();

    const q = this.state.quiz.currentQuestion;
    const activePlayer = this.getActivePlayer();
    const isCorrect = index === q.answer;

    this.state.quiz.selectedOption = index;
    this.state.quiz.revealed = true;

    let basePoints = q.points * this.state.quiz.activeMultiplier;
    if (this.state.quiz.currentEvent?.type === 'blitz' && isCorrect) {
      basePoints += this.state.quiz.currentEvent.bonus || 250;
    }

    if (isCorrect) {
      sfx.play('correct');
      activePlayer.score += basePoints;
      activePlayer.streak = (activePlayer.streak || 0) + 1;

      // Бонус за серию из 3 верных ответов подряд
      if (activePlayer.streak >= 3) {
        activePlayer.score += 100;
      }

      // Если был взят Джокер «Консилиум»
      if (this.state.quiz.allyPlayerId) {
        const ally = this.state.players.find((p) => p.id === this.state.quiz.allyPlayerId);
        if (ally) ally.score += 150;
      }

      // Если ивент «Робин Гуд»
      if (this.state.quiz.currentEvent?.type === 'steal_leader') {
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
      if (this.state.quiz.activeMultiplier > 1) {
        activePlayer.score -= 150;
      }
    }

    // Расчёт ставок зрителей (Side Bets)
    const betDelta = this.state.quiz.currentEvent?.type === 'multiplier' ? 150 : 100;
    for (const [pid, bet] of Object.entries(this.state.quiz.sideBets)) {
      const voter = this.state.players.find((p) => p.id === pid);
      if (!voter) continue;
      if ((bet === 'pass' && isCorrect) || (bet === 'fail' && !isCorrect)) {
        voter.score += betDelta;
      } else {
        voter.score -= 50;
      }
    }

    this.saveState();
    this.render();
  }

  // --- ЛОГИКА РЕЖИМА 2: ПРАВДОРУБ (FIBBAGE БЛЕФ) ---
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

    // 1. Настоящая правда
    choices.push({
      id: 'truth',
      text: item.truth,
      authorIds: [],
      isTruth: true
    });

    // 2. Блефы от игроков
    for (const [pid, text] of Object.entries(this.state.bluff.submittedBluffs)) {
      if (text.toLowerCase() === item.truth.toLowerCase()) continue;
      const existing = choices.find((c) => c.text.toLowerCase() === text.toLowerCase());
      if (existing) {
        existing.authorIds.push(pid);
      } else {
        choices.push({
          id: `bluff_${pid}`,
          text,
          authorIds: [pid],
          isTruth: false
        });
      }
    }

    // 3. Добиваем правдоподобными заготовками (идеально, если играете на одном экране в ДС без ввода с телефонов!)
    const targetCount = useQuickDecoys ? 5 : Math.max(4, choices.length + 1);
    for (const decoy of item.decoyBluffs) {
      if (choices.length >= targetCount) break;
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
    sfx.play('click');
    this.state.bluff.votes[playerId] = choiceId;
    this.saveState();
    this.render();
  }

  revealBluffResults() {
    sfx.play('fanfare');
    this.state.bluff.phase = 'reveal';

    for (const [voterId, choiceId] of Object.entries(this.state.bluff.votes)) {
      const voter = this.state.players.find((p) => p.id === voterId);
      const chosen = this.state.bluff.choices.find((c) => c.id === choiceId);
      if (!voter || !chosen) continue;

      if (chosen.isTruth) {
        voter.score += 400; // Угадал правду!
      } else if (chosen.authorIds.length > 0) {
        // Игрок попался на блеф коллеги -> автор блефа получает +300 очков!
        chosen.authorIds.forEach((authorId) => {
          if (authorId !== voterId) {
            const author = this.state.players.find((p) => p.id === authorId);
            if (author) author.score += 300;
          }
        });
      }
    }

    if (window.confetti) {
      window.confetti({ particleCount: 50, spread: 70, origin: { y: 0.65 } });
    }
    this.saveState();
    this.render();
  }

  // --- ЛОГИКА РЕЖИМА 3: НА ОДНОЙ ВОЛНЕ (WAVELENGTH) ---
  revealWavelength() {
    if (this.state.wavelength.revealed) return;
    this.state.wavelength.revealed = true;

    const diff = Math.abs(this.state.wavelength.targetValue - this.state.wavelength.teamGuess);
    const activePlayer = this.getActivePlayer();

    let points = 0;
    if (diff <= 4) points = 500;
    else if (diff <= 10) points = 350;
    else if (diff <= 18) points = 200;

    if (points > 0) {
      sfx.play('correct');
      activePlayer.score += points;
      if (window.confetti && points >= 350) {
        window.confetti({ particleCount: 60, spread: 70, origin: { y: 0.6 } });
      }
    } else {
      sfx.play('wrong');
    }

    // Проверяем ставки остальных игроков «Левее / Правее»
    const actualDir = this.state.wavelength.targetValue < this.state.wavelength.teamGuess ? 'left' : 'right';
    for (const [pid, guessedDir] of Object.entries(this.state.wavelength.sideVotes)) {
      const p = this.state.players.find((pl) => pl.id === pid);
      if (!p) continue;
      if (diff <= 4 || guessedDir === actualDir) {
        p.score += 150;
      }
    }

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
      alert('Ваш браузер не поддерживает голосовой ввод Web Speech API (лучше всего работает в Chrome/Edge).');
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
      this.state.caseBattle.answerText = 'Команда решила вопрос устной дипломатией в голосовом канале Discord!';
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

  addCasePeerLike() {
    sfx.play('joker');
    this.state.caseBattle.peerLikes += 1;
    const activePlayer = this.getActivePlayer();
    activePlayer.score += 50;
    this.saveState();
    this.render();
  }

  // --- ТАЙМЕР ---
  toggleTimer() {
    if (this.state.quiz.timerRunning) {
      this.stopTimer();
    } else {
      this.state.quiz.timerRunning = true;
      this.timerInterval = setInterval(() => {
        if (this.state.quiz.timerSeconds > 0) {
          this.state.quiz.timerSeconds -= 1;
          sfx.play(this.state.quiz.timerSeconds <= 5 ? 'urgent_tick' : 'tick');
          const timerEl = document.getElementById('quiz-timer-val');
          if (timerEl) timerEl.textContent = `${this.state.quiz.timerSeconds}с`;
        } else {
          this.stopTimer();
          sfx.play('wrong');
          this.render();
        }
      }, 1000);
    }
    this.render();
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

  // --- МОДАЛКИ: YANDEX CLOUD AI & P2P ROOM ---
  openAiModal() {
    const modal = document.getElementById('ai-modal');
    if (modal) modal.classList.remove('hidden');
  }

  closeAiModal() {
    const modal = document.getElementById('ai-modal');
    if (modal) modal.classList.add('hidden');
  }

  async saveAndTestAiConfig() {
    const apiKey = document.getElementById('yc-api-key')?.value || '';
    const folderId = document.getElementById('yc-folder-id')?.value || '';
    const model = document.getElementById('yc-model')?.value || 'yandexgpt/latest';
    const customEndpoint = document.getElementById('yc-custom-ep')?.value || '';

    aiClient.saveConfig({ apiKey, folderId, model, customEndpoint });
    const statusEl = document.getElementById('yc-status-msg');
    if (statusEl) {
      statusEl.innerHTML = `<span class="text-indigo-400">⏳ Сохранено в localStorage! Проверяем связь с YandexGPT...</span>`;
    }

    if (!apiKey.trim()) {
      if (statusEl) statusEl.innerHTML = `<span class="text-amber-400">Ключ очищен. Игра работает на встроенной базе (150+ карточек).</span>`;
      this.render();
      return;
    }

    try {
      const reply = await aiClient.complete('Ответь одним предложением.', 'Поприветствуй команду из 3 менеджеров и 3 прогеров!', 0.6);
      if (statusEl) {
        statusEl.innerHTML = `<span class="text-emerald-400">✅ Успех! Ответ YandexGPT: «${reply}»</span>`;
      }
      sfx.play('correct');
    } catch (err) {
      if (statusEl) {
        statusEl.innerHTML = `<span class="text-amber-300">⚠️ Ключ сохранён, но браузер заблокировал прямой CORS-запрос (${err.message}). Запустите локальный мост <code>node yandex-bridge.mjs</code> в терминале для 100% работы с GitHub Pages!</span>`;
      }
    }
  }

  async generateAiPackFromModal() {
    const topicInput = document.getElementById('ai-topic-input');
    const topic = topicInput?.value?.trim() || 'Кино, видеоигры, курьёзы в IT и менеджменте';
    const statusEl = document.getElementById('yc-status-msg');

    if (!aiClient.isConfigured()) {
      if (statusEl) statusEl.innerHTML = `<span class="text-rose-400">Сначала введите API-ключ Yandex Cloud выше!</span>`;
      return;
    }

    try {
      if (statusEl) statusEl.innerHTML = `<span class="text-indigo-400">✨ YandexGPT генерирует 5 свежих вопросов по теме «${topic}»...</span>`;
      const newQuestions = await aiClient.generateCustomQuestions(topic, 5);
      if (newQuestions.length > 0) {
        this.state.customQuestions = [...newQuestions, ...this.state.customQuestions];
        this.saveState();
        sfx.play('fanfare');
        if (statusEl) {
          statusEl.innerHTML = `<span class="text-emerald-400">🎉 Добавлено ${newQuestions.length} новых вопросов от YandexGPT в начало колоды!</span>`;
        }
        this.render();
      }
    } catch (err) {
      if (statusEl) {
        statusEl.innerHTML = `<span class="text-rose-400">Ошибка генерации: ${err.message}</span>`;
      }
    }
  }

  // --- РЕНДЕРИНГ ИНТЕРФЕЙСА ---
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
        <main class="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6">
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
      <header class="border-b border-white/10 bg-[#090b12]/80 backdrop-blur-xl sticky top-0 z-30">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <button id="btn-home-logo" class="flex items-center gap-2.5 text-left group">
              <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 flex items-center justify-center shadow-lg shadow-indigo-500/25 group-hover:scale-105 transition">
                <i data-lucide="zap" class="w-5 h-5 text-white"></i>
              </div>
              <div>
                <div class="font-display font-extrabold text-lg tracking-tight leading-none flex items-center gap-2">
                  ВЕЧЕРНИЙ СИНК
                  <span class="text-[11px] font-mono-code uppercase px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">6 Players Edition</span>
                </div>
                <div class="text-xs text-slate-400">Интерактивное шоу для Discord • 3 Прогера & 3 Менеджера</div>
              </div>
            </button>
          </div>

          <!-- Табло командного зачёта Прогеры vs Менеджеры -->
          <div class="hidden md:flex items-center gap-3 px-3.5 py-1.5 rounded-full bg-white/5 border border-white/10 text-xs font-medium">
            <span class="flex items-center gap-1.5 text-indigo-300">
              💻 Прогеры: <strong class="font-mono-code text-white text-sm">${devScore}</strong>
            </span>
            <span class="text-slate-600">vs</span>
            <span class="flex items-center gap-1.5 text-pink-300">
              📊 Менеджеры: <strong class="font-mono-code text-white text-sm">${mgrScore}</strong>
            </span>
          </div>

          <div class="flex items-center gap-2">
            ${
              this.p2p.roomCode
                ? `<button id="btn-copy-room" data-url="${roomUrl}" class="px-3 py-1.5 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-xs font-mono-code flex items-center gap-1.5 hover:bg-emerald-500/25 transition" title="Нажмите, чтобы скопировать ссылку на пульт для игроков в Discord">
                    <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                    Комната: <strong>${this.p2p.roomCode}</strong> (${this.p2p.connections.size} подкл.)
                    <i data-lucide="copy" class="w-3.5 h-3.5"></i>
                  </button>`
                : `<button id="btn-start-p2p" class="px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 text-xs font-medium flex items-center gap-1.5 transition">
                    <i data-lucide="smartphone" class="w-3.5 h-3.5 text-indigo-400"></i>
                    <span class="hidden sm:inline">Пульты с телефонов (P2P)</span>
                  </button>`
            }

            <button id="btn-open-ai" class="px-3 py-1.5 rounded-xl ${
              aiReady
                ? 'bg-fuchsia-500/20 border-fuchsia-500/40 text-fuchsia-200'
                : 'bg-white/5 border-white/10 text-slate-300'
            } border hover:bg-white/15 text-xs font-medium flex items-center gap-1.5 transition">
              <i data-lucide="sparkles" class="w-3.5 h-3.5 ${aiReady ? 'text-fuchsia-400' : 'text-slate-400'}"></i>
              <span class="hidden sm:inline">${aiReady ? 'YandexGPT Активен' : 'Yandex Cloud AI'}</span>
            </button>

            <button id="btn-toggle-sound" class="p-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 transition" title="Звуковые эффекты">
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
        id: 'show',
        title: '🎰 Большое Вечернее Шоу (Все 4 режима)',
        badge: 'ХИТ ВЕЧЕРА',
        desc: 'Каждые 6 ходов (круг игроков) игра меняет раунд: 1) Квиз с джокерами и ставками → 2) Правдоруб (Блеф) → 3) На одной волне → 4) Кейс-Баттл с ИИ!',
        color: 'from-indigo-500/20 via-purple-500/15 to-pink-500/20 border-indigo-500/40'
      },
      {
        id: 'quiz',
        title: '🎯 50 Вопросов 2.0 (Джокеры + Ивенты + Ставки)',
        badge: 'КЛАССИКА НА СТЕРОИДАХ',
        desc: 'Ваш любимый поочерёдный формат, но теперь с 6 Джокерами, ставками зрителей на каждом вопросе, Чёрным Ящиком и Дилеммой заключённого!',
        color: 'from-blue-500/15 to-indigo-500/10 border-white/10'
      },
      {
        id: 'bluff',
        title: '🎭 Правдоруб (Fibbage Блеф-Клуб)',
        badge: 'ИНТРИГА',
        desc: 'Безумные реальные факты с пропуском. Придумай правдоподобную ложь, замани коллег в ловушку и найди настоящую правду!',
        color: 'from-pink-500/15 to-rose-500/10 border-white/10'
      },
      {
        id: 'wavelength',
        title: '📡 На одной волне (Wavelength)',
        badge: 'ЧТЕНИЕ МЫСЛЕЙ',
        desc: 'Ведущий хода видит секретный процент между двумя полюсами и даёт ассоциацию. Команда в Discord спорит и крутит стрелку спидометра!',
        color: 'from-emerald-500/15 to-teal-500/10 border-white/10'
      },
      {
        id: 'case',
        title: '🤖 Кейс-Баттл с YandexGPT',
        badge: 'ИМПРОВИЗАЦИЯ',
        desc: 'Весёлые рабочие и жизненные катастрофы + секретное условие-мутатор. Озвучь свой план спасения за 45 секунд и получи оценку от ИИ и коллег!',
        color: 'from-amber-500/15 to-orange-500/10 border-white/10'
      }
    ];

    return `
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start animate-pop">
        <!-- Левая колонка: Состав команды (6 игроков) -->
        <div class="lg:col-span-5 glass-card rounded-3xl p-6">
          <div class="flex items-center justify-between mb-4">
            <div>
              <h2 class="font-display font-bold text-xl flex items-center gap-2">
                <i data-lucide="users" class="w-5 h-5 text-indigo-400"></i>
                Участники созвона (${this.state.players.length})
              </h2>
              <p class="text-xs text-slate-400 mt-0.5">Впишите имена коллег и выберите роль (Прогер 💻 / Менеджер 📊)</p>
            </div>
            <button id="btn-add-player" class="px-3 py-1.5 rounded-xl bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-500/40 text-indigo-300 text-xs font-semibold flex items-center gap-1 transition">
              <i data-lucide="user-plus" class="w-3.5 h-3.5"></i> Добавить
            </button>
          </div>

          <div class="space-y-2.5 max-h-[430px] overflow-y-auto pr-1">
            ${this.state.players
              .map(
                (p, idx) => `
              <div class="flex items-center gap-2 p-2.5 rounded-2xl bg-white/[0.04] border border-white/10">
                <span class="w-6 text-center font-mono-code text-xs text-slate-400">${idx + 1}</span>
                <input
                  type="text"
                  data-player-name="${p.id}"
                  value="${this.escapeHtml(p.name)}"
                  class="flex-1 bg-transparent border-b border-transparent focus:border-indigo-400 focus:outline-none text-sm font-semibold text-white px-1 py-0.5"
                  placeholder="Имя игрока"
                />
                <button
                  data-toggle-role="${p.id}"
                  class="px-2.5 py-1 rounded-lg text-xs font-medium transition border ${
                    p.role === 'dev'
                      ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-300'
                      : 'bg-pink-500/20 border-pink-500/40 text-pink-300'
                  }"
                  title="Нажмите, чтобы переключить роль Прогер / Менеджер"
                >
                  ${p.role === 'dev' ? '💻 Прогер' : '📊 Менеджер'}
                </button>
                ${
                  this.state.players.length > 2
                    ? `<button data-remove-player="${p.id}" class="p-1 text-slate-500 hover:text-rose-400 transition" title="Удалить">
                        <i data-lucide="x" class="w-4 h-4"></i>
                      </button>`
                    : ''
                }
              </div>
            `
              )
              .join('')}
          </div>

          <div class="mt-5 pt-4 border-t border-white/10 flex items-center justify-between gap-2 text-xs text-slate-400">
            <span>Длительность партии (ходов):</span>
            <div class="flex items-center gap-1.5">
              ${[18, 30, 50]
                .map(
                  (num) => `
                <button data-set-turns="${num}" class="px-3 py-1 rounded-lg font-mono-code font-semibold border transition ${
                    this.state.totalTurnsTarget === num
                      ? 'bg-indigo-500 text-white border-indigo-400'
                      : 'bg-white/5 text-slate-300 border-white/10 hover:bg-white/10'
                  }">${num}</button>
              `
                )
                .join('')}
            </div>
          </div>
        </div>

        <!-- Правая колонка: Выбор режима и старт -->
        <div class="lg:col-span-7 glass-card rounded-3xl p-6">
          <div class="flex items-center justify-between mb-4">
            <div>
              <h2 class="font-display font-bold text-xl flex items-center gap-2">
                <i data-lucide="gamepad-2" class="w-5 h-5 text-pink-400"></i>
                Выберите формат игры
              </h2>
              <p class="text-xs text-slate-400 mt-0.5">Режимы можно переключать даже прямо во время партии с сохранением очков!</p>
            </div>
          </div>

          <div class="space-y-3">
            ${modes
              .map(
                (m) => `
              <div
                data-select-mode="${m.id}"
                class="cursor-pointer p-4 rounded-2xl bg-gradient-to-r ${m.color} border transition hover:scale-[1.01] ${
                  this.state.gameMode === m.id ? 'ring-2 ring-indigo-400 shadow-lg shadow-indigo-500/15' : 'opacity-85 hover:opacity-100'
                }"
              >
                <div class="flex items-center justify-between gap-2">
                  <div class="font-display font-bold text-base text-white">${m.title}</div>
                  <span class="text-[10px] font-mono-code font-bold uppercase px-2.5 py-0.5 rounded-full bg-white/10 text-indigo-200 border border-white/15">
                    ${m.badge}
                  </span>
                </div>
                <p class="text-xs text-slate-300 mt-1.5 leading-relaxed">${m.desc}</p>
              </div>
            `
              )
              .join('')}
          </div>

          <div class="mt-6 flex flex-wrap items-center gap-3">
            <button id="btn-start-game" class="flex-1 py-3.5 px-6 rounded-2xl bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 hover:from-indigo-400 hover:to-pink-400 text-white font-display font-bold text-base shadow-xl shadow-indigo-500/25 flex items-center justify-center gap-2 transition transform hover:-translate-y-0.5">
              <i data-lucide="play" class="w-5 h-5 fill-current"></i>
              ЗАПУСТИТЬ ВЕЧЕРНИЙ СИНК
            </button>

            ${
              this.state.turnNumber > 1
                ? `<button id="btn-resume-game" class="py-3.5 px-5 rounded-2xl bg-white/10 hover:bg-white/15 border border-white/15 text-white font-semibold text-sm flex items-center gap-2 transition">
                    <i data-lucide="rotate-cw" class="w-4 h-4 text-emerald-400"></i>
                    Продолжить (Ход ${this.state.turnNumber})
                  </button>`
                : ''
            }
          </div>
        </div>
      </div>
    `;
  }

  renderGameScreen() {
    const activePlayer = this.getActivePlayer();

    return `
      <div class="space-y-6 animate-pop">
        <!-- Верхняя полоса игроков (6 карточек с очками, ролями и быстрым переключением) -->
        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          ${this.state.players
            .map((p, idx) => {
              const isTurn = idx === this.state.activePlayerIndex;
              return `
                <div
                  data-make-active="${idx}"
                  class="cursor-pointer rounded-2xl p-3 transition relative ${
                    isTurn ? 'glass-card active-player-glow' : 'glass-card-interactive opacity-85 hover:opacity-100'
                  }"
                  title="Кликните, чтобы передать ход этому игроку"
                >
                  ${
                    isTurn
                      ? `<div class="absolute -top-2.5 left-3 px-2 py-0.5 rounded-full bg-indigo-500 text-[10px] font-bold uppercase tracking-wider text-white shadow">
                          Сейчас отвечает
                        </div>`
                      : ''
                  }
                  <div class="flex items-center justify-between gap-1 mt-0.5">
                    <div class="font-bold text-sm truncate text-white flex items-center gap-1.5">
                      <span>${p.role === 'dev' ? '💻' : '📊'}</span>
                      <span class="truncate">${this.escapeHtml(p.name)}</span>
                    </div>
                    ${
                      p.streak >= 2
                        ? `<span class="text-[11px] font-mono-code text-amber-400" title="Серия верных ответов">🔥${p.streak}</span>`
                        : ''
                    }
                  </div>
                  <div class="mt-2 flex items-baseline justify-between">
                    <div class="font-mono-code font-extrabold text-xl ${
                      p.score >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }">${p.score}</div>
                    <div class="flex items-center gap-1">
                      <button data-score-minus="${p.id}" class="w-5 h-5 rounded bg-white/5 hover:bg-rose-500/30 text-slate-400 hover:text-white text-xs flex items-center justify-center" title="-50 очков">-</button>
                      <button data-score-plus="${p.id}" class="w-5 h-5 rounded bg-white/5 hover:bg-emerald-500/30 text-slate-400 hover:text-white text-xs flex items-center justify-center" title="+50 очков">+</button>
                    </div>
                  </div>
                  <div class="mt-1.5 flex items-center gap-1 flex-wrap">
                    <span class="text-[10px] text-slate-400">Джокеров: ${p.jokers.length}</span>
                    ${p.peerId ? `<span class="ml-auto text-[10px] text-emerald-400">📱 онлайн</span>` : ''}
                  </div>
                </div>
              `;
            })
            .join('')}
        </div>

        <!-- Панель переключения раундов и прогресса хода -->
        <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 rounded-2xl bg-white/[0.03] border border-white/10">
          <div class="flex items-center gap-3">
            <span class="font-mono-code text-xs px-2.5 py-1 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 font-bold">
              ХОД ${this.state.turnNumber} / ${this.state.totalTurnsTarget}
            </span>
            <span class="text-xs text-slate-300">
              Отвечает: <strong class="text-white">${this.escapeHtml(activePlayer.name)}</strong>
              (${activePlayer.role === 'dev' ? '💻 Прогер' : '📊 Менеджер'})
            </span>
          </div>

          <!-- Быстрое переключение раундов на лету -->
          <div class="flex items-center gap-1.5 flex-wrap">
            ${[
              { id: 'quiz', label: '🎯 Квиз 2.0' },
              { id: 'bluff', label: '🎭 Правдоруб' },
              { id: 'wavelength', label: '📡 На волне' },
              { id: 'case', label: '🤖 Кейс-Баттл' }
            ]
              .map(
                (tab) => `
              <button
                data-switch-act="${tab.id}"
                class="px-3 py-1 rounded-xl text-xs font-semibold transition border ${
                  this.state.currentAct === tab.id
                    ? 'bg-indigo-500 text-white border-indigo-400 shadow'
                    : 'bg-white/5 text-slate-300 border-white/10 hover:bg-white/10'
                }"
              >${tab.label}</button>
            `
              )
              .join('')}
            <button id="btn-to-lobby" class="ml-2 px-2.5 py-1 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs text-slate-400 hover:text-white transition">
              ⚙️ В лобби
            </button>
            <button id="btn-end-game" class="px-2.5 py-1 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-xs text-amber-300 transition">
              🏆 Итоги
            </button>
          </div>
        </div>

        <!-- Контент активного раунда -->
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

  renderQuizAct() {
    const q = this.state.quiz.currentQuestion;
    if (!q) return '';
    const activePlayer = this.getActivePlayer();
    const cat = CATEGORIES[q.category] || CATEGORIES.weird_world;
    const ev = this.state.quiz.currentEvent;

    return `
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <!-- Основная карточка вопроса (8 колонок) -->
        <div class="lg:col-span-8 space-y-4">
          ${
            ev
              ? `<div class="p-4 rounded-2xl bg-gradient-to-r from-amber-500/20 via-pink-500/20 to-purple-500/20 border border-amber-400/50 animate-pop">
                  <div class="flex items-center justify-between">
                    <div class="font-display font-extrabold text-amber-300 text-base">${ev.title}</div>
                    <span class="text-[11px] font-mono-code uppercase px-2 py-0.5 rounded bg-amber-500/20 text-amber-200">Ивент хода</span>
                  </div>
                  <p class="text-xs text-slate-200 mt-1">${ev.desc}</p>
                  ${this.renderEventInteractiveWidget(ev)}
                </div>`
              : ''
          }

          <div class="glass-card rounded-3xl p-6 sm:p-8 relative overflow-hidden">
            <div class="flex flex-wrap items-center justify-between gap-2 mb-5">
              <div class="flex items-center gap-2">
                <span class="px-3 py-1 rounded-full text-xs font-semibold bg-indigo-500/20 border border-indigo-500/40 text-indigo-300">
                  ${cat.name}
                </span>
                <span class="px-3 py-1 rounded-full text-xs font-mono-code font-bold bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
                  +${q.points * this.state.quiz.activeMultiplier} очков
                </span>
                ${
                  q.isAi
                    ? `<span class="px-2.5 py-1 rounded-full text-xs font-semibold bg-fuchsia-500/20 border border-fuchsia-500/40 text-fuchsia-300">🤖 YandexGPT</span>`
                    : ''
                }
              </div>

              <!-- Таймер и кнопка случайного Ивента -->
              <div class="flex items-center gap-2">
                <button id="btn-roll-event" class="px-3 py-1 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-300 text-xs font-semibold flex items-center gap-1 transition" title="Запустить случайное игровое событие на этот вопрос">
                  🎲 Ивент!
                </button>
                <button id="btn-quiz-timer" class="px-3 py-1 rounded-xl border text-xs font-mono-code font-bold flex items-center gap-1.5 transition ${
                  this.state.quiz.timerRunning
                    ? 'bg-rose-500/20 border-rose-500/40 text-rose-300 animate-pulse'
                    : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'
                }">
                  <i data-lucide="timer" class="w-3.5 h-3.5"></i>
                  <span id="quiz-timer-val">${this.state.quiz.timerSeconds}с</span>
                </button>
              </div>
            </div>

            <h3 class="font-display font-bold text-xl sm:text-2xl text-white leading-snug mb-6">
              ${this.escapeHtml(q.question)}
            </h3>

            ${
              this.state.quiz.aiHintText
                ? `<div class="mb-5 p-3.5 rounded-2xl bg-fuchsia-500/15 border border-fuchsia-500/30 text-xs text-fuchsia-200 flex items-start gap-2.5 animate-pop">
                    <i data-lucide="sparkles" class="w-4 h-4 text-fuchsia-400 shrink-0 mt-0.5"></i>
                    <div><strong>Подсказка Оракула:</strong> ${this.escapeHtml(this.state.quiz.aiHintText)}</div>
                  </div>`
                : ''
            }

            ${
              this.state.quiz.allyPlayerId
                ? `<div class="mb-5 p-3 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 text-xs text-emerald-200 flex items-center gap-2">
                    🤝 <strong>Консилиум активен:</strong> ${this.escapeHtml(
                      this.state.players.find((p) => p.id === this.state.quiz.allyPlayerId)?.name || 'Коллега'
                    )} помогает советом (+150 очков при успехе)!
                  </div>`
                : ''
            }

            <!-- Варианты ответов A, B, C, D -->
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              ${q.options
                .map((opt, idx) => {
                  const letters = ['A', 'B', 'C', 'D'];
                  const isHidden = this.state.quiz.hiddenOptions.includes(idx);
                  const isRevealed = this.state.quiz.revealed;
                  const isCorrect = idx === q.answer;
                  const isSelected = idx === this.state.quiz.selectedOption;

                  let cardStyle = 'glass-card-interactive text-white';
                  if (isHidden) {
                    cardStyle = 'opacity-20 pointer-events-none bg-white/[0.02] border border-white/5';
                  } else if (isRevealed) {
                    if (isCorrect) {
                      cardStyle = 'bg-emerald-500/25 border-2 border-emerald-400 text-white shadow-lg shadow-emerald-500/20';
                    } else if (isSelected && !isCorrect) {
                      cardStyle = 'bg-rose-500/25 border-2 border-rose-400 text-rose-100';
                    } else {
                      cardStyle = 'opacity-50 bg-white/[0.03] border border-white/10';
                    }
                  }

                  // Голоса зала для джокера «Голос Discord»
                  const votersForOpt = Object.entries(this.state.quiz.crowdVotes)
                    .filter(([, vIdx]) => vIdx === idx)
                    .map(([pid]) => this.state.players.find((p) => p.id === pid)?.name)
                    .filter(Boolean);

                  return `
                    <button
                      data-quiz-option="${idx}"
                      ${isHidden || isRevealed ? 'disabled' : ''}
                      class="p-4 rounded-2xl text-left flex items-start gap-3.5 transition ${cardStyle}"
                    >
                      <span class="w-8 h-8 rounded-xl bg-white/10 border border-white/15 font-mono-code font-bold text-sm flex items-center justify-center shrink-0">
                        ${letters[idx]}
                      </span>
                      <div class="flex-1">
                        <div class="font-medium text-sm sm:text-base leading-snug">${this.escapeHtml(opt)}</div>
                        ${
                          this.state.quiz.showCrowdVotes && votersForOpt.length > 0
                            ? `<div class="mt-1.5 text-[11px] text-cyan-300">📢 За этот вариант: ${votersForOpt.join(', ')}</div>`
                            : ''
                        }
                      </div>
                    </button>
                  `;
                })
                .join('')}
            </div>

            <!-- Блок объяснения после ответа -->
            ${
              this.state.quiz.revealed
                ? `<div class="mt-6 p-4 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 animate-pop">
                    <div class="flex items-start justify-between gap-4">
                      <div>
                        <div class="text-xs font-bold uppercase tracking-wider text-indigo-300 mb-1">
                          ${
                            this.state.quiz.selectedOption === q.answer
                              ? '🎉 Верный ответ!'
                              : '💡 Интересный факт:'
                          }
                        </div>
                        <p class="text-sm text-slate-200 leading-relaxed">${this.escapeHtml(q.explanation)}</p>
                      </div>
                      <button id="btn-next-turn" class="px-5 py-3 rounded-xl bg-gradient-to-r from-indigo-500 to-pink-500 hover:from-indigo-400 hover:to-pink-400 text-white font-display font-bold text-sm shrink-0 flex items-center gap-2 shadow-lg shadow-indigo-500/25 transition">
                        Следующий ход <i data-lucide="arrow-right" class="w-4 h-4"></i>
                      </button>
                    </div>
                  </div>`
                : ''
            }
          </div>
        </div>

        <!-- Правая колонка: Арсенал Джокеров и Ставки остальных 5 игроков (4 колонки) -->
        <div class="lg:col-span-4 space-y-4">
          <!-- Арсенал Джокеров активного игрока -->
          <div class="glass-card rounded-3xl p-5">
            <div class="flex items-center justify-between mb-3">
              <h4 class="font-display font-bold text-sm uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                <i data-lucide="wand-2" class="w-4 h-4 text-indigo-400"></i>
                Джокеры игрока ${this.escapeHtml(activePlayer.name)}
              </h4>
              <span class="text-xs text-slate-400">${activePlayer.jokers.length} / 6</span>
            </div>

            <div class="grid grid-cols-2 gap-2.5">
              ${JOKERS.map((jk) => {
                const available = activePlayer.jokers.includes(jk.id);
                return `
                  <button
                    data-use-joker="${jk.id}"
                    ${!available || this.state.quiz.revealed ? 'disabled' : ''}
                    class="p-2.5 rounded-xl border text-left transition ${
                      available && !this.state.quiz.revealed
                        ? `bg-gradient-to-br ${jk.color} bg-opacity-20 border-white/20 hover:scale-[1.02] text-white shadow`
                        : 'bg-white/[0.02] border-white/5 text-slate-600 opacity-35 cursor-not-allowed'
                    }"
                    title="${jk.desc}"
                  >
                    <div class="font-bold text-xs flex items-center justify-between">
                      <span>${jk.name}</span>
                      <i data-lucide="sparkles" class="w-3.5 h-3.5 opacity-80"></i>
                    </div>
                    <div class="text-[10px] text-white/80 mt-1 line-clamp-2 leading-tight">${jk.desc}</div>
                  </button>
                `;
              }).join('')}
            </div>
          </div>

          <!-- Ставки остальных 5 игроков (чтобы никто не скучал на чужом ходе!) -->
          <div class="glass-card rounded-3xl p-5">
            <div class="mb-3">
              <h4 class="font-display font-bold text-sm uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                <i data-lucide="flame" class="w-4 h-4 text-amber-400"></i>
                Ставки зала на этот ход
              </h4>
              <p class="text-[11px] text-slate-400 mt-0.5">
                Пока ${this.escapeHtml(activePlayer.name)} думает, остальные ставят: угадал исход +100, ошибся -50!
              </p>
            </div>

            <div class="space-y-2">
              ${this.state.players
                .filter((p) => p.id !== activePlayer.id)
                .map((p) => {
                  const currentBet = this.state.quiz.sideBets[p.id];
                  return `
                    <div class="flex items-center justify-between gap-2 p-2 rounded-xl bg-white/[0.03] border border-white/5">
                      <span class="text-xs font-medium text-slate-200 truncate">
                        ${p.role === 'dev' ? '💻' : '📊'} ${this.escapeHtml(p.name)}
                      </span>
                      <div class="flex items-center gap-1.5">
                        <button
                          data-side-bet="${p.id}:pass"
                          ${this.state.quiz.revealed ? 'disabled' : ''}
                          class="px-2.5 py-1 rounded-lg text-[11px] font-semibold transition border ${
                            currentBet === 'pass'
                              ? 'bg-emerald-500 text-white border-emerald-400'
                              : 'bg-white/5 text-slate-400 border-white/10 hover:text-white'
                          }"
                        >👍 Ответит</button>
                        <button
                          data-side-bet="${p.id}:fail"
                          ${this.state.quiz.revealed ? 'disabled' : ''}
                          class="px-2.5 py-1 rounded-lg text-[11px] font-semibold transition border ${
                            currentBet === 'fail'
                              ? 'bg-rose-500 text-white border-rose-400'
                              : 'bg-white/5 text-slate-400 border-white/10 hover:text-white'
                          }"
                        >💀 Засыпется</button>
                      </div>
                    </div>
                  `;
                })
                .join('')}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  renderEventInteractiveWidget(ev) {
    if (ev.type === 'box') {
      if (this.state.quiz.boxResolved) {
        return `<div class="mt-3 p-2.5 rounded-xl bg-black/30 text-xs font-bold text-emerald-300">${this.state.quiz.boxResultText}</div>`;
      }
      return `
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <button id="btn-box-safe" class="px-3.5 py-1.5 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/40 text-emerald-200 text-xs font-bold transition">
            🛡️ Забрать гарантированные +150 очков
          </button>
          <button id="btn-box-risk" class="px-3.5 py-1.5 rounded-xl bg-amber-500/25 hover:bg-amber-500/35 border border-amber-400/50 text-amber-200 text-xs font-bold transition">
            🎁 Открыть Чёрный Ящик!
          </button>
        </div>
      `;
    }

    if (ev.type === 'dilemma') {
      const activePlayer = this.getActivePlayer();
      const partner = this.state.players.find((p) => p.id === this.state.quiz.dilemmaPartnerId);
      if (!partner) return '';
      if (this.state.quiz.dilemmaResolved) {
        return `<div class="mt-3 p-2.5 rounded-xl bg-black/30 text-xs font-bold text-amber-200">${this.state.quiz.dilemmaResultText}</div>`;
      }
      const c1 = this.state.quiz.dilemmaChoices[activePlayer.id];
      const c2 = this.state.quiz.dilemmaChoices[partner.id];

      return `
        <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2.5 p-3 rounded-xl bg-black/25 border border-white/10">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-bold text-white">${this.escapeHtml(activePlayer.name)}:</span>
            ${
              c1
                ? `<span class="text-xs text-emerald-400 font-mono-code">Выбор сделан ✓</span>`
                : `<div class="flex gap-1.5">
                    <button data-dilemma="${activePlayer.id}:coop" class="px-2.5 py-1 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-200 text-xs font-semibold">🤝 Мир</button>
                    <button data-dilemma="${activePlayer.id}:betray" class="px-2.5 py-1 rounded bg-rose-500/20 border border-rose-500/40 text-rose-200 text-xs font-semibold">🗡️ Крысить</button>
                  </div>`
            }
          </div>
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-bold text-white">${this.escapeHtml(partner.name)}:</span>
            ${
              c2
                ? `<span class="text-xs text-emerald-400 font-mono-code">Выбор сделан ✓</span>`
                : `<div class="flex gap-1.5">
                    <button data-dilemma="${partner.id}:coop" class="px-2.5 py-1 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-200 text-xs font-semibold">🤝 Мир</button>
                    <button data-dilemma="${partner.id}:betray" class="px-2.5 py-1 rounded bg-rose-500/20 border border-rose-500/40 text-rose-200 text-xs font-semibold">🗡️ Крысить</button>
                  </div>`
            }
          </div>
        </div>
      `;
    }

    return '';
  }

  renderBluffAct() {
    const item = this.state.bluff.currentItem;
    if (!item) return '';
    const phase = this.state.bluff.phase;

    return `
      <div class="glass-card rounded-3xl p-6 sm:p-8 max-w-4xl mx-auto space-y-6">
        <div class="flex items-center justify-between gap-2">
          <span class="px-3 py-1 rounded-full text-xs font-semibold bg-pink-500/20 border border-pink-500/40 text-pink-300">
            🎭 Правдоруб • ${item.category}
          </span>
          <span class="text-xs text-slate-400">Угадай правду (+400) • Обмани коллегу (+300 за каждого!)</span>
        </div>

        <h3 class="font-display font-bold text-xl sm:text-2xl text-white leading-relaxed">
          ${this.escapeHtml(item.prompt)}
        </h3>

        ${
          phase === 'collect'
            ? `
          <div class="space-y-4">
            <div class="p-4 rounded-2xl bg-white/[0.03] border border-white/10">
              <div class="text-xs font-semibold text-slate-300 mb-3">
                Вариант А: Вписать блефы игроков (с пультов P2P или вписать ниже) • Вариант Б: Сразу открыть 5 вариантов на экране!
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                ${this.state.players
                  .map((p) => {
                    const hasBluff = Boolean(this.state.bluff.submittedBluffs[p.id]);
                    return `
                    <div class="flex items-center gap-2 p-2 rounded-xl bg-black/25 border border-white/10">
                      <span class="text-xs font-semibold text-slate-300 w-28 truncate">${this.escapeHtml(p.name)}:</span>
                      ${
                        hasBluff
                          ? `<span class="text-xs text-emerald-400 font-mono-code">Блеф готов ✓</span>`
                          : `<input type="text" data-bluff-input="${p.id}" placeholder="Тайный блеф (Enter)" class="flex-1 bg-transparent text-xs text-white focus:outline-none border-b border-white/15 focus:border-pink-400 py-0.5" />`
                      }
                    </div>
                  `;
                  })
                  .join('')}
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-3">
              <button id="btn-bluff-start-vote" class="px-5 py-3 rounded-2xl bg-gradient-to-r from-pink-500 to-purple-600 hover:from-pink-400 hover:to-purple-500 text-white font-display font-bold text-sm shadow-lg shadow-pink-500/20 transition">
                🎭 Перемешать блефы и начать голосование
              </button>
              <button id="btn-bluff-quick" class="px-4 py-3 rounded-2xl bg-white/10 hover:bg-white/15 border border-white/15 text-slate-200 text-xs font-semibold transition">
                ⚡ Играем без ввода: сразу показать 5 готовых вариантов на экране
              </button>
            </div>
          </div>
        `
            : ''
        }

        ${
          phase === 'vote'
            ? `
          <div class="space-y-4 animate-pop">
            <div class="text-xs font-bold uppercase tracking-wider text-pink-300">
              Где здесь настоящая ПРАВДА? (Кликните на имя игрока под вариантом, за который он голосует):
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              ${this.state.bluff.choices
                .map(
                  (c, idx) => `
                <div class="p-4 rounded-2xl bg-white/[0.04] border border-white/15 flex flex-col justify-between gap-3">
                  <div class="flex items-start gap-3">
                    <span class="w-7 h-7 rounded-lg bg-pink-500/20 border border-pink-500/40 text-pink-300 font-mono-code font-bold text-xs flex items-center justify-center shrink-0">
                      ${idx + 1}
                    </span>
                    <div class="font-semibold text-base text-white">${this.escapeHtml(c.text)}</div>
                  </div>
                  <div class="flex flex-wrap gap-1.5 pt-2 border-t border-white/10">
                    ${this.state.players
                      .map((p) => {
                        const votedThis = this.state.bluff.votes[p.id] === c.id;
                        return `
                        <button
                          data-bluff-vote="${p.id}:${c.id}"
                          class="px-2 py-1 rounded-lg text-[11px] font-semibold transition border ${
                            votedThis
                              ? 'bg-pink-500 text-white border-pink-400'
                              : 'bg-white/5 text-slate-400 border-white/10 hover:text-white'
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

            <button id="btn-bluff-reveal" class="w-full py-3.5 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-600 text-white font-display font-bold text-sm shadow-lg transition">
              🔥 ВСКРЫТЬ ПРАВДУ И РАЗОБЛАЧИТЬ БЛЕФЫ!
            </button>
          </div>
        `
            : ''
        }

        ${
          phase === 'reveal'
            ? `
          <div class="space-y-4 animate-pop">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              ${this.state.bluff.choices
                .map((c) => {
                  const voters = Object.entries(this.state.bluff.votes)
                    .filter(([, cid]) => cid === c.id)
                    .map(([pid]) => this.state.players.find((p) => p.id === pid)?.name)
                    .filter(Boolean);
                  const authors = c.authorIds
                    .map((aid) => this.state.players.find((p) => p.id === aid)?.name)
                    .filter(Boolean);

                  return `
                  <div class="p-4 rounded-2xl border ${
                    c.isTruth
                      ? 'bg-emerald-500/20 border-2 border-emerald-400'
                      : authors.length > 0
                      ? 'bg-pink-500/15 border-pink-500/40'
                      : 'bg-white/[0.03] border-white/10 opacity-65'
                  }">
                    <div class="flex items-center justify-between text-xs font-bold mb-1">
                      <span class="${c.isTruth ? 'text-emerald-300' : 'text-pink-300'}">
                        ${
                          c.isTruth
                            ? '✅ НАСТОЯЩАЯ ПРАВДА (+400)'
                            : authors.length > 0
                            ? `🎭 Блеф от: ${authors.join(', ')} (+300 за каждого)`
                            : '🤖 Ловушка ведущего'
                        }
                      </span>
                    </div>
                    <div class="font-bold text-base text-white">${this.escapeHtml(c.text)}</div>
                    ${
                      voters.length > 0
                        ? `<div class="mt-2 text-xs text-slate-300">Сюда проголосовали: <strong>${voters.join(', ')}</strong></div>`
                        : `<div class="mt-2 text-xs text-slate-500">Никто не выбрал</div>`
                    }
                  </div>
                `;
                })
                .join('')}
            </div>

            <div class="p-4 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-between gap-4">
              <p class="text-sm text-slate-200">${this.escapeHtml(item.fact)}</p>
              <button id="btn-next-turn" class="px-5 py-3 rounded-xl bg-gradient-to-r from-indigo-500 to-pink-500 text-white font-display font-bold text-sm shrink-0 flex items-center gap-2">
                Следующий ход <i data-lucide="arrow-right" class="w-4 h-4"></i>
              </button>
            </div>
          </div>
        `
            : ''
        }
      </div>
    `;
  }

  renderWavelengthAct() {
    const w = this.state.wavelength;
    if (!w.card) return '';
    const activePlayer = this.getActivePlayer();

    return `
      <div class="glass-card rounded-3xl p-6 sm:p-8 max-w-4xl mx-auto space-y-6">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 border border-emerald-500/40 text-emerald-300">
            📡 На одной волне • Категория: ${w.card.category}
          </span>
          <span class="text-xs text-slate-400">
            Телепат раунда: <strong class="text-white">${this.escapeHtml(activePlayer.name)}</strong>
          </span>
        </div>

        <!-- Полюса спектра -->
        <div class="grid grid-cols-2 gap-4">
          <div class="p-4 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 text-left">
            <div class="text-xs font-mono-code text-indigo-300 uppercase">0% (Левый край)</div>
            <div class="font-display font-bold text-lg sm:text-xl text-white mt-1">◄ ${this.escapeHtml(w.card.left)}</div>
          </div>
          <div class="p-4 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 text-right">
            <div class="text-xs font-mono-code text-emerald-300 uppercase">100% (Правый край)</div>
            <div class="font-display font-bold text-lg sm:text-xl text-white mt-1">${this.escapeHtml(w.card.right)} ►</div>
          </div>
        </div>

        <!-- Управление секретной мишенью для Телепата -->
        <div class="p-4 rounded-2xl bg-white/[0.03] border border-white/10 flex flex-wrap items-center justify-between gap-3">
          <div class="text-xs text-slate-300">
            ${
              w.peekTarget || w.revealed
                ? `<span class="text-amber-300 font-bold text-sm">🎯 Секретная мишень находится на отметке: ${w.targetValue}%</span>`
                : `1) Остальные на секунду отворачиваются (или ${this.escapeHtml(
                    activePlayer.name
                  )} смотрит на телефоне в P2P). 2) Телепат называет ассоциацию на этот процент!`
            }
          </div>
          ${
            !w.revealed
              ? `<button id="btn-wavelength-peek" class="px-3.5 py-2 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200 text-xs font-bold transition">
                  ${w.peekTarget ? '🙈 Спрятать мишень от зала' : '👁️ Подсмотреть мишень (Телепату)'}
                </button>`
              : ''
          }
        </div>

        <!-- Ползунок команды -->
        <div class="p-6 rounded-2xl bg-black/35 border border-white/10 space-y-4">
          <div class="flex items-center justify-between">
            <span class="text-xs uppercase tracking-wider text-slate-400 font-bold">Куда команда ставит стрелку:</span>
            <span id="wavelength-guess-label" class="font-mono-code font-extrabold text-2xl text-indigo-400">${w.teamGuess}%</span>
          </div>

          <div class="relative pt-2 pb-4">
            <input
              id="wavelength-slider-input"
              type="range"
              min="0"
              max="100"
              value="${w.teamGuess}"
              ${w.revealed ? 'disabled' : ''}
              class="wavelength-slider"
            />
            ${
              w.revealed
                ? `<div class="mt-4 p-3 rounded-xl bg-emerald-500/20 border border-emerald-400/50 text-center animate-pop">
                    <div class="font-display font-bold text-lg text-white">
                      🎯 Реальная мишень: <span class="text-emerald-300">${w.targetValue}%</span> • Ответ команды: <span class="text-indigo-300">${w.teamGuess}%</span> (Разница: ${Math.abs(
                    w.targetValue - w.teamGuess
                  )}%)
                    </div>
                  </div>`
                : ''
            }
          </div>

          <!-- Ставки остальных игроков Левее / Правее -->
          <div class="pt-3 border-t border-white/10">
            <div class="text-xs text-slate-400 mb-2">Индивидуальные ставки зрителей (+150 очков): где реальная мишень относительно стрелки команды?</div>
            <div class="grid grid-cols-2 sm:grid-cols-5 gap-2">
              ${this.state.players
                .filter((p) => p.id !== activePlayer.id)
                .map((p) => {
                  const sv = w.sideVotes[p.id];
                  return `
                  <div class="p-2 rounded-xl bg-white/[0.03] border border-white/10 text-center space-y-1.5">
                    <div class="text-xs font-semibold text-white truncate">${this.escapeHtml(p.name)}</div>
                    <div class="flex justify-center gap-1">
                      <button data-wave-side="${p.id}:left" ${w.revealed ? 'disabled' : ''} class="px-2 py-1 rounded text-[10px] font-bold border ${
                    sv === 'left' ? 'bg-indigo-500 text-white border-indigo-400' : 'bg-white/5 text-slate-400 border-white/10'
                  }">◄ Левее</button>
                      <button data-wave-side="${p.id}:right" ${w.revealed ? 'disabled' : ''} class="px-2 py-1 rounded text-[10px] font-bold border ${
                    sv === 'right' ? 'bg-emerald-500 text-white border-emerald-400' : 'bg-white/5 text-slate-400 border-white/10'
                  }">Правее ►</button>
                    </div>
                  </div>
                `;
                })
                .join('')}
            </div>
          </div>
        </div>

        <div class="flex justify-end gap-3">
          ${
            !w.revealed
              ? `<button id="btn-wavelength-reveal" class="w-full py-3.5 rounded-2xl bg-gradient-to-r from-indigo-500 to-emerald-500 text-white font-display font-bold text-sm shadow-lg transition">
                  🎯 ОТКРЫТЬ ШИРМУ И ПРОВЕРИТЬ ПОПАДАНИЕ!
                </button>`
              : `<button id="btn-next-turn" class="px-6 py-3.5 rounded-2xl bg-gradient-to-r from-indigo-500 to-pink-500 text-white font-display font-bold text-sm flex items-center gap-2">
                  Следующий ход <i data-lucide="arrow-right" class="w-4 h-4"></i>
                </button>`
          }
        </div>
      </div>
    `;
  }

  renderCaseAct() {
    const cb = this.state.caseBattle;
    if (!cb.scenario) return '';
    const activePlayer = this.getActivePlayer();

    return `
      <div class="glass-card rounded-3xl p-6 sm:p-8 max-w-4xl mx-auto space-y-6">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/20 border border-amber-500/40 text-amber-300">
            🤖 Кейс-Баттл с ИИ-Арбитром
          </span>
          <span class="text-xs text-slate-300">
            Отдувается: <strong class="text-white">${this.escapeHtml(activePlayer.name)}</strong> (${
      activePlayer.role === 'dev' ? '💻 Прогер' : '📊 Менеджер'
    })
          </span>
        </div>

        <div class="space-y-3">
          <h3 class="font-display font-bold text-xl sm:text-2xl text-white">${this.escapeHtml(cb.scenario.title)}</h3>
          <p class="text-base text-slate-200 leading-relaxed">${this.escapeHtml(cb.scenario.situation)}</p>
          <p class="text-xs text-indigo-300 font-medium">${this.escapeHtml(cb.scenario.roleHint)}</p>
        </div>

        <!-- Карточка секретного условия-мутатора -->
        <div class="p-4 rounded-2xl bg-gradient-to-r from-fuchsia-500/20 to-indigo-500/20 border border-fuchsia-400/40 flex items-center justify-between gap-3">
          <div>
            <div class="text-[11px] font-mono-code uppercase text-fuchsia-300 font-bold">🎲 Обязательное условие-мутатор:</div>
            <div class="text-sm font-bold text-white mt-0.5">${this.escapeHtml(cb.mutator)}</div>
          </div>
          <button id="btn-reroll-mutator" class="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/15 text-xs text-slate-200 shrink-0 transition">
            🔄 Другой мутатор
          </button>
        </div>

        <!-- Ввод ответа или голосовой диктант -->
        <div class="space-y-2.5">
          <div class="flex items-center justify-between">
            <label class="text-xs font-semibold text-slate-300">
              Кратко запишите план игрока (или нажмите «Голосовой ввод», пока он отвечает в Discord!):
            </label>
            <button id="btn-voice-dictate" class="px-3 py-1 rounded-xl text-xs font-bold flex items-center gap-1.5 border transition ${
              this.speechRecognition
                ? 'bg-rose-500 text-white border-rose-400 animate-pulse'
                : 'bg-indigo-500/20 border-indigo-500/40 text-indigo-200 hover:bg-indigo-500/30'
            }">
              <i data-lucide="mic" class="w-3.5 h-3.5"></i>
              ${this.speechRecognition ? 'Слушаю речь... (Стоп)' : '🎙️ Голосовой ввод (RU)'}
            </button>
          </div>
          <textarea
            id="case-answer-input"
            rows="3"
            placeholder="Например: Мы скажем совету директоров, что танцующий енот — это наш новый ИИ-маскот на синей изоленте, и закажем всем шаурму..."
            class="w-full rounded-2xl bg-black/40 border border-white/15 focus:border-indigo-400 focus:outline-none p-4 text-sm text-white"
          >${this.escapeHtml(cb.answerText)}</textarea>
        </div>

        ${
          cb.verdictData
            ? `<div class="p-5 rounded-2xl bg-emerald-500/15 border-2 border-emerald-400/60 space-y-2 animate-pop">
                <div class="flex items-center justify-between">
                  <span class="px-2.5 py-0.5 rounded-full bg-emerald-500/30 text-emerald-200 text-xs font-bold">
                    🏆 Титул: ${this.escapeHtml(cb.verdictData.highlight)}
                  </span>
                  <span class="font-mono-code font-extrabold text-xl text-emerald-300">+${cb.verdictData.score} очков!</span>
                </div>
                <p class="text-sm text-white leading-relaxed">${this.escapeHtml(cb.verdictData.verdict)}</p>
                <div class="pt-3 flex items-center justify-between border-t border-white/10">
                  <button id="btn-case-like" class="px-3.5 py-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 text-amber-200 text-xs font-bold transition">
                    👏 Респект от коллег (+50 очков) • Нажато: ${cb.peerLikes}
                  </button>
                  <button id="btn-next-turn" class="px-5 py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-pink-500 text-white font-display font-bold text-sm flex items-center gap-2">
                    Следующий ход <i data-lucide="arrow-right" class="w-4 h-4"></i>
                  </button>
                </div>
              </div>`
            : `<button id="btn-judge-case" ${cb.isJudging ? 'disabled' : ''} class="w-full py-3.5 rounded-2xl bg-gradient-to-r from-amber-500 via-pink-500 to-indigo-500 text-white font-display font-bold text-sm shadow-lg transition">
                ${cb.isJudging ? '🤖 Нейро-Судья выносит вердикт...' : '⚖️ ОЦЕНИТЬ ОТВЕТ И НАЧИСЛИТЬ ОЧКИ!'}
              </button>`
        }
      </div>
    `;
  }

  renderPodium() {
    const sorted = [...this.state.players].sort((a, b) => b.score - a.score);
    const { devScore, mgrScore } = this.getTeamScores();
    const winningTeam =
      devScore > mgrScore ? '💻 Программисты' : mgrScore > devScore ? '📊 Менеджеры' : '🤝 Боевая ничья!';

    return `
      <div class="glass-card rounded-3xl p-8 max-w-3xl mx-auto text-center space-y-6 animate-pop">
        <div class="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-amber-500/20 border border-amber-400/40 text-amber-300 text-xs font-bold uppercase">
          🏆 Финал Вечернего Синка
        </div>
        <h2 class="font-display font-extrabold text-3xl sm:text-4xl text-white">
          Чемпион вечера: ${this.escapeHtml(sorted[0]?.name || '')}!
        </h2>
        <p class="text-sm text-slate-300">
          Битва отделов: <strong class="text-indigo-300">💻 Прогеры (${devScore})</strong> vs <strong class="text-pink-300">📊 Менеджеры (${mgrScore})</strong> — Победа за: <strong>${winningTeam}</strong>
        </p>

        <div class="space-y-2.5 text-left max-w-xl mx-auto">
          ${sorted
            .map(
              (p, i) => `
            <div class="flex items-center justify-between p-3.5 rounded-2xl ${
              i === 0
                ? 'bg-gradient-to-r from-amber-500/25 to-indigo-500/20 border border-amber-400/50'
                : 'bg-white/[0.04] border border-white/10'
            }">
              <div class="flex items-center gap-3">
                <span class="font-mono-code font-bold text-lg w-7 text-center">${
                  i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`
                }</span>
                <div>
                  <div class="font-bold text-white">${this.escapeHtml(p.name)}</div>
                  <div class="text-xs text-slate-400">${p.role === 'dev' ? '💻 Прогер' : '📊 Менеджер'}</div>
                </div>
              </div>
              <div class="font-mono-code font-extrabold text-xl text-emerald-400">${p.score} очков</div>
            </div>
          `
            )
            .join('')}
        </div>

        <div class="pt-4 flex justify-center gap-3">
          <button id="btn-restart-lobby" class="px-6 py-3 rounded-2xl bg-gradient-to-r from-indigo-500 to-pink-500 text-white font-display font-bold text-sm">
            🔄 Сыграть ещё партию
          </button>
        </div>
      </div>
    `;
  }

  renderAiSettingsModal() {
    const cfg = aiClient.config;
    return `
      <div id="ai-modal" class="hidden fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-4">
        <div class="glass-card rounded-3xl max-w-xl w-full p-6 space-y-5 border border-white/15 animate-pop">
          <div class="flex items-center justify-between">
            <h3 class="font-display font-bold text-lg text-white flex items-center gap-2">
              <i data-lucide="sparkles" class="w-5 h-5 text-fuchsia-400"></i>
              Настройки Yandex Cloud AI (Приватно)
            </h3>
            <button id="btn-close-ai" class="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white">
              <i data-lucide="x" class="w-4 h-4"></i>
            </button>
          </div>

          <div class="p-3.5 rounded-2xl bg-indigo-500/10 border border-indigo-500/30 text-xs text-slate-300 leading-relaxed">
            🔒 <strong>Безопасность на GitHub Pages:</strong> Ваш API-ключ и Folder ID сохраняются <strong>только в localStorage вашего браузера</strong> и никогда не попадают в код репозитория.
            <div class="mt-1.5 text-slate-400">
              💡 Чтобы обойти CORS браузера при вызове Yandex Cloud с <code>github.io</code>, запустите локально в терминале скрипт из корня репо: <code>node yandex-bridge.mjs</code>
            </div>
          </div>

          <div class="space-y-3">
            <div>
              <label class="block text-xs font-semibold text-slate-300 mb-1">Yandex Cloud API-Key (или IAM-токен):</label>
              <input id="yc-api-key" type="password" value="${this.escapeHtml(cfg.apiKey)}" placeholder="AQVN..." class="w-full rounded-xl bg-black/40 border border-white/15 px-3.5 py-2 text-sm text-white focus:border-indigo-400 focus:outline-none" />
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label class="block text-xs font-semibold text-slate-300 mb-1">Folder ID (Каталог в облаке):</label>
                <input id="yc-folder-id" type="text" value="${this.escapeHtml(cfg.folderId)}" placeholder="b1g..." class="w-full rounded-xl bg-black/40 border border-white/15 px-3.5 py-2 text-sm text-white focus:border-indigo-400 focus:outline-none" />
              </div>
              <div>
                <label class="block text-xs font-semibold text-slate-300 mb-1">Модель:</label>
                <select id="yc-model" class="w-full rounded-xl bg-black/60 border border-white/15 px-3 py-2 text-sm text-white focus:border-indigo-400 focus:outline-none">
                  <option value="yandexgpt/latest" ${cfg.model === 'yandexgpt/latest' ? 'selected' : ''}>YandexGPT Pro (latest)</option>
                  <option value="yandexgpt-lite/latest" ${cfg.model === 'yandexgpt-lite/latest' ? 'selected' : ''}>YandexGPT Lite (быстрая)</option>
                </select>
              </div>
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-300 mb-1">Кастомный прокси / Worker URL (опционально):</label>
              <input id="yc-custom-ep" type="text" value="${this.escapeHtml(cfg.customEndpoint || '')}" placeholder="По умолчанию используется локальный мост http://127.0.0.1:31337 или прямой API" class="w-full rounded-xl bg-black/40 border border-white/15 px-3.5 py-2 text-xs text-white focus:border-indigo-400 focus:outline-none" />
            </div>
          </div>

          <div class="flex items-center gap-2">
            <button id="btn-save-ai" class="flex-1 py-2.5 rounded-xl bg-indigo-500 hover:bg-indigo-400 text-white font-semibold text-xs transition">
              💾 Сохранить и проверить связь
            </button>
          </div>

          <!-- Генератор свежих вопросов от YandexGPT на любую тему -->
          <div class="pt-4 border-t border-white/10 space-y-2.5">
            <label class="block text-xs font-bold text-fuchsia-300">
              ✨ Сгенерировать свежий пак вопросов через YandexGPT прямо в игру:
            </label>
            <div class="flex gap-2">
              <input id="ai-topic-input" type="text" placeholder="Например: фильмы Тарантино, CS2, факапы на работе..." class="flex-1 rounded-xl bg-black/40 border border-white/15 px-3.5 py-2 text-xs text-white focus:border-fuchsia-400 focus:outline-none" />
              <button id="btn-gen-ai-pack" class="px-4 py-2 rounded-xl bg-gradient-to-r from-fuchsia-500 to-purple-600 text-white font-bold text-xs shrink-0">
                +5 вопросов
              </button>
            </div>
          </div>

          <div id="yc-status-msg" class="text-xs min-h-[20px]"></div>
        </div>
      </div>
    `;
  }

  // --- ЭКРАН МОБИЛЬНОГО ПУЛЬТА ИГРОКА (P2P CLIENT VIEW) ---
  renderClientControllerView() {
    if (!this.hostSyncedState) {
      return `
        <div class="min-h-screen flex items-center justify-center p-4">
          <div class="glass-card rounded-3xl max-w-md w-full p-6 space-y-4">
            <div class="text-center">
              <div class="inline-flex px-3 py-1 rounded-full bg-indigo-500/20 text-indigo-300 text-xs font-mono-code mb-2">
                КОМНАТА: ${this.escapeHtml(this.clientRoomCode)}
              </div>
              <h2 class="font-display font-bold text-2xl text-white">Пульт игрока</h2>
              <p class="text-xs text-slate-400 mt-1">Подключитесь к экрану ведущего в Discord без регистрации</p>
            </div>
            <div class="space-y-3">
              <input id="client-name-input" type="text" placeholder="Ваше имя (например, Алекс)" class="w-full rounded-xl bg-black/40 border border-white/15 px-4 py-3 text-sm text-white" />
              <select id="client-role-input" class="w-full rounded-xl bg-black/60 border border-white/15 px-4 py-3 text-sm text-white">
                <option value="dev">💻 Программист</option>
                <option value="mgr">📊 Менеджер</option>
              </select>
              <button id="btn-client-join" class="w-full py-3.5 rounded-xl bg-gradient-to-r from-indigo-500 to-pink-500 text-white font-display font-bold text-sm">
                🚀 Войти в игру
              </button>
            </div>
          </div>
        </div>
      `;
    }

    const hs = this.hostSyncedState;
    const me = hs.players?.find((p) => p.peerId === this.p2p.peer?.id) || hs.players?.[0];
    const isMyTurn = me && hs.activePlayerId === me.id;

    return `
      <div class="min-h-screen max-w-md mx-auto p-4 flex flex-col gap-4">
        <div class="glass-card rounded-2xl p-4 flex items-center justify-between">
          <div>
            <div class="text-xs text-slate-400">Вы играете как:</div>
            <div class="font-bold text-base text-white">${me ? this.escapeHtml(me.name) : 'Участник'}</div>
          </div>
          <div class="text-right">
            <div class="text-xs text-slate-400">Очки:</div>
            <div class="font-mono-code font-bold text-xl text-emerald-400">${me ? me.score : 0}</div>
          </div>
        </div>

        ${
          hs.currentAct === 'quiz' && hs.quiz
            ? `
          <div class="glass-card rounded-3xl p-5 space-y-4">
            <div class="text-xs font-bold uppercase ${isMyTurn ? 'text-emerald-400' : 'text-indigo-300'}">
              ${isMyTurn ? '🔥 СЕЙЧАС ВАШ ХОД! Выберите ответ:' : 'Ставка зрителя и голосование зала:'}
            </div>
            <div class="text-sm font-semibold text-white">${this.escapeHtml(hs.quiz.question)}</div>
            <div class="grid grid-cols-1 gap-2.5">
              ${hs.quiz.options
                .map(
                  (opt, idx) => `
                <button data-client-quiz-opt="${idx}" class="p-3.5 rounded-xl bg-white/10 hover:bg-indigo-500/30 border border-white/15 text-left text-sm font-semibold text-white">
                  <strong>${['A', 'B', 'C', 'D'][idx]}.</strong> ${this.escapeHtml(opt)}
                </button>
              `
                )
                .join('')}
            </div>
            ${
              !isMyTurn
                ? `<div class="pt-3 border-t border-white/10 flex gap-2">
                    <button data-client-bet="pass" class="flex-1 py-2.5 rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-200 text-xs font-bold">👍 Ответит верно</button>
                    <button data-client-bet="fail" class="flex-1 py-2.5 rounded-xl bg-rose-500/20 border border-rose-500/40 text-rose-200 text-xs font-bold">💀 Засыпется</button>
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
          <div class="glass-card rounded-3xl p-5 space-y-4">
            <div class="text-sm font-semibold text-white">${this.escapeHtml(hs.bluff.prompt)}</div>
            ${
              hs.bluff.phase === 'collect'
                ? `<div class="space-y-2">
                    <input id="client-bluff-text" type="text" placeholder="Ваш правдоподобный блеф..." class="w-full rounded-xl bg-black/40 border border-white/15 px-3.5 py-2.5 text-sm text-white" />
                    <button id="btn-client-send-bluff" class="w-full py-3 rounded-xl bg-pink-500 text-white font-bold text-xs">Отправить блеф</button>
                  </div>`
                : `<div class="space-y-2">
                    ${hs.bluff.choices
                      .map(
                        (c) => `
                      <button data-client-bluff-vote="${c.id}" class="w-full p-3 rounded-xl bg-white/10 border border-white/15 text-left text-xs font-bold text-white">
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
          <div class="glass-card rounded-3xl p-5 space-y-4 text-center">
            <div class="text-xs text-slate-300">${this.escapeHtml(hs.wavelength.left)} ◄───► ${this.escapeHtml(
                hs.wavelength.right
              )}</div>
            ${
              isMyTurn
                ? `<div class="p-4 rounded-2xl bg-amber-500/20 border border-amber-400 text-amber-200 font-bold text-lg">
                    🎯 Вы Телепат! Ваша секретная мишень: ${hs.wavelength.targetValue}%
                  </div>`
                : `<div class="flex gap-2">
                    <button data-client-wave="left" class="flex-1 py-3 rounded-xl bg-indigo-500/20 border border-indigo-400 text-xs font-bold">◄ Мишень левее</button>
                    <button data-client-wave="right" class="flex-1 py-3 rounded-xl bg-emerald-500/20 border border-emerald-400 text-xs font-bold">Мишень правее ►</button>
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
        alert(`Ссылка на комнату скопирована в буфер обмена!\nСкиньте её коллегам в чат Discord:\n${url}`);
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
      const role = this.state.players.filter((p) => p.role === 'dev').length <= this.state.players.filter((p) => p.role === 'mgr').length ? 'dev' : 'mgr';
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
        sfx.play('click');
        this.saveState();
        this.render();
      });
    });

    document.querySelectorAll('[data-select-mode]').forEach((card) => {
      card.addEventListener('click', (e) => {
        const mode = e.currentTarget.getAttribute('data-select-mode');
        this.state.gameMode = mode;
        this.state.currentAct = mode === 'show' ? 'quiz' : mode;
        sfx.play('click');
        this.saveState();
        this.render();
      });
    });

    document.getElementById('btn-start-game')?.addEventListener('click', () => {
      this.state.currentAct = this.state.gameMode === 'show' ? 'quiz' : this.state.gameMode;
      this.startNewGame();
    });

    document.getElementById('btn-resume-game')?.addEventListener('click', () => {
      sfx.play('click');
      this.state.screen = 'game';
      this.render();
    });

    // Игровой экран
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
        this.switchAct(e.currentTarget.getAttribute('data-switch-act'));
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

    // Квиз
    document.querySelectorAll('[data-quiz-option]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const idx = Number(e.currentTarget.getAttribute('data-quiz-option'));
        this.selectQuizOption(idx);
      });
    });

    document.querySelectorAll('[data-use-joker]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const jid = e.currentTarget.getAttribute('data-use-joker');
        this.useJoker(jid);
      });
    });

    document.querySelectorAll('[data-side-bet]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const [pid, bet] = e.currentTarget.getAttribute('data-side-bet').split(':');
        this.setSideBet(pid, bet);
      });
    });

    document.getElementById('btn-roll-event')?.addEventListener('click', () => this.triggerManualEvent());
    document.getElementById('btn-quiz-timer')?.addEventListener('click', () => this.toggleTimer());
    document.getElementById('btn-box-safe')?.addEventListener('click', () => this.resolveMysteryBox(true));
    document.getElementById('btn-box-risk')?.addEventListener('click', () => this.resolveMysteryBox(false));

    document.querySelectorAll('[data-dilemma]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const [pid, choice] = e.currentTarget.getAttribute('data-dilemma').split(':');
        this.setDilemmaChoice(pid, choice);
      });
    });

    document.getElementById('btn-next-turn')?.addEventListener('click', () => this.nextTurn());

    // Правдоруб (Fibbage)
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

    document.getElementById('btn-bluff-start-vote')?.addEventListener('click', () => this.startBluffVoting(false));
    document.getElementById('btn-bluff-quick')?.addEventListener('click', () => this.startBluffVoting(true));

    document.querySelectorAll('[data-bluff-vote]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const [pid, cid] = e.currentTarget.getAttribute('data-bluff-vote').split(':');
        this.voteBluffChoice(pid, cid);
      });
    });

    document.getElementById('btn-bluff-reveal')?.addEventListener('click', () => this.revealBluffResults());

    // На одной волне
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
    document.getElementById('btn-case-like')?.addEventListener('click', () => this.addCasePeerLike());
  }

  bindClientEvents() {
    document.getElementById('btn-client-join')?.addEventListener('click', async () => {
      const name = document.getElementById('client-name-input')?.value?.trim() || 'Игрок';
      const role = document.getElementById('client-role-input')?.value || 'dev';
      await this.p2p.joinRoom(this.clientRoomCode, { name, role });
    });

    document.querySelectorAll('[data-client-quiz-opt]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const optionIndex = Number(e.currentTarget.getAttribute('data-client-quiz-opt'));
        const hs = this.hostSyncedState;
        const me = hs?.players?.find((p) => p.peerId === this.p2p.peer?.id);
        if (me && hs.activePlayerId === me.id) {
          this.p2p.sendActionToHost({ kind: 'QUIZ_ANSWER', optionIndex });
        } else {
          this.p2p.sendActionToHost({ kind: 'CROWD_VOTE', optionIndex });
        }
      });
    });

    document.querySelectorAll('[data-client-bet]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const bet = e.currentTarget.getAttribute('data-client-bet');
        this.p2p.sendActionToHost({ kind: 'SIDE_BET', bet });
      });
    });

    document.getElementById('btn-client-send-bluff')?.addEventListener('click', () => {
      const text = document.getElementById('client-bluff-text')?.value?.trim();
      if (text) this.p2p.sendActionToHost({ kind: 'SUBMIT_BLUFF', text });
    });

    document.querySelectorAll('[data-client-bluff-vote]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const choiceId = e.currentTarget.getAttribute('data-client-bluff-vote');
        this.p2p.sendActionToHost({ kind: 'VOTE_BLUFF', choiceId });
      });
    });

    document.querySelectorAll('[data-client-wave]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const dir = e.currentTarget.getAttribute('data-client-wave');
        this.p2p.sendActionToHost({ kind: 'WAVELENGTH_SIDE', dir });
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
