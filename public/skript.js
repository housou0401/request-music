let searchMode = "song"; // "song" または "artist"

// 検索モード切替関数
function setSearchMode(mode) {
  searchMode = mode;
  if (mode === "artist") {
    // アーティストから検索の場合、アーティスト名入力欄を非表示にし、曲名入力欄のプレースホルダーを変更
    document.getElementById("artistName").style.display = "none";
    document.getElementById("songName").placeholder = "アーティスト名を入力してください";
  } else {
    // 曲名(アーティスト)検索の場合、両方表示
    document.getElementById("artistName").style.display = "block";
    document.getElementById("songName").placeholder = "曲名を入力してください";
  }
  // 近似曲一覧をクリア
  document.getElementById("suggestions").innerHTML = "";
  document.getElementById("selectedLabel").innerHTML = "";
  document.getElementById("selectedSong").innerHTML = "";
}

// 検索処理
async function searchSongs() {
  if (searchMode === "artist") {
    const artistQuery = document.getElementById("songName").value.trim();
    if (artistQuery.length < 2) return;
    const suggestionsContainer = document.getElementById("suggestions");
    suggestionsContainer.innerHTML = "";
    try {
      const response = await fetch(`/search?mode=artist&query=${encodeURIComponent(artistQuery)}`);
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
  } else {
    // song モード
    const songQuery = document.getElementById("songName").value.trim();
    const artistQuery = document.getElementById("artistName").value.trim();
    if (songQuery.length < 2) return;
    const suggestionsContainer = document.getElementById("suggestions");
    suggestionsContainer.innerHTML = "";
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

// 選択された曲の表示（前回の形式に戻す）
function selectSong(song) {
  document.getElementById("songName").value = song.trackName;
  if (searchMode === "song") {
    document.getElementById("artistName").value = song.artistName;
  }
  // 選択中ラベルを表示
  document.getElementById("selectedLabel").innerHTML = `<div class="selected-label">選択中</div>`;
  const selectedSongContainer = document.getElementById("selectedSong");
  selectedSongContainer.innerHTML = `
    <div class="selected-item" style="display: flex; align-items: center; justify-content: space-between; margin-top:10px;">
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
  // hidden fields（appleMusicUrl と artworkUrl のみ）
  let hiddenAppleUrl = document.getElementById("appleMusicUrlHidden");
  if (!hiddenAppleUrl) {
    hiddenAppleUrl = document.createElement("input");
    hiddenAppleUrl.type = "hidden";
    hiddenAppleUrl.id = "appleMusicUrlHidden";
    hiddenAppleUrl.name = "appleMusicUrl";
    document.getElementById("requestForm").appendChild(hiddenAppleUrl);
  }
  hiddenAppleUrl.value = song.trackViewUrl;
  
  let hiddenArtwork = document.getElementById("artworkUrlHidden");
  if (!hiddenArtwork) {
    hiddenArtwork = document.createElement("input");
    hiddenArtwork.type = "hidden";
    hiddenArtwork.id = "artworkUrlHidden";
    hiddenArtwork.name = "artworkUrl";
    document.getElementById("requestForm").appendChild(hiddenArtwork);
  }
  hiddenArtwork.value = song.artworkUrl;
}

// 選択解除ボタンの処理
function clearSelection() {
  document.getElementById("selectedSong").innerHTML = "";
  document.getElementById("selectedLabel").innerHTML = "";
  if (document.getElementById("appleMusicUrlHidden"))
    document.getElementById("appleMusicUrlHidden").value = "";
  if (document.getElementById("artworkUrlHidden"))
    document.getElementById("artworkUrlHidden").value = "";
  // 再度候補一覧を更新
  const songNameInput = document.getElementById("songName");
  if (songNameInput.value.trim().length > 0) {
    setTimeout(searchSongs, 100);
  }
}

// 送信フォームの送信処理（曲選択が必須）
function handleSubmit(event) {
  event.preventDefault();
  const songName = document.getElementById("songName").value.trim();
  // hidden field appleMusicUrlHidden が必須
  if (!document.getElementById("appleMusicUrlHidden").value) {
    alert("必ず候補一覧から曲を選択してください");
    return;
  }
  if (!songName) {
    alert("曲名を入力または選択してください");
    return;
  }
  document.getElementById("requestForm").submit();
}

// 管理者ログイン用の関数
function showAdminLogin() {
  var password = prompt("⚠️管理者パスワードを入力してください:");
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
