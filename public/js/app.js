let searchMode = "song";
let artistPhase = 0;
let selectedArtistId = null;
let isPlaying = false;
let isMuted = false;
let playerControlsEnabled = true;

window.onload = async () => {
  await loadSettings();
  setSearchMode("song");
  document.addEventListener("click", () => {
    if (audioContext && audioContext.state === "suspended") audioContext.resume();
  }, { once: true });
};

async function loadSettings() {
  try {
    const res = await fetch("/settings");
    const data = await res.json();
    playerControlsEnabled = data.playerControlsEnabled !== false;
  } catch {
    playerControlsEnabled = true;
  }
}

function setSearchMode(mode) {
  searchMode = mode;
  artistPhase = 0;
  selectedArtistId = null;
  document.getElementById("songName").value = "";
  document.getElementById("artistName").value = "";
  UI.clearSuggestions();
  UI.clearSelected();
  pausePreview();
  isPlaying = false; updatePlayPauseIcon();

  // ボタン活性化
  document.getElementById("modeSong").style.backgroundColor = mode==="song"?"#007bff":"";
  document.getElementById("modeSong").style.color = mode==="song"?"white":"";
  document.getElementById("modeArtist").style.backgroundColor = mode==="artist"?"#007bff":"";
  document.getElementById("modeArtist").style.color = mode==="artist"?"white":"";

  if (mode==="artist") {
    document.getElementById("artistInputContainer").style.display = "none";
    document.getElementById("songName").placeholder = "アーティスト名を入力してください";
    document.getElementById("reSearchSongMode").style.display = "none";
    document.getElementById("reSearchArtistMode").style.display = "block";
  } else {
    document.getElementById("artistInputContainer").style.display = "block";
    document.getElementById("songName").placeholder = "曲名を入力してください";
    document.getElementById("reSearchSongMode").style.display = "block";
    document.getElementById("reSearchArtistMode").style.display = "none";
  }
}

function reSearch() {
  searchSongs();
}

async function searchSongs() {
  UI.clearSuggestions();
  UI.showLoading();
  const c = document.getElementById("suggestions");
  if (searchMode==="artist") {
    if (artistPhase===0) {
      const q = document.getElementById("songName").value.trim();
      if (!q) { UI.hideLoading(); return; }
      const res = await fetch(`/search?mode=artist&query=${encodeURIComponent(q)}`);
      const list = await res.json();
      list.forEach(a => {
        const div = document.createElement("div");
        div.className = "suggestion-item";
        div.innerHTML = `<img src="${a.artworkUrl}"><div><strong>${a.trackName}</strong></div>`;
        div.onclick = () => selectArtist(a);
        c.appendChild(div);
      });
    } else {
      const res = await fetch(`/search?mode=artist&artistId=${encodeURIComponent(selectedArtistId)}`);
      const list = await res.json();
      list.forEach(s => {
        const div = document.createElement("div");
        div.className = "suggestion-item";
        div.innerHTML = `<img src="${s.artworkUrl}"><div><strong>${s.trackName}</strong><br><small>${s.artistName}</small></div>`;
        div.onclick = () => selectSong(s);
        c.appendChild(div);
      });
    }
  } else {
    const song = document.getElementById("songName").value.trim();
    const artist = document.getElementById("artistName").value.trim();
    if (!song) { UI.hideLoading(); return; }
    const res = await fetch(`/search?query=${encodeURIComponent(song)}&artist=${encodeURIComponent(artist)}`);
    const list = await res.json();
    list.forEach(s => {
      const div = document.createElement("div");
      div.className = "suggestion-item";
      div.innerHTML = `<img src="${s.artworkUrl}"><div><strong>${s.trackName}</strong><br><small>${s.artistName}</small></div>`;
      div.onclick = () => selectSong(s);
      c.appendChild(div);
    });
  }
  UI.hideLoading();
}

function selectArtist(a) {
  selectedArtistId = a.artistId;
  artistPhase = 1;
  document.getElementById("selectedArtist").innerHTML = `
    <div class="selected-label">選択中のアーティスト</div>
    <div class="selected-item" style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;">
      <div style="display:flex;align-items:center;">
        <img src="${a.artworkUrl}" style="width:50px;height:50px;border-radius:5px;margin-right:10px;">
        <div><strong>${a.trackName}</strong></div>
      </div>
      <button class="clear-btn" onclick="clearArtistSelection()">🗑️</button>
    </div>`;
  UI.clearSuggestions();
  searchSongs();
}

function selectSong(s) {
  document.getElementById("songName").value = s.trackName;
  if (searchMode==="song" && !document.getElementById("artistName").value.trim()) {
    document.getElementById("artistName").value = s.artistName;
  }
  document.getElementById("selectedLabel").innerHTML = `<div class="selected-label">選択中の曲</div>`;
  document.getElementById("selectedSong").innerHTML = `
    <div class="selected-item" style="display:flex;align-items:center;justify-content:space-between;border:1px solid rgba(0,0,0,0.2);border-radius:10px;padding:10px;margin-top:10px;">
      <div style="display:flex;align-items:center;">
        <img src="${s.artworkUrl}" style="width:50px;height:50px;border-radius:5px;margin-right:10px;">
        <div><strong>${s.trackName}</strong><br><small>${s.artistName}</small></div>
      </div>
      <div style="display:flex;align-items:center;">
        ${playerControlsEnabled?`
          <button class="control-btn" id="playPauseBtn" onclick="togglePlay(event)"></button>
          <button class="control-btn" id="volumeBtn" onclick="toggleMute(event)"></button>
          <input type="range" min="0" max="100" value="50" class="volume-slider" id="volumeSlider" oninput="changeVolume(this.value)">
        `:""}
        <button class="clear-btn" onclick="clearSelection()">🗑️</button>
      </div>
    </div>`;
  document.getElementById("appleMusicUrlHidden").value = s.trackViewUrl;
  document.getElementById("artworkUrlHidden").value = s.artworkUrl;
  document.getElementById("previewUrlHidden").value = s.previewUrl;

  if (playerControlsEnabled && s.previewUrl) {
    playPreview(s.previewUrl);
    setPreviewVolume(50);
    mutePreview(false);
    isPlaying = true; isMuted = false;
    updatePlayPauseIcon(); updateVolumeIcon();
  }
}

function changeVolume(v) {
  if (!previewAudio) return;
  const vol = v/100;
  if (isMuted) { isMuted=false; mutePreview(false); }
  setPreviewVolume(v);
  updateVolumeIcon();
}

function updateVolumeIcon() {
  const btn = document.getElementById("volumeBtn");
  if (!btn) return;
  let vol = gainNode?gainNode.gain.value:previewAudio.volume;
  let icon = '🔇';
  if (!isMuted && vol>0.01) {
    if (vol<0.35) icon='🔈';
    else if (vol<0.65) icon='🔉';
    else icon='🔊';
  }
  btn.textContent = icon;
}

function togglePlay(e) {
  e.stopPropagation();
  if (!previewAudio) return;
  if (isPlaying) pausePreview();
  else {
    if (audioContext && audioContext.state==="suspended") audioContext.resume();
    previewAudio.play().catch(console.error);
  }
  isPlaying=!isPlaying; updatePlayPauseIcon();
}

function updatePlayPauseIcon() {
  const btn = document.getElementById("playPauseBtn");
  if (!btn) return;
  btn.textContent = isPlaying ? '⏸' : '▶️';
}

function toggleMute(e) {
  e.stopPropagation();
  if (!previewAudio) return;
  isMuted=!isMuted;
  mutePreview(isMuted);
  updateVolumeIcon();
}

function clearSelection() {
  UI.clearSelected();
  pausePreview(); isPlaying=false; updatePlayPauseIcon();
  clearArtistSelection();
  searchSongs();
}

function clearArtistSelection() {
  artistPhase=0; selectedArtistId=null;
  UI.clearSelected();
  pausePreview(); isPlaying=false; updatePlayPauseIcon();
  UI.clearSuggestions();
  searchSongs();
}

function clearInput(id) {
  document.getElementById(id).value="";
  searchSongs();
}

function handleSubmit(e) {
  e.preventDefault();
  if (!document.getElementById("appleMusicUrlHidden").value) {
    alert("必ず候補一覧から曲を選択してください");
    return;
  }
  e.target.submit();
}

function showAdminLogin() {
  const pwd = prompt("⚠️管理者パスワードを入力してください:");
  if (!pwd) return;
  fetch(`/admin-login?password=${encodeURIComponent(pwd)}`)
    .then(r=>r.json())
    .then(d=>{ if(d.success) location.href="/admin"; else alert("パスワードが違います"); })
    .catch(console.error);
}
