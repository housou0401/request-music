/** skript.js 
 *  ユーザーページ & 管理者ページで共通利用する単一ファイル
 */

// ===== ユーザーページ用 変数 =====
let searchMode = "song";
let artistPhase = 0;
let selectedArtistId = null;
let previewAudio = null;
let isPlaying = false;
let isMuted = false;
let playerControlsEnabled = true;

// ===== 管理者ページ用 変数 =====
let adminAudioMap = {};        // { [id]: HTMLAudioElement }
let adminIsPlayingMap = {};    // { [id]: boolean }
let adminIsMutedMap = {};      // { [id]: boolean }
let adminFadeIntervalMap = {}; // { [id]: setIntervalId }

// ========== ユーザーページの関数 ==========

// 初期設定をロード
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

// 検索モードを切り替え (曲名 or アーティスト)
function setSearchMode(mode) {
  searchMode = mode;
  artistPhase = 0;
  selectedArtistId = null;
  document.getElementById("songName").value = "";
  if (document.getElementById("artistName")) {
    document.getElementById("artistName").value = "";
  }
  const sugg = document.getElementById("suggestions");
  if (sugg) sugg.innerHTML = "";
  const lab = document.getElementById("selectedLabel");
  if (lab) lab.innerHTML = "";
  const so = document.getElementById("selectedSong");
  if (so) so.innerHTML = "";
  const sa = document.getElementById("selectedArtist");
  if (sa) sa.innerHTML = "";

  if (previewAudio) {
    previewAudio.pause();
    previewAudio.currentTime = 0;
    isPlaying = false;
    updatePlayPauseIcon();
  }
  if (mode === "artist") {
    if (document.getElementById("artistInputContainer")) {
      document.getElementById("artistInputContainer").style.display = "none";
    }
    if (document.getElementById("songName")) {
      document.getElementById("songName").placeholder = "アーティスト名を入力してください";
    }
    if (document.getElementById("modeArtist")) {
      document.getElementById("modeArtist").style.backgroundColor = "#007bff";
      document.getElementById("modeArtist").style.color = "white";
    }
    if (document.getElementById("modeSong")) {
      document.getElementById("modeSong").style.backgroundColor = "";
      document.getElementById("modeSong").style.color = "";
    }
  } else {
    if (document.getElementById("artistInputContainer")) {
      document.getElementById("artistInputContainer").style.display = "block";
    }
    if (document.getElementById("songName")) {
      document.getElementById("songName").placeholder = "曲名を入力してください";
    }
    if (document.getElementById("modeSong")) {
      document.getElementById("modeSong").style.backgroundColor = "#007bff";
      document.getElementById("modeSong").style.color = "white";
    }
    if (document.getElementById("modeArtist")) {
      document.getElementById("modeArtist").style.backgroundColor = "";
      document.getElementById("modeArtist").style.color = "";
    }
  }
}

// ユーザーページ: 検索
async function searchSongs() {
  const suggestionsContainer = document.getElementById("suggestions");
  if (!suggestionsContainer) return;
  suggestionsContainer.innerHTML = "";

  if (searchMode === "artist") {
    // アーティスト検索モード
    if (artistPhase === 0) {
      const artistQuery = (document.getElementById("songName")?.value || "").trim();
      if (artistQuery.length < 2) return;
      try {
        const response = await fetch("/search?mode=artist&query=" + encodeURIComponent(artistQuery));
        const suggestions = await response.json();
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
    } else if (artistPhase === 1 && selectedArtistId) {
      await fetchArtistTracksAndShow();
    }
  } else {
    // 曲検索モード
    const songQuery = (document.getElementById("songName")?.value || "").trim();
    const artistQuery = (document.getElementById("artistName")?.value || "").trim();
    if (songQuery.length < 2) return;
    try {
      const response = await fetch("/search?query=" + encodeURIComponent(songQuery) + "&artist=" + encodeURIComponent(artistQuery));
      const suggestions = await response.json();
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
}

function selectArtist(artist) {
  selectedArtistId = artist.artistId;
  artistPhase = 1;
  const sa = document.getElementById("selectedArtist");
  if (sa) {
    sa.innerHTML = `
      <div class="selected-label">選択中のアーティスト</div>
      <div class="selected-item" style="display:flex; align-items:center; justify-content:space-between; margin-top:10px;">
        <div style="display:flex; align-items:center;">
          <img src="${artist.artworkUrl}" alt="Artist Icon" style="width:50px; height:50px; border-radius:5px; margin-right:10px;">
          <div><strong>${artist.trackName}</strong></div>
        </div>
        <button type="button" class="clear-btn" onclick="clearArtistSelection()">×</button>
      </div>
    `;
  }
  const sugg = document.getElementById("suggestions");
  if (sugg) sugg.innerHTML = "";
  fetchArtistTracksAndShow();
}

async function fetchArtistTracksAndShow() {
  const suggestionsContainer = document.getElementById("suggestions");
  if (!suggestionsContainer) return;
  suggestionsContainer.innerHTML = "";
  try {
    const res = await fetch("/search?mode=artist&artistId=" + encodeURIComponent(selectedArtistId));
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
  if (document.getElementById("songName")) {
    document.getElementById("songName").value = song.trackName;
  }
  if (searchMode === "song" && document.getElementById("artistName") && !document.getElementById("artistName").value.trim()) {
    document.getElementById("artistName").value = song.artistName;
  }
  const lab = document.getElementById("selectedLabel");
  if (lab) {
    lab.innerHTML = `<div class="selected-label">選択中の曲</div>`;
  }
  const container = document.getElementById("selectedSong");
  if (!container) return;

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
        ${
          playerControlsEnabled
            ? `
          <button type="button" class="control-btn" id="playPauseBtn" onclick="togglePlay(event)">▶</button>
          <button type="button" class="control-btn" id="muteBtn" onclick="toggleMute(event)">🔈</button>
          <input type="range" min="0" max="100" value="50" class="volume-slider" id="volumeSlider" oninput="changeVolume(this.value)">
        `
            : ""
        }
        <button type="button" class="clear-btn" onclick="clearSelection()" style="margin-left:10px;">×</button>
      </div>
    </div>
  `;

  // 隠しフィールドに反映
  let hiddenAppleUrl = document.getElementById("appleMusicUrlHidden");
  if (!hiddenAppleUrl) {
    hiddenAppleUrl = document.createElement("input");
    hiddenAppleUrl.type = "hidden";
    hiddenAppleUrl.id = "appleMusicUrlHidden";
    hiddenAppleUrl.name = "appleMusicUrl";
    document.getElementById("requestForm").appendChild(hiddenAppleUrl);
  }
  hiddenAppleUrl.value = song.previewUrl || "";

  let hiddenArtwork = document.getElementById("artworkUrlHidden");
  if (!hiddenArtwork) {
    hiddenArtwork = document.createElement("input");
    hiddenArtwork.type = "hidden";
    hiddenArtwork.id = "artworkUrlHidden";
    hiddenArtwork.name = "artworkUrl";
    document.getElementById("requestForm").appendChild(hiddenArtwork);
  }
  hiddenArtwork.value = song.artworkUrl || "";

  // プレビュー再生
  if (playerControlsEnabled && song.previewUrl) {
    if (!previewAudio) {
      previewAudio = document.createElement("audio");
      previewAudio.id = "previewAudio";
      previewAudio.style.display = "none";
      document.body.appendChild(previewAudio);
    }
    previewAudio.src = song.previewUrl;
    previewAudio.volume = 0;
    previewAudio.currentTime = 10;
    previewAudio.loop = false;
    previewAudio.play();
    isPlaying = true;
    isMuted = false;
    fadeInUserAudio(750, 0.5);
    updatePlayPauseIcon();
    updateMuteIcon();

    // 曲終了時のループ再生 (フェードアウト→巻き戻し→フェードイン)
    if (!previewAudio.hasEndedListener) {
      previewAudio.hasEndedListener = true;
      previewAudio.addEventListener("ended", () => {
        fadeOutUserAudio(500, () => {
          if (!previewAudio) return;
          previewAudio.currentTime = 10;
          previewAudio.play();
          isPlaying = true;
          fadeInUserAudio(500, 0.5);
          updatePlayPauseIcon();
        });
      });
    }
  }
}

// フェードイン／フェードアウト
function fadeInUserAudio(duration, finalVolume) {
  if (!previewAudio) return;
  const steps = 30;
  const stepTime = duration / steps;
  let currentStep = 0;
  const stepVol = finalVolume / steps;
  const interval = setInterval(() => {
    currentStep++;
    let newVol = stepVol * currentStep;
    if (newVol >= finalVolume) {
      newVol = finalVolume;
      clearInterval(interval);
    }
    previewAudio.volume = newVol;
  }, stepTime);
}
function fadeOutUserAudio(duration, onDone) {
  if (!previewAudio) {
    if (onDone) onDone();
    return;
  }
  const steps = 10;
  const stepTime = duration / steps;
  let currentStep = 0;
  const initialVolume = previewAudio.volume;
  const stepVol = initialVolume / steps;
  const interval = setInterval(() => {
    currentStep++;
    let newVol = initialVolume - stepVol * currentStep;
    if (newVol <= 0) {
      newVol = 0;
      clearInterval(interval);
      previewAudio.pause();
      isPlaying = false;
      updatePlayPauseIcon();
      if (onDone) onDone();
    }
    previewAudio.volume = newVol;
  }, stepTime);
}

function togglePlay(e) {
  e.stopPropagation();
  if (!previewAudio) return;
  if (isPlaying) {
    fadeOutUserAudio(200);
  } else {
    previewAudio.play();
    isPlaying = true;
    fadeInUserAudio(750, 0.5);
  }
  updatePlayPauseIcon();
}
function updatePlayPauseIcon() {
  const btn = document.getElementById("playPauseBtn");
  if (!btn) return;
  if (isPlaying) {
    btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20"><rect x="4" y="3" width="4" height="14" fill="#888"/><rect x="12" y="3" width="4" height="14" fill="#888"/></svg>';
  } else {
    btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20"><polygon points="5,3 17,10 5,17" fill="#888"/></svg>';
  }
}
function toggleMute(e) {
  e.stopPropagation();
  if (!previewAudio) return;
  if (previewAudio.volume === 0 || isMuted) {
    const slider = document.getElementById("volumeSlider");
    let vol = slider ? parseInt(slider.value, 10) / 100 : 0.5;
    previewAudio.volume = vol;
    isMuted = false;
    previewAudio.muted = false;
  } else {
    isMuted = true;
    previewAudio.muted = true;
  }
  updateMuteIcon();
}
function updateMuteIcon() {
  const btn = document.getElementById("muteBtn");
  if (!btn) return;
  let vol = previewAudio ? previewAudio.volume : 0;
  let svg;
  if (vol < 0.01 || isMuted) {
    svg = '<svg width="20" height="20" viewBox="0 0 20 20"><polygon points="3,7 7,7 12,3 12,17 7,13 3,13" fill="#888"/><line x1="14" y1="6" x2="18" y2="14" stroke="#888" stroke-width="2"/><line x1="18" y1="6" x2="14" y2="14" stroke="#888" stroke-width="2"/></svg>';
  } else if (vol < 0.31) {
    svg = '<svg width="20" height="20" viewBox="0 0 20 20"><polygon points="3,7 7,7 12,3 12,17 7,13 3,13" fill="#888"/></svg>';
  } else if (vol < 0.61) {
    svg = '<svg width="20" height="20" viewBox="0 0 20 20"><polygon points="3,7 7,7 12,3 12,17 7,13 3,13" fill="#888"/><path d="M14 6 C16 8,16 12,14 14" stroke="#888" stroke-width="2" fill="none"/></svg>';
  } else {
    svg = '<svg width="20" height="20" viewBox="0 0 20 20"><polygon points="3,7 7,7 12,3 12,17 7,13 3,13" fill="#888"/><path d="M14 6 C16 8,16 12,14 14" stroke="#888" stroke-width="2" fill="none"/><path d="M16 4 C19 7,19 13,16 16" stroke="#888" stroke-width="2" fill="none"/></svg>';
  }
  btn.innerHTML = svg;
}
function changeVolume(val) {
  if (!previewAudio) return;
  let volume = parseInt(val, 10) / 100;
  previewAudio.volume = volume;
  if (volume > 0 && isMuted) {
    isMuted = false;
    previewAudio.muted = false;
  }
  updateMuteIcon();
}
function clearSelection() {
  fadeOutUserAudio(200, () => {
    if (document.getElementById("selectedLabel")) {
      document.getElementById("selectedLabel").innerHTML = "";
    }
    if (document.getElementById("selectedSong")) {
      document.getElementById("selectedSong").innerHTML = "";
    }
    if (document.getElementById("appleMusicUrlHidden")) {
      document.getElementById("appleMusicUrlHidden").value = "";
    }
    if (document.getElementById("artworkUrlHidden")) {
      document.getElementById("artworkUrlHidden").value = "";
    }
    if (document.getElementById("previewUrlHidden")) {
      document.getElementById("previewUrlHidden").value = "";
    }
    clearArtistSelection();
    searchSongs();
  });
}
function clearArtistSelection() {
  selectedArtistId = null;
  artistPhase = 0;
  if (document.getElementById("selectedArtist")) {
    document.getElementById("selectedArtist").innerHTML = "";
  }
  if (document.getElementById("selectedLabel")) {
    document.getElementById("selectedLabel").innerHTML = "";
  }
  if (document.getElementById("selectedSong")) {
    document.getElementById("selectedSong").innerHTML = "";
  }
  if (previewAudio) fadeOutUserAudio(200);
  if (document.getElementById("suggestions")) {
    document.getElementById("suggestions").innerHTML = "";
  }
  searchSongs();
}
function clearInput(id) {
  const el = document.getElementById(id);
  if (el) el.value = "";
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
    fetch("/admin-login?password=" + encodeURIComponent(password))
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          window.location.href = "/admin";
        } else {
          alert("⚠️パスワードが間違っています。");
        }
      })
      .catch(err => console.error("管理者ログインエラー:", err));
  }
}

// ========== 管理者ページの関数 ==========

function initAdminPage() {
  console.log("initAdminPage: hooking up admin page events");
  document.querySelectorAll(".entry").forEach(entry => {
    const id = entry.dataset.id;
    const previewUrl = entry.dataset.previewurl || "";
    const playBtn = entry.querySelector('[data-action="adminTogglePlay"]');
    const muteBtn = entry.querySelector('[data-action="adminToggleMute"]');
    const volSlider = entry.querySelector('.volume-slider');

    if (playBtn) {
      playBtn.onclick = () => adminTogglePlay(id);
    }
    if (muteBtn) {
      muteBtn.onclick = () => adminToggleMute(id);
    }
    if (volSlider) {
      volSlider.oninput = () => adminChangeVolume(id, volSlider.value);
    }
  });
}

/** フェードイン／アウト＋ループ再生(終了時) **/
function addAdminEndedListener(id, audio) {
  if (audio.hasEndedListener) return;
  audio.hasEndedListener = true;
  audio.addEventListener("ended", () => {
    // 終了時にフェードアウト→巻き戻し→フェードイン
    fadeOutAdminAudio(id, 500, () => {
      audio.currentTime = 10;
      audio.play();
      adminIsPlayingMap[id] = true;
      fadeInAdminAudio(id, 0.5, 500);
      updateAdminPlayIcon(id);
    });
  });
}

function adminTogglePlay(id) {
  console.log("adminTogglePlay => id=", id);
  if (!adminAudioMap[id]) {
    // 初回再生 => Audio生成
    const entry = document.querySelector(`.entry[data-id="${id}"]`);
    if (!entry) return;
    const previewUrl = entry.dataset.previewurl || "";
    if (!previewUrl) return;
    const audio = new Audio(previewUrl);
    audio.volume = 0;
    audio.currentTime = 10;
    adminAudioMap[id] = audio;
    adminIsPlayingMap[id] = false;
    adminIsMutedMap[id] = false;
    addAdminEndedListener(id, audio);
  }
  if (adminIsPlayingMap[id]) {
    // 再生中 => 停止
    fadeOutAdminAudio(id, 200);
  } else {
    // 停止中 => 再生
    adminAudioMap[id].muted = false;
    adminIsMutedMap[id] = false;
    adminAudioMap[id].play();
    adminIsPlayingMap[id] = true;
    fadeInAdminAudio(id, 0.5, 750);
  }
  updateAdminPlayIcon(id);
  updateAdminMuteIcon(id);
}

function fadeInAdminAudio(id, finalVolume, duration) {
  const audio = adminAudioMap[id];
  if (!audio) return;
  const steps = 30;
  const stepTime = duration / steps;
  let currentStep = 0;
  const stepVol = finalVolume / steps;
  clearInterval(adminFadeIntervalMap[id]);
  adminFadeIntervalMap[id] = setInterval(() => {
    currentStep++;
    let newVol = stepVol * currentStep;
    if (newVol >= finalVolume) {
      newVol = finalVolume;
      clearInterval(adminFadeIntervalMap[id]);
      adminFadeIntervalMap[id] = null;
    }
    audio.volume = newVol;
  }, stepTime);
}

function fadeOutAdminAudio(id, duration, onDone) {
  const audio = adminAudioMap[id];
  if (!audio) {
    if (onDone) onDone();
    return;
  }
  const steps = 10;
  const stepTime = duration / steps;
  let currentStep = 0;
  const initialVolume = audio.volume;
  const stepVol = initialVolume / steps;
  const interval = setInterval(() => {
    currentStep++;
    let newVol = initialVolume - stepVol * currentStep;
    if (newVol <= 0) {
      newVol = 0;
      clearInterval(interval);
      audio.pause();
      adminIsPlayingMap[id] = false;
      updateAdminPlayIcon(id);
      if (onDone) onDone();
    }
    audio.volume = newVol;
  }, stepTime);
}

function updateAdminPlayIcon(id) {
  const btn = document.querySelector(`.entry[data-id="${id}"] [data-action="adminTogglePlay"]`);
  if (!btn) return;
  if (adminIsPlayingMap[id]) {
    btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20"><rect x="4" y="3" width="4" height="14" fill="#888"/><rect x="12" y="3" width="4" height="14" fill="#888"/></svg>';
  } else {
    btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20"><polygon points="5,3 17,10 5,17" fill="#888"/></svg>';
  }
}

function adminToggleMute(id) {
  const audio = adminAudioMap[id];
  if (!audio) return;
  adminIsMutedMap[id] = !adminIsMutedMap[id];
  audio.muted = adminIsMutedMap[id];
  updateAdminMuteIcon(id);
}

function updateAdminMuteIcon(id) {
  const audio = adminAudioMap[id];
  if (!audio) return;
  const btn = document.querySelector(`.entry[data-id="${id}"] [data-action="adminToggleMute"]`);
  if (!btn) return;
  let vol = audio.volume;
  let svg;
  if (vol < 0.01 || adminIsMutedMap[id]) {
    svg = '<svg width="20" height="20" viewBox="0 0 20 20"><polygon points="3,7 7,7 12,3 12,17 7,13 3,13" fill="#888"/><line x1="14" y1="6" x2="18" y2="14" stroke="#888" stroke-width="2"/><line x1="18" y1="6" x2="14" y2="14" stroke="#888" stroke-width="2"/></svg>';
  } else if (vol < 0.31) {
    svg = '<svg width="20" height="20" viewBox="0 0 20 20"><polygon points="3,7 7,7 12,3 12,17 7,13 3,13" fill="#888"/></svg>';
  } else if (vol < 0.61) {
    svg = '<svg width="20" height="20" viewBox="0 0 20 20"><polygon points="3,7 7,7 12,3 12,17 7,13 3,13" fill="#888"/><path d="M14 6 C16 8,16 12,14 14" stroke="#888" stroke-width="2" fill="none"/></svg>';
  } else {
    svg = '<svg width="20" height="20" viewBox="0 0 20 20"><polygon points="3,7 7,7 12,3 12,17 7,13 3,13" fill="#888"/><path d="M14 6 C16 8,16 12,14 14" stroke="#888" stroke-width="2" fill="none"/><path d="M16 4 C19 7,19 13,16 16" stroke="#888" stroke-width="2" fill="none"/></svg>';
  }
  btn.innerHTML = svg;
}

function adminChangeVolume(id, val) {
  const audio = adminAudioMap[id];
  if (!audio) return;
  const volume = parseInt(val, 10) / 100;
  audio.volume = volume;
  if (volume > 0 && adminIsMutedMap[id]) {
    audio.muted = false;
    adminIsMutedMap[id] = false;
  }
  updateAdminMuteIcon(id);
}
