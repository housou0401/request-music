const App = {
  searchMode: 'song',
  artistPhase: 0,
  selectedArtistId: null,
  isPlaying: false,
  isMuted: false,

  init() {
    UI.setModeButtons(this.searchMode);
  },

  setMode(mode) {
    this.searchMode = mode;
    this.artistPhase = 0;
    this.selectedArtistId = null;
    UI.setModeButtons(mode);
    UI.clearInput('songName');
    UI.clearInput('artistName');
    UI.clearSuggestions();
    UI.clearSelected();
  },

  selectArtist(artist) {
    this.selectedArtistId = artist.artistId;
    this.artistPhase = 1;
    UI.renderSelectedArtist(artist);
    Search.onInput();
  },

  selectSong(song) {
    document.getElementById("songName").value = song.trackName;
    if (this.searchMode === 'song' && !document.getElementById("artistName").value.trim()) {
      document.getElementById("artistName").value = song.artistName;
    }

    const controlsHtml = `
      <button class="control-btn" id="playPauseBtn" onclick="App.togglePlay()">▶️</button>
      <button class="control-btn" id="volumeBtn" onclick="App.toggleMute()">🔊</button>
      <input type="range" min="0" max="100" value="50" class="volume-slider" id="volumeSlider" oninput="App.changeVolume(this.value)">
    `;
    UI.renderSelectedSong(song, controlsHtml);

    document.getElementById("appleMusicUrlHidden").value = song.trackViewUrl;
    document.getElementById("artworkUrlHidden").value    = song.artworkUrl;
    document.getElementById("previewUrlHidden").value    = song.previewUrl;

    if (song.previewUrl) {
      Preview.play(song.previewUrl);
      Preview.setVolume(50);
      Preview.mute(false);
      this.isPlaying = true;
      this.isMuted = false;
      this.updatePlayPauseIcon();
      this.updateVolumeIcon();
    }
  },

  changeVolume(val) {
    Preview.setVolume(val);
    if (this.isMuted && val > 0) {
      this.isMuted = false;
      Preview.mute(false);
    }
    this.updateVolumeIcon();
  },

  togglePlay() {
    if (this.isPlaying) Preview.pause();
    else Preview.play(document.getElementById("previewUrlHidden").value);
    this.isPlaying = !this.isPlaying;
    this.updatePlayPauseIcon();
  },

  toggleMute() {
    this.isMuted = !this.isMuted;
    Preview.mute(this.isMuted);
    this.updateVolumeIcon();
  },

  updatePlayPauseIcon() {
    document.getElementById("playPauseBtn").textContent = this.isPlaying ? '⏸' : '▶️';
  },

  updateVolumeIcon() {
    const vol = +document.getElementById("volumeSlider").value;
    const btn = document.getElementById("volumeBtn");
    if (this.isMuted || vol === 0) btn.textContent = '🔇';
    else if (vol < 35)      btn.textContent = '🔈';
    else if (vol < 65)      btn.textContent = '🔉';
    else                    btn.textContent = '🔊';
  },

  clearSelection() {
    UI.clearSelected();
    Preview.pause();
    this.clearArtist();
  },

  clearArtist() {
    this.setMode(this.searchMode);
  },

  clearInput(id) {
    UI.clearInput(id);
    Search.onInput();
  },

  handleSubmit(e) {
    e.preventDefault();
    if (!document.getElementById("appleMusicUrlHidden").value) {
      alert("必ず候補一覧から曲を選択してください");
      return;
    }
    e.target.submit();
  },

  showAdminLogin() {
    const pwd = prompt("⚠️管理者パスワードを入力してください:");
    if (!pwd) return;
    fetch(`/admin-login?password=${encodeURIComponent(pwd)}`)
      .then(r => r.json())
      .then(d => {
        if (d.success) location.href = '/admin';
        else alert("パスワードが違います");
      })
      .catch(console.error);
  }
};
