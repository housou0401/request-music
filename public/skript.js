// 検索モード ("song" or "artist")
let searchMode = "song";
// アーティストモードのフェーズ管理：0=アーティスト一覧, 1=アーティストの曲一覧
let artistPhase = 0;
let selectedArtistId = null;

// ページ初期化時に「曲名(アーティスト)で検索」ボタンをONにする
window.onload = function() {
  // デフォルト: 曲名モード
  document.getElementById("modeSong").style.backgroundColor = "#007bff";
  document.getElementById("modeSong").style.color = "white";
};

// 検索モード切替関数
function setSearchMode(mode) {
  searchMode = mode;
  artistPhase = 0;
  selectedArtistId = null;

  if (mode === "artist") {
    // アーティスト検索
    document.getElementById("artistName").style.display = "none";
    document.getElementById("songName").placeholder = "アーティスト名を入力してください";
    document.getElementById("modeArtist").style.backgroundColor = "#007bff";
    document.getElementById("modeArtist").style.color = "white";
    document.getElementById("modeSong").style.backgroundColor = "";
    document.getElementById("modeSong").style.color = "";
  } else {
    // 曲名(アーティスト)検索
    document.getElementById("artistName").style.display = "block";
    document.getElementById("songName").placeholder = "曲名を入力してください";
    document.getElementById("modeSong").style.backgroundColor = "#007bff";
    document.getElementById("modeSong").style.color = "white";
    document.getElementById("modeArtist").style.backgroundColor = "";
    document.getElementById("modeArtist").style.color = "";
  }
  // クリア
  document.getElementById("songName").value = "";
  document.getElementById("artistName").value = "";
  document.getElementById("suggestions").innerHTML = "";
  document.getElementById("selectedLabel").innerHTML = "";
  document.getElementById("selectedSong").innerHTML = "";
}

// メインの検索処理
async function searchSongs() {
  const suggestionsContainer = document.getElementById("suggestions");
  suggestionsContainer.innerHTML = "";

  if (searchMode === "artist") {
    // アーティスト検索モード
    if (artistPhase === 0) {
      // アーティスト一覧を検索
      const artistQuery = document.getElementById("songName").value.trim();
      if (artistQuery.length < 2) return;
      try {
        // entity=musicArtist
        const response = await fetch(`/search?mode=artist&query=${encodeURIComponent(artistQuery)}`);
        const suggestions = await response.json();
        suggestions.forEach(item => {
          // item.artistId がある => trackName=アーティスト名, artistName="アーティスト"
          const div = document.createElement("div");
          div.classList.add("suggestion-item");
          div.innerHTML = `
            <img src="${item.artworkUrl}" alt="Artist" style="width:50px;height:50px;">
            <div>
              <strong>${item.trackName}</strong><br>
              <small>${item.artistName}</small>
            </div>
          `;
          div.onclick = () => {
            // アーティストを選択 → 次の段階(曲一覧)に移行
            selectedArtistId = item.artistId;
            artistPhase = 1;
            fetchArtistTracksAndShow();
          };
          suggestionsContainer.appendChild(div);
        });
      } catch (error) {
        console.error("アーティスト検索エラー:", error);
      }
    } else if (artistPhase === 1 && selectedArtistId) {
      // アーティストの曲一覧表示フェーズ
      await fetchArtistTracksAndShow();
    }
  } else {
    // 曲名(アーティスト)モード
    const songQuery = document.getElementById("songName").value.trim();
    const artistQuery = document.getElementById("artistName").value.trim();
    if (songQuery.length < 2) return;
    try {
      const response = await fetch(`/search?query=${encodeURIComponent(songQuery)}&artist=${encodeURIComponent(artistQuery)}`);
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
    } catch (error) {
      console.error("検索エラー:", error);
    }
  }
}

// アーティストIDから曲一覧を取得して #suggestions に表示
async function fetchArtistTracksAndShow() {
  const suggestionsContainer = document.getElementById("suggestions");
  suggestionsContainer.innerHTML = "";
  try {
    const response = await fetch(`/search?mode=artist&artistId=${selectedArtistId}`);
    const tracks = await response.json();
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
  } catch (error) {
    console.error("アーティストの曲一覧取得エラー:", error);
  }
}

// 選択された曲を表示
function selectSong(song) {
  // モードがartistの場合は2段階目(曲一覧)の状態
  const songNameInput = document.getElementById("songName");
  const artistNameInput = document.getElementById("artistName");

  // モードが"song"なら、songNameInputとartistNameInputにセット
  // モードが"artist"ならsongNameInputには曲名をセット(artistNameは隠す)
  songNameInput.value = song.trackName;
  if (searchMode === "song") {
    artistNameInput.value = song.artistName;
  }

  document.getElementById("selectedLabel").innerHTML = `<div class="selected-label">選択中</div>`;
  const selectedSongContainer = document.getElementById("selectedSong");
  selectedSongContainer.innerHTML = `
    <div class="selected-item" style="display: flex; align-items: center; justify-content: space-between; border: 1px solid rgba(0,0,0,0.2); border-radius: 10px; padding: 10px; margin-top: 10px;">
      <div style="display: flex; align-items: center;">
        <img src="${song.artworkUrl}" alt="Cover" style="width:50px; height:50px; border-radius:5px; margin-right:10px;">
        <div>
          <strong>${song.trackName}</strong><br>
          <small>${song.artistName}</small>
        </div>
      </div>
      <button class="clear-btn" onclick="clearSelection()">×</button>
    </div>
  `;
  // 隠しフィールドにセット
  let hiddenAppleUrl = document.getElementById("appleMusicUrlHidden");
  if (!hiddenAppleUrl) {
    hiddenAppleUrl = document.createElement("input");
    hiddenAppleUrl.type = "hidden";
    hiddenAppleUrl.id = "appleMusicUrlHidden";
    hiddenAppleUrl.name = "appleMusicUrl";
    document.getElementById("requestForm").appendChild(hiddenAppleUrl);
  }
  hiddenAppleUrl.value = song.trackViewUrl || "";

  let hiddenArtwork = document.getElementById("artworkUrlHidden");
  if (!hiddenArtwork) {
    hiddenArtwork = document.createElement("input");
    hiddenArtwork.type = "hidden";
    hiddenArtwork.id = "artworkUrlHidden";
    hiddenArtwork.name = "artworkUrl";
    document.getElementById("requestForm").appendChild(hiddenArtwork);
  }
  hiddenArtwork.value = song.artworkUrl || "";
}

// 選択解除
function clearSelection() {
  document.getElementById("selectedLabel").innerHTML = "";
  document.getElementById("selectedSong").innerHTML = "";
  if (document.getElementById("appleMusicUrlHidden")) {
    document.getElementById("appleMusicUrlHidden").value = "";
  }
  if (document.getElementById("artworkUrlHidden")) {
    document.getElementById("artworkUrlHidden").value = "";
  }
  // 再検索
  searchSongs();
}

// 送信フォームの送信処理
function handleSubmit(event) {
  event.preventDefault();
  // 必ず曲を選択させる
  const appleUrl = document.getElementById("appleMusicUrlHidden").value.trim();
  if (!appleUrl) {
    alert("必ず候補一覧から曲を選択してください");
    return;
  }
  document.getElementById("requestForm").submit();
}

// 管理者ログイン
function showAdminLogin() {
  const password = prompt("⚠️管理者パスワードを入力してください:");
  if (password) {
    fetch(`/admin-login?password=${encodeURIComponent(password)}`)
      .then(response => response.json())
      .then(data => {
        if (data.success) {
          window.location.href = "/admin";
        } else {
          alert("⚠️パスワードが間違っています。");
        }
      })
      .catch(error => console.error("管理者ログインエラー:", error));
  }
}
