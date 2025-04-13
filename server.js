// public/skript.js

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
          item.innerHTML = `<strong>${artist.trackName}</strong>`;
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
        item.innerHTML = `<strong>${song.trackName}</strong><br>${song.artistName}`;
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
    <div>選択中のアーティスト</div>
    <div>${artist.trackName}</div>
    <button onclick="clearArtistSelection()">×</button>
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
      item.innerHTML = `<strong>${song.trackName}</strong><br>${song.artistName}`;
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
  document.getElementById("selectedLabel").innerHTML = `<div>選択中の曲</div>`;
  const container = document.getElementById("selectedSong");
  container.innerHTML = `
    <div>${song.trackName}</div>
    <div>${song.artistName}</div>
    <button onclick="clearSelection()">×</button>
  `;

  // hidden fields
  let hiddenApple = document.getElementById("appleMusicUrlHidden") || document.createElement("input");
  if (!hiddenApple.id) {
    hiddenApple.type = "hidden"; hiddenApple.id = "appleMusicUrlHidden"; hiddenApple.name = "appleMusicUrl";
    document.getElementById("requestForm").appendChild(hiddenApple);
  }
  hiddenApple.value = song.trackViewUrl;

  let hiddenArtwork = document.getElementById("artworkUrlHidden") || document.createElement("input");
  if (!hiddenArtwork.id) {
    hiddenArtwork.type = "hidden"; hiddenArtwork.id = "artworkUrlHidden"; hiddenArtwork.name = "artworkUrl";
    document.getElementById("requestForm").appendChild(hiddenArtwork);
  }
  hiddenArtwork.value = song.artworkUrl;

  let hiddenPreview = document.getElementById("previewUrlHidden") || document.createElement("input");
  if (!hiddenPreview.id) {
    hiddenPreview.type = "hidden"; hiddenPreview.id = "previewUrlHidden"; hiddenPreview.name = "previewUrl";
    document.getElementById("requestForm").appendChild(hiddenPreview);
  }
  hiddenPreview.value = song.previewUrl;

  // プレビュー再生
  if (playerControlsEnabled && song.previewUrl) {
    if (!previewAudio) {
      previewAudio = document.createElement("audio");
      previewAudio.id = "previewAudio";
      // 動作確認用にネイティブコントロールを有効化
      previewAudio.controls = true;
      previewAudio.style.display = "block";
      document.body.appendChild(previewAudio);

      if (!window.AudioContext && !window.webkitAudioContext) {
        console.warn("Web Audio API がサポートされていません");
      } else {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
    }

    previewAudio.src = song.previewUrl;
    previewAudio.loop = true;

    // 音量制御用ノードの初期化
    if (audioContext && !gainNode) {
      const source = audioContext.createMediaElementSource(previewAudio);
      gainNode = audioContext.createGain();
      source.connect(gainNode);
      gainNode.connect(audioContext.destination);
    }

    // デフォルト音量
    if (audioContext && gainNode) {
      gainNode.gain.value = 0.5;
    } else {
      previewAudio.volume = 0.5;
    }

    // ユーザー操作と同一のハンドラ内で再生を呼び出す
    previewAudio.play().catch(err => {
      console.error("Playback error:", err);
      alert("プレビューの再生がブラウザの制限によりブロックされました。画面上の再生ボタンを押してください。");
    });

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
    svg = `<svg><!-- ミュートアイコン --></svg>`;
  } else if (vol < 0.35) {
    svg = `<svg><!-- 低音量アイコン --></svg>`;
  } else if (vol < 0.65) {
    svg = `<svg><!-- 中音量アイコン --></svg>`;
  } else {
    svg = `<svg><!-- 高音量アイコン --></svg>`;
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
    previewAudio.play().catch(err => {
      console.error("Playback error:", err);
      alert("再生できませんでした。");
    });
    isPlaying = true;
  }
  updatePlayPauseIcon();
}

function updatePlayPauseIcon() {
  const btn = document.getElementById("playPauseBtn");
  if (!btn) return;
  let svg = "";
  if (isPlaying) {
    svg = `<svg><!-- 一時停止アイコン --></svg>`;
  } else {
    svg = `<svg><!-- 再生アイコン --></svg>`;
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
  if (document.getElementById("appleMusicUrlHidden")) document.getElementById("appleMusicUrlHidden").value = "";
  if (document.getElementById("artworkUrlHidden")) document.getElementById("artworkUrlHidden").value = "";
  if (document.getElementById("previewUrlHidden")) document.getElementById("previewUrlHidden").value = "";
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
