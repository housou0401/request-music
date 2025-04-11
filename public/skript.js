// Web Audio API セットアップ
let audioContext, gainNode, previewAudio;
let searchMode="song", artistPhase=0, selectedArtistId=null;
let isPlaying=false, isMuted=false, playerControlsEnabled=true;

window.onload = async () => {
  await loadSettings();
  setSearchMode("song");
  document.addEventListener("click", ()=> {
    if (audioContext && audioContext.state==="suspended") audioContext.resume();
  }, { once:true });
};

async function loadSettings() {
  try {
    const res = await fetch("/settings");
    const cfg = await res.json();
    playerControlsEnabled = cfg.playerControlsEnabled!==false;
  } catch(e){ console.error(e); }
}

// 検索モード切替
function setSearchMode(mode) {
  searchMode = mode; artistPhase=0; selectedArtistId=null;
  document.getElementById("songName").value="";
  document.getElementById("artistName").value="";
  document.getElementById("suggestions").innerHTML="";
  document.getElementById("selectedArtist").innerHTML="";
  document.getElementById("selectedLabel").innerHTML="";
  document.getElementById("selectedSong").innerHTML="";
  pausePreview(); isPlaying=false; updatePlayPauseIcon();
  // ボタンスタイル
  document.getElementById("modeSong").classList.toggle("active", mode==="song");
  document.getElementById("modeArtist").classList.toggle("active", mode==="artist");
  // 入力欄、再検索ボタン
  if (mode==="artist") {
    document.getElementById("artistInputContainer").style.display="none";
    document.getElementById("songName").placeholder="アーティスト名を入力してください";
    document.getElementById("reSearchSongMode").style.display="none";
    document.getElementById("reSearchArtistMode").style.display="block";
  } else {
    document.getElementById("artistInputContainer").style.display="block";
    document.getElementById("songName").placeholder="曲名を入力してください";
    document.getElementById("reSearchSongMode").style.display="block";
    document.getElementById("reSearchArtistMode").style.display="none";
  }
}

// 再検索
function reSearch(){ searchSongs(); }

// 曲／アーティスト検索
async function searchSongs(){
  const cont = document.getElementById("suggestions");
  cont.innerHTML=""; showLoading();
  if (searchMode==="artist"){
    if (artistPhase===0){
      const q=document.getElementById("songName").value.trim();
      if (!q){ hideLoading(); return; }
      const res=await fetch(`/search?mode=artist&query=${encodeURIComponent(q)}`);
      const list=await res.json();
      list.forEach(a=>{
        const d=document.createElement("div");
        d.className="suggestion-item";
        d.innerHTML=`<img src="${a.artworkUrl}"><div><strong>${a.trackName}</strong></div>`;
        d.onclick=()=>selectArtist(a);
        cont.appendChild(d);
      });
    } else {
      const res=await fetch(`/search?mode=artist&artistId=${selectedArtistId}`);
      const list=await res.json();
      list.forEach(s=>{
        const d=document.createElement("div");
        d.className="suggestion-item";
        d.innerHTML=`<img src="${s.artworkUrl}"><div><strong>${s.trackName}</strong><br><small>${s.artistName}</small></div>`;
        d.onclick=()=>selectSong(s);
        cont.appendChild(d);
      });
    }
  } else {
    const q=document.getElementById("songName").value.trim();
    const art=document.getElementById("artistName").value.trim();
    if (!q){ hideLoading(); return; }
    const res=await fetch(`/search?query=${encodeURIComponent(q)}&artist=${encodeURIComponent(art)}`);
    const list=await res.json();
    list.forEach(s=>{
      const d=document.createElement("div");
      d.className="suggestion-item";
      d.innerHTML=`<img src="${s.artworkUrl}"><div><strong>${s.trackName}</strong><br><small>${s.artistName}</small></div>`;
      d.onclick=()=>selectSong(s);
      cont.appendChild(d);
    });
  }
  hideLoading();
}

// アーティスト選択
function selectArtist(a){
  selectedArtistId=a.artistId; artistPhase=1;
  document.getElementById("selectedArtist").innerHTML=`
    <div class="selected-label">選択中のアーティスト</div>
    <div class="selected-item" style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;">
      <div style="display:flex;align-items:center;">
        <img src="${a.artworkUrl}" style="width:50px;height:50px;border-radius:5px;margin-right:10px;">
        <div><strong>${a.trackName}</strong></div>
      </div>
      <button class="clear-btn" onclick="clearArtistSelection()">×</button>
    </div>`;
  document.getElementById("suggestions").innerHTML="";
  searchSongs();
}

// 曲選択
function selectSong(s){
  document.getElementById("songName").value=s.trackName;
  if (searchMode==="song"&& !document.getElementById("artistName").value.trim())
    document.getElementById("artistName").value=s.artistName;
  document.getElementById("selectedLabel").innerHTML=`<div class="selected-label">選択中の曲</div>`;
  document.getElementById("selectedSong").innerHTML=`
    <div class="selected-item" style="display:flex;align-items:center;justify-content:space-between;border:1px solid rgba(0,0,0,0.2);border-radius:10px;padding:10px;margin-top:10px;">
      <div style="display:flex;align-items:center;">
        <img src="${s.artworkUrl}" style="width:50px;height:50px;border-radius:5px;margin-right:10px;">
        <div><strong>${s.trackName}</strong><br><small>${s.artistName}</small></div>
      </div>
      <div style="display:flex;align-items:center;">
        ${playerControlsEnabled?`
          <button class="control-btn" id="playPauseBtn" onclick="togglePlay(event)"></button>
          <button class="control-btn" id="volumeBtn" onclick="toggleMute(event)"></button>
          <input type="range" min="0" max="100" value="50" class="volume-slider" id="volumeSlider" oninput="changeVolume(this.value)">
        `:""}
        <button class="clear-btn" onclick="clearSelection()">×</button>
      </div>
    </div>`;
  // hidden
  document.getElementById("appleMusicUrlHidden").value=s.trackViewUrl;
  document.getElementById("artworkUrlHidden").value=s.artworkUrl;
  document.getElementById("previewUrlHidden").value=s.previewUrl;
  // プレビュー
  if (playerControlsEnabled && s.previewUrl){
    playPreview(s.previewUrl);
    setPreviewVolume(50);
    mutePreview(false);
    isPlaying=true; isMuted=false;
    updatePlayPauseIcon(); updateVolumeIcon();
  }
}

// 以下、プレビュー制御・音量・再生アイコン更新などは前版と同一
function playPreview(url){ /*…*/ }
function setPreviewVolume(v){ /*…*/ }
function pausePreview(){ /*…*/ }
function mutePreview(f){ /*…*/ }
function changeVolume(v){ /*…*/ }
function updateVolumeIcon(){ /*…*/ }
function togglePlay(e){ /*…*/ }
function updatePlayPauseIcon(){ /*…*/ }
function toggleMute(e){ /*…*/ }

// クリア
function clearSelection(){
  document.getElementById("selectedArtist").innerHTML="";
  document.getElementById("selectedLabel").innerHTML="";
  document.getElementById("selectedSong").innerHTML="";
  pausePreview(); isPlaying=false; updatePlayPauseIcon();
  clearArtistSelection();
  searchSongs();
}
function clearArtistSelection(){
  artistPhase=0; selectedArtistId=null;
  document.getElementById("selectedArtist").innerHTML="";
  document.getElementById("selectedLabel").innerHTML="";
  document.getElementById("selectedSong").innerHTML="";
  pausePreview(); isPlaying=false; updatePlayPauseIcon();
  document.getElementById("suggestions").innerHTML="";
  searchSongs();
}
function clearInput(id){
  document.getElementById(id).value="";
  searchSongs();
}

// フォーム送信
function handleSubmit(e){
  e.preventDefault();
  if (!document.getElementById("appleMusicUrlHidden").value){
    alert("必ず候補一覧から曲を選択してください");
    return;
  }
  e.target.submit();
}

// 管理者ログイン
function showAdminLogin(){
  const pwd=prompt("⚠️管理者パスワードを入力してください:");
  if (!pwd) return;
  fetch(`/admin-login?password=${encodeURIComponent(pwd)}`)
    .then(r=>r.json()).then(d=>{
      if(d.success) location.href="/admin";
      else alert("パスワードが違います");
    });
}

// リクエスト募集状況取得
function checkRecruitingStatus(){
  fetch("/settings").then(r=>r.json()).then(cfg=>{
    if(!cfg.recruiting){
      const c=document.getElementById("mainContainer");
      c.innerHTML=`<div style="text-align:center;color:red;font-size:1.5em;margin:20px 0;">現在は曲を募集していません</div>`;
      if(cfg.reason) c.innerHTML+=`<div style="text-align:center;color:#333;font-size:1.2em;margin:10px 0;">${cfg.reason}</div>`;
    }
  });
}
// フロントタイトル更新
function updateFrontendTitle(){
  fetch("/settings").then(r=>r.json()).then(cfg=>{
    if(cfg.frontendTitle) document.getElementById("frontendTitle").innerText=cfg.frontendTitle;
  });
}

// Loading UI
function showLoading(){ document.getElementById("loadingIndicator").style.display="flex"; }
function hideLoading(){ document.getElementById("loadingIndicator").style.display="none"; }
