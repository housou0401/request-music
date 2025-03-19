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
  // 初期状態は曲名モード
  setSearchMode('song');
  // 初回タップで AudioContext 再開（iOS Safari/Chrome対策）
  document.addEventListener("click", () => {
    if (audioContext && audioContext.state === "suspended") {
      audioContext.resume();
    }
  }, { once: true });
  await loadSettings();
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
  document.getElementById("suggestions").innerHTML = "";
  document.getElementById("selectedLabel").innerHTML = "";
  document.getElementById("selectedSong").innerHTML = "";
  document.getElementById("selectedArtist").innerHTML = "";
  if (previewAudio) {
    previewAudio.pause();
    previewAudio.currentTime = 0;
    isPlaying = false;
    updatePlayPauseIcon();
  }
  // モードに応じた表示切替
  if (mode === "artist") {
    document.getElementById("artistInputContainer").style.display = "none";
    document.getElementById("songName").placeholder = "アーティスト名を入力してください";
    document.getElementById("modeArtist").style.backgroundColor = "#007bff";
    document.getElementById("modeArtist").style.color = "white";
    document.getElementById("modeSong").style.backgroundColor = "";
    document.getElementById("modeSong").style.color = "";
    // アーティストモードでは再検索ボタンを表示
    document.getElementById("reSearchSongMode").style.display = "none";
    document.getElementById("reSearchArtistMode").style.display = "block";
  } else {
    document.getElementById("artistInputContainer").style.display = "block";
    document.getElementById("songName").placeholder = "曲名を入力してください";
    document.getElementById("modeSong").style.backgroundColor = "#007bff";
    document.getElementById("modeSong").style.color = "white";
    document.getElementById("modeArtist").style.backgroundColor = "";
    document.getElementById("modeArtist").style.color = "";
    // 曲名モードでは再検索ボタンを表示
    document.getElementById("reSearchSongMode").style.display = "block";
    document.getElementById("reSearchArtistMode").style.display = "none";
  }
}

function reSearch() {
  searchSongs();
}

async function searchSongs() {
  const suggestionsContainer = document.getElementById("suggestions");
  suggestionsContainer.innerHTML = "";
  showLoading();
  if (searchMode === "artist") {
    if (artistPhase === 0) {
      const artistQuery = document.getElementById("songName").value.trim();
      if (artistQuery.length < 1) { hideLoading(); return; }
      try {
        const res = await fetch(`/search?mode=artist&query=${encodeURIComponent(artistQuery)}`);
        const suggestions = await res.json();
        suggestions.forEach(artist => {
          const item = document.createElement("div");
          item.classList.add("suggestion-item");
          item.innerHTML = `
            <img src="${artist.artworkUrl}" alt="Artist Icon" style="width:50px; height:50px; border-radius:5px; margin-right:10px;">
            <div><strong>${artist.trackName}</strong></div>
          `;
          item.onclick = () => selectArtist(artist);
          suggestionsContainer.appendChild(item);
        });
      } catch (e) {
        console.error("アーティスト検索エラー:", e);
      }
    } else {
      await fetchArtistTracksAndShow();
    }
  } else {
    const songQuery = document.getElementById("songName").value.trim();
    const artistQuery = document.getElementById("artistName").value.trim();
    if (songQuery.length < 1) { hideLoading(); return; }
    try {
      const res = await fetch(`/search?query=${encodeURIComponent(songQuery)}&artist=${encodeURIComponent(artistQuery)}`);
      const suggestions = await res.json();
      suggestions.forEach(song => {
        const item = document.createElement("div");
        item.classList.add("suggestion-item");
        item.innerHTML = `
          <img src="${song.artworkUrl}" alt="Cover">
          <div>
            <strong>${song.trackName}</strong><br>
            <small>${song.artistName}</small>
          </div>
        `;
        item.onclick = () => selectSong(song);
        suggestionsContainer.appendChild(item);
      });
    } catch (e) {
      console.error("曲検索エラー:", e);
    }
  }
  hideLoading();
}

function selectArtist(artist) {
  selectedArtistId = artist.artistId;
  artistPhase = 1;
  document.getElementById("selectedArtist").innerHTML = `
    <div class="selected-label">選択中のアーティスト</div>
    <div class="selected-item" style="display:flex; align-items:center; justify-content:space-between; margin-top:10px;">
      <div style="display:flex; align-items:center;">
        <img src="${artist.artworkUrl}" alt="Artist Icon" style="width:50px; height:50px; border-radius:5px; margin-right:10px;">
        <div><strong>${artist.trackName}</strong></div>
      </div>
      <button type="button" class="clear-btn" onclick="clearArtistSelection()">×</button>
    </div>
  `;
  document.getElementById("suggestions").innerHTML = "";
  fetchArtistTracksAndShow();
}

async function fetchArtistTracksAndShow() {
  const suggestionsContainer = document.getElementById("suggestions");
  suggestionsContainer.innerHTML = "";
  try {
    const res = await fetch(`/search?mode=artist&artistId=${encodeURIComponent(selectedArtistId)}`);
    const tracks = await res.json();
    tracks.forEach(song => {
      const item = document.createElement("div");
      item.classList.add("suggestion-item");
      item.innerHTML = `
        <img src="${song.artworkUrl}" alt="Cover">
        <div>
          <strong>${song.trackName}</strong><br>
          <small>${song.artistName}</small>
        </div>
      `;
      item.onclick = () => selectSong(song);
      suggestionsContainer.appendChild(item);
    });
  } catch (e) {
    console.error("アーティストの曲一覧取得エラー:", e);
  }
}

function selectSong(song) {
  document.getElementById("songName").value = song.trackName;
  if (searchMode === "song" && !document.getElementById("artistName").value.trim()) {
    document.getElementById("artistName").value = song.artistName;
  }
  document.getElementById("selectedLabel").innerHTML = `<div class="selected-label">選択中の曲</div>`;
  const container = document.getElementById("selectedSong");
  container.innerHTML = `
    <div class="selected-item" style="display:flex; align-items:center; justify-content:space-between; border:1px solid rgba(0,0,0,0.2); border-radius:10px; padding:10px; margin-top:10px;">
      <div style="display:flex; align-items:center;">
        <img src="${song.artworkUrl}" alt="Cover" style="width:50px; height:50px; border-radius:5px; margin-right:10px;">
        <div>
          <strong>${song.trackName}</strong><br>
          <small>${song.artistName}</small>
        </div>
      </div>
      <div style="display:flex; align-items:center;">
        <button type="button" class="control-btn" id="playPauseBtn" onclick="togglePlay(event)"></button>
        <button type="button" class="control-btn" id="volumeBtn" onclick="toggleMute(event)"></button>
        <input type="range" min="0" max="100" value="50" class="volume-slider" id="volumeSlider" oninput="changeVolume(this.value)">
        <button type="button" class="clear-btn" onclick="clearSelection()">×</button>
      </div>
    </div>
  `;
  // hidden fields
  let hiddenApple = document.getElementById("appleMusicUrlHidden") || document.createElement("input");
  if (!document.getElementById("appleMusicUrlHidden")) {
    hiddenApple.type = "hidden";
    hiddenApple.id = "appleMusicUrlHidden";
    hiddenApple.name = "appleMusicUrl";
    document.getElementById("requestForm").appendChild(hiddenApple);
  }
  hiddenApple.value = song.trackViewUrl;

  let hiddenArtwork = document.getElementById("artworkUrlHidden") || document.createElement("input");
  if (!document.getElementById("artworkUrlHidden")) {
    hiddenArtwork.type = "hidden";
    hiddenArtwork.id = "artworkUrlHidden";
    hiddenArtwork.name = "artworkUrl";
    document.getElementById("requestForm").appendChild(hiddenArtwork);
  }
  hiddenArtwork.value = song.artworkUrl;

  let hiddenPreview = document.getElementById("previewUrlHidden") || document.createElement("input");
  if (!document.getElementById("previewUrlHidden")) {
    hiddenPreview.type = "hidden";
    hiddenPreview.id = "previewUrlHidden";
    hiddenPreview.name = "previewUrl";
    document.getElementById("requestForm").appendChild(hiddenPreview);
  }
  hiddenPreview.value = song.previewUrl;

  if (playerControlsEnabled && song.previewUrl) {
    if (!previewAudio) {
      previewAudio = document.createElement("audio");
      previewAudio.id = "previewAudio";
      previewAudio.style.display = "none";
      previewAudio.autoplay = true;
      document.body.appendChild(previewAudio);
      if (!window.AudioContext && !window.webkitAudioContext) {
        console.warn("Web Audio API がサポートされていません");
      } else {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
    }
    previewAudio.src = song.previewUrl;
    previewAudio.load();
    previewAudio.onloadedmetadata = function() {
      previewAudio.currentTime = (previewAudio.duration > 15) ? 15 : 0;
      previewAudio.play().catch(err => { console.error("Playback error:", err); });
    };
    if (audioContext && gainNode) {
      gainNode.gain.value = 0.5;
    } else if (audioContext && !gainNode) {
      const source = audioContext.createMediaElementSource(previewAudio);
      gainNode = audioContext.createGain();
      source.connect(gainNode);
      gainNode.connect(audioContext.destination);
      gainNode.gain.value = 0.5;
    } else {
      previewAudio.volume = 0.5;
    }
    previewAudio.loop = true;
    isPlaying = true;
    isMuted = false;
    updatePlayPauseIcon();
    updateVolumeIcon();
  }
}

function changeVolume(val) {
  if (!previewAudio) return;
  const volumeValue = parseInt(val, 10) / 100;
  if (isMuted) {
    isMuted = false;
    previewAudio.muted = false;
  }
  if (audioContext && gainNode) {
    gainNode.gain.value = volumeValue;
  } else {
    previewAudio.volume = volumeValue;
  }
  updateVolumeIcon();
}

function updateVolumeIcon() {
  const volumeBtn = document.getElementById("volumeBtn");
  if (!volumeBtn || !previewAudio) return;
  let vol = audioContext && gainNode ? gainNode.gain.value : previewAudio.volume;
  let svg = "";
  if (isMuted || vol <= 0.01) {
    // ミュート時のアイコン（従来のスピーカー＋×）
    svg = `<svg width="24" height="24" viewBox="0 0 24 24" style="pointer-events:none;">
      <polygon points="4,9 8,9 13,5 13,19 8,15 4,15" fill="#888"/>
      <line x1="15" y1="4" x2="21" y2="20" stroke="#888" stroke-width="2"/>
    </svg>`;
  } else if (vol < 0.35) {
    // 低音量：1つの波形、縦長に調整
    svg = `<svg width="24" height="24" viewBox="0 0 24 24" style="pointer-events:none;">
      <polygon points="4,9 8,9 13,5 13,19 8,15 4,15" fill="#888"/>
      <path d="M15,12 C15.5,8 15.5,16 15,12" stroke="#888" stroke-width="2" fill="none"/>
    </svg>`;
  } else if (vol < 0.65) {
    // 中音量：2つの波形
    svg = `<svg width="24" height="24" viewBox="0 0 24 24" style="pointer-events:none;">
      <polygon points="4,9 8,9 13,5 13,19 8,15 4,15" fill="#888"/>
      <path d="M15,12 C15.5,8 15.5,16 15,12" stroke="#888" stroke-width="2" fill="none"/>
      <path d="M18,12 C18.5,7 18.5,17 18,12" stroke="#888" stroke-width="2" fill="none"/>
    </svg>`;
  } else {
    // 高音量：3つの波形
    svg = `<svg width="24" height="24" viewBox="0 0 24 24" style="pointer-events:none;">
      <polygon points="4,9 8,9 13,5 13,19 8,15 4,15" fill="#888"/>
      <path d="M15,12 C15.5,8 15.5,16 15,12" stroke="#888" stroke-width="2" fill="none"/>
      <path d="M18,12 C18.5,7 18.5,17 18,12" stroke="#888" stroke-width="2" fill="none"/>
      <path d="M21,12 C21.5,6 21.5,18 21,12" stroke="#888" stroke-width="2" fill="none"/>
    </svg>`;
  }
  volumeBtn.innerHTML = svg;
}

function togglePlay(e) {
  e.stopPropagation();
  if (!previewAudio) return;
  if (isPlaying) {
    previewAudio.pause();
    isPlaying = false;
  } else {
    if (audioContext && audioContext.state === "suspended") {
      audioContext.resume();
    }
    previewAudio.play().catch(err => { console.error("Playback error:", err); });
    isPlaying = true;
  }
  updatePlayPauseIcon();
}

function updatePlayPauseIcon() {
  const btn = document.getElementById("playPauseBtn");
  if (!btn) return;
  let svg = "";
  if (isPlaying) {
    svg = `<svg width="24" height="24" viewBox="0 0 24 24" style="pointer-events:none;">
      <rect x="6" y="5" width="4" height="14" fill="#888"/>
      <rect x="14" y="5" width="4" height="14" fill="#888"/>
    </svg>`;
  } else {
    svg = `<svg width="24" height="24" viewBox="0 0 24 24" style="pointer-events:none;">
      <polygon points="7,4 19,12 7,20" fill="#888"/>
    </svg>`;
  }
  btn.innerHTML = svg;
}

function toggleMute(e) {
  e.stopPropagation();
  if (!previewAudio) return;
  isMuted = !isMuted;
  previewAudio.muted = isMuted;
  updateVolumeIcon();
}

function clearSelection() {
  document.getElementById("selectedLabel").innerHTML = "";
  document.getElementById("selectedSong").innerHTML = "";
  if (document.getElementById("appleMusicUrlHidden"))
    document.getElementById("appleMusicUrlHidden").value = "";
  if (document.getElementById("artworkUrlHidden"))
    document.getElementById("artworkUrlHidden").value = "";
  if (document.getElementById("previewUrlHidden"))
    document.getElementById("previewUrlHidden").value = "";
  if (previewAudio) {
    previewAudio.pause();
    previewAudio.currentTime = 0;
    isPlaying = false;
    updatePlayPauseIcon();
  }
  clearArtistSelection();
  searchSongs();
}

function clearArtistSelection() {
  selectedArtistId = null;
  artistPhase = 0;
  document.getElementById("selectedArtist").innerHTML = "";
  document.getElementById("selectedLabel").innerHTML = "";
  document.getElementById("selectedSong").innerHTML = "";
  if (previewAudio) {
    previewAudio.pause();
    previewAudio.currentTime = 0;
    isPlaying = false;
    updatePlayPauseIcon();
  }
  document.getElementById("suggestions").innerHTML = "";
  searchSongs();
}

function clearInput(id) {
  document.getElementById(id).value = "";
  searchSongs();
}

function handleSubmit(e) {
  e.preventDefault();
  const appleUrl = document.getElementById("appleMusicUrlHidden")?.value.trim();
  if (!appleUrl) {
    alert("必ず候補一覧から曲を選択してください");
    return;
  }
  document.getElementById("requestForm").submit();
}

function showAdminLogin() {
  const password = prompt("⚠️管理者パスワードを入力してください:");
  if (password) {
    fetch(`/admin-login?password=${encodeURIComponent(password)}`)
      .then(r => r.json())
      .then(d => {
        if (d.success) window.location.href = "/admin";
        else alert("⚠️パスワードが間違っています。");
      })
      .catch(err => console.error("管理者ログインエラー:", err));
  }
}

/* ロード中UI */
function showLoading() {
  const loader = document.getElementById("loadingIndicator");
  if (loader) loader.style.display = "flex";
}
function hideLoading() {
  const loader = document.getElementById("loadingIndicator");
  if (loader) loader.style.display = "none";
}
