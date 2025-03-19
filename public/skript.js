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
  // モード切替：曲名モードの場合はアーティスト入力欄表示と再検索ボタン表示
  if (mode === "artist") {
    document.getElementById("artistInputContainer").style.display = "none";
    document.getElementById("songName").placeholder = "アーティスト名を入力してください";
    document.getElementById("modeArtist").style.backgroundColor = "#007bff";
    document.getElementById("modeArtist").style.color = "white";
    document.getElementById("modeSong").style.backgroundColor = "";
    document.getElementById("modeSong").style.color = "";
    document.getElementById("reSearchSongMode").style.display = "none";
    document.getElementById("reSearchArtistMode").style.display = "block";
  } else {
    document.getElementById("artistInputContainer").style.display = "block";
    document.getElementById("songName").placeholder = "曲名を入力してください";
    document.getElementById("modeSong").style.backgroundColor = "#007bff";
    document.getElementById("modeSong").style.color = "white";
    document.getElementById("modeArtist").style.backgroundColor = "";
    document.getElementById("modeArtist").style.color = "";
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
  // (検索処理は従来のコードと同様)
  // ...
  // ※ここは従来の検索処理コードをそのまま利用してください。
  hideLoading();
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
        ${ playerControlsEnabled ? `
          <button type="button" class="control-btn" id="playPauseBtn" onclick="togglePlay(event)"></button>
          <button type="button" class="control-btn" id="muteBtn" onclick="toggleMute(event)"></button>
          <input type="range" min="0" max="100" value="50" class="volume-slider" id="volumeSlider" oninput="changeVolume(this.value)">
        ` : "" }
        <button type="button" class="clear-btn" onclick="clearSelection()">×</button>
      </div>
    </div>
  `;
  // hidden fields の設定
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
      if (window.AudioContext || window.webkitAudioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
    }
    previewAudio.src = song.previewUrl;
    previewAudio.load();
    previewAudio.onloadedmetadata = function() {
      previewAudio.currentTime = (previewAudio.duration > 15) ? 15 : 0;
      previewAudio.play().catch(err => { console.error("Playback error:", err); });
    };
    // oncanplay を追加（万が一 onloadedmetadata で再生されなかった場合）
    previewAudio.oncanplay = function() {
      previewAudio.play().catch(err => { console.error("Playback error (canplay):", err); });
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
    updateMuteIcon();
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
  const volumeBtn = document.getElementById("muteBtn");
  if (!volumeBtn || !previewAudio) return;
  let vol = audioContext && gainNode ? gainNode.gain.value : previewAudio.volume;
  let svg = "";
  if (isMuted || vol <= 0.01) {
    // ミュート時：従来のスピーカー＋×アイコン（添付アイコン）
    svg = `<svg width="24" height="24" viewBox="0 0 24 24" style="pointer-events:none;">
      <polygon points="4,9 8,9 13,5 13,19 8,15 4,15" fill="#888"/>
      <line x1="15" y1="4" x2="21" y2="20" stroke="#888" stroke-width="2"/>
    </svg>`;
  } else if (vol < 0.35) {
    // 低音量：1本の波形、縦に長く伸ばす
    svg = `<svg width="24" height="24" viewBox="0 0 24 24" style="pointer-events:none;">
      <polygon points="4,9 8,9 13,5 13,19 8,15 4,15" fill="#888"/>
      <path d="M15,12 C15.5,6 15.5,18 15,12" stroke="#888" stroke-width="2" fill="none"/>
    </svg>`;
  } else if (vol < 0.65) {
    // 中音量：2本の波形
    svg = `<svg width="24" height="24" viewBox="0 0 24 24" style="pointer-events:none;">
      <polygon points="4,9 8,9 13,5 13,19 8,15 4,15" fill="#888"/>
      <path d="M15,12 C15.5,6 15.5,18 15,12" stroke="#888" stroke-width="2" fill="none"/>
      <path d="M18,12 C18.5,4 18.5,20 18,12" stroke="#888" stroke-width="2" fill="none"/>
    </svg>`;
  } else {
    // 高音量：3本の波形
    svg = `<svg width="24" height="24" viewBox="0 0 24 24" style="pointer-events:none;">
      <polygon points="4,9 8,9 13,5 13,19 8,15 4,15" fill="#888"/>
      <path d="M15,12 C15.5,6 15.5,18 15,12" stroke="#888" stroke-width="2" fill="none"/>
      <path d="M18,12 C18.5,4 18.5,20 18,12" stroke="#888" stroke-width="2" fill="none"/>
      <path d="M21,12 C21.5,2 21.5,22 21,12" stroke="#888" stroke-width="2" fill="none"/>
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
