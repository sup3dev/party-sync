// Надёжный Realtime Room Engine поверх MQTT over WebSockets (EMQX + HiveMQ fallback) + BroadcastChannel
// Работает в РФ без блокировок (в отличие от 0.peerjs.com, отдающего 403) и не страдает от мобильного NAT!

const BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt'
];

const TOPIC_PREFIX = 'psync_sup3dev_v6';

export class P2PRoomManager {
  constructor({ onPlayerJoin, onPlayerLeave, onPlayerAction, onHostStateUpdate, onStatusChange }) {
    this.client = null;
    this.bc = null; // BroadcastChannel для мгновенной работы между вкладками одного браузера
    this.roomCode = null;
    this.isHost = false;
    this.brokerIdx = 0;
    this.lastStateJson = null;

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

  setupBroadcastChannel(roomCode) {
    try {
      if (this.bc) this.bc.close();
      if (typeof BroadcastChannel !== 'undefined') {
        this.bc = new BroadcastChannel(`${TOPIC_PREFIX}_${roomCode}`);
        this.bc.onmessage = (ev) => {
          const data = ev.data;
          if (!data || typeof data !== 'object') return;
          this.handleIncomingPacket(data);
        };
      }
    } catch (e) {}
  }

  handleIncomingPacket(data) {
    if (this.isHost) {
      if (data.type === 'JOIN') {
        this.onPlayerJoin?.(data.senderId, data.payload);
      } else if (data.type === 'ACTION') {
        this.onPlayerAction?.(data.senderId, data.payload);
      } else if (data.type === 'PING_STATE' && this.lastStateJson) {
        this.publishRaw(`${TOPIC_PREFIX}/${this.roomCode}/state`, this.lastStateJson, true);
      }
    } else {
      if (data.type === 'STATE') {
        this.onHostStateUpdate?.(data.payload);
      }
    }
  }

  publishRaw(topic, messageObj, retain = false) {
    const jsonStr = typeof messageObj === 'string' ? messageObj : JSON.stringify(messageObj);
    try {
      if (this.bc) {
        this.bc.postMessage(typeof messageObj === 'string' ? JSON.parse(messageObj) : messageObj);
      }
    } catch (e) {}

    if (this.client && this.client.connected) {
      try {
        this.client.publish(topic, jsonStr, { qos: 0, retain });
      } catch (e) {}
    }
  }

  async initHost(existingCode = null) {
    this.isHost = true;
    this.roomCode = (existingCode || this.generateRoomCode()).toUpperCase();
    this.setupBroadcastChannel(this.roomCode);

    // Код комнаты готов МГНОВЕННО — сразу уведомляем UI, не заставляя ждать!
    this.onStatusChange?.('connecting', this.roomCode);
    this.connectMqttHost(0);
    return this.roomCode;
  }

  connectMqttHost(brokerIndex = 0) {
    if (!window.mqtt) {
      this.onStatusChange?.('local_only', this.roomCode);
      return;
    }

    const url = BROKERS[brokerIndex % BROKERS.length];
    try {
      if (this.client) {
        try {
          this.client.end(true);
        } catch (e) {}
      }

      const clientId = `ps_host_${this.roomCode}_${Math.random().toString(36).slice(2, 7)}`;
      this.client = window.mqtt.connect(url, {
        clientId,
        clean: true,
        connectTimeout: 5000,
        reconnectPeriod: 3000
      });

      const eventsTopic = `${TOPIC_PREFIX}/${this.roomCode}/events`;
      const stateTopic = `${TOPIC_PREFIX}/${this.roomCode}/state`;

      this.client.on('connect', () => {
        this.onStatusChange?.('ready', this.roomCode);
        this.client.subscribe(eventsTopic, { qos: 0 });
        if (this.lastStateJson) {
          this.client.publish(stateTopic, this.lastStateJson, { qos: 0, retain: true });
        }
      });

      this.client.on('message', (topic, payloadBuf) => {
        try {
          const data = JSON.parse(payloadBuf.toString());
          this.handleIncomingPacket(data);
        } catch (e) {}
      });

      this.client.on('error', () => {
        if (brokerIndex + 1 < BROKERS.length) {
          this.connectMqttHost(brokerIndex + 1);
        }
      });
    } catch (e) {
      if (brokerIndex + 1 < BROKERS.length) {
        this.connectMqttHost(brokerIndex + 1);
      }
    }
  }

  async joinRoom(roomCode, playerProfile) {
    this.isHost = false;
    this.roomCode = roomCode.toUpperCase().trim();
    this.senderId = playerProfile.token || `plr_${Math.random().toString(36).slice(2, 8)}`;
    this.setupBroadcastChannel(this.roomCode);

    const joinPacket = {
      type: 'JOIN',
      senderId: this.senderId,
      payload: playerProfile
    };

    // Сразу отправляем через BroadcastChannel (если открыто в соседней вкладке того же браузера — сработает за 1 мс!)
    try {
      if (this.bc) this.bc.postMessage(joinPacket);
    } catch (e) {}

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

      const tryBroker = (idx) => {
        const url = BROKERS[idx];
        const clientId = `ps_plr_${this.roomCode}_${Math.random().toString(36).slice(2, 7)}`;

        try {
          if (this.client) {
            try {
              this.client.end(true);
            } catch (e) {}
          }

          this.client = window.mqtt.connect(url, {
            clientId,
            clean: true,
            connectTimeout: 4500,
            reconnectPeriod: 2500
          });

          const eventsTopic = `${TOPIC_PREFIX}/${this.roomCode}/events`;
          const stateTopic = `${TOPIC_PREFIX}/${this.roomCode}/state`;

          const timer = setTimeout(() => {
            if (!resolved) {
              if (idx + 1 < BROKERS.length) {
                tryBroker(idx + 1);
              } else {
                finish(false, 'Не удалось связаться с сервером комнат. Попробуйте ещё раз.');
              }
            }
          }, 5000);

          this.client.on('connect', () => {
            clearTimeout(timer);
            this.onStatusChange?.('connected', this.roomCode);
            this.client.subscribe(stateTopic, { qos: 0 }, () => {
              this.client.publish(eventsTopic, JSON.stringify(joinPacket), { qos: 0 });
              this.client.publish(eventsTopic, JSON.stringify({ type: 'PING_STATE', senderId: this.senderId }), { qos: 0 });
            });
            finish(true);
          });

          this.client.on('message', (topic, payloadBuf) => {
            try {
              const data = JSON.parse(payloadBuf.toString());
              this.handleIncomingPacket(data);
            } catch (e) {}
          });

          this.client.on('error', () => {
            clearTimeout(timer);
            if (!resolved && idx + 1 < BROKERS.length) {
              tryBroker(idx + 1);
            }
          });
        } catch (err) {
          if (!resolved && idx + 1 < BROKERS.length) {
            tryBroker(idx + 1);
          } else {
            finish(false, err.message);
          }
        }
      };

      tryBroker(0);
    });
  }

  broadcastState(statePayload) {
    if (!this.isHost || !this.roomCode) return;
    const packet = {
      type: 'STATE',
      payload: statePayload
    };
    this.lastStateJson = JSON.stringify(packet);
    this.publishRaw(`${TOPIC_PREFIX}/${this.roomCode}/state`, packet, true);
  }

  sendActionToHost(actionPayload) {
    if (this.isHost || !this.roomCode) return;
    const packet = {
      type: 'ACTION',
      senderId: this.senderId,
      payload: actionPayload
    };
    this.publishRaw(`${TOPIC_PREFIX}/${this.roomCode}/events`, packet, false);
  }
}
