// Web Audio API（iOS Safari/Chrome対応）
let audioContext = null;
let gainNode = null;

let searchMode = "song";
let artistPhase = 0;
let selectedArtistId = null;
let previewAudio = null;
let isPlaying = false;
let isMuted = false;
let playerControlsEnabled = true;

window.onload = async function() {
  await loadSettings();
  setSearchMode('song');
  document.addEventListener("click", () => {
    if (audioContext && audioContext.state === "suspended") {
      audioContext.resume();
    }
  }, { once: true });
};

async function loadSettings() {
  try {
    const res = await fetch("/settings");
    const data = await res.json();
    playerControlsEnabled = data.playerControlsEnabled !== false;
  } catch (e) {
    console.error("設定読み込みエラー:", e);
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
  if (previewAudio) {
    previewAudio.pause();
    previewAudio.currentTime = 0;
    isPlaying = false;
    updatePlayPauseIcon();
  }

  // ボタン活性化
  document.getElementById("modeSong").style.backgroundColor = mode === "song" ? "#007bff" : "";
  document.getElementById("modeSong").style.color = mode === "song" ? "white" : "";
  document.getElementById("modeArtist").style.backgroundColor = mode === "artist" ? "#007bff" : "";
  document.getElementById("modeArtist").style.color = mode === "artist" ? "white" : "";

  if (mode === "artist") {
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
  const c = document.getElementById("suggestions");
  c.innerHTML = "";
  UI.showLoading();
  if (searchMode === "artist") {
    if (artistPhase === 0) {
      const q = document.getElementById("songName").value.trim();
      if (!q) { UI.hideLoading(); return; }
      const res = await fetch(`/search?mode=artist&query=${encodeURIComponent(q)}`);
      const list = await res.json();
      list.forEach(a => {
        const item = document.createElement("div");
        item.className = "suggestion-item";
        item.innerHTML = `
          <img src="${a.artworkUrl}" style="width:50px;height:50px;border-radius:5px;margin-right:10px;">
          <div><strong>${a.trackName}</strong></div>`;
        item.onclick = () => selectArtist(a);
        c.appendChild(item);
      });
    } else {
      const res = await fetch(`/search?mode=artist&artistId=${encodeURIComponent(selectedArtistId)}`);
      const tracks = await res.json();
      tracks.forEach(s => {
        const item = document.createElement("div");
        item.className = "suggestion-item";
        item.innerHTML = `
          <img src="${s.artworkUrl}"><div><strong>${s.trackName}</strong><br><small>${s.artistName}</small></div>`;
        item.onclick = () => selectSong(s);
        c.appendChild(item);
      });
    }
  } else {
    const song = document.getElementById("songName").value.trim();
    const artist = document.getElementById("artistName").value.trim();
    if (!song) { UI.hideLoading(); return; }
    const res = await fetch(`/search?query=${encodeURIComponent(song)}&artist=${encodeURIComponent(artist)}`);
    const list = await res.json();
    list.forEach(s => {
      const item = document.createElement("div");
      item.className = "suggestion-item";
      item.innerHTML = `
        <img src="${s.artworkUrl}"><div><strong>${s.trackName}</strong><br><small>${s.artistName}</small></div>`;
      item.onclick = () => selectSong(s);
      c.appendChild(item);
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
      <button class="clear-btn" onclick="clearArtistSelection()">×</button>
    </div>`;
  document.getElementById("suggestions").innerHTML = "";
  searchSongs();
}

function selectSong(song) {
  document.getElementById("songName").value = song.trackName;
  if (searchMode==="song" && !document.getElementById("artistName").value.trim()) {
    document.getElementById("artistName").value = song.artistName;
  }
  document.getElementById("selectedLabel").innerHTML = `<div class="selected-label">選択中の曲</div>`;
  document.getElementById("selectedSong").innerHTML = `
    <div class="selected-item" style="display:flex;align-items:center;justify-content:space-between;border:1px solid rgba(0,0,0,0.2);border-radius:10px;padding:10px;margin-top:10px;">
      <div style="display:flex;align-items:center;">
        <img src="${song.artworkUrl}" style="width:50px;height:50px;border-radius:5px;margin-right:10px;">
        <div><strong>${song.trackName}</strong><br><small>${song.artistName}</small></div>
      </div>
      <div style="display:flex;align-items:center;">
        ${playerControlsEnabled?`
          <button class="control-btn" id="playPauseBtn" onclick="togglePlay(event)"></button>
          <button class="control-btn" id="volumeBtn" onclick="toggleMute(event)"></button>
          <input type="range" min="0" max="100" value="50" class="volume-slider" id="volumeSlider" oninput="changeVolume(this.value)">
        `:""}
        <button class="clear-btn" onclick="clearSelection()">×</button>
      </div>
    </div>`;

  // hidden
  document.getElementById("appleMusicUrlHidden").value = song.trackViewUrl;
  document.getElementById("artworkUrlHidden").value = song.artworkUrl;
  document.getElementById("previewUrlHidden").value = song.previewUrl;

  // preview 再生
  if (playerControlsEnabled && song.previewUrl) {
    if (!previewAudio) {
      previewAudio = document.createElement("audio");
      previewAudio.style.display = "none";
      previewAudio.muted = true;
      document.body.appendChild(previewAudio);
      if (window.AudioContext||window.webkitAudioContext) {
        audioContext = new (window.AudioContext||window.webkitAudioContext)();
      }
    }
    previewAudio.src = song.previewUrl;
    previewAudio.load();
    previewAudio.onloadedmetadata = () => {
      previewAudio.currentTime = previewAudio.duration>15?15:0;
      previewAudio.play().then(()=> previewAudio.muted=false).catch(console.error);
    };
    previewAudio.loop = true;
    if (audioContext) {
      if (!gainNode) {
        const src = audioContext.createMediaElementSource(previewAudio);
        gainNode = audioContext.createGain();
        src.connect(gainNode).connect(audioContext.destination);
      }
      gainNode.gain.value = 0.5;
    } else {
      previewAudio.volume = 0.5;
    }
    isPlaying = true; isMuted=false;
    updatePlayPauseIcon(); updateVolumeIcon();
  }
}

function changeVolume(v) {
  if (!previewAudio) return;
  const vol = v/100;
  if (isMuted) {
    isMuted=false; previewAudio.muted=false;
  }
  if (gainNode) gainNode.gain.value=vol;
  else previewAudio.volume=vol;
  updateVolumeIcon();
}

function updateVolumeIcon() {
  const btn = document.getElementById("volumeBtn");
  if (!btn||!previewAudio) return;
  let vol = gainNode?gainNode.gain.value:previewAudio.volume;
  let svg="";
  if (isMuted||vol<=0.01) {
    svg=`<svg width="24" height="24"><polygon points="4,9 8,9 13,5 13,19 8,15 4,15" fill="#888"/><line x1="15" y1="4" x2="21" y2="20" stroke="#888" stroke-width="2"/><line x1="21" y1="4" x2="15" y2="20" stroke="#888" stroke-width="2"/></svg>`;
  } else if (vol<0.35) {
    svg=`<svg width="24" height="24"><polygon points="4,9 8,9 13,5 13,19 8,15 4,15" fill="#888"/><path d="M15,12 C15.5,8 15.5,16 15,12" stroke="#888" stroke-width="2" fill="none"/></svg>`;
  } else if (vol<0.65) {
    svg=`<svg width="24" height="24"><polygon points="4,9 8,9 13,5 13,19 8,15 4,15" fill="#888"/><path d="M15,12 C15.5,8 15.5,16 15,12" stroke="#888" stroke-width="2" fill="none"/><path d="M18,12 C18.7,7 18.7,17 18,12" stroke="#888" stroke-width="2" fill="none"/></svg>`;
  } else {
    svg=`<svg width="24" height="24"><polygon points="4,9 8,9 13,5 13,19 8,15 4,15" fill="#888"/><path d="M15,12 C15.5,8 15.5,16 15,12" stroke="#888" stroke-width="2" fill="none"/><path d="M18,12 C18.7,7 18.7,17 18,12" stroke="#888" stroke-width="2" fill="none"/><path d="M21,12 C21.5,6 21.5,18 21,12" stroke="#888" stroke-width="2" fill="none"/></svg>`;
  }
  btn.innerHTML = svg;
}

function togglePlay(e) {
  e.stopPropagation();
  if (!previewAudio) return;
  if (isPlaying) previewAudio.pause();
  else {
    if (audioContext&&audioContext.state==="suspended") audioContext.resume();
    previewAudio.play().catch(console.error);
  }
  isPlaying=!isPlaying; updatePlayPauseIcon();
}

function updatePlayPauseIcon() {
  const btn=document.getElementById("playPauseBtn");
  if (!btn) return;
  btn.innerHTML = isPlaying
    ? `<svg width="24" height="24"><rect x="6" y="5" width="4" height="14" fill="#888"/><rect x="14" y="5" width="4" height="14" fill="#888"/></svg>`
    : `<svg width="24" height="24"><polygon points="7,4 19,12 7,20" fill="#888"/></svg>`;
}

function toggleMute(e) {
  e.stopPropagation();
  if (!previewAudio) return;
  isMuted=!isMuted;
  previewAudio.muted=isMuted;
  updateVolumeIcon();
}

function clearSelection() {
  UI.clearSelected();
  if (previewAudio) { previewAudio.pause(); previewAudio.currentTime=0; isPlaying=false; updatePlayPauseIcon(); }
  clearArtistSelection();
  searchSongs();
}

function clearArtistSelection() {
  artistPhase=0; selectedArtistId=null;
  UI.clearSelected();
  if (previewAudio) { previewAudio.pause(); previewAudio.currentTime=0; isPlaying=false; updatePlayPauseIcon(); }
  document.getElementById("suggestions").innerHTML="";
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
  const pwd=prompt("⚠️管理者パスワードを入力してください:");
  if (!pwd) return;
  fetch(`/admin-login?password=${encodeURIComponent(pwd)}`)
    .then(r=>r.json())
    .then(d=>{ if (d.success) location.href="/admin"; else alert("パスワードが違います"); })
    .catch(console.error);
}

function showLoading() { document.getElementById("loadingIndicator").style.display="flex"; }
function hideLoading() { document.getElementById("loadingIndicator").style.display="none"; }
