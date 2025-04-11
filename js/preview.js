const Preview = {
  audio: null,
  ctx: null,
  gain: null,

  init() {
    this.audio = document.createElement("audio");
    this.audio.style.display = "none";
    document.body.appendChild(this.audio);
    if (window.AudioContext || window.webkitAudioContext) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = this.ctx.createMediaElementSource(this.audio);
      this.gain = this.ctx.createGain();
      src.connect(this.gain).connect(this.ctx.destination);
    }
  },

  play(url) {
    if (!this.audio) this.init();
    this.audio.src = url;
    this.audio.muted = true;
    this.audio.load();
    this.audio.onloadedmetadata = () => {
      this.audio.currentTime = this.audio.duration > 15 ? 15 : 0;
      this.audio.play().then(() => this.audio.muted = false)
        .catch(console.error);
    };
    this.audio.loop = true;
  },

  setVolume(pct) {
    const v = pct / 100;
    if (this.gain) this.gain.gain.value = v;
    else this.audio.volume = v;
  },

  pause() {
    this.audio?.pause();
  },

  mute(flag) {
    this.audio.muted = flag;
  }
};
