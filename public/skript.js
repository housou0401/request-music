// 曲名入力欄に基づいて、Apple Musicから近似の曲候補を取得して表示する
async function searchSongs() {
    const songQuery = document.getElementById("songName").value.trim();
    if (songQuery.length < 2) return; // 2文字以上で検索開始

    const suggestionsContainer = document.getElementById("suggestions");
    suggestionsContainer.innerHTML = "";
    suggestionsContainer.style.display = "block"; // 候補リストを表示

    try {
        const response = await fetch(`/search?query=${encodeURIComponent(songQuery)}`);
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

// 選択された曲を入力欄に反映し、選択情報は #selectedSong に表示する
function selectSong(song) {
    document.getElementById("songName").value = song.trackName;
    const selectedSongContainer = document.getElementById("selectedSong");
    selectedSongContainer.innerHTML = `
    <div class="selected-item" style="display: flex; align-items: center; justify-content: space-between; border: 1px solid rgba(0,0,0,0.2); border-radius: 10px; padding: 10px; margin-bottom: 10px;">
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
    // 隠しフィールドに選択情報を格納
    let hiddenArtist = document.getElementById("artistHidden");
    if (!hiddenArtist) {
        hiddenArtist = document.createElement("input");
        hiddenArtist.type = "hidden";
        hiddenArtist.id = "artistHidden";
        hiddenArtist.name = "artist";
        document.getElementById("requestForm").appendChild(hiddenArtist);
    }
    hiddenArtist.value = song.artistName;

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

    // 近似曲候補リストは選択後に非表示にする
    document.getElementById("suggestions").style.display = "none";
}

// 選択解除ボタンの処理
function clearSelection() {
    document.getElementById("selectedSong").innerHTML = "";
    if (document.getElementById("artistHidden")) {
        document.getElementById("artistHidden").value = "";
    }
    if (document.getElementById("appleMusicUrlHidden")) {
        document.getElementById("appleMusicUrlHidden").value = "";
    }
    if (document.getElementById("artworkUrlHidden")) {
        document.getElementById("artworkUrlHidden").value = "";
    }
    // 近似曲候補リストを再表示する
    document.getElementById("suggestions").style.display = "block";
    // 入力欄にテキストがある場合、再検索して候補リストを表示
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
