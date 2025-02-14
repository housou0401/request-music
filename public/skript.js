// 曲名およびアーティスト名入力欄に基づいて、Apple Musicから近似の曲候補を取得して表示する
async function searchSongs() {
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

// 選択された曲を入力欄に反映し、専用コンテナ #selectedSong に表示する（前回の形式に戻す）
function selectSong(song) {
  document.getElementById("songName").value = song.trackName;
  document.getElementById("artistName").value = song.artistName;
  const selectedSongContainer = document.getElementById("selectedSong");
  selectedSongContainer.innerHTML = `
    <div class="selected-item" style="display: flex; align-items: center; justify-content: space-between;">
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
  if (document.getElementById("appleMusicUrlHidden")) document.getElementById("appleMusicUrlHidden").value = "";
  if (document.getElementById("artworkUrlHidden")) document.getElementById("artworkUrlHidden").value = "";
  const songNameInput = document.getElementById("songName");
  if (songNameInput.value.trim().length > 0) {
    setTimeout(searchSongs, 100);
  }
}

// 送信フォームの送信処理
function handleSubmit(event) {
  event.preventDefault();
  const songName = document.getElementById("songName").value.trim();
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
