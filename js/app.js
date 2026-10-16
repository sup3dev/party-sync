// PARTY SYNC — Архитектура Stage (Экран Хоста с QR) + Controller (Личный пульт игрока)
// Вдохновлено Jackbox, Kahoot, Doot Games и The Merkive
import { CATEGORIES, WHEEL_EVENTS, QUIZ_QUESTIONS } from '../data/content.js?v=10';
import { sfx } from './audio.js?v=10';
import { aiClient } from './ai.js?v=10';
import { P2PRoomManager } from './p2p.js?v=10';

const HOST_STORAGE_KEY = 'party_sync_host_v5';
const CLIENT_TOKEN_KEY = 'party_sync_client_token_v5';

const PLAYER_COLORS = [
  { id: 'gold', hex: '#facc15', label: 'Золотой' },
  { id: 'emerald', hex: '#10b981', label: 'Изумрудный' },
  { id: 'rose', hex: '#f43f5e', label: 'Рубиновый' },
  { id: 'blue', hex: '#3b82f6', label: 'Сапфировый' },
  { id: 'purple', hex: '#a855f7', label: 'Аметистовый' },
  { id: 'orange', hex: '#f97316', label: 'Янтарный' }
];

class PartySyncPlatform {
  constructor() {
    // Роль текущего окна: 'landing' (выбор роли) | 'host' (экран для Discord) | 'player' (пульт игрока)
    this.role = 'landing';
    this.wheelSpinning = false;

    // Данные клиента-игрока
    this.clientToken = this.getOrCreateClientToken();
    this.clientRoomInput = '';
    this.clientNameInput = localStorage.getItem('ps_last_name') || '';
    this.clientColorInput = localStorage.getItem('ps_last_color') || 'gold';
    this.clientConnected = false;
    this.clientConnecting = false;
    this.clientError = null;
    this.remoteState = null; // Стейт, пришедший от Хоста

    // Состояние Хоста
    this.state = this.loadHostState() || this.createInitialHostState();

    this.p2p = new P2PRoomManager({
      onPlayerJoin: (peerId, profile) => this.handlePeerJoin(peerId, profile),
      onPlayerLeave: (peerId) => this.handlePeerLeave(peerId),
      onPlayerAction: (peerId, action) => this.handlePeerAction(peerId, action),
      onHostStateUpdate: (st) => this.handleRemoteStateFromHost(st),
      onStatusChange: (status, info) => this.handleP2PStatus(status, info)
    });

    this.checkUrlParams();
    this.render();
  }

  getOrCreateClientToken() {
    let tok = localStorage.getItem(CLIENT_TOKEN_KEY);
    if (!tok) {
      tok = 'usr_' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(CLIENT_TOKEN_KEY, tok);
    }
    return tok;
  }

  checkUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam && roomParam.trim().length >= 3) {
      // Если открыли по QR-коду или ссылке с кодом комнаты — сразу включаем режим Игрока!
      this.role = 'player';
      this.clientRoomInput = roomParam.trim().toUpperCase();
      return;
    }
    // Если ведущий обновил страницу (F5 / Ctrl+F5), автоматически возвращаем его в комнату Хоста!
    if (sessionStorage.getItem('ps_active_role') === 'host') {
      setTimeout(() => this.becomeHost(true), 0);
    }
  }

  createInitialHostState() {
    return {
      screen: 'lobby', // 'lobby' | 'play' | 'results'
      roomCode: null,
      totalQuestions: 50,
      turn: 1,
      activePlayerIdx: 0,
      players: [], // Заполняются при входе по QR/коду + можно добавить с экрана Хоста
      usedIds: [],
      customQuestions: [],
      currentTurn: null
    };
  }

  loadHostState() {
    try {
      const raw = localStorage.getItem(HOST_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.players)) {
          return parsed;
        }
      }
    } catch (e) {}
    return null;
  }

  saveHostState() {
    if (this.role !== 'host') return;
    try {
      localStorage.setItem(HOST_STORAGE_KEY, JSON.stringify(this.state));
    } catch (e) {}
    this.broadcastToPlayers();
  }

  // --- ПЕРЕКЛЮЧЕНИЕ РОЛИ НА СТАРТОВОМ ЭКРАНЕ ---
  async becomeHost(silent = false) {
    if (!silent) sfx.play('click');
    this.role = 'host';
    sessionStorage.setItem('ps_active_role', 'host');
    if (!this.state.roomCode) {
      this.state.roomCode = this.p2p.generateRoomCode();
    }
    this.hostNetStatus = 'connecting';
    this.saveHostState();
    this.render();

    const code = await this.p2p.initHost(this.state.roomCode);
    if (code) {
      this.state.roomCode = code;
      this.saveHostState();
      this.render();
    }
  }

  becomePlayer() {
    sfx.play('click');
    this.role = 'player';
    sessionStorage.setItem('ps_active_role', 'player');
    this.render();
  }

  // --- ПОДКЛЮЧЕНИЕ ИГРОКОВ К ХОСТУ (P2P) ---
  handleP2PStatus(status, info) {
    if (this.role === 'host') {
      this.hostNetStatus = status;
      if (status === 'ready') {
        this.broadcastToPlayers();
      }
      return;
    }
    if (this.role === 'player') {
      if (status === 'error') {
        this.clientConnecting = false;
        this.clientError = info;
        this.render();
      } else if (status === 'disconnected') {
        this.clientConnected = false;
        this.clientError = info;
        this.render();
      }
    }
  }

  handlePeerJoin(peerId, profile) {
    if (this.role !== 'host') return;

    const cleanName = (profile.name || 'Игрок').trim().slice(0, 18);
    let existing = this.state.players.find(
      (p) =>
        (profile.token && p.token === profile.token) ||
        p.name.toLowerCase() === cleanName.toLowerCase()
    );

    if (existing) {
      const changed =
        existing.name !== cleanName ||
        (profile.color && existing.color !== profile.color) ||
        !existing.online;

      existing.peerId = peerId;
      existing.online = true;
      existing.name = cleanName;
      if (profile.color) existing.color = profile.color;
      if (profile.token) existing.token = profile.token;

      this.saveHostState();
      if (changed) {
        this.render();
      }
      return;
    }

    sfx.play('joker');
    const colorObj =
      PLAYER_COLORS.find((c) => c.id === profile.color) ||
      PLAYER_COLORS[this.state.players.length % PLAYER_COLORS.length];

    this.state.players.push({
      id: `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
      token: profile.token || null,
      peerId,
      online: true,
      name: cleanName,
      color: colorObj.id,
      colorHex: colorObj.hex,
      score: 0,
      streak: 0,
      jokers: { fifty: true, double: true, ally: true, pass: true, hint: true }
    });

    this.saveHostState();
    this.render();
  }

  handlePeerLeave(peerId) {
    if (this.role !== 'host') return;
    const pl = this.state.players.find((p) => p.peerId === peerId);
    if (pl) {
      pl.online = false;
      this.saveHostState();
      this.render();
    }
  }

  // Добавление локального игрока прямо на экране Хоста (если сам Хост тоже играет или кто-то без телефона)
  addLocalPlayerOnHost(customName = '') {
    sfx.play('click');
    const idx = this.state.players.length + 1;
    const colorObj = PLAYER_COLORS[(idx - 1) % PLAYER_COLORS.length];
    this.state.players.push({
      id: `local_${Date.now()}_${idx}`,
      token: null,
      peerId: null,
      online: true,
      isLocal: true,
      name: customName.trim() || `Игрок ${idx}`,
      color: colorObj.id,
      colorHex: colorObj.hex,
      score: 0,
      streak: 0,
      jokers: { fifty: true, double: true, ally: true, pass: true, hint: true }
    });
    this.saveHostState();
    this.render();
  }

  // Приём команд с телефонов игроков!
  handlePeerAction(peerId, action) {
    if (this.role !== 'host') return;
    const player = this.state.players.find((p) => p.peerId === peerId || p.token === action.token);
    if (!player) return;

    // 1. Живая реакция с телефона на главный экран в Discord!
    if (action.kind === 'REACTION') {
      this.spawnReactionOnHost(player.name, player.colorHex, action.emoji);
      return;
    }

    const ct = this.state.currentTurn;
    if (!ct) return;
    const activePlayer = this.getActivePlayer();
    const isActivePlayer = activePlayer && activePlayer.id === player.id;

    // 2. Вращение барабана событий с телефона активного игрока
    if (action.kind === 'SPIN_WHEEL' && isActivePlayer && ct.step === 'wheel') {
      if (!ct.wheelSpun) this.spinEventWheel();
      else this.proceedFromWheel();
      return;
    }

    // 3. Действия в ивентах (Шкатулки, Перекуп, Дуэль, Сделка)
    if (ct.step === 'event_action') {
      if (action.kind === 'PICK_BOX' && isActivePlayer) {
        this.pickBox(Number(action.boxIdx));
      } else if (action.kind === 'PROCEED_QUESTION' && isActivePlayer) {
        ct.step = 'question';
        this.saveHostState();
        this.render();
      } else if (action.kind === 'AUCTION_TAKE') {
        this.pickAuctionBuyer(player.id);
      } else if (action.kind === 'DUEL_TARGET' && isActivePlayer) {
        this.pickDuelOpponent(action.targetId);
      } else if (action.kind === 'DILEMMA_TARGET' && isActivePlayer) {
        this.pickDilemmaPartner(action.targetId);
      } else if (action.kind === 'DILEMMA_ACT') {
        // В дилемме сначала жмёт активный игрок, затем выбранный напарник
        if (!ct.dilemmaFirstChoice && isActivePlayer) {
          this.submitDilemmaChoice(action.choice);
        } else if (ct.dilemmaFirstChoice && player.id === ct.dilemmaPartnerId) {
          this.submitDilemmaChoice(action.choice);
        }
      }
      return;
    }

    // 4. Ставки зрителей с телефонов (пока активный игрок думает над вопросом)
    if (action.kind === 'SIDE_BET' && !isActivePlayer && ct.step === 'question' && !ct.betsLocked) {
      sfx.play('click');
      ct.sideBets[player.id] = action.bet; // 'pass' | 'fail'
      this.saveHostState();
      this.render();
      return;
    }

    // 5. Использование Джокера с телефона активного игрока
    if (action.kind === 'USE_JOKER' && isActivePlayer && ct.step === 'question') {
      this.useJoker(action.jokerType);
      return;
    }
    if (action.kind === 'JOKER_TARGET' && isActivePlayer && ct.step === 'question') {
      this.confirmJokerTarget(action.targetId);
      return;
    }

    // 6. Ответ на вопрос с телефона
    if (action.kind === 'ANSWER_OPTION') {
      // В социальном вопросе на шаге 'social_verify' отвечает тот коллега, про которого вопрос!
      if (ct.question.type === 'social' && ct.step === 'social_verify') {
        if (player.id === ct.question.socialTargetId) {
          this.answerQuestion(Number(action.optionIdx));
        }
        return;
      }
      // В дуэли сначала отвечает активный игрок, а вторым — вызванный соперник!
      if (ct.eventObj?.id === 'duel' && ct.duelOpponentId && ct.step === 'question') {
        if (ct.duelFirstAnswer === null && isActivePlayer) {
          this.answerQuestion(Number(action.optionIdx));
        } else if (ct.duelFirstAnswer !== null && player.id === ct.duelOpponentId) {
          this.answerQuestion(Number(action.optionIdx));
        }
        return;
      }
      // В обычном вопросе отвечает активный игрок
      if (isActivePlayer && ct.step === 'question') {
        this.answerQuestion(Number(action.optionIdx));
      }
      return;
    }

    // 7. Ползунок интуиции с телефона активного игрока
    if (action.kind === 'SLIDER_SUBMIT' && isActivePlayer && ct.step === 'question') {
      ct.sliderValue = Number(action.value);
      this.submitSliderGuess();
      return;
    }

    // 8. Переход к следующему ходу с телефона активного игрока
    if (action.kind === 'NEXT_TURN' && isActivePlayer && ct.step === 'answered') {
      this.nextTurn();
    }
  }

  spawnReactionOnHost(playerName, colorHex, emoji) {
    sfx.play('click');
    const container = document.getElementById('host-reactions-layer');
    if (!container) return;

    const el = document.createElement('div');
    const leftPct = Math.floor(Math.random() * 65) + 15;
    el.className = 'reaction-toast fixed bottom-8 z-50 px-4 py-2 rounded-full bg-[#151923] border-2 shadow-xl flex items-center gap-2 pointer-events-none';
    el.style.left = `${leftPct}%`;
    el.style.borderColor = colorHex || '#facc15';
    el.innerHTML = `<span class="text-xl">${this.escapeHtml(emoji)}</span><span class="text-xs font-bold text-white">${this.escapeHtml(playerName)}</span>`;
    container.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  // Синхронизация состояния Хоста на все подключённые телефоны
  broadcastToPlayers() {
    if (this.role !== 'host' || !this.p2p.roomCode) return;
    const activePlayer = this.getActivePlayer();
    const ct = this.state.currentTurn;

    const payload = {
      screen: this.state.screen,
      roomCode: this.state.roomCode,
      turn: this.state.turn,
      totalQuestions: this.state.totalQuestions,
      activePlayerId: activePlayer?.id || null,
      activePlayerName: activePlayer?.name || '',
      players: this.state.players.map((p) => ({
        id: p.id,
        token: p.token,
        name: p.name,
        color: p.color,
        colorHex: p.colorHex,
        score: p.score,
        streak: p.streak,
        jokers: p.jokers
      })),
      currentTurn: ct
        ? {
            step: ct.step,
            wheelSpun: ct.wheelSpun,
            eventObj: ct.eventObj,
            multiplier: ct.multiplier,
            usedHintOrFifty: ct.usedHintOrFifty,
            hiddenOptions: ct.hiddenOptions,
            hintText: ct.hintText,
            allyPlayerId: ct.allyPlayerId,
            selectingTargetFor: ct.selectingTargetFor,
            betsLocked: ct.betsLocked,
            sideBets: ct.sideBets,
            boxes: ct.boxes.map((b) => ({ label: b.label })),
            boxResultMsg: ct.boxResultMsg,
            duelOpponentId: ct.duelOpponentId,
            duelFirstAnswerDone: ct.duelFirstAnswer !== null,
            dilemmaPartnerId: ct.dilemmaPartnerId,
            dilemmaFirstChoiceDone: Boolean(ct.dilemmaFirstChoice),
            dilemmaResultMsg: ct.dilemmaResultMsg,
            sliderValue: ct.sliderValue,
            isWin: ct.isWin,
            outcomeTitle: ct.outcomeTitle,
            outcomeDeltaText: ct.outcomeDeltaText,
            question: {
              type: ct.question.type,
              category: ct.question.category,
              points: ct.question.points,
              question: ct.question.question,
              options: ct.question.options,
              min: ct.question.min,
              max: ct.question.max,
              step: ct.question.step,
              unit: ct.question.unit,
              socialTargetId: ct.question.socialTargetId,
              socialTargetName: ct.question.socialTargetName,
              explanation: ct.step === 'answered' ? ct.question.explanation : ''
            }
          }
        : null
    };

    this.p2p.broadcastState(payload);
  }

  handleRemoteStateFromHost(st) {
    const nextJson = JSON.stringify(st);
    const isSame = this.lastRemoteJson === nextJson;
    this.lastRemoteJson = nextJson;
    this.remoteState = st;

    const me = this.getClientPlayerObj();
    if (me) {
      this.p2p.stopJoinRetry();
    }

    if (!isSame) {
      this.render();
    }
  }

  getClientPlayerObj() {
    if (!this.remoteState?.players) return null;
    return (
      this.remoteState.players.find((p) => p.token === this.clientToken) ||
      this.remoteState.players.find((p) => p.name.toLowerCase() === this.clientNameInput.trim().toLowerCase())
    );
  }

  // --- ИГРОВАЯ ЛОГИКА ХОСТА ---
  getActivePlayer() {
    return this.state.players[this.state.activePlayerIdx] || this.state.players[0];
  }

  startGame() {
    if (this.state.players.length < 2) {
      alert('Добавьте хотя бы 2 игроков (с телефонов по QR-коду или кнопкой «+ Игрок на экране»)!');
      return;
    }
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
      this.saveHostState();
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

    if ((!q.type || q.type === 'choice') && Array.isArray(q.options) && q.options.length === 4) {
      const correctText = q.options[q.answer];
      const indices = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
      q.options = indices.map((i) => q.options[i]);
      q.answer = q.options.indexOf(correctText);
      q.type = 'choice';
    }

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

    const isWheelTurn = this.state.turn % 4 === 0;
    let evObj = null;
    if (isWheelTurn) {
      const prevEvId = this.lastWheelEventId || null;
      const candidates = WHEEL_EVENTS.filter((e) => e.id !== prevEvId);
      evObj = candidates[Math.floor(Math.random() * candidates.length)] || WHEEL_EVENTS[0];
      this.lastWheelEventId = evObj.id;
    }

    const boxes = [
      { label: 'Шкатулка №1', effect: 'plus300', title: '+300 очков' },
      { label: 'Шкатулка №2', effect: 'double', title: 'Удвоение вопроса ×2' },
      { label: 'Шкатулка №3', effect: 'minus100', title: 'Ловушка -100 очков' }
    ].sort(() => Math.random() - 0.5);

    const midSlider = q.type === 'slider' ? Math.round(((q.min + q.max) / 2) / q.step) * q.step : 50;

    this.state.currentTurn = {
      question: q,
      eventObj: evObj,
      wheelSpun: false,
      step: isWheelTurn ? 'wheel' : 'question',

      multiplier: 1,
      usedDouble: false,
      usedHintOrFifty: false,
      betsLocked: false,
      sideBets: {}, // voterId -> 'pass' | 'fail'
      hiddenOptions: [],
      hintText: null,
      allyPlayerId: null,
      passedFromId: null,
      selectingTargetFor: null,

      sliderValue: midSlider,
      socialGuessedIdx: null,
      socialActualIdx: null,

      selectedOption: null,
      isWin: false,
      outcomeTitle: '',
      outcomeDeltaText: '',

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

    this.saveHostState();
    this.render();
  }

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
      if (slotTextEl) slotTextEl.textContent = randomEv.title;
      ticks++;
      if (ticks >= totalTicks) {
        clearInterval(interval);
        this.wheelSpinning = false;
        sfx.play('event');
        ct.wheelSpun = true;
        this.saveHostState();
        this.render();
      }
    }, 85);
  }

  proceedFromWheel() {
    const ct = this.state.currentTurn;
    const player = this.getActivePlayer();
    const evId = ct.eventObj?.id;
    sfx.play('click');

    if (evId === 'gold_rush') {
      ct.multiplier = 2;
      ct.step = 'question';
    } else if (evId === 'minefield') {
      ct.multiplier = 2;
      ct.usedDouble = true;
      ct.step = 'question';
    } else if (evId === 'free_joker') {
      player.jokers = { fifty: true, double: true, ally: true, pass: true, hint: true };
      player.score += 100;
      sfx.play('joker');
      ct.step = 'question';
    } else if (evId === 'sniper') {
      ct.extraLife = true;
      ct.step = 'question';
    } else if (evId === 'steal' || evId === 'robin_hood' || evId === 'chain') {
      ct.step = 'question';
    } else {
      ct.step = 'event_action';
      if (evId === 'duel' && ct.question.type !== 'choice' && ct.question.type !== 'truth') {
        const choicePool = QUIZ_QUESTIONS.filter((q) => q.type === 'choice');
        ct.question = this.prepareQuestionInstance(choicePool[Math.floor(Math.random() * choicePool.length)]);
      }
    }
    this.saveHostState();
    this.render();
  }

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
      if (!b) return;
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
    this.saveHostState();
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
    this.saveHostState();
    this.render();
  }

  pickDuelOpponent(opponentId) {
    const ct = this.state.currentTurn;
    sfx.play('event');
    ct.duelOpponentId = opponentId;
    ct.step = 'question';
    this.saveHostState();
    this.render();
  }

  pickDilemmaPartner(partnerId) {
    const ct = this.state.currentTurn;
    sfx.play('click');
    ct.dilemmaPartnerId = partnerId;
    this.saveHostState();
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
      this.saveHostState();
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

    this.saveHostState();
    this.render();
  }

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
      ct.betsLocked = true;
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
      ct.betsLocked = true;
      ct.hintText = 'Подсказка загружается...';
      this.saveHostState();
      this.render();
      ct.hintText = await aiClient.generateHint(q);
    } else if (type === 'ally' || type === 'pass') {
      sfx.play('click');
      ct.selectingTargetFor = ct.selectingTargetFor === type ? null : type;
    }

    this.saveHostState();
    this.render();
  }

  confirmJokerTarget(targetId) {
    const ct = this.state.currentTurn;
    const player = this.getActivePlayer();
    const target = this.state.players.find((p) => p.id === targetId);
    if (!target) return;

    const mode = ct.selectingTargetFor;
    ct.selectingTargetFor = null;
    ct.betsLocked = true;
    sfx.play('joker');

    if (mode === 'ally') {
      player.jokers.ally = false;
      ct.usedHintOrFifty = true;
      ct.allyPlayerId = target.id;
    } else if (mode === 'pass') {
      player.jokers.pass = false;
      ct.passedFromId = player.id;
      delete ct.sideBets[target.id];
      const newIdx = this.state.players.findIndex((p) => p.id === target.id);
      if (newIdx !== -1) {
        this.state.activePlayerIdx = newIdx;
      }
    }

    this.saveHostState();
    this.render();
  }

  resolveSpectatorBets(isWin) {
    const ct = this.state.currentTurn;
    for (const [voterId, bet] of Object.entries(ct.sideBets || {})) {
      const voter = this.state.players.find((p) => p.id === voterId);
      if (!voter) continue;
      if ((bet === 'pass' && isWin) || (bet === 'fail' && !isWin)) {
        voter.score += 100;
      } else {
        voter.score -= 50;
      }
    }
  }

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
      ct.outcomeTitle = `Точно в яблочко! Ответ: ${q.correctValue}${q.unit}`;
    } else if (diff <= q.toleranceGood) {
      baseAward = 200;
      ct.outcomeTitle = `Очень близко! Ответ: ${q.correctValue}${q.unit}`;
    } else {
      baseAward = 0;
      ct.outcomeTitle = `Мимо! Правильный ответ: ${q.correctValue}${q.unit} (выбрано: ${ct.sliderValue}${q.unit})`;
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
      if (ct.eventObj?.id === 'robin_hood') {
        const sorted = [...this.state.players].sort((a, b) => b.score - a.score);
        const leader = sorted[0];
        const last = sorted[sorted.length - 1];
        if (leader && leader.id !== player.id) {
          leader.score -= 200;
          player.score += 100;
          if (last) last.score += 100;
          notes.push(`Робин Гуд: -200 у ${leader.name}, +100 тебе и +100 для ${last?.name}`);
        }
      }
      if (ct.eventObj?.id === 'chain') {
        const nextP = this.state.players[(this.state.activePlayerIdx + 1) % this.state.players.length];
        if (nextP && nextP.id !== player.id) {
          nextP.score += 150;
          notes.push(`Цепная реакция: +150 для ${nextP.name}`);
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

    this.resolveSpectatorBets(ct.isWin);
    this.saveHostState();
    this.render();
  }

  answerQuestion(optionIdx) {
    const ct = this.state.currentTurn;
    const q = ct.question;
    const player = this.getActivePlayer();

    if (q.type === 'social') {
      if (ct.step === 'question') {
        sfx.play('click');
        ct.socialGuessedIdx = optionIdx;
        ct.step = 'social_verify';
        this.saveHostState();
        this.render();
        return;
      }
      if (ct.step === 'social_verify') {
        ct.socialActualIdx = optionIdx;
        ct.selectedOption = ct.socialGuessedIdx;
        q.answer = optionIdx;
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
          ct.outcomeTitle = `Полный синхрон! Мысли ${q.socialTargetName} прочитаны!`;
          ct.outcomeDeltaText = `+${pts} для ${player.name} и +100 для ${q.socialTargetName}`;
          if (window.confetti) window.confetti({ particleCount: 55, spread: 65, origin: { y: 0.7 } });
        } else {
          sfx.play('wrong');
          player.streak = 0;
          ct.isWin = false;
          ct.outcomeTitle = `Не совпало! ${q.socialTargetName} выбрал другой вариант`;
          ct.outcomeDeltaText = '0 очков';
        }
        this.resolveSpectatorBets(ct.isWin);
        this.saveHostState();
        this.render();
        return;
      }
    }

    if (ct.step !== 'question') return;

    if (ct.eventObj?.id === 'duel' && ct.duelOpponentId) {
      if (ct.duelFirstAnswer === null) {
        sfx.play('click');
        ct.duelFirstAnswer = optionIdx;
        this.saveHostState();
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

      this.resolveSpectatorBets(ct.isWin);
      this.saveHostState();
      this.render();
      return;
    }

    const isCorrect = optionIdx === q.answer;

    // Если активен ивент «Право на ошибку (Снайпер)» и игрок промахнулся в первый раз — сжигаем неверный вариант и даём вторую попытку!
    if (!isCorrect && ct.extraLife && q.type === 'choice') {
      sfx.play('joker');
      ct.extraLife = false;
      ct.hiddenOptions.push(optionIdx);
      ct.hintText = 'Сработала броня «Право на ошибку»! Этот вариант был неверным — выберите ещё раз.';
      this.saveHostState();
      this.render();
      return;
    }

    ct.selectedOption = optionIdx;
    ct.step = 'answered';
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
      if (ct.eventObj?.id === 'robin_hood') {
        const sorted = [...this.state.players].sort((a, b) => b.score - a.score);
        const leader = sorted[0];
        const last = sorted[sorted.length - 1];
        if (leader && leader.id !== player.id) {
          leader.score -= 200;
          player.score += 100;
          if (last) last.score += 100;
          extraNotes.push(`Робин Гуд: -200 у ${leader.name}, +100 тебе и +100 для ${last?.name}`);
        }
      }
      if (ct.eventObj?.id === 'chain') {
        const nextP = this.state.players[(this.state.activePlayerIdx + 1) % this.state.players.length];
        if (nextP && nextP.id !== player.id) {
          nextP.score += 150;
          extraNotes.push(`Цепная реакция: +150 следующему игроку (${nextP.name})`);
        }
      }

      ct.outcomeTitle = 'Точно в цель!';
      ct.outcomeDeltaText = extraNotes.join(' · ');
      if (window.confetti) window.confetti({ particleCount: 45, spread: 60, origin: { y: 0.7 } });
    } else {
      sfx.play('wrong');
      player.streak = 0;
      ct.isWin = false;
      ct.outcomeTitle = 'Промах';
      if (ct.usedDouble) {
        const penalty = Math.round(q.points / 2);
        player.score -= penalty;
        ct.outcomeDeltaText = `Штраф за повышенный риск: -${penalty} очков`;
      } else if (ct.passedFromId) {
        player.score -= 100;
        ct.outcomeDeltaText = `Штраф по переданному вопросу: -100 очков`;
      } else {
        ct.outcomeDeltaText = '0 очков за этот ход';
      }
    }

    this.resolveSpectatorBets(ct.isWin);
    this.saveHostState();
    this.render();
  }

  // --- РЕНДЕРИНГ ВСЕХ 3 РЕЖИМОВ ОКНА: LANDING | HOST STAGE | PLAYER CONTROLLER ---
  render() {
    const root = document.getElementById('app-root');
    if (!root) return;

    if (this.role === 'landing') {
      root.innerHTML = this.renderLandingRoleChoice();
      this.bindLandingEvents();
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    if (this.role === 'player') {
      root.innerHTML = this.renderPlayerController();
      this.bindPlayerEvents();
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    // HOST VIEW (Экран для демонстрации в Discord)
    root.innerHTML = `
      <div class="min-h-screen flex flex-col relative">
        <div id="host-reactions-layer"></div>
        ${this.renderHostTopBar()}
        <main class="flex-1 flex items-center justify-center px-4 py-6">
          <div class="w-full ${this.state.screen === 'lobby' ? 'max-w-4xl' : 'max-w-2xl'}">
            ${
              this.state.screen === 'lobby'
                ? this.renderHostLobbyWithQR()
                : this.state.screen === 'results'
                ? this.renderHostResults()
                : this.renderHostPlayStage()
            }
          </div>
        </main>
        ${this.renderAiModal()}
      </div>
    `;

    this.bindHostEvents();
    this.drawQrCodeIfPresent();
    if (window.lucide) window.lucide.createIcons();
  }

  drawQrCodeIfPresent() {
    const canvas = document.getElementById('lobby-qr-canvas');
    if (!canvas || !window.QRious || !this.state.roomCode) return;
    const joinUrl = `${window.location.origin}${window.location.pathname}?room=${this.state.roomCode}`;
    new window.QRious({
      element: canvas,
      value: joinUrl,
      size: 200,
      background: '#ffffff',
      foreground: '#090b10',
      level: 'M'
    });
  }

  // ==========================================
  // 1. LANDING: ВЫБОР «Я ХОСТ» ИЛИ «Я ИГРОК»
  // ==========================================
  renderLandingRoleChoice() {
    return `
      <div class="min-h-screen flex items-center justify-center p-4">
        <div class="max-w-3xl w-full space-y-8 stage-enter">
          <div class="text-center space-y-2">
            <div class="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-yellow-400/15 text-yellow-400 text-xs font-bold">
              Вечерняя игра для Discord (Jackbox / Kahoot формат)
            </div>
            <h1 class="font-title text-3xl sm:text-4xl font-extrabold text-white">Выберите вашу роль</h1>
            <p class="text-sm text-gray-400 max-w-lg mx-auto">
              Один человек запускает <strong>Экран Хоста</strong> и шарит его в Discord, а остальные подключаются со своих телефонов или вкладок по QR-коду!
            </p>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <!-- Карточка Хоста -->
            <button id="btn-choose-host" class="game-stage-card p-7 text-left hover:border-yellow-400 transition group flex flex-col justify-between space-y-6">
              <div class="space-y-3">
                <div class="w-12 h-12 rounded-2xl bg-yellow-400 text-black flex items-center justify-center shadow-lg shadow-yellow-400/20 group-hover:scale-105 transition">
                  <i data-lucide="monitor" class="w-6 h-6"></i>
                </div>
                <h2 class="font-title text-xl font-bold text-white">Создать игру (Я Хост)</h2>
                <p class="text-xs text-gray-400 leading-relaxed">
                  Откроет главный экран с <strong>QR-кодом</strong> и кодом комнаты для демонстрации экрана в Discord.
                </p>
              </div>
              <div class="inline-flex items-center gap-2 text-xs font-bold text-yellow-400">
                Открыть экран ведущего <i data-lucide="arrow-right" class="w-4 h-4"></i>
              </div>
            </button>

            <!-- Карточка Игрока -->
            <button id="btn-choose-player" class="game-stage-card p-7 text-left hover:border-emerald-400 transition group flex flex-col justify-between space-y-6">
              <div class="space-y-3">
                <div class="w-12 h-12 rounded-2xl bg-emerald-400 text-black flex items-center justify-center shadow-lg shadow-emerald-400/20 group-hover:scale-105 transition">
                  <i data-lucide="smartphone" class="w-6 h-6"></i>
                </div>
                <h2 class="font-title text-xl font-bold text-white">Войти в комнату (Я Игрок)</h2>
                <p class="text-xs text-gray-400 leading-relaxed">
                  Введите 4 буквы кода комнаты с экрана Хоста, назовите себя и отвечайте со своего устройства!
                </p>
              </div>
              <div class="inline-flex items-center gap-2 text-xs font-bold text-emerald-400">
                Подключиться к игре <i data-lucide="arrow-right" class="w-4 h-4"></i>
              </div>
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // ==========================================
  // 2. HOST VIEW: ЛОББИ С QR-КОДОМ И ИГРОВАЯ СЦЕНА
  // ==========================================
  renderHostTopBar() {
    const joinUrl = this.state.roomCode
      ? `${window.location.origin}${window.location.pathname}?room=${this.state.roomCode}`
      : '';

    return `
      <header class="border-b border-[#2a3246] bg-[#0b0d13]/95 backdrop-blur sticky top-0 z-20">
        <div class="max-w-5xl mx-auto px-4 py-2.5 flex flex-wrap items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <button id="btn-host-to-lobby" class="px-3 py-1.5 rounded-xl bg-[#151923] hover:bg-[#1c2230] border border-[#2a3246] text-xs font-semibold text-gray-300 flex items-center gap-1.5">
              <i data-lucide="users" class="w-3.5 h-3.5 text-yellow-400"></i>
              Лобби (${this.state.players.length})
            </button>
            ${
              this.state.roomCode
                ? `<button id="btn-copy-join-link" data-url="${joinUrl}" class="px-3 py-1.5 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-num text-xs font-bold flex items-center gap-1.5 hover:bg-emerald-500/25 transition" title="Скопировать ссылку для входа игроков">
                    КОД: ${this.state.roomCode}
                    <i data-lucide="copy" class="w-3.5 h-3.5"></i>
                  </button>`
                : ''
            }
          </div>

          ${
            this.state.screen === 'play'
              ? `<div class="flex items-center gap-1.5 flex-wrap">
                  ${this.state.players
                    .map((p, idx) => {
                      const active = idx === this.state.activePlayerIdx;
                      const bet = this.state.currentTurn?.sideBets?.[p.id];
                      return `
                        <div class="px-3 py-1 rounded-xl text-xs flex items-center gap-1.5 transition ${
                          active
                            ? 'bg-yellow-400 text-black font-extrabold shadow scale-105'
                            : 'bg-[#151923] text-gray-200 border border-[#2a3246]'
                        }">
                          <span class="w-2 h-2 rounded-full" style="background:${p.colorHex || '#facc15'}"></span>
                          <span>${this.escapeHtml(p.name)}</span>
                          <span class="font-num ${active ? 'text-black' : 'text-yellow-400 font-bold'}">${p.score}</span>
                          ${
                            !active && bet
                              ? `<span class="text-[10px] px-1 rounded ${
                                  bet === 'pass' ? 'bg-emerald-500/30 text-emerald-300' : 'bg-red-500/30 text-red-300'
                                }">${bet === 'pass' ? 'Верит' : 'Фол'}</span>`
                              : ''
                          }
                        </div>
                      `;
                    })
                    .join('')}
                </div>`
              : ''
          }

          <div class="flex items-center gap-1.5">
            <button id="btn-open-ai" class="px-3 py-1.5 rounded-xl bg-[#151923] hover:bg-[#1c2230] border border-[#2a3246] text-xs font-semibold text-gray-300 flex items-center gap-1.5">
              <i data-lucide="sparkles" class="w-3.5 h-3.5 text-yellow-400"></i>
              <span class="hidden sm:inline">ИИ-вопросы</span>
            </button>
            <button id="btn-sound" class="p-2 rounded-xl bg-[#151923] hover:bg-[#1c2230] border border-[#2a3246] text-gray-300">
              <i data-lucide="${sfx.muted ? 'volume-x' : 'volume-2'}" class="w-4 h-4"></i>
            </button>
          </div>
        </div>
      </header>
    `;
  }

  renderHostLobbyWithQR() {
    const joinUrl = this.state.roomCode
      ? `${window.location.origin}${window.location.pathname}?room=${this.state.roomCode}`
      : '';

    return `
      <div class="grid grid-cols-1 md:grid-cols-12 gap-6 items-stretch stage-enter">
        <!-- Левая карточка: QR-код и Код комнаты (5 колонок) -->
        <div class="md:col-span-5 game-stage-card p-6 flex flex-col items-center justify-between text-center space-y-4">
          <div class="space-y-1">
            <div class="text-xs font-bold uppercase tracking-wider text-yellow-400">Вход с телефона или ПК</div>
            <div class="text-xs text-gray-400">Наведите камеру на QR-код или перейдите по ссылке в чате Discord</div>
          </div>

          <!-- QR-код -->
          <div class="p-3.5 bg-white rounded-2xl shadow-xl">
            ${
              this.state.roomCode
                ? `<canvas id="lobby-qr-canvas" width="200" height="200" class="block"></canvas>`
                : `<div class="w-[200px] h-[200px] flex items-center justify-center text-xs text-gray-500">Создаём комнату...</div>`
            }
          </div>

          <div class="w-full space-y-2">
            <div class="text-[11px] font-bold uppercase text-gray-400">Код комнаты:</div>
            <div class="font-title text-3xl font-black tracking-widest text-yellow-400 bg-[#0b0d13] py-2.5 rounded-xl border border-[#2a3246]">
              ${this.state.roomCode || '....'}
            </div>
            <button id="btn-copy-join-link-big" data-url="${joinUrl}" class="w-full py-2.5 px-4 rounded-xl bg-[#1c2230] hover:bg-[#252d3f] border border-[#2a3246] text-xs font-semibold text-gray-200 flex items-center justify-center gap-2 transition">
              <i data-lucide="copy" class="w-3.5 h-3.5 text-yellow-400"></i>
              Скопировать ссылку для Discord
            </button>
          </div>
        </div>

        <!-- Правая карточка: Подключившиеся игроки и кнопка старта (7 колонок) -->
        <div class="md:col-span-7 game-stage-card p-6 flex flex-col justify-between space-y-5">
          <div class="space-y-4">
            <div class="flex items-center justify-between">
              <div>
                <h2 class="font-title text-xl font-bold text-white">
                  Игроки в комнате (${this.state.players.length})
                </h2>
                <p class="text-xs text-gray-400 mt-0.5">
                  Игроки появляются здесь автоматически при входе по QR/ссылке
                </p>
              </div>
              <button id="btn-add-local-player" class="px-3 py-1.5 rounded-xl bg-[#1c2230] hover:bg-[#252d3f] border border-[#2a3246] text-xs font-bold text-yellow-400">
                + Игрок на экране
              </button>
            </div>

            ${
              this.state.players.length === 0
                ? `<div class="p-8 rounded-2xl bg-[#0b0d13] border border-dashed border-[#2a3246] text-center space-y-2">
                    <div class="text-sm font-semibold text-gray-300">Ждём подключения игроков...</div>
                    <div class="text-xs text-gray-500">Отсканируйте QR-код слева со смартфона или скиньте ссылку коллегам в Discord!</div>
                  </div>`
                : `<div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-[270px] overflow-y-auto pr-1">
                    ${this.state.players
                      .map(
                        (p) => `
                      <div class="flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl bg-[#0b0d13] border border-[#2a3246]">
                        <div class="flex items-center gap-2.5 min-w-0 flex-1">
                          <span class="w-3.5 h-3.5 rounded-full shrink-0" style="background:${p.colorHex || '#facc15'}"></span>
                          <input
                            type="text"
                            data-host-edit-name="${p.id}"
                            value="${this.escapeHtml(p.name)}"
                            class="bg-transparent text-sm font-bold text-white focus:outline-none truncate w-full"
                          />
                        </div>
                        <div class="flex items-center gap-1.5 shrink-0">
                          <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                            p.peerId ? 'bg-emerald-500/15 text-emerald-400' : 'bg-gray-800 text-gray-400'
                          }">
                            ${p.peerId ? '📱 Пульт' : '🖥️ Экран'}
                          </span>
                          <button data-host-kick="${p.id}" class="text-gray-500 hover:text-red-400">
                            <i data-lucide="x" class="w-4 h-4"></i>
                          </button>
                        </div>
                      </div>
                    `
                      )
                      .join('')}
                  </div>`
            }
          </div>

          <div class="space-y-4 pt-3 border-t border-[#2a3246]">
            <div class="flex items-center justify-between">
              <span class="text-xs font-semibold text-gray-400">Вопросов в партии:</span>
              <div class="flex gap-1.5">
                ${[20, 35, 50]
                  .map(
                    (n) => `
                  <button
                    data-set-total="${n}"
                    class="px-3.5 py-1.5 rounded-xl font-num text-xs font-bold border transition ${
                      this.state.totalQuestions === n
                        ? 'bg-yellow-400 text-black border-yellow-400'
                        : 'bg-[#0b0d13] text-gray-400 border-[#2a3246] hover:text-white'
                    }"
                  >${n}</button>
                `
                  )
                  .join('')}
              </div>
            </div>

            <div class="flex gap-3">
              <button id="btn-host-start" class="tactile-gold-btn flex-1 py-4 px-6 text-sm font-title">
                Запустить игру (${this.state.players.length} игр.)
              </button>
              ${
                this.state.currentTurn && this.state.turn > 1
                  ? `<button id="btn-host-resume" class="tactile-option py-4 px-4 text-xs font-bold text-white">
                      Продолжить (Ход ${this.state.turn})
                    </button>`
                  : ''
              }
            </div>
          </div>
        </div>
      </div>
    `;
  }

  renderHostPlayStage() {
    const ct = this.state.currentTurn;
    if (!ct) return '';

    if (ct.step === 'wheel') return this.renderWheelStep(ct);
    if (ct.step === 'event_action') return this.renderEventActionStep(ct);
    return this.renderQuestionCard(ct);
  }

  renderWheelStep(ct) {
    const player = this.getActivePlayer();
    const ev = ct.eventObj;

    return `
      <div class="game-stage-card p-6 sm:p-9 text-center space-y-6 stage-enter">
        <div class="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-yellow-400/15 text-yellow-400 text-xs font-bold uppercase">
          ★ Событие ${this.state.turn}-го хода
        </div>

        <h2 class="font-title text-2xl sm:text-3xl font-extrabold text-white">
          Барабан событий для ${this.escapeHtml(player.name)}
        </h2>
        <p class="text-xs text-gray-400">
          ${this.escapeHtml(player.name)} может крутануть барабан прямо со своего телефона (или ведущий на экране)
        </p>

        <div class="p-7 rounded-2xl bg-[#0b0d13] border-2 ${
          ct.wheelSpun ? 'border-yellow-400 shadow-lg shadow-yellow-400/10' : 'border-[#2a3246]'
        } max-w-md mx-auto space-y-2">
          <div class="text-xs font-semibold text-gray-500 uppercase tracking-widest">
            ${ct.wheelSpun ? 'ВЫПАЛ СЕКТОР:' : 'БАРАБАН ГОТОВ'}
          </div>
          <div id="wheel-slot-title" class="font-title text-2xl sm:text-3xl font-black text-yellow-400 py-2">
            ${ct.wheelSpun ? ev.title : '???'}
          </div>
          ${ct.wheelSpun ? `<p class="text-sm text-gray-300 leading-relaxed pt-1">${this.escapeHtml(ev.desc)}</p>` : ''}
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

  renderEventActionStep(ct) {
    const player = this.getActivePlayer();
    const others = this.state.players.filter((p) => p.id !== player.id);
    const evId = ct.eventObj?.id;
    const cat = CATEGORIES[ct.question.category] || CATEGORIES.wild_cases;

    if (evId === 'boxes') {
      return `
        <div class="game-stage-card p-6 sm:p-9 space-y-6 text-center stage-enter">
          <div class="inline-block px-3 py-1 rounded-full bg-yellow-400/15 text-yellow-400 text-xs font-bold">
            Три шкатулки · Выбирает ${this.escapeHtml(player.name)}
          </div>
          <h2 class="font-title text-2xl font-bold text-white">Выбери одну из трёх шкатулок</h2>
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
                  Отказаться от риска и забрать +100 очков
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
            Любой игрок может нажать кнопку на своём телефоне и перехватить этот вопрос за <strong>двойные очки (+${ct.question.points * 2})</strong>!
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
            Оба ответите со своих пультов. Победитель получает <strong>+300 очков</strong> и забирает 100 очков у проигравшего!
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
                  Оба тайно жмут на пультах: «Поделить» (+200 обоим) или «Украсть» (+350 себе, -100 напарнику). Если оба нажали «Украсть» — оба теряют по 150!
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
                  Выбирает на пульте: <span class="text-yellow-400">${this.escapeHtml(
                    !ct.dilemmaFirstChoice ? player.name : partner.name
                  )}</span>
                </h2>
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
      choice: { label: `${cat.name} · Вопрос ${this.state.turn}/${this.state.totalQuestions}`, color: 'text-indigo-300 bg-indigo-500/15 border-indigo-500/30' },
      truth: { label: `Правда или Вымысел · Ход ${this.state.turn}/${this.state.totalQuestions}`, color: 'text-amber-300 bg-amber-500/15 border-amber-500/30' },
      slider: { label: `Ползунок интуиции · Ход ${this.state.turn}/${this.state.totalQuestions}`, color: 'text-cyan-300 bg-cyan-500/15 border-cyan-500/30' },
      social: { label: `Чтение мыслей · ${q.socialTargetName || 'Коллега'}`, color: 'text-pink-300 bg-pink-500/15 border-pink-500/30' }
    };
    const badge = typeBadges[q.type || 'choice'] || typeBadges.choice;

    return `
      <div class="game-stage-card p-6 sm:p-9 space-y-6 stage-enter">
        <div class="flex flex-wrap items-center justify-between gap-2 pb-4 border-b border-[#2a3246]">
          <div class="space-y-1">
            <span class="inline-block px-2.5 py-0.5 rounded-md border text-[11px] font-bold ${badge.color}">
              ${badge.label}
            </span>
            <div class="text-base font-bold text-white pt-0.5">
              ${
                isSocialVerify
                  ? `Ждём подтверждения на пульте от <span class="text-pink-400">${this.escapeHtml(q.socialTargetName)}</span>`
                  : isDuel
                  ? ct.duelFirstAnswer === null
                    ? `Дуэль (1/2) · Отвечает: <span class="text-yellow-400">${this.escapeHtml(player.name)}</span>`
                    : `Дуэль (2/2) · Отвечает: <span class="text-yellow-400">${this.escapeHtml(duelOpponent?.name || '')}</span>`
                  : `Отвечает: <span class="text-yellow-400">${this.escapeHtml(player.name)}</span>`
              }
            </div>
          </div>

          <span class="px-3.5 py-1.5 rounded-xl bg-yellow-400/15 border border-yellow-400/30 text-yellow-400 font-num font-bold text-sm">
            +${isDuel ? 300 : q.type === 'slider' ? 350 * ct.multiplier : pts}
          </span>
        </div>

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
                )}</strong> подсказывает в голосовом чате (+150 ему при успехе).
              </div>`
            : ''
        }

        ${q.type === 'slider' ? this.renderSliderBody(ct, q, isAnswered) : this.renderOptionsBody(ct, q, isAnswered)}

        ${
          ct.selectingTargetFor && !isAnswered
            ? `<div class="p-4 rounded-xl bg-[#0b0d13] border border-yellow-400/50 space-y-2.5 stage-enter">
                <div class="text-xs font-bold text-yellow-400">
                  ${
                    ct.selectingTargetFor === 'ally'
                      ? 'Кого берём в союзники (+150 ему при верном ответе)?'
                      : 'Кому принудительно передаём этот вопрос?'
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

        ${
          !isAnswered && !isSocialVerify && !isDuel
            ? `
              <div class="pt-4 border-t border-[#2a3246] space-y-2">
                <div class="text-[11px] font-semibold text-gray-500">
                  Джокеры игрока ${this.escapeHtml(player.name)} (доступны и на телефоне):
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
          <span class="text-xs font-bold uppercase tracking-wider text-gray-400">Ответ на шкале:</span>
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

  renderHostResults() {
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
                <span class="w-3 h-3 rounded-full" style="background:${p.colorHex || '#facc15'}"></span>
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

  // ==========================================
  // 3. PLAYER CONTROLLER VIEW: ЛИЧНЫЙ ПУЛЬТ ИГРОКА НА ТЕЛЕФОНЕ / ВКЛАДКЕ
  // ==========================================
  renderPlayerController() {
    // Шаг А: Если ещё не подключился к комнате — экран ввода кода комнаты, имени и цвета
    if (!this.clientConnected) {
      return `
        <div class="min-h-screen flex items-center justify-center p-4">
          <div class="game-stage-card max-w-md w-full p-6 sm:p-8 space-y-6 stage-enter">
            <div class="flex items-center justify-between">
              <button id="btn-player-back-landing" class="text-xs text-gray-400 hover:text-white">← Назад</button>
              <span class="text-xs font-bold uppercase text-emerald-400">Пульт игрока</span>
            </div>

            <div>
              <h1 class="font-title text-2xl font-bold text-white">Вход в комнату</h1>
              <p class="text-xs text-gray-400 mt-1">Введите 4-буквенный код с экрана ведущего в Discord и назовите себя</p>
            </div>

            ${
              this.clientError
                ? `<div class="p-3 rounded-xl bg-red-500/15 border border-red-500/40 text-xs font-semibold text-red-300">
                    ${this.escapeHtml(this.clientError)}
                  </div>`
                : ''
            }

            <div class="space-y-4">
              <div>
                <label class="block text-xs font-bold uppercase text-gray-400 mb-1.5">Код комнаты (4 символа):</label>
                <input
                  id="player-room-code"
                  type="text"
                  maxlength="4"
                  value="${this.escapeHtml(this.clientRoomInput)}"
                  placeholder="ABCD"
                  class="w-full rounded-xl bg-[#0b0d13] border-2 border-[#2a3246] focus:border-yellow-400 px-4 py-3 font-title text-2xl text-center uppercase tracking-widest text-yellow-400 focus:outline-none"
                />
              </div>

              <div>
                <label class="block text-xs font-bold uppercase text-gray-400 mb-1.5">Ваше имя:</label>
                <input
                  id="player-nickname"
                  type="text"
                  maxlength="18"
                  value="${this.escapeHtml(this.clientNameInput)}"
                  placeholder="Например, Алекс"
                  class="w-full rounded-xl bg-[#0b0d13] border border-[#2a3246] focus:border-yellow-400 px-4 py-3 text-base font-bold text-white focus:outline-none"
                />
              </div>

              <div>
                <label class="block text-xs font-bold uppercase text-gray-400 mb-1.5">Ваш цвет:</label>
                <div class="grid grid-cols-6 gap-2">
                  ${PLAYER_COLORS.map(
                    (c) => `
                    <button
                      type="button"
                      data-pick-color="${c.id}"
                      class="h-10 rounded-xl border-2 transition ${
                        this.clientColorInput === c.id ? 'border-white scale-110 shadow-lg' : 'border-transparent opacity-60'
                      }"
                      style="background:${c.hex}"
                    ></button>
                  `
                  ).join('')}
                </div>
              </div>

              <button
                id="btn-player-connect"
                ${this.clientConnecting ? 'disabled' : ''}
                class="tactile-gold-btn w-full py-4 text-sm font-title"
              >
                ${this.clientConnecting ? 'Подключаемся...' : 'Войти в игру →'}
              </button>
            </div>
          </div>
        </div>
      `;
    }

    // Шаг Б: Игрок подключён!
    const rs = this.remoteState || { screen: 'lobby', roomCode: this.clientRoomInput, players: [] };
    const me = this.getClientPlayerObj();
    const isMyTurn = me && rs.activePlayerId === me.id;
    const ct = rs.currentTurn;
    const sorted = [...(rs.players || [])].sort((a, b) => b.score - a.score);
    const myRank = me ? sorted.findIndex((p) => p.id === me.id) + 1 : '-';

    return `
      <div class="min-h-screen max-w-md mx-auto p-4 flex flex-col justify-between gap-4">
        <!-- Верхняя плашка игрока на телефоне -->
        <div class="game-stage-card p-4 flex items-center justify-between">
          <div class="flex items-center gap-2.5">
            <span class="w-4 h-4 rounded-full" style="background:${me?.colorHex || '#facc15'}"></span>
            <div>
              <div class="font-bold text-sm text-white">${this.escapeHtml(me?.name || this.clientNameInput)}</div>
              <div class="text-[11px] text-gray-400">Место: #${myRank} из ${rs.players?.length || 1}</div>
            </div>
          </div>
          <div class="text-right">
            <div class="font-num font-extrabold text-xl text-yellow-400">${me?.score ?? 0}</div>
            <div class="text-[10px] text-gray-400 uppercase">очков</div>
          </div>
        </div>

        <!-- Центральная панель пульта в зависимости от фазы игры -->
        <div class="flex-1 flex flex-col justify-center">
          ${this.renderPlayerActiveControl(rs, ct, me, isMyTurn)}
        </div>

        <!-- Нижняя панель живых реакций (вылетают на экран Хоста в Discord!) -->
        <div class="game-stage-card p-3 flex items-center justify-between">
          <span class="text-[11px] font-semibold text-gray-400 pl-1">Реакция на экран:</span>
          <div class="flex gap-1.5">
            ${['🔥', '😂', '👏', '🎯', '💀']
              .map(
                (em) => `
              <button data-send-reaction="${em}" class="w-10 h-10 rounded-xl bg-[#0b0d13] hover:bg-[#1c2230] border border-[#2a3246] text-lg flex items-center justify-center active:scale-90 transition">
                ${em}
              </button>
            `
              )
              .join('')}
          </div>
        </div>
      </div>
    `;
  }

  renderPlayerActiveControl(rs, ct, me, isMyTurn) {
    if (!me) {
      return `
        <div class="game-stage-card p-7 text-center space-y-4 stage-enter">
          <div class="w-12 h-12 rounded-2xl bg-yellow-400/20 text-yellow-400 flex items-center justify-center mx-auto animate-pulse">
            <i data-lucide="radio" class="w-7 h-7"></i>
          </div>
          <h2 class="font-title text-xl font-bold text-white">Стучимся в комнату ${this.escapeHtml(this.clientRoomInput)}...</h2>
          <p class="text-xs text-gray-400 leading-relaxed">
            Отправляем сигнал на экран ведущего. Убедитесь, что у Хоста на компьютере открыто лобби с кодом <strong>${this.escapeHtml(this.clientRoomInput)}</strong>!
          </p>
          <button id="btn-client-change-room" class="px-4 py-2 rounded-xl bg-[#0b0d13] border border-[#2a3246] text-xs font-bold text-gray-300">
            ← Изменить код комнаты
          </button>
        </div>
      `;
    }

    if (rs.screen === 'lobby' || !ct) {
      const playerNames = (rs.players || []).map((p) => p.name).join(', ');
      return `
        <div class="game-stage-card p-7 text-center space-y-4 stage-enter">
          <div class="w-12 h-12 rounded-2xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center mx-auto">
            <i data-lucide="check-circle-2" class="w-7 h-7"></i>
          </div>
          <h2 class="font-title text-xl font-bold text-white">Вы в комнате ${this.escapeHtml(rs.roomCode)}!</h2>
          <div class="p-3 rounded-xl bg-[#0b0d13] border border-[#2a3246] text-xs text-gray-300">
            Игроки в лобби (${rs.players?.length || 1}): <strong class="text-yellow-400">${this.escapeHtml(playerNames)}</strong>
          </div>
          <p class="text-xs text-gray-400 leading-relaxed">
            Ждём, когда ведущий нажмёт «Запустить игру» на главном экране в Discord.
          </p>
        </div>
      `;
    }

    if (rs.screen === 'results') {
      return `
        <div class="game-stage-card p-7 text-center space-y-3 stage-enter">
          <div class="text-xs font-bold uppercase text-yellow-400">Партия завершена!</div>
          <h2 class="font-title text-2xl font-bold text-white">Ваш итоговый счёт: ${me?.score ?? 0}</h2>
        </div>
      `;
    }

    // 1. Шаг барабана событий
    if (ct.step === 'wheel') {
      if (isMyTurn) {
        return `
          <div class="game-stage-card p-6 text-center space-y-5 stage-enter">
            <div class="text-xs font-bold uppercase text-yellow-400">Твой ход · Событие!</div>
            <h2 class="font-title text-xl font-bold text-white">
              ${ct.wheelSpun ? ct.eventObj?.title : 'Испытай удачу на барабане!'}
            </h2>
            ${
              ct.wheelSpun
                ? `<p class="text-xs text-gray-300">${this.escapeHtml(ct.eventObj?.desc || '')}</p>
                   <button id="btn-client-wheel" class="tactile-gold-btn w-full py-4 text-sm font-title">Продолжить →</button>`
                : `<button id="btn-client-wheel" class="tactile-gold-btn w-full py-5 text-base font-title">Крутить барабан!</button>`
            }
          </div>
        `;
      }
      return `
        <div class="game-stage-card p-6 text-center space-y-2">
          <div class="text-xs font-bold text-yellow-400">Барабан событий</div>
          <p class="text-sm text-gray-300">Сейчас крутит барабан игрок <strong>${this.escapeHtml(rs.activePlayerName)}</strong></p>
        </div>
      `;
    }

    // 2. Шаг спец-ивента перед вопросом
    if (ct.step === 'event_action') {
      const evId = ct.eventObj?.id;
      if (evId === 'boxes' && isMyTurn) {
        return `
          <div class="game-stage-card p-6 space-y-4 text-center stage-enter">
            <div class="text-xs font-bold text-yellow-400 uppercase">Три шкатулки</div>
            ${
              ct.boxResultMsg
                ? `<div class="p-3.5 rounded-xl bg-[#0b0d13] text-sm font-bold text-yellow-300">${this.escapeHtml(ct.boxResultMsg)}</div>
                   <button id="btn-client-proceed-q" class="tactile-gold-btn w-full py-4 text-sm font-title">Перейти к вопросу →</button>`
                : `<div class="grid grid-cols-1 gap-2.5">
                    ${ct.boxes
                      .map(
                        (b, i) => `
                      <button data-client-box="${i}" class="tactile-option p-4 font-bold text-sm text-white">Открыть: ${b.label}</button>
                    `
                      )
                      .join('')}
                    <button data-client-box="-1" class="py-2 text-xs text-gray-400 underline">Отказаться и взять +100 очков</button>
                  </div>`
            }
          </div>
        `;
      }

      if (evId === 'auction') {
        return `
          <div class="game-stage-card p-6 space-y-4 text-center stage-enter">
            <div class="text-xs font-bold text-emerald-400 uppercase">Перекуп вопроса вслепую</div>
            <p class="text-xs text-gray-300">Нажмите ниже, если готовы забрать этот вопрос себе за двойные очки!</p>
            <button id="btn-client-auction-take" class="tactile-gold-btn w-full py-4 text-sm font-title">
              Перекупить вопрос себе (×2)!
            </button>
          </div>
        `;
      }

      if (evId === 'duel' && isMyTurn) {
        const others = (rs.players || []).filter((p) => p.id !== me.id);
        return `
          <div class="game-stage-card p-6 space-y-3 stage-enter">
            <div class="text-xs font-bold text-red-400 uppercase">Выбери соперника для дуэли:</div>
            ${others
              .map(
                (op) => `
              <button data-client-duel-target="${op.id}" class="tactile-option w-full p-3.5 text-left font-bold text-sm text-white flex justify-between">
                <span>${this.escapeHtml(op.name)}</span>
                <span class="text-yellow-400 font-num">${op.score}</span>
              </button>
            `
              )
              .join('')}
          </div>
        `;
      }

      if (evId === 'dilemma') {
        if (!ct.dilemmaPartnerId && isMyTurn) {
          const others = (rs.players || []).filter((p) => p.id !== me.id);
          return `
            <div class="game-stage-card p-6 space-y-3 stage-enter">
              <div class="text-xs font-bold text-purple-400 uppercase">Выбери напарника для сделки:</div>
              ${others
                .map(
                  (op) => `
                <button data-client-dilemma-target="${op.id}" class="tactile-option w-full p-3.5 text-left font-bold text-sm text-white flex justify-between">
                  <span>${this.escapeHtml(op.name)}</span>
                  <span class="text-yellow-400 font-num">${op.score}</span>
                </button>
              `
                )
                .join('')}
            </div>
          `;
        }
        if (ct.dilemmaResultMsg && isMyTurn) {
          return `
            <div class="game-stage-card p-6 space-y-4 text-center">
              <div class="text-sm font-bold text-yellow-300">${this.escapeHtml(ct.dilemmaResultMsg)}</div>
              <button id="btn-client-proceed-q" class="tactile-gold-btn w-full py-4 text-sm font-title">К вопросу →</button>
            </div>
          `;
        }
        const canActDilemma =
          (!ct.dilemmaFirstChoiceDone && isMyTurn) ||
          (ct.dilemmaFirstChoiceDone && me && me.id === ct.dilemmaPartnerId);
        if (canActDilemma) {
          return `
            <div class="game-stage-card p-6 space-y-4 text-center stage-enter">
              <div class="text-xs font-bold text-purple-400 uppercase">Ваше тайное решение в сделке:</div>
              <div class="grid grid-cols-2 gap-3">
                <button data-client-dilemma-act="coop" class="tactile-option p-5 font-bold text-emerald-400">Поделить (+200)</button>
                <button data-client-dilemma-act="betray" class="tactile-option p-5 font-bold text-red-400">Украсть (+350)</button>
              </div>
            </div>
          `;
        }
      }

      return `
        <div class="game-stage-card p-6 text-center space-y-2">
          <div class="text-xs font-bold text-yellow-400">${this.escapeHtml(ct.eventObj?.title || 'Событие')}</div>
          <p class="text-sm text-gray-300">Решение принимает <strong>${this.escapeHtml(rs.activePlayerName)}</strong></p>
        </div>
      `;
    }

    // 3. Если это социальный вопрос на шаге подтверждения ('social_verify') и он про МЕНЯ!
    const q = ct.question;
    if (ct.step === 'social_verify') {
      if (me && q.socialTargetId === me.id) {
        return `
          <div class="game-stage-card p-5 space-y-4 stage-enter">
            <div class="px-3 py-1 rounded-full bg-pink-500/20 text-pink-300 text-xs font-bold inline-block">
              Вопрос про тебя! Выбери правду:
            </div>
            <div class="text-sm font-bold text-white">${this.escapeHtml(q.question)}</div>
            <div class="grid grid-cols-1 gap-2.5">
              ${(q.options || [])
                .map(
                  (opt, idx) => `
                <button data-client-ans="${idx}" class="tactile-option p-3.5 text-left text-xs font-semibold text-white">
                  <strong class="text-pink-400 mr-1.5">${['A', 'B', 'C', 'D'][idx]}.</strong> ${this.escapeHtml(opt)}
                </button>
              `
                )
                .join('')}
            </div>
          </div>
        `;
      }
      return `
        <div class="game-stage-card p-6 text-center space-y-2">
          <div class="text-xs font-bold text-pink-400">Чтение мыслей</div>
          <p class="text-sm text-gray-300">Ждём, какой вариант выберет <strong>${this.escapeHtml(q.socialTargetName)}</strong> на своём пульте!</p>
        </div>
      `;
    }

    // 4. Шаг ответа на вопрос (для активного игрока или второго участника дуэли)
    const isDuelMyTurn =
      ct.eventObj?.id === 'duel' &&
      ct.duelOpponentId &&
      ((!ct.duelFirstAnswerDone && isMyTurn) || (ct.duelFirstAnswerDone && me && me.id === ct.duelOpponentId));

    if (ct.step === 'question' && (isMyTurn || isDuelMyTurn)) {
      const others = (rs.players || []).filter((p) => p.id !== me.id);
      return `
        <div class="game-stage-card p-5 space-y-4 stage-enter">
          <div class="flex items-center justify-between">
            <span class="px-2.5 py-0.5 rounded bg-yellow-400 text-black font-bold text-xs uppercase">Ваш выход!</span>
            <span class="font-num text-xs font-bold text-yellow-400">+${Math.round(q.points * ct.multiplier)} очк.</span>
          </div>

          <div class="text-sm font-bold text-white leading-snug">${this.escapeHtml(q.question)}</div>

          ${
            ct.hintText
              ? `<div class="p-3 rounded-xl bg-[#0b0d13] border border-yellow-400/40 text-xs text-yellow-200">${this.escapeHtml(ct.hintText)}</div>`
              : ''
          }

          ${
            q.type === 'slider'
              ? `<div class="p-4 rounded-xl bg-[#0b0d13] border border-[#2a3246] space-y-4">
                  <div class="text-center font-num text-2xl font-extrabold text-yellow-400">
                    <span id="client-slider-lbl">${ct.sliderValue}</span>${q.unit}
                  </div>
                  <input id="client-slider-inp" type="range" min="${q.min}" max="${q.max}" step="${q.step}" value="${ct.sliderValue}" class="intuition-slider" />
                  <button id="btn-client-slider-send" class="tactile-gold-btn w-full py-3.5 text-xs font-title">Отправить ответ</button>
                </div>`
              : `<div class="grid grid-cols-1 gap-2.5">
                  ${(q.options || [])
                    .map((opt, idx) => {
                      const hidden = (ct.hiddenOptions || []).includes(idx);
                      if (hidden) return '';
                      return `
                        <button data-client-ans="${idx}" class="tactile-option p-3.5 text-left flex items-center gap-3 text-white">
                          <span class="w-7 h-7 rounded-lg bg-[#0b0d13] border border-[#2a3246] font-num font-bold text-xs text-yellow-400 flex items-center justify-center shrink-0">
                            ${q.type === 'truth' ? (idx === 0 ? '✓' : '✕') : ['A', 'B', 'C', 'D'][idx]}
                          </span>
                          <span class="text-xs sm:text-sm font-semibold leading-snug">${this.escapeHtml(opt)}</span>
                        </button>
                      `;
                    })
                    .join('')}
                </div>`
          }

          ${
            ct.selectingTargetFor
              ? `<div class="p-3 rounded-xl bg-[#0b0d13] border border-yellow-400 space-y-2">
                  <div class="text-xs font-bold text-yellow-400">Выберите игрока:</div>
                  <div class="flex flex-wrap gap-1.5">
                    ${others
                      .map(
                        (op) => `
                      <button data-client-joker-target="${op.id}" class="px-3 py-1.5 rounded-lg bg-[#151923] border border-[#2a3246] text-xs font-bold text-white">
                        ${this.escapeHtml(op.name)}
                      </button>
                    `
                      )
                      .join('')}
                  </div>
                </div>`
              : ''
          }

          ${
            !isDuelMyTurn || !ct.eventObj
              ? `<div class="pt-3 border-t border-[#2a3246] flex flex-wrap gap-1.5">
                  ${[
                    ...(q.type === 'choice' ? [{ id: 'fifty', label: '50/50', ok: me.jokers?.fifty }] : []),
                    { id: 'double', label: '×2', ok: me.jokers?.double && !ct.usedHintOrFifty },
                    { id: 'ally', label: 'Друг', ok: me.jokers?.ally },
                    { id: 'pass', label: 'Передать', ok: me.jokers?.pass },
                    { id: 'hint', label: 'Подсказка', ok: me.jokers?.hint }
                  ]
                    .map(
                      (jk) => `
                    <button
                      data-client-joker="${jk.id}"
                      ${!jk.ok ? 'disabled' : ''}
                      class="px-2.5 py-1.5 rounded-lg text-[11px] font-bold border ${
                        jk.ok
                          ? 'bg-[#0b0d13] border-[#2a3246] text-yellow-400'
                          : 'opacity-30 line-through border-transparent text-gray-500'
                      }"
                    >${jk.label}</button>
                  `
                    )
                    .join('')}
                </div>`
              : ''
          }
        </div>
      `;
    }

    // 5. Если сейчас отвечает ДРУГОЙ игрок — пульт зрителя со ставками!
    if (ct.step === 'question' && !isMyTurn) {
      const myBet = me ? ct.sideBets?.[me.id] : null;
      return `
        <div class="game-stage-card p-6 space-y-5 text-center stage-enter">
          <div class="space-y-1">
            <div class="text-xs font-bold uppercase text-gray-400">Сейчас отвечает</div>
            <div class="font-title text-xl font-bold text-yellow-400">${this.escapeHtml(rs.activePlayerName)}</div>
          </div>

          <div class="p-4 rounded-2xl bg-[#0b0d13] border border-[#2a3246] space-y-3">
            <div class="text-xs font-semibold text-gray-300">
              Ставка зрителя на этот ход (+100 за угаданный исход, -50 за промах):
            </div>
            <div class="grid grid-cols-2 gap-2.5">
              <button
                data-client-bet="pass"
                ${ct.betsLocked ? 'disabled' : ''}
                class="p-3.5 rounded-xl font-bold text-xs border transition ${
                  myBet === 'pass'
                    ? 'bg-emerald-500 text-black border-emerald-300'
                    : 'bg-[#151923] text-emerald-400 border-[#2a3246]'
                }"
              >👍 Справится</button>
              <button
                data-client-bet="fail"
                ${ct.betsLocked ? 'disabled' : ''}
                class="p-3.5 rounded-xl font-bold text-xs border transition ${
                  myBet === 'fail'
                    ? 'bg-red-500 text-white border-red-300'
                    : 'bg-[#151923] text-red-400 border-[#2a3246]'
                }"
              >💀 Ошибётся</button>
            </div>
          </div>
        </div>
      `;
    }

    // 6. Когда ответ уже открыт ('answered')
    if (ct.step === 'answered') {
      return `
        <div class="game-stage-card p-6 space-y-4 text-center stage-enter">
          <div class="font-title text-lg font-bold ${ct.isWin ? 'text-emerald-400' : 'text-red-400'}">
            ${this.escapeHtml(ct.outcomeTitle)}
          </div>
          <div class="text-xs font-bold text-yellow-400">${this.escapeHtml(ct.outcomeDeltaText)}</div>
          <p class="text-xs text-gray-300 leading-relaxed">${this.escapeHtml(q.explanation || '')}</p>
          ${
            isMyTurn
              ? `<button id="btn-client-next" class="tactile-gold-btn w-full py-4 text-sm font-title">
                  Следующий ход →
                </button>`
              : ''
          }
        </div>
      `;
    }

    return '';
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
            Ключ хранится только в вашем браузере. Для обхода CORS с GitHub Pages запустите локально <code>node yandex-bridge.mjs</code>.
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

  // --- ПРИВЯЗКА СОБЫТИЙ ---
  bindLandingEvents() {
    document.getElementById('btn-choose-host')?.addEventListener('click', () => this.becomeHost());
    document.getElementById('btn-choose-player')?.addEventListener('click', () => this.becomePlayer());
  }

  bindHostEvents() {
    document.getElementById('btn-sound')?.addEventListener('click', () => {
      sfx.toggleMute();
      this.render();
    });

    document.getElementById('btn-host-to-lobby')?.addEventListener('click', () => {
      this.state.screen = 'lobby';
      this.saveHostState();
      this.render();
    });

    const copyHandler = (e) => {
      const url = e.currentTarget.getAttribute('data-url');
      if (url && navigator.clipboard) {
        navigator.clipboard.writeText(url);
        sfx.play('joker');
        e.currentTarget.innerHTML = '✓ Ссылка скопирована!';
      }
    };
    document.getElementById('btn-copy-join-link')?.addEventListener('click', copyHandler);
    document.getElementById('btn-copy-join-link-big')?.addEventListener('click', copyHandler);

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
        this.saveHostState();
        sfx.play('correct');
        if (statusEl) statusEl.textContent = `Готово! Добавлено ${qs.length} вопросов в колоду.`;
      } catch (err) {
        if (statusEl) statusEl.textContent = `Ошибка: ${err.message}`;
      }
    });

    // Лобби Хоста
    document.getElementById('btn-add-local-player')?.addEventListener('click', () => this.addLocalPlayerOnHost());

    document.querySelectorAll('[data-host-edit-name]').forEach((inp) => {
      inp.addEventListener('input', (e) => {
        const pid = e.target.getAttribute('data-host-edit-name');
        const pl = this.state.players.find((p) => p.id === pid);
        if (pl) {
          pl.name = e.target.value;
          this.saveHostState();
        }
      });
    });

    document.querySelectorAll('[data-host-kick]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const pid = e.currentTarget.getAttribute('data-host-kick');
        this.state.players = this.state.players.filter((p) => p.id !== pid);
        this.saveHostState();
        this.render();
      });
    });

    document.querySelectorAll('[data-set-total]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        this.state.totalQuestions = Number(e.currentTarget.getAttribute('data-set-total'));
        this.saveHostState();
        this.render();
      });
    });

    document.getElementById('btn-host-start')?.addEventListener('click', () => this.startGame());
    document.getElementById('btn-host-resume')?.addEventListener('click', () => {
      this.state.screen = 'play';
      this.saveHostState();
      this.render();
    });

    // Игровая сцена Хоста
    document.getElementById('btn-spin-wheel')?.addEventListener('click', () => this.spinEventWheel());
    document.getElementById('btn-wheel-proceed')?.addEventListener('click', () => this.proceedFromWheel());

    document.querySelectorAll('[data-pick-box]').forEach((btn) => {
      btn.addEventListener('click', (e) => this.pickBox(Number(e.currentTarget.getAttribute('data-pick-box'))));
    });

    document.getElementById('btn-proceed-question')?.addEventListener('click', () => {
      sfx.play('click');
      this.state.currentTurn.step = 'question';
      this.saveHostState();
      this.render();
    });

    document.querySelectorAll('[data-auction-take]').forEach((btn) => {
      btn.addEventListener('click', (e) => this.pickAuctionBuyer(e.currentTarget.getAttribute('data-auction-take')));
    });

    document.querySelectorAll('[data-duel-target]').forEach((btn) => {
      btn.addEventListener('click', (e) => this.pickDuelOpponent(e.currentTarget.getAttribute('data-duel-target')));
    });

    document.querySelectorAll('[data-dilemma-target]').forEach((btn) => {
      btn.addEventListener('click', (e) => this.pickDilemmaPartner(e.currentTarget.getAttribute('data-dilemma-target')));
    });

    document.querySelectorAll('[data-dilemma-act]').forEach((btn) => {
      btn.addEventListener('click', (e) => this.submitDilemmaChoice(e.currentTarget.getAttribute('data-dilemma-act')));
    });

    const sliderEl = document.getElementById('intuition-slider-input');
    sliderEl?.addEventListener('input', (e) => {
      this.state.currentTurn.sliderValue = Number(e.target.value);
      const valEl = document.getElementById('slider-live-val');
      if (valEl) valEl.textContent = String(this.state.currentTurn.sliderValue);
    });
    document.getElementById('btn-submit-slider')?.addEventListener('click', () => this.submitSliderGuess());

    document.querySelectorAll('[data-answer-idx]').forEach((btn) => {
      btn.addEventListener('click', (e) => this.answerQuestion(Number(e.currentTarget.getAttribute('data-answer-idx'))));
    });

    document.querySelectorAll('[data-joker]').forEach((btn) => {
      btn.addEventListener('click', (e) => this.useJoker(e.currentTarget.getAttribute('data-joker')));
    });

    document.querySelectorAll('[data-joker-target]').forEach((btn) => {
      btn.addEventListener('click', (e) => this.confirmJokerTarget(e.currentTarget.getAttribute('data-joker-target')));
    });

    document.getElementById('btn-next-turn')?.addEventListener('click', () => this.nextTurn());
    document.getElementById('btn-restart')?.addEventListener('click', () => {
      this.state.screen = 'lobby';
      this.saveHostState();
      this.render();
    });
  }

  bindPlayerEvents() {
    document.getElementById('btn-player-back-landing')?.addEventListener('click', () => {
      this.p2p.cleanupConnections();
      this.role = 'landing';
      this.render();
    });

    document.getElementById('btn-client-change-room')?.addEventListener('click', () => {
      this.p2p.cleanupConnections();
      this.clientConnected = false;
      this.remoteState = null;
      this.render();
    });

    document.querySelectorAll('[data-pick-color]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        this.clientColorInput = e.currentTarget.getAttribute('data-pick-color');
        localStorage.setItem('ps_last_color', this.clientColorInput);
        this.render();
      });
    });

    document.getElementById('player-room-code')?.addEventListener('input', (e) => {
      this.clientRoomInput = e.target.value.toUpperCase();
    });

    document.getElementById('player-nickname')?.addEventListener('input', (e) => {
      this.clientNameInput = e.target.value;
    });

    document.getElementById('btn-player-connect')?.addEventListener('click', async () => {
      const code = (document.getElementById('player-room-code')?.value || this.clientRoomInput).trim().toUpperCase();
      const name = (document.getElementById('player-nickname')?.value || this.clientNameInput).trim();
      if (code.length < 3) {
        this.clientError = 'Введите 4-значный код комнаты с экрана ведущего';
        this.render();
        return;
      }
      if (!name) {
        this.clientError = 'Введите ваше имя';
        this.render();
        return;
      }

      this.clientRoomInput = code;
      this.clientNameInput = name;
      localStorage.setItem('ps_last_name', name);
      this.clientError = null;
      this.clientConnecting = true;
      this.render();

      const ok = await this.p2p.joinRoom(code, {
        token: this.clientToken,
        name,
        color: this.clientColorInput
      });
      this.clientConnecting = false;
      this.clientConnected = ok;
      this.render();
    });

    // Кнопки управления на пульте игрока
    const send = (payload) => this.p2p.sendActionToHost({ ...payload, token: this.clientToken });

    document.querySelectorAll('[data-send-reaction]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        sfx.play('click');
        send({ kind: 'REACTION', emoji: e.currentTarget.getAttribute('data-send-reaction') });
      });
    });

    document.getElementById('btn-client-wheel')?.addEventListener('click', () => {
      sfx.play('click');
      send({ kind: 'SPIN_WHEEL' });
    });

    document.querySelectorAll('[data-client-box]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        sfx.play('click');
        send({ kind: 'PICK_BOX', boxIdx: Number(e.currentTarget.getAttribute('data-client-box')) });
      });
    });

    document.getElementById('btn-client-proceed-q')?.addEventListener('click', () => {
      sfx.play('click');
      send({ kind: 'PROCEED_QUESTION' });
    });

    document.getElementById('btn-client-auction-take')?.addEventListener('click', () => {
      sfx.play('joker');
      send({ kind: 'AUCTION_TAKE' });
    });

    document.querySelectorAll('[data-client-duel-target]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        send({ kind: 'DUEL_TARGET', targetId: e.currentTarget.getAttribute('data-client-duel-target') });
      });
    });

    document.querySelectorAll('[data-client-dilemma-target]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        send({ kind: 'DILEMMA_TARGET', targetId: e.currentTarget.getAttribute('data-client-dilemma-target') });
      });
    });

    document.querySelectorAll('[data-client-dilemma-act]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        send({ kind: 'DILEMMA_ACT', choice: e.currentTarget.getAttribute('data-client-dilemma-act') });
      });
    });

    document.querySelectorAll('[data-client-ans]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        sfx.play('click');
        send({ kind: 'ANSWER_OPTION', optionIdx: Number(e.currentTarget.getAttribute('data-client-ans')) });
      });
    });

    const cSlider = document.getElementById('client-slider-inp');
    cSlider?.addEventListener('input', (e) => {
      const lbl = document.getElementById('client-slider-lbl');
      if (lbl) lbl.textContent = e.target.value;
    });
    document.getElementById('btn-client-slider-send')?.addEventListener('click', () => {
      const val = Number(document.getElementById('client-slider-inp')?.value || 50);
      sfx.play('click');
      send({ kind: 'SLIDER_SUBMIT', value: val });
    });

    document.querySelectorAll('[data-client-joker]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        sfx.play('joker');
        send({ kind: 'USE_JOKER', jokerType: e.currentTarget.getAttribute('data-client-joker') });
      });
    });

    document.querySelectorAll('[data-client-joker-target]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        send({ kind: 'JOKER_TARGET', targetId: e.currentTarget.getAttribute('data-client-joker-target') });
      });
    });

    document.querySelectorAll('[data-client-bet]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        sfx.play('click');
        send({ kind: 'SIDE_BET', bet: e.currentTarget.getAttribute('data-client-bet') });
      });
    });

    document.getElementById('btn-client-next')?.addEventListener('click', () => {
      sfx.play('click');
      send({ kind: 'NEXT_TURN' });
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
  window.partySyncPlatform = new PartySyncPlatform();
});
