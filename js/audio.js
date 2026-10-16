// Web Audio API Sound Effects Synthesizer for Party Sync Show
class SoundEngine {
  constructor() {
    this.ctx = null;
    this.muted = localStorage.getItem('ps_muted') === 'true';
    this.volume = 0.35;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    localStorage.setItem('ps_muted', String(this.muted));
    if (!this.muted) this.play('click');
    return this.muted;
  }

  playTone(freq, type = 'sine', duration = 0.12, delay = 0, gainScale = 1, slideTo = null) {
    if (this.muted) return;
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (slideTo) {
      osc.frequency.exponentialRampToValueAtTime(slideTo, now + duration);
    }

    const maxGain = this.volume * gainScale;
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(maxGain, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  play(effect) {
    if (this.muted) return;
    switch (effect) {
      case 'click':
        this.playTone(520, 'triangle', 0.06, 0, 0.4, 680);
        break;
      case 'tick':
        this.playTone(880, 'sine', 0.04, 0, 0.25);
        break;
      case 'urgent_tick':
        this.playTone(1100, 'square', 0.06, 0, 0.3, 800);
        break;
      case 'correct':
        this.playTone(523.25, 'triangle', 0.14, 0, 0.7);     // C5
        this.playTone(659.25, 'triangle', 0.14, 0.09, 0.7);  // E5
        this.playTone(783.99, 'triangle', 0.16, 0.18, 0.8);  // G5
        this.playTone(1046.50, 'sine', 0.35, 0.27, 0.9);     // C6
        break;
      case 'wrong':
        this.playTone(300, 'sawtooth', 0.22, 0, 0.5, 220);
        this.playTone(210, 'sawtooth', 0.38, 0.18, 0.6, 130);
        break;
      case 'joker':
        this.playTone(440, 'sine', 0.1, 0, 0.6, 880);
        this.playTone(660, 'triangle', 0.12, 0.08, 0.7, 1320);
        this.playTone(1320, 'sine', 0.25, 0.16, 0.8);
        break;
      case 'event':
        [330, 440, 554, 659, 880].forEach((f, idx) => {
          this.playTone(f, 'triangle', 0.12, idx * 0.06, 0.65);
        });
        break;
      case 'reveal':
        this.playTone(261.6, 'sine', 0.15, 0, 0.5, 523.2);
        this.playTone(523.2, 'triangle', 0.35, 0.14, 0.8, 784);
        break;
      case 'fanfare':
        const notes = [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5];
        const times = [0, 0.12, 0.24, 0.36, 0.55, 0.70];
        const durs = [0.1, 0.1, 0.1, 0.18, 0.12, 0.5];
        notes.forEach((n, i) => this.playTone(n, 'triangle', durs[i], times[i], 0.85));
        break;
    }
  }
}

export const sfx = new SoundEngine();
