// Стабильный Multi-Broker Realtime Engine (QoS 1 + Fast Retry + Versioned State + Keepalive)
const BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt'
];

const TOPIC_PREFIX = 'psync_sup3dev_v8';

export class P2PRoomManager {
  constructor({ onPlayerJoin, onPlayerLeave, onPlayerAction, onHostStateUpdate, onStatusChange }) {
    this.clients = [];
    this.bc = null;
    this.roomCode = null;
    this.isHost = false;
    this.lastStatePacket = null;
    this.stateVersion = 1;
    this.seenPacketIds = new Set();
    this.joinRetryTimer = null;
    this.hostSyncTimer = null;

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
    if (this.hostSyncTimer) {
      clearInterval(this.hostSyncTimer);
      this.hostSyncTimer = null;
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

    if (data.pktId && data.type !== 'STATE') {
      if (this.seenPacketIds.has(data.pktId)) return;
      this.seenPacketIds.add(data.pktId);
      if (this.seenPacketIds.size > 500) {
        const first = this.seenPacketIds.values().next().value;
        this.seenPacketIds.delete(first);
      }
    }

    if (this.isHost) {
      if (data.type === 'JOIN') {
        this.onPlayerJoin?.(data.senderId, data.payload);
      } else if (data.type === 'ACTION') {
        this.onPlayerAction?.(data.senderId, data.payload);
      } else if (data.type === 'PING_STATE' && this.lastStatePacket) {
        this.publishAll(`${TOPIC_PREFIX}/${this.roomCode}/state`, this.lastStatePacket, true);
      }
    } else {
      if (data.type === 'STATE' && data.payload) {
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
          c.publish(topic, jsonStr, { qos: 1, retain });
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

    BROKERS.forEach((url, idx) => {
      try {
        const clientId = `ps8_h_${this.roomCode}_${idx}_${Math.random().toString(36).slice(2, 6)}`;
        const client = window.mqtt.connect(url, {
          clientId,
          clean: true,
          keepalive: 25,
          connectTimeout: 5000,
          reconnectPeriod: 2000
        });

        client.on('connect', () => {
          if (!anyConnected) {
            anyConnected = true;
            this.onStatusChange?.('ready', this.roomCode);
          }
          client.subscribe(eventsTopic, { qos: 1 }, () => {
            if (this.lastStatePacket) {
              client.publish(stateTopic, JSON.stringify(this.lastStatePacket), { qos: 1, retain: true });
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

    // Фоновая синхронизация каждые 3 секунды (если у кого-то на телефоне мигнула мобильная сеть, он догонит стейт без перезагрузки!)
    this.hostSyncTimer = setInterval(() => {
      if (this.lastStatePacket) {
        this.publishAll(stateTopic, this.lastStatePacket, true);
      }
    }, 3000);

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
          pktId: this.makePacketId(),
          senderId: this.senderId,
          payload: this.playerProfile
        },
        false
      );
    };

    sendJoinSignal();
    this.joinRetryTimer = setInterval(sendJoinSignal, 1200);

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
        finish(false, 'Не удалось подключиться к сети. Проверьте интернет.');
      }, 6500);

      BROKERS.forEach((url, idx) => {
        try {
          const clientId = `ps8_p_${this.roomCode}_${idx}_${Math.random().toString(36).slice(2, 6)}`;
          const client = window.mqtt.connect(url, {
            clientId,
            clean: true,
            keepalive: 25,
            connectTimeout: 5000,
            reconnectPeriod: 2000
          });

          client.on('connect', () => {
            clearTimeout(timeout);
            this.onStatusChange?.('connected', this.roomCode);
            client.subscribe(stateTopic, { qos: 1 }, () => {
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
    this.stateVersion += 1;
    const packet = {
      type: 'STATE',
      pktId: `st_${this.roomCode}_${this.stateVersion}`,
      payload: statePayload
    };
    this.lastStatePacket = packet;
    this.publishAll(`${TOPIC_PREFIX}/${this.roomCode}/state`, packet, true);
  }

  sendActionToHost(actionPayload) {
    if (this.isHost || !this.roomCode) return;
    // Генерируем один и тот же pktId для основного пакета и его быстрого повтора через 220 мс (для 100% доставки на мобильной сети без дублей!)
    const pktId = this.makePacketId();
    const packet = {
      type: 'ACTION',
      pktId,
      senderId: this.senderId,
      payload: actionPayload
    };
    const topic = `${TOPIC_PREFIX}/${this.roomCode}/events`;
    this.publishAll(topic, packet, false);
    setTimeout(() => {
      this.publishAll(topic, packet, false);
    }, 220);
  }
}
