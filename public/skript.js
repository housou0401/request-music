// 曲名入力欄とアーティスト名入力欄の内容に基づいて、検索候補を取得して表示する
async function searchSongs() {
    const songQuery = document.getElementById("songName").value;
    const artistQuery = document.getElementById("artistName").value;
    const combinedQuery = songQuery + " " + artistQuery;
    const suggestionsContainer = document.getElementById("suggestions");
    suggestionsContainer.innerHTML = "";
    if (songQuery.length < 2) return; // 2文字以上で検索開始

    try {
        const response = await fetch(`/search?query=${encodeURIComponent(combinedQuery)}`);
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

// 選択された曲を固定表示し、入力欄に反映させる
function selectSong(song) {
    // 入力欄に選択された曲の情報を反映
    document.getElementById("songName").value = song.trackName;
    document.getElementById("artistName").value = song.artistName;
    // 検索候補リストをクリア
    document.getElementById("suggestions").innerHTML = "";
    // 選択された曲を視覚的に表示
    const selectedContainer = document.getElementById("selectedSong");
    selectedContainer.innerHTML = `
    <div class="selected-item" style="display: flex; align-items: center; justify-content: center; border: 1px solid rgba(0,0,0,0.2); border-radius: 10px; padding: 10px; margin-top: 10px;">
      <img src="${song.artworkUrl}" alt="Cover" style="width:50px;height:50px;border-radius:5px;margin-right:10px;">
      <div><strong>${song.trackName}</strong><br><small>${song.artistName}</small></div>
    </div>
  `;
}

// 送信フォームの送信処理
function handleSubmit(event) {
    event.preventDefault();
    // 送信前に必ず、ユーザーが選択した曲情報が入力欄に反映されている前提
    const songName = document.getElementById("songName").value;
    const artistName = document.getElementById("artistName").value;
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