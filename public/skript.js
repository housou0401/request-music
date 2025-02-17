/** skript.js
 *  ユーザーページ & 管理者ページ用の単一スクリプト
 */

// --- ユーザーページの変数・関数 ---
let searchMode = "song";
let artistPhase = 0;
let selectedArtistId = null;
let previewAudio = null;
let isPlaying = false;
let isMuted = false;
let playerControlsEnabled = true;

// --- 管理者ページの変数・関数 ---
let adminAudioMap = {};       // { [id]: HTMLAudioElement }
let adminIsPlayingMap = {};   // { [id]: boolean }
let adminIsMutedMap = {};     // { [id]: boolean }
let adminFadeIntervalMap = {}; // { [id]: setIntervalId }

/** initUserPage: (必要なら) ユーザーページの初期化 **/
function initUserPage() {
  // 必要に応じて、ユーザーページに特有の初期化を行う
}

/** initAdminPage: 管理者ページの初期化 **/
function initAdminPage() {
  // ページ内のエントリーを走査し、再生ボタンなどにイベントを付与する
  // ただし server.js のHTML側で onclick=... を指定しているため、こちらでは特に処理不要でもOK
  // もし動的にイベントを付けたい場合は以下のようにする:
  document.querySelectorAll(".entry").forEach(entry => {
    const id = entry.dataset.id;
    const previewUrl = entry.dataset.previewurl || "";
    // すでに onclick がHTMLにある場合は不要
    // ここで ended リスナーを付与するなら:
    // adminAudioMap[id] は再生開始時に生成されるため、ここでは付与しづらい。
    // -> adminTogglePlay() 内で audio を生成後に ended リスナーを追加する
  });
}

/** Apple Music ユーザーページ - 検索切り替え **/
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

// --- ユーザーページ：検索関連ロジック ---
// (従来通り index.html 側で oninput="searchSongs()" を呼び出すなど)

// --- ユーザーページ：曲選択時の再生関連 ---
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

function fadeOutUserAudio(duration, onFadeComplete) {
  if (!previewAudio) {
    if (onFadeComplete) onFadeComplete();
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
      if (onFadeComplete) onFadeComplete();
    }
    previewAudio.volume = newVol;
  }, stepTime);
}

// ended イベントでのループ：曲が終わったらフェードアウト→巻き戻し→フェードイン
function onUserAudioEnded() {
  fadeOutUserAudio(500, () => {
    if (!previewAudio) return;
    previewAudio.currentTime = 10; // プレビューを途中から再生
    previewAudio.play();
    isPlaying = true;
    fadeInUserAudio(500, 0.5);
    updatePlayPauseIcon();
  });
}

// --- ユーザーページ：再生ボタンなど ---
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
    // ミュート解除
    const slider = document.getElementById("volumeSlider");
    let vol = slider ? parseInt(slider.value, 10) / 100 : 0.5;
    previewAudio.volume = vol;
    isMuted = false;
    previewAudio.muted = false;
  } else {
    // ミュート
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

/** 選択解除 **/
function clearSelection() {
  fadeOutUserAudio(200, () => {
    const label = document.getElementById("selectedLabel");
    if (label) label.innerHTML = "";
    const songDiv = document.getElementById("selectedSong");
    if (songDiv) songDiv.innerHTML = "";
    const apple = document.getElementById("appleMusicUrlHidden");
    if (apple) apple.value = "";
    const art = document.getElementById("artworkUrlHidden");
    if (art) art.value = "";
    const pre = document.getElementById("previewUrlHidden");
    if (pre) pre.value = "";
    clearArtistSelection();
    // 再検索
    searchSongs();
  });
}

function clearArtistSelection() {
  selectedArtistId = null;
  artistPhase = 0;
  const artDiv = document.getElementById("selectedArtist");
  if (artDiv) artDiv.innerHTML = "";
  const lab = document.getElementById("selectedLabel");
  if (lab) lab.innerHTML = "";
  const sDiv = document.getElementById("selectedSong");
  if (sDiv) sDiv.innerHTML = "";
  if (previewAudio) fadeOutUserAudio(200);
  const sugg = document.getElementById("suggestions");
  if (sugg) sugg.innerHTML = "";
  searchSongs();
}

function clearInput(id) {
  const el = document.getElementById(id);
  if (el) el.value = "";
  searchSongs();
}

/** フォーム送信 **/
function handleSubmit(e) {
  e.preventDefault();
  const appleUrl = document.getElementById("appleMusicUrlHidden")?.value.trim();
  if (!appleUrl) {
    alert("必ず候補一覧から曲を選択してください");
    return;
  }
  document.getElementById("requestForm").submit();
}

/** 管理者ログイン **/
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

/** ========== 管理者ページ用ロジック ========== **/

function initAdminPage() {
  // 管理者ページ読み込み後に呼ばれる想定
  // .entry の中の data-previewurl, data-id を読み取り、各ボタンにイベントを紐付ける
  document.querySelectorAll(".entry").forEach(entry => {
    const id = entry.dataset.id;
    const previewUrl = entry.dataset.previewurl || "";

    // Audio は adminTogglePlay() を押したときに生成
    // ここで ended リスナーを付けるには、Audio 生成後が良いので adminTogglePlay() 内で付与
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

// フェードイン／フェードアウトでループ再生
function addAdminEndedListener(id, audio) {
  if (audio.hasEndedListener) return;
  audio.hasEndedListener = true;
  audio.addEventListener("ended", () => {
    // 曲が終わったのでフェードアウト→巻き戻し→フェードイン
    fadeOutAdminAudio(id, 500, () => {
      audio.currentTime = 10; // 途中から
      audio.play();
      adminIsPlayingMap[id] = true;
      fadeInAdminAudio(id, 0.5, 500);
      updateAdminPlayIcon(id);
    });
  });
}

function adminTogglePlay(id) {
  if (!adminAudioMap[id]) {
    // Audio未生成 => 新規生成
    const entry = document.querySelector(`.entry[data-id="${id}"]`);
    if (!entry) return;
    const previewUrl = entry.dataset.previewurl;
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
    // pause icon
    btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20"><rect x="4" y="3" width="4" height="14" fill="#888"/><rect x="12" y="3" width="4" height="14" fill="#888"/></svg>';
  } else {
    // play icon
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
