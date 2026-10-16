// Сверхнадёжный Multi-Broker Realtime Engine (одновременно держит связь через EMQX + HiveMQ + Mosquitto + BroadcastChannel)
// С гарантированным подтверждением входа (Handshake Retry Loop) и дедупликацией пакетов.

const BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt'
];

const TOPIC_PREFIX = 'psync_sup3dev_v7';

export class P2PRoomManager {
  constructor({ onPlayerJoin, onPlayerLeave, onPlayerAction, onHostStateUpdate, onStatusChange }) {
    this.clients = []; // Подключаемся ко всем доступным брокерам параллельно!
    this.bc = null;
    this.roomCode = null;
    this.isHost = false;
    this.lastStateJson = null;
    this.seenPacketIds = new Set();
    this.joinRetryTimer = null;

    this.onPlayerJoin = onPlayerJoin;
    this.onPlayerLeave = onPlayerLeave;
    this.onPlayerAction = onPlayerAction;
    this.onHostStateUpdate = onHostStateUpdate;
    this.onStatusChange = onStatusChange;
  }

  generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  makePacketId() {
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  cleanupConnections() {
    if (this.joinRetryTimer) {
      clearInterval(this.joinRetryTimer);
      this.joinRetryTimer = null;
    }
    if (this.bc) {
      try {
        this.bc.close();
      } catch (e) {}
      this.bc = null;
    }
    for (const c of this.clients) {
      try {
        c.end(true);
      } catch (e) {}
    }
    this.clients = [];
  }

  setupBroadcastChannel(roomCode) {
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        this.bc = new BroadcastChannel(`${TOPIC_PREFIX}_${roomCode}`);
        this.bc.onmessage = (ev) => {
          if (ev.data && typeof ev.data === 'object') {
            this.handleIncomingPacket(ev.data);
          }
        };
      }
    } catch (e) {}
  }

  handleIncomingPacket(data) {
    if (!data || typeof data !== 'object') return;

    // Дедупликация пакетов, пришедших одновременно через разные брокеры
    if (data.pktId) {
      if (this.seenPacketIds.has(data.pktId)) return;
      this.seenPacketIds.add(data.pktId);
      if (this.seenPacketIds.size > 400) {
        const first = this.seenPacketIds.values().next().value;
        this.seenPacketIds.delete(first);
      }
    }

    if (this.isHost) {
      if (data.type === 'JOIN') {
        this.onPlayerJoin?.(data.senderId, data.payload);
      } else if (data.type === 'ACTION') {
        this.onPlayerAction?.(data.senderId, data.payload);
      } else if (data.type === 'PING_STATE' && this.lastStateJson) {
        this.publishAll(`${TOPIC_PREFIX}/${this.roomCode}/state`, JSON.parse(this.lastStateJson), true);
      }
    } else {
      if (data.type === 'STATE') {
        this.onHostStateUpdate?.(data.payload);
      }
    }
  }

  publishAll(topic, packetObj, retain = false) {
    const withId = {
      ...packetObj,
      pktId: packetObj.pktId || this.makePacketId()
    };
    const jsonStr = JSON.stringify(withId);

    try {
      if (this.bc) this.bc.postMessage(withId);
    } catch (e) {}

    for (const c of this.clients) {
      if (c && c.connected) {
        try {
          c.publish(topic, jsonStr, { qos: 0, retain });
        } catch (e) {}
      }
    }
  }

  async initHost(existingCode = null) {
    this.cleanupConnections();
    this.isHost = true;
    this.roomCode = (existingCode || this.generateRoomCode()).toUpperCase();
    this.setupBroadcastChannel(this.roomCode);

    this.onStatusChange?.('connecting', this.roomCode);

    if (!window.mqtt) {
      this.onStatusChange?.('local_only', this.roomCode);
      return this.roomCode;
    }

    const eventsTopic = `${TOPIC_PREFIX}/${this.roomCode}/events`;
    const stateTopic = `${TOPIC_PREFIX}/${this.roomCode}/state`;
    let anyConnected = false;

    // Подключаем Хоста ко всем брокерам параллельно!
    BROKERS.forEach((url, idx) => {
      try {
        const clientId = `ps7_h_${this.roomCode}_${idx}_${Math.random().toString(36).slice(2, 6)}`;
        const client = window.mqtt.connect(url, {
          clientId,
          clean: true,
          connectTimeout: 5000,
          reconnectPeriod: 2500
        });

        client.on('connect', () => {
          if (!anyConnected) {
            anyConnected = true;
            this.onStatusChange?.('ready', this.roomCode);
          }
          client.subscribe(eventsTopic, { qos: 0 }, () => {
            if (this.lastStateJson) {
              client.publish(stateTopic, this.lastStateJson, { qos: 0, retain: true });
            }
          });
        });

        client.on('message', (_topic, payloadBuf) => {
          try {
            const data = JSON.parse(payloadBuf.toString());
            this.handleIncomingPacket(data);
          } catch (e) {}
        });

        this.clients.push(client);
      } catch (e) {}
    });

    return this.roomCode;
  }

  async joinRoom(roomCode, playerProfile) {
    this.cleanupConnections();
    this.isHost = false;
    this.roomCode = roomCode.toUpperCase().trim();
    this.senderId = playerProfile.token || `plr_${Math.random().toString(36).slice(2, 8)}`;
    this.playerProfile = playerProfile;
    this.setupBroadcastChannel(this.roomCode);

    const eventsTopic = `${TOPIC_PREFIX}/${this.roomCode}/events`;
    const stateTopic = `${TOPIC_PREFIX}/${this.roomCode}/state`;

    const sendJoinSignal = () => {
      this.publishAll(
        eventsTopic,
        {
          type: 'JOIN',
          senderId: this.senderId,
          payload: this.playerProfile
        },
        false
      );
    };

    // Отправляем сразу в BroadcastChannel
    sendJoinSignal();

    // И запускаем авто-повтор JOIN каждые 1.2 секунды, пока Хост не пришлёт STATE с нашим игроком!
    this.joinRetryTimer = setInterval(() => {
      sendJoinSignal();
    }, 1200);

    if (!window.mqtt) {
      this.onStatusChange?.('connected', this.roomCode);
      return true;
    }

    return new Promise((resolve) => {
      let resolved = false;
      const finish = (ok, errText = null) => {
        if (resolved) return;
        resolved = true;
        if (!ok && errText) this.onStatusChange?.('error', errText);
        resolve(ok);
      };

      const timeout = setTimeout(() => {
        finish(false, 'Не удалось подключиться к сети. Проверьте интернет на телефоне.');
      }, 6500);

      BROKERS.forEach((url, idx) => {
        try {
          const clientId = `ps7_p_${this.roomCode}_${idx}_${Math.random().toString(36).slice(2, 6)}`;
          const client = window.mqtt.connect(url, {
            clientId,
            clean: true,
            connectTimeout: 5000,
            reconnectPeriod: 2500
          });

          client.on('connect', () => {
            clearTimeout(timeout);
            this.onStatusChange?.('connected', this.roomCode);
            client.subscribe(stateTopic, { qos: 0 }, () => {
              sendJoinSignal();
            });
            finish(true);
          });

          client.on('message', (_topic, payloadBuf) => {
            try {
              const data = JSON.parse(payloadBuf.toString());
              this.handleIncomingPacket(data);
            } catch (e) {}
          });

          this.clients.push(client);
        } catch (e) {}
      });
    });
  }

  stopJoinRetry() {
    if (this.joinRetryTimer) {
      clearInterval(this.joinRetryTimer);
      this.joinRetryTimer = null;
    }
  }

  broadcastState(statePayload) {
    if (!this.isHost || !this.roomCode) return;
    const packet = {
      type: 'STATE',
      pktId: this.makePacketId(),
      payload: statePayload
    };
    this.lastStateJson = JSON.stringify(packet);
    this.publishAll(`${TOPIC_PREFIX}/${this.roomCode}/state`, packet, true);
  }

  sendActionToHost(actionPayload) {
    if (this.isHost || !this.roomCode) return;
    this.publishAll(
      `${TOPIC_PREFIX}/${this.roomCode}/events`,
      {
        type: 'ACTION',
        senderId: this.senderId,
        payload: actionPayload
      },
      false
    );
  }
}
