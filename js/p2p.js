// WebRTC P2P мультиплеер без бэкенда (работает прямо на GitHub Pages через PeerJS)
// Позволяет играть как на одном экране в Discord, так и подключаться с телефонов/вкладок как в Jackbox!

export class P2PRoomManager {
  constructor({ onPlayerJoin, onPlayerAction, onHostStateUpdate, onStatusChange }) {
    this.peer = null;
    this.roomCode = null;
    this.isHost = true;
    this.connections = new Map(); // peerId -> DataConnection (у хоста)
    this.hostConn = null;         // DataConnection к хосту (у клиента)
    this.onPlayerJoin = onPlayerJoin;
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
      this.onStatusChange?.('error', 'Библиотека PeerJS не загружена');
      return null;
    }

    this.isHost = true;
    this.roomCode = existingCode || this.generateRoomCode();
    const fullPeerId = `partysync-sup3dev-${this.roomCode}`;

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
              this.onPlayerJoin?.(conn.peer, data.payload);
            } else if (data.type === 'ACTION') {
              this.onPlayerAction?.(conn.peer, data.payload);
            }
          });

          conn.on('close', () => {
            this.connections.delete(conn.peer);
          });
        });

        this.peer.on('error', (err) => {
          if (err.type === 'unavailable-id') {
            this.roomCode = this.generateRoomCode();
            this.initHost(this.roomCode).then(resolve);
          } else {
            this.onStatusChange?.('error', err.message || 'Ошибка P2P');
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
      this.onStatusChange?.('error', 'PeerJS недоступен');
      return false;
    }

    this.isHost = false;
    this.roomCode = roomCode.toUpperCase().trim();
    const targetPeerId = `partysync-sup3dev-${this.roomCode}`;

    return new Promise((resolve) => {
      if (this.peer) this.peer.destroy();
      this.peer = new window.Peer(undefined, { debug: 1 });

      this.peer.on('open', () => {
        const conn = this.peer.connect(targetPeerId, { reliable: true });
        this.hostConn = conn;

        conn.on('open', () => {
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
          this.onStatusChange?.('disconnected', 'Связь с ведущим потеряна');
        });

        conn.on('error', (err) => {
          this.onStatusChange?.('error', err.message || 'Ошибка подключения');
          resolve(false);
        });
      });

      this.peer.on('error', (err) => {
        this.onStatusChange?.('error', 'Комната не найдена или закрыта');
        resolve(false);
      });
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
    this.hostConn.send({
      type: 'ACTION',
      payload: actionPayload
    });
  }
}
