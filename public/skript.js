// --- 共通グローバル変数 ---
let audioContext = null;
let gainNode = null;
let previewAudio = null;
let isPlaying = false;
let isMuted = false;
let playerControlsEnabled = true;

let searchMode = "song";
let artistPhase = 0;
let selectedArtistId = null;

// 初期化
window.onload = async () => {
  await loadSettings();
  setSearchMode("song");
  document.addEventListener("click", () => {
    if (audioContext && audioContext.state === "suspended") audioContext.resume();
  }, { once: true });
};

// 設定読み込み
async function loadSettings() {
  try {
    const res = await fetch("/settings");
    const data = await res.json();
    playerControlsEnabled = data.playerControlsEnabled !== false;
  } catch {
    playerControlsEnabled = true;
  }
}

// 募集状況チェック
function checkRecruitingStatus() {
  fetch("/settings")
    .then(r => r.json())
    .then(data => {
      if (!data.recruiting) {
        const c = document.getElementById("mainContainer");
        c.innerHTML = "";
        const m = document.createElement("div");
        m.style.textAlign = "center";
        m.style.color = "red";
        m.style.fontSize = "1.5em";
        m.style.margin = "20px 0";
        m.innerText = "現在は曲を募集していません";
        c.appendChild(m);
        if (data.reason) {
          const r = document.createElement("div");
          r.style.textAlign = "center";
          r.style.color = "black";
          r.style.fontSize = "1.2em";
          r.style.margin = "10px 0";
          r.innerText = data.reason;
          c.appendChild(r);
        }
      }
    })
    .catch(console.error);
}

// タイトル更新
function updateFrontendTitle() {
  fetch("/settings")
    .then(r => r.json())
    .then(data => {
      if (data.frontendTitle) {
        document.getElementById("frontendTitle").innerText = data.frontendTitle;
      }
    })
    .catch(console.error);
}

// 検索モード切替
function setSearchMode(mode) {
  searchMode = mode;
  artistPhase = 0;
  selectedArtistId = null;
  document.getElementById("songName").value = "";
  document.getElementById("artistName").value = "";
  clearSuggestions();
  clearSelected();
  pausePreview(); isPlaying=false; updatePlayPauseIcon();

  // ボタンスタイル
  document.getElementById("modeSong").style.backgroundColor = mode==="song"?"#007bff":"";
  document.getElementById("modeSong").style.color = mode==="song"?"white":"";
  document.getElementById("modeArtist").style.backgroundColor = mode==="artist"?"#007bff":"";
  document.getElementById("modeArtist").style.color = mode==="artist"?"white":"";

  // 入力欄
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

// 再検索
function reSearch() {
  searchSongs();
}

// 曲／アーティスト検索
async function searchSongs() {
  clearSuggestions();
  showLoading();
  const container = document.getElementById("suggestions");

  if (searchMode==="artist") {
    if (artistPhase===0) {
      const q = document.getElementById("songName").value.trim();
      if (!q) { hideLoading(); return; }
      const res = await fetch(`/search?mode=artist&query=${encodeURIComponent(q)}`);
      const list = await res.json();
      list.forEach(a => {
        const d = document.createElement("div");
        d.className = "suggestion-item";
        d.innerHTML = `<img src="${a.artworkUrl}"><div><strong>${a.trackName}</strong></div>`;
        d.onclick = () => selectArtist(a);
        container.appendChild(d);
      });
    } else {
      const res = await fetch(`/search?mode=artist&artistId=${encodeURIComponent(selectedArtistId)}`);
      const list = await res.json();
      list.forEach(s => {
        const d = document.createElement("div");
        d.className = "suggestion-item";
        d.innerHTML = `<img src="${s.artworkUrl}"><div><strong>${s.trackName}</strong><br><small>${s.artistName}</small></div>`;
        d.onclick = () => selectSong(s);
        container.appendChild(d);
      });
    }
  } else {
    const song = document.getElementById("songName").value.trim();
    const artist = document.getElementById("artistName").value.trim();
    if (!song) { hideLoading(); return; }
    const res = await fetch(`/search?query=${encodeURIComponent(song)}&artist=${encodeURIComponent(artist)}`);
    const list = await res.json();
    list.forEach(s => {
      const d = document.createElement("div");
      d.className = "suggestion-item";
      d.innerHTML = `<img src="${s.artworkUrl}"><div><strong>${s.trackName}</strong><br><small>${s.artistName}</small></div>`;
      d.onclick = () => selectSong(s);
      container.appendChild(d);
    });
  }
  hideLoading();
}

// アーティスト選択
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
  clearSuggestions();
  searchSongs();
}

// 曲選択
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
        <button class="clear-btn" onclick="clearSelection()">×</button>
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

// 音量変更
function changeVolume(v) {
  if (!previewAudio) return;
  if (isMuted) { isMuted=false; mutePreview(false); }
  setPreviewVolume(v);
  updateVolumeIcon();
}

// 再生／一時停止
function togglePlay(e) {
  e.stopPropagation();
  if (!previewAudio) return;
  if (isPlaying) pausePreview();
  else {
    if (audioContext && audioContext.state==="suspended") audioContext.resume();
    previewAudio.play().catch(console.error);
  }
  isPlaying = !isPlaying; updatePlayPauseIcon();
}

// ミュート切替
function toggleMute(e) {
  e.stopPropagation();
  if (!previewAudio) return;
  isMuted = !isMuted;
  mutePreview(isMuted);
  updateVolumeIcon();
}

// アイコン更新
function updatePlayPauseIcon() {
  const btn = document.getElementById("playPauseBtn");
  if (!btn) return;
  btn.textContent = isPlaying ? '⏸' : '▶️';
}
function updateVolumeIcon() {
  const btn = document.getElementById("volumeBtn");
  if (!btn || !previewAudio) return;
  let vol = gainNode?gainNode.gain.value:previewAudio.volume;
  let icon = '🔇';
  if (!isMuted && vol>0.01) {
    icon = vol<0.35 ? '🔈' : vol<0.65 ? '🔉' : '🔊';
  }
  btn.textContent = icon;
}

// クリア処理
function clearSelection() {
  clearArtistSelection();
}
function clearArtistSelection() {
  artistPhase=0; selectedArtistId=null;
  clearSelected();
  pausePreview(); isPlaying=false; updatePlayPauseIcon();
  clearSuggestions();
  searchSongs();
}
function clearSelected() {
  document.getElementById("selectedLabel").innerHTML="";
  document.getElementById("selectedSong").innerHTML="";
  document.getElementById("selectedArtist").innerHTML="";
}
function clearSuggestions() {
  document.getElementById("suggestions").innerHTML="";
}

// フォーム送信
function handleSubmit(e) {
  e.preventDefault();
  if (!document.getElementById("appleMusicUrlHidden").value) {
    alert("必ず候補一覧から曲を選択してください");
    return;
  }
  e.target.submit();
}

// 再検索呼び出し
function reSearch() {
  searchSongs();
}

// 入力クリア
function clearInput(id) {
  document.getElementById(id).value="";
  searchSongs();
}

// 管理者ログイン
function showAdminLogin() {
  const pwd = prompt("⚠️管理者パスワードを入力してください:");
  if (!pwd) return;
  fetch(`/admin-login?password=${encodeURIComponent(pwd)}`)
    .then(r=>r.json())
    .then(d=>{ if(d.success) location.href="/admin"; else alert("パスワードが違います"); })
    .catch(console.error);
}

// --- プレビュー制御（preview.js から移動） ---
function initPreview() {
  if (!previewAudio) {
    previewAudio = document.createElement("audio");
    previewAudio.style.display="none";
    previewAudio.muted = true;
    document.body.appendChild(previewAudio);
    if (window.AudioContext||window.webkitAudioContext) {
      audioContext = new (window.AudioContext||window.webkitAudioContext)();
      const src = audioContext.createMediaElementSource(previewAudio);
      gainNode = audioContext.createGain();
      src.connect(gainNode).connect(audioContext.destination);
    }
  }
}
function playPreview(url) {
  initPreview();
  previewAudio.src = url;
  previewAudio.load();
  previewAudio.onloadedmetadata = () => {
    previewAudio.currentTime = previewAudio.duration>15?15:0;
    previewAudio.play().then(()=> previewAudio.muted=false).catch(console.error);
  };
  previewAudio.loop = true;
}
function pausePreview() {
  previewAudio?.pause();
}
function mutePreview(flag) {
  previewAudio.muted = flag;
}
function setPreviewVolume(pct) {
  const v = pct/100;
  if (gainNode) gainNode.gain.value=v;
  else previewAudio.volume=v;
}

// ローディング表示
function showLoading() {
  document.getElementById("loadingIndicator").style.display="flex";
}
function hideLoading() {
  document.getElementById("loadingIndicator").style.display="none";
}
