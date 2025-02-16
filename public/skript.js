let searchMode = "song"; 
let artistPhase = 0; 
let selectedArtistId = null;
let previewAudio = null;
let isPlaying = false;
let isMuted = false;
let playerControlsEnabled = true; // 管理者ページの設定を反映

// ページ初期化
window.onload = async function() {
  document.getElementById("modeSong").style.backgroundColor = "#007bff";
  document.getElementById("modeSong").style.color = "white";
  // 管理者設定を取得
  await loadSettings();
};

// 設定を読み込み、playerControlsEnabled が false の場合は再生・音量UIを非表示
async function loadSettings() {
  try {
    const res = await fetch("/settings");
    const data = await res.json();
    playerControlsEnabled = data.playerControlsEnabled !== false;
  } catch(e) {
    console.error("設定読み込みエラー:", e);
    playerControlsEnabled = true;
  }
}

function setSearchMode(mode) {
  searchMode = mode;
  artistPhase = 0;
  selectedArtistId = null;
  // 入力欄・候補をクリア
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
  }
  if (mode === "artist") {
    document.getElementById("artistInputContainer").style.display = "none";
    document.getElementById("songName").placeholder = "アーティスト名を入力してください";
    document.getElementById("modeArtist").style.backgroundColor = "#007bff";
    document.getElementById("modeArtist").style.color = "white";
    document.getElementById("modeSong").style.backgroundColor = "";
    document.getElementById("modeSong").style.color = "";
  } else {
    document.getElementById("artistInputContainer").style.display = "block";
    document.getElementById("songName").placeholder = "曲名を入力してください";
    document.getElementById("modeSong").style.backgroundColor = "#007bff";
    document.getElementById("modeSong").style.color = "white";
    document.getElementById("modeArtist").style.backgroundColor = "";
    document.getElementById("modeArtist").style.color = "";
  }
}

async function searchSongs() {
  document.getElementById("suggestions").innerHTML = "";
  if (searchMode === "artist") {
    if (artistPhase === 0) {
      const artistQuery = document.getElementById("songName").value.trim();
      if (artistQuery.length < 2) return;
      try {
        const response = await fetch(`/search?mode=artist&query=${encodeURIComponent(artistQuery)}`);
        const suggestions = await response.json();
        for (let artist of suggestions) {
          const item = document.createElement("div");
          item.classList.add("suggestion-item");
          item.innerHTML = `
            <img src="${artist.artworkUrl}" alt="Artist Icon" style="width:50px; height:50px; border-radius:5px; margin-right:10px;">
            <div><strong>${artist.trackName}</strong></div>
          `;
          item.onclick = () => selectArtist(artist);
          document.getElementById("suggestions").appendChild(item);
        }
      } catch(e) {
        console.error("アーティスト検索エラー:", e);
      }
    } else if (artistPhase === 1 && selectedArtistId) {
      await fetchArtistTracksAndShow();
    }
  } else {
    const songQuery = document.getElementById("songName").value.trim();
    const artistQuery = document.getElementById("artistName").value.trim();
    if (songQuery.length < 2) return;
    try {
      const response = await fetch(`/search?query=${encodeURIComponent(songQuery)}&artist=${encodeURIComponent(artistQuery)}`);
      const suggestions = await response.json();
      for (let song of suggestions) {
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
        document.getElementById("suggestions").appendChild(item);
      }
    } catch(e) {
      console.error("曲検索エラー:", e);
    }
  }
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
  document.getElementById("suggestions").innerHTML = "";
  try {
    const res = await fetch(`/search?mode=artist&artistId=${encodeURIComponent(selectedArtistId)}`);
    const tracks = await res.json();
    for (let song of tracks) {
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
      document.getElementById("suggestions").appendChild(item);
    }
  } catch(e) {
    console.error("アーティストの曲一覧取得エラー:", e);
  }
}

function selectSong(song) {
  document.getElementById("songName").value = song.trackName;
  if (searchMode === "song") {
    if (!document.getElementById("artistName").value.trim()) {
      document.getElementById("artistName").value = song.artistName;
    }
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
        ${
          // 再生・音量コントロールを表示するかどうか
          playerControlsEnabled ? `
            <button type="button" class="control-btn" id="playPauseBtn" onclick="togglePlay(event)">&#9658;</button>
            <button type="button" class="control-btn" id="muteBtn" onclick="toggleMute(event)">&#128266;</button>
            <input type="range" min="1" max="100" value="50" style="width:100px; margin-left:8px;" oninput="changeVolume(this.value)" id="volumeSlider">
          ` : ""
        }
        <button type="button" class="clear-btn" onclick="clearSelection()" style="margin-left:10px;">×</button>
      </div>
    </div>
  `;
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

  if (playerControlsEnabled && song.previewUrl) {
    if (!previewAudio) {
      previewAudio = document.createElement("audio");
      previewAudio.style.display = "none";
      document.body.appendChild(previewAudio);
    }
    previewAudio.src = song.previewUrl;
    previewAudio.volume = 0.5;
    previewAudio.currentTime = 10;
    previewAudio.loop = false;
    previewAudio.play();
    isPlaying = true;
    isMuted = false;
    updatePlayPauseIcon();
    updateMuteIcon();
  }
}

function togglePlay(e) {
  e.stopPropagation();
  if (!previewAudio) return;
  if (isPlaying) {
    previewAudio.pause();
    isPlaying = false;
  } else {
    previewAudio.play();
    isPlaying = true;
  }
  updatePlayPauseIcon();
}

function updatePlayPauseIcon() {
  const btn = document.getElementById("playPauseBtn");
  if (!btn) return;
  if (isPlaying) {
    btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20">
      <rect x="4" y="3" width="4" height="14" fill="#888"/>
      <rect x="12" y="3" width="4" height="14" fill="#888"/>
    </svg>`;
  } else {
    btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20">
      <polygon points="5,3 17,10 5,17" fill="#888"/>
    </svg>`;
  }
}

function toggleMute(e) {
  e.stopPropagation();
  if (!previewAudio) return;
  isMuted = !isMuted;
  previewAudio.muted = isMuted;
  updateMuteIcon();
}

function updateMuteIcon() {
  const btn = document.getElementById("muteBtn");
  if (!btn) return;
  if (isMuted) {
    btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20">
      <polygon points="3,7 7,7 12,3 12,17 7,13 3,13" fill="#888"/>
      <line x1="14" y1="6" x2="18" y2="14" stroke="#888" stroke-width="2"/>
      <line x1="18" y1="6" x2="14" y2="14" stroke="#888" stroke-width="2"/>
    </svg>`;
  } else {
    btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20">
      <polygon points="3,7 7,7 12,3 12,17 7,13 3,13" fill="#888"/>
      <path d="M14 6 L16 10 L14 14" stroke="#888" stroke-width="2" fill="none"/>
    </svg>`;
  }
}

// 音量スライダー
function changeVolume(val) {
  if (!previewAudio) return;
  let volume = parseInt(val, 10) / 100;
  previewAudio.volume = volume;
}

function clearSelection() {
  document.getElementById("selectedLabel").innerHTML = "";
  document.getElementById("selectedSong").innerHTML = "";
  if (document.getElementById("appleMusicUrlHidden")) document.getElementById("appleMusicUrlHidden").value = "";
  if (document.getElementById("artworkUrlHidden")) document.getElementById("artworkUrlHidden").value = "";
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
