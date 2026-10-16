// WebRTC P2P Room Engine (PeerJS) для архитектуры Stage (Экран Хоста) + Controller (Телефоны игроков)
// Поддерживает QR-вход, 4-символьные коды комнат и автоматический реконнект по имени/токену игрока.

const PEER_PREFIX = 'psync-room-';

export class P2PRoomManager {
  constructor({ onPlayerJoin, onPlayerLeave, onPlayerAction, onHostStateUpdate, onStatusChange }) {
    this.peer = null;
    this.roomCode = null;
    this.isHost = false;
    this.connections = new Map(); // peerId -> DataConnection (у Хоста)
    this.hostConn = null;         // DataConnection (у Игрока)

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

  async initHost(existingCode = null) {
    if (!window.Peer) {
      this.onStatusChange?.('error', 'PeerJS не загружен');
      return null;
    }

    this.isHost = true;
    this.roomCode = (existingCode || this.generateRoomCode()).toUpperCase();
    const fullPeerId = `${PEER_PREFIX}${this.roomCode}`;

    return new Promise((resolve) => {
      try {
        if (this.peer) this.peer.destroy();
        this.peer = new window.Peer(fullPeerId, { debug: 1 });

        this.peer.on('open', () => {
          this.onStatusChange?.('ready', this.roomCode);
          resolve(this.roomCode);
        });

        this.peer.on('connection', (conn) => {
          conn.on('open', () => {
            this.connections.set(conn.peer, conn);
          });

          conn.on('data', (data) => {
            if (!data || typeof data !== 'object') return;
            if (data.type === 'JOIN') {
              this.onPlayerJoin?.(conn.peer, data.payload, conn);
            } else if (data.type === 'ACTION') {
              this.onPlayerAction?.(conn.peer, data.payload);
            }
          });

          conn.on('close', () => {
            this.connections.delete(conn.peer);
            this.onPlayerLeave?.(conn.peer);
          });

          conn.on('error', () => {
            this.connections.delete(conn.peer);
            this.onPlayerLeave?.(conn.peer);
          });
        });

        this.peer.on('error', (err) => {
          if (err.type === 'unavailable-id') {
            this.roomCode = this.generateRoomCode();
            this.initHost(this.roomCode).then(resolve);
          } else {
            this.onStatusChange?.('error', err.message || 'Ошибка сети');
            resolve(null);
          }
        });
      } catch (e) {
        this.onStatusChange?.('error', e.message);
        resolve(null);
      }
    });
  }

  async joinRoom(roomCode, playerProfile) {
    if (!window.Peer) {
      this.onStatusChange?.('error', 'PeerJS не загружен');
      return false;
    }

    this.isHost = false;
    this.roomCode = roomCode.toUpperCase().trim();
    const targetPeerId = `${PEER_PREFIX}${this.roomCode}`;

    return new Promise((resolve) => {
      try {
        if (this.peer) this.peer.destroy();
        this.peer = new window.Peer(undefined, { debug: 1 });

        const timeout = setTimeout(() => {
          this.onStatusChange?.('error', 'Превышено время ожидания ответа от комнаты');
          resolve(false);
        }, 9000);

        this.peer.on('open', () => {
          const conn = this.peer.connect(targetPeerId, { reliable: true });
          this.hostConn = conn;

          conn.on('open', () => {
            clearTimeout(timeout);
            this.onStatusChange?.('connected', this.roomCode);
            conn.send({
              type: 'JOIN',
              payload: playerProfile
            });
            resolve(true);
          });

          conn.on('data', (data) => {
            if (data && data.type === 'STATE') {
              this.onHostStateUpdate?.(data.payload);
            }
          });

          conn.on('close', () => {
            this.onStatusChange?.('disconnected', 'Связь с экраном ведущего прервана');
          });

          conn.on('error', () => {
            clearTimeout(timeout);
            this.onStatusChange?.('error', 'Не удалось подключиться к комнате');
            resolve(false);
          });
        });

        this.peer.on('error', () => {
          clearTimeout(timeout);
          this.onStatusChange?.('error', 'Комната с таким кодом не найдена');
          resolve(false);
        });
      } catch (e) {
        this.onStatusChange?.('error', e.message);
        resolve(false);
      }
    });
  }

  broadcastState(statePayload) {
    if (!this.isHost) return;
    for (const [, conn] of this.connections.entries()) {
      if (conn.open) {
        try {
          conn.send({ type: 'STATE', payload: statePayload });
        } catch (e) {}
      }
    }
  }

  sendActionToHost(actionPayload) {
    if (this.isHost || !this.hostConn || !this.hostConn.open) return;
    try {
      this.hostConn.send({
        type: 'ACTION',
        payload: actionPayload
      });
    } catch (e) {}
  }
}
