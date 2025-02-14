// 検索モード ("song" または "artist")
let searchMode = "song";
// アーティストモード用フェーズ: 0 = アーティスト一覧, 1 = 選択済みアーティストの曲一覧
let artistPhase = 0;
let selectedArtistId = null;

// ページ初期化時（デフォルトは曲名モード）
window.onload = function() {
  document.getElementById("modeSong").style.backgroundColor = "#007bff";
  document.getElementById("modeSong").style.color = "white";
};

// モード切替関数
function setSearchMode(mode) {
  searchMode = mode;
  artistPhase = 0;
  selectedArtistId = null;
  // 入力欄と候補エリアをクリア
  document.getElementById("songName").value = "";
  document.getElementById("artistName").value = "";
  document.getElementById("suggestions").innerHTML = "";
  document.getElementById("selectedLabel").innerHTML = "";
  document.getElementById("selectedSong").innerHTML = "";
  document.getElementById("selectedArtist").innerHTML = "";
  
  if (mode === "artist") {
    // アーティストモード：artistName入力欄を非表示、songNameをアーティスト用に再利用
    document.getElementById("artistName").style.display = "none";
    document.getElementById("songName").placeholder = "アーティスト名を入力してください";
    document.getElementById("modeArtist").style.backgroundColor = "#007bff";
    document.getElementById("modeArtist").style.color = "white";
    document.getElementById("modeSong").style.backgroundColor = "";
    document.getElementById("modeSong").style.color = "";
  } else {
    // 曲名モード：通常表示
    document.getElementById("artistName").style.display = "block";
    document.getElementById("songName").placeholder = "曲名を入力してください";
    document.getElementById("modeSong").style.backgroundColor = "#007bff";
    document.getElementById("modeSong").style.color = "white";
    document.getElementById("modeArtist").style.backgroundColor = "";
    document.getElementById("modeArtist").style.color = "";
  }
}

// メインの検索処理
async function searchSongs() {
  const suggestionsContainer = document.getElementById("suggestions");
  suggestionsContainer.innerHTML = "";
  
  if (searchMode === "artist") {
    if (artistPhase === 0) {
      // アーティスト一覧検索
      const artistQuery = document.getElementById("songName").value.trim();
      if (artistQuery.length < 2) return;
      try {
        const response = await fetch(`/search?mode=artist&query=${encodeURIComponent(artistQuery)}`);
        const suggestions = await response.json();
        suggestions.forEach(artist => {
          const item = document.createElement("div");
          item.classList.add("suggestion-item");
          item.innerHTML = `
            <img src="${artist.artworkUrl}" alt="Artist Icon" style="width:50px; height:50px; border-radius:5px; margin-right:10px;">
            <div>
              <strong>${artist.trackName}</strong>
            </div>
          `;
          item.onclick = () => selectArtist(artist);
          suggestionsContainer.appendChild(item);
        });
      } catch (error) {
        console.error("アーティスト検索エラー:", error);
      }
    } else if (artistPhase === 1 && selectedArtistId) {
      // 既にアーティストが選択済み → 曲一覧表示（lookup）
      await fetchArtistTracksAndShow();
    }
  } else {
    // 曲名モード
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
      console.error("曲名検索エラー:", error);
    }
  }
}

// アーティスト一覧検索で候補から選択
function selectArtist(artist) {
  selectedArtistId = artist.artistId;
  artistPhase = 1;
  // 選択中のアーティスト表示（カード形式＋解除ボタン）
  document.getElementById("selectedArtist").innerHTML = `
    <div class="selected-item" style="display: flex; align-items: center; justify-content: space-between; margin-top:10px;">
      <div style="display: flex; align-items: center;">
        <img src="${artist.artworkUrl}" alt="Artist Icon" style="width:50px; height:50px; border-radius:5px; margin-right:10px;">
        <div>
          <strong>${artist.trackName}</strong>
        </div>
      </div>
      <button class="clear-btn" onclick="clearArtistSelection()">×</button>
    </div>
  `;
  // クリア候補一覧
  document.getElementById("suggestions").innerHTML = "";
  // 次に、そのアーティストの曲一覧を表示
  fetchArtistTracksAndShow();
}

// アーティストの曲一覧取得して表示
async function fetchArtistTracksAndShow() {
  const suggestionsContainer = document.getElementById("suggestions");
  suggestionsContainer.innerHTML = "";
  try {
    const response = await fetch(`/search?mode=artist&artistId=${encodeURIComponent(selectedArtistId)}`);
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

// 曲選択
function selectSong(song) {
  // 曲名は必ず更新
  document.getElementById("songName").value = song.trackName;
  // 曲名モードの場合のみ、artistName入力欄は自動更新（上書きしない場合は条件追加）
  if (searchMode === "song") {
    // もし既にartistNameに入力されているなら上書きしない
    if (document.getElementById("artistName").value.trim() === "") {
      document.getElementById("artistName").value = song.artistName;
    }
  }
  // 選択中ラベル表示
  document.getElementById("selectedLabel").innerHTML = `<div class="selected-label">選択中</div>`;
  const selectedSongContainer = document.getElementById("selectedSong");
  selectedSongContainer.innerHTML = `
    <div class="selected-item" style="display: flex; align-items: center; justify-content: space-between; border: 1px solid rgba(0,0,0,0.2); border-radius: 10px; padding: 10px; margin-top:10px;">
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

// 選択解除（曲選択）
function clearSelection() {
  document.getElementById("selectedLabel").innerHTML = "";
  document.getElementById("selectedSong").innerHTML = "";
  if (document.getElementById("appleMusicUrlHidden"))
    document.getElementById("appleMusicUrlHidden").value = "";
  if (document.getElementById("artworkUrlHidden"))
    document.getElementById("artworkUrlHidden").value = "";
  // 再度候補一覧更新
  searchSongs();
}

// 選択解除（アーティスト選択）
function clearArtistSelection() {
  selectedArtistId = null;
  artistPhase = 0;
  document.getElementById("selectedArtist").innerHTML = "";
  document.getElementById("suggestions").innerHTML = "";
  searchSongs();
}

// 送信処理（必ず曲選択済み）
function handleSubmit(event) {
  event.preventDefault();
  const appleUrl = document.getElementById("appleMusicUrlHidden").value.trim();
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
