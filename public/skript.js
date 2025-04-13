// Web Audio API 初期化
let audioContext = null, gainNode = null;
let previewAudio = null, isPlaying = false, isMuted = false;
let searchMode = "song", artistPhase = 0, selectedArtistId = null;
let playerControlsEnabled = true;

window.onload = async () => {
  setSearchMode("song");
  document.addEventListener("click", () => {
    if (audioContext?.state === "suspended") audioContext.resume();
  }, { once: true });
  const res = await fetch("/settings");
  const cfg = await res.json();
  document.getElementById("frontendTitle").innerText = cfg.frontendTitle;
  document.title = cfg.frontendTitle;
  playerControlsEnabled = cfg.playerControlsEnabled;
};

function setSearchMode(mode) {
  searchMode = mode; artistPhase = 0; selectedArtistId = null;
  ["songName","artistName"].forEach(id=>document.getElementById(id).value="");
  ["suggestions","selectedLabel","selectedSong","selectedArtist"].forEach(id=>document.getElementById(id).innerHTML="");
  previewAudio?.pause(); isPlaying = false; updatePlayPauseIcon();
  const ai = document.getElementById("artistInputContainer");
  document.getElementById("modeSong").style.background="";
  document.getElementById("modeArtist").style.background="";
  if (mode==="artist") {
    ai.style.display="none";
    document.getElementById("modeArtist").style.background="#007bff";
    document.getElementById("modeArtist").style.color="#fff";
    document.getElementById("reSearchSongMode").style.display="none";
    document.getElementById("reSearchArtistMode").style.display="block";
    document.getElementById("songName").placeholder="アーティスト名を入力してください";
  } else {
    ai.style.display="block";
    document.getElementById("modeSong").style.background="#007bff";
    document.getElementById("modeSong").style.color="#fff";
    document.getElementById("reSearchSongMode").style.display="block";
    document.getElementById("reSearchArtistMode").style.display="none";
    document.getElementById("songName").placeholder="曲名を入力してください";
  }
}

async function searchSongs() {
  const cont = document.getElementById("suggestions");
  cont.innerHTML = ""; showLoading();
  let url = "/search?";
  if (searchMode==="artist") {
    if (artistPhase===0) {
      const q = encodeURIComponent(document.getElementById("songName").value.trim());
      if (!q) return hideLoading();
      url += `mode=artist&query=${q}`;
    } else {
      url += `mode=artist&artistId=${selectedArtistId}`;
    }
  } else {
    const q=encodeURIComponent(document.getElementById("songName").value.trim()),
          a=encodeURIComponent(document.getElementById("artistName").value.trim());
    if (!q) return hideLoading();
    url += `query=${q}&artist=${a}`;
  }
  try {
    const res = await fetch(url);
    const list = await res.json();
    list.forEach(item=>{
      const div = document.createElement("div");
      div.className="suggestion-item";
      div.innerHTML=`
        <img src="${item.artworkUrl}" alt="" />
        <div>${searchMode==="artist"?item.trackName:`<strong>${item.trackName}</strong><br><small>${item.artistName}</small>`}</div>`;
      div.onclick = ()=> searchMode==="artist" && artistPhase===0
        ? selectArtist(item)
        : selectSong(item);
      cont.appendChild(div);
    });
  } catch(e){ console.error(e); }
  hideLoading();
}

function reSearch(){ searchSongs(); }

function selectArtist(art) {
  selectedArtistId = art.artistId;
  artistPhase = 1;
  document.getElementById("selectedArtist").innerHTML=`
    <div class="selected-label">選択中のアーティスト</div>
    <div class="selected-item">
      <img src="${art.artworkUrl}" /><strong>${art.trackName}</strong>
      <button class="clear-btn" onclick="clearArtistSelection()">×</button>
    </div>`;
  document.getElementById("suggestions").innerHTML="";
  fetchArtistTracksAndShow();
}

async function fetchArtistTracksAndShow(){
  const res=await fetch(`/search?mode=artist&artistId=${selectedArtistId}`);
  const tracks=await res.json();
  const cont=document.getElementById("suggestions"); cont.innerHTML="";
  tracks.forEach(s=>{
    const div=document.createElement("div");
    div.className="suggestion-item";
    div.innerHTML=`<img src="${s.artworkUrl}" /><div><strong>${s.trackName}</strong><br><small>${s.artistName}</small></div>`;
    div.onclick=()=>selectSong(s);
    cont.appendChild(div);
  });
}

function selectSong(song) {
  document.getElementById("songName").value=song.trackName;
  if (searchMode==="song" && !document.getElementById("artistName").value.trim())
    document.getElementById("artistName").value=song.artistName;
  document.getElementById("selectedLabel").innerHTML=`<div class="selected-label">選択中の曲</div>`;
  const cont=document.getElementById("selectedSong");
  cont.innerHTML=`
    <div class="selected-item">
      <img src="${song.artworkUrl}" />
      <div><strong>${song.trackName}</strong><br><small>${song.artistName}</small></div>
      <div>
        ${playerControlsEnabled?`
          <button class="control-btn" id="playPauseBtn" onclick="togglePlay(event)"></button>
          <button class="control-btn" id="volumeBtn" onclick="toggleMute(event)"></button>
          <input type="range" min="0" max="100" value="50" class="volume-slider" id="volumeSlider" oninput="changeVolume(this.value)">
        `:""}
        <button class="clear-btn" onclick="clearSelection()">×</button>
    </div></div>`;
  // hidden fields
  ["appleMusicUrl","artworkUrl","previewUrl"].forEach(name=>{
    let el=document.getElementById(name+"Hidden");
    if(!el){
      el=document.createElement("input");
      el.type="hidden"; el.id=name+"Hidden"; el.name=name;
      document.getElementById("requestForm").appendChild(el);
    }
    el.value = name==="appleMusicUrl"?song.trackViewUrl:(name==="artworkUrl"?song.artworkUrl:song.previewUrl);
  });
  // プレビュー再生
  if (playerControlsEnabled && song.previewUrl) {
    if (!previewAudio) {
      previewAudio=new Audio();
      previewAudio.preload="auto";
      audioContext=new (window.AudioContext||window.webkitAudioContext)();
      const src=audioContext.createMediaElementSource(previewAudio);
      gainNode=audioContext.createGain();
      src.connect(gainNode).connect(audioContext.destination);
    }
    previewAudio.src=song.previewUrl;
    previewAudio.currentTime=15;
    previewAudio.loop=true;
    gainNode.gain.setValueAtTime(0, audioContext.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.5, audioContext.currentTime+0.75);
    previewAudio.play().catch(console.error);
    isPlaying=true; isMuted=false;
    updatePlayPauseIcon(); updateVolumeIcon();
  }
}

function changeVolume(val){
  if(!previewAudio)return;
  const v=val/100;
  if(isMuted){ isMuted=false; previewAudio.muted=false; }
  gainNode?gainNode.gain.setValueAtTime(v,audioContext.currentTime):previewAudio.volume=v;
  updateVolumeIcon();
}

function updateVolumeIcon(){
  const btn=document.getElementById("volumeBtn");
  if(!btn||!previewAudio)return;
  let vol=isMuted?0:(gainNode?gainNode.gain.value:previewAudio.volume);
  let svg;
  if(vol<=0.01){
    svg=`<svg width="24" height="24" viewBox="0 0 24 24">
      <polygon points="4,9 8,9 13,5 13,19 8,15 4,15" fill="#888"/>
      <line x1="15" y1="4" x2="21" y2="20" stroke="#888" stroke-width="2"/>
      <line x1="21" y1="4" x2="15" y2="20" stroke="#888" stroke-width="2"/>
    </svg>`;
  } else if(vol<0.35){
    svg=`<svg width="24" height="24" viewBox="0 0 24 24">
      <polygon points="4,9 8,9 13,5 13,19 8,15 4,15" fill="#888"/>
      <path d="M15,12 C15.5,7 15.5,17 15,12" stroke="#888" stroke-width="2" fill="none"/>
    </svg>`;
  } else if(vol<0.65){
    svg=`<svg width="24" height="24" viewBox="0 0 24 24">
      <polygon points="4,9 8,9 13,5 13,19 8,15 4,15" fill="#888"/>
      <path d="M15,12 C15.5,7 15.5,17 15,12" stroke="#888" stroke-width="2" fill="none"/>
      <path d="M18,12 C18.5,6 18.5,18 18,12" stroke="#888" stroke-width="2" fill="none"/>
    </svg>`;
  } else {
    svg=`<svg width="24" height="24" viewBox="0 0 24 24">
      <polygon points="4,9 8,9 13,5 13,19 8,15 4,15" fill="#888"/>
      <path d="M15,12 C15.5,7 15.5,17 15,12" stroke="#888" stroke-width="2" fill="none"/>
      <path d="M18,12 C18.5,6 18.5,18 18,12" stroke="#888" stroke-width="2" fill="none"/>
      <path d="M21,12 C21.5,5 21.5,19 21,12" stroke="#888" stroke-width="2" fill="none"/>
    </svg>`;
  }
  btn.innerHTML=svg;
}

function togglePlay(e){
  e.stopPropagation();
  if(!previewAudio)return;
  if(isPlaying){ previewAudio.pause(); isPlaying=false; }
  else{ audioContext.resume().then(()=>previewAudio.play().catch(console.error)); isPlaying=true; }
  updatePlayPauseIcon();
}

function updatePlayPauseIcon(){
  const btn=document.getElementById("playPauseBtn");
  if(!btn)return;
  btn.innerHTML = isPlaying
    ? `<svg width="24" height="24"><rect x="6" y="5" width="4" height="14" fill="#888"/><rect x="14" y="5" width="4" height="14" fill="#888"/></svg>`
    : `<svg width="24" height="24"><polygon points="7,4 19,12 7,20" fill="#888"/></svg>`;
}

function toggleMute(e){
  e.stopPropagation();
  if(!previewAudio)return;
  isMuted=!isMuted; previewAudio.muted=isMuted; updateVolumeIcon();
}

function clearSelection(){
  ["selectedLabel","selectedSong","appleMusicUrlHidden","artworkUrlHidden","previewUrlHidden"].forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.tagName==="INPUT"?el.value="":el.innerHTML="";
  });
  if(previewAudio){ previewAudio.pause(); previewAudio.currentTime=0; isPlaying=false; updatePlayPauseIcon(); }
  clearArtistSelection();
  searchSongs();
}

function clearArtistSelection(){
  selectedArtistId=null; artistPhase=0;
  ["selectedArtist","selectedLabel","selectedSong"].forEach(id=>document.getElementById(id).innerHTML="");
  if(previewAudio){ previewAudio.pause(); previewAudio.currentTime=0; isPlaying=false; updatePlayPauseIcon(); }
  document.getElementById("suggestions").innerHTML="";
  searchSongs();
}

function clearInput(id){ document.getElementById(id).value=""; searchSongs(); }

function handleSubmit(e){
  e.preventDefault();
  if(!document.getElementById("appleMusicUrlHidden")?.value){
    alert("必ず候補一覧から曲を選択してください");
    return;
  }
  document.getElementById("requestForm").submit();
}

function showAdminLogin(){
  const pw=prompt("管理者パスワード:");
  if(!pw) return;
  fetch(`/admin-login?password=${encodeURIComponent(pw)}`)
    .then(r=>r.json()).then(d=>{
      if(d.success) location.href="/admin"; else alert("パスワード違います");
    });
}

function showLoading(){document.getElementById("loadingIndicator").style.display="flex";}
function hideLoading(){document.getElementById("loadingIndicator").style.display="none";}

