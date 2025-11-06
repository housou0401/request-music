
/* =========================================================
   AudioManager で単一路線化（/preview プロキシ再生）
   - <audio id="previewAudio"> は 1 つだけ
   - 音量は GainNode で制御（fallback: audio.volume）
   - スライダーは 1〜100%（左=1%, 右=100%）
   ========================================================= */

const AudioManager = (() => {
  let audioEl = null;        // <audio>
  let ctx = null;            // AudioContext
  let source = null;         // MediaElementSourceNode
  let gain = null;           // GainNode
  let useWA = false;         // WebAudio を使えているか
  let lastNonZero = 0.4;     // ミュート解除時に戻す音量(0.0-1.0)
  let vol01 = 0.4;           // 現在の音量(0.0-1.0) 初期は控えめ

  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  function ensureNodes() {
    // <audio> を1つだけ確保
    if (!audioEl) {
      audioEl = document.getElementById("previewAudio");
      if (!audioEl) {
        audioEl = document.createElement("audio");
        audioEl.id = "previewAudio";
        audioEl.preload = "none";
        audioEl.crossOrigin = "anonymous";
        audioEl.style.display = "none";
        document.body.appendChild(audioEl);
      }
    }

    // 旧・他の <audio> は強制停止（重複再生の根絶）
    document.querySelectorAll("audio").forEach(a => {
      if (a !== audioEl) { try { a.pause(); } catch{} }
    });

    // WebAudio 構築
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) ctx = new AC();
    }
    if (ctx && !gain) {
      gain = ctx.createGain();
      gain.gain.value = vol01;
    }
    if (ctx && !source) {
      try {
        source = ctx.createMediaElementSource(audioEl);
        source.connect(gain).connect(ctx.destination);
        useWA = true;
      } catch (e) {
        // 既に接続済みのとき
        useWA = !!gain;
      }
    }

    // 出力経路の一本化
    if (useWA) {
      audioEl.volume = 1.0;    // 実音量は GainNode 側で
    } else {
      audioEl.volume = vol01;  // Fallback
    }
    return audioEl;
  }

  return {
    load(url) {
      const el = ensureNodes();
      try { el.pause(); el.currentTime = 0; } catch {}
      // 他の audio を止める（念のため）
      document.querySelectorAll("audio").forEach(a => { if (a !== el) { try{ a.pause(); }catch{} }});
      el.src = `/preview?url=${encodeURIComponent(url)}`;
      try { el.load(); } catch {}
    },
    async play() {
      const el = ensureNodes();
      if (ctx && ctx.state === "suspended") await ctx.resume();
      return el.play();
    },
    pause(reset=false) {
      const el = ensureNodes();
      try { el.pause(); if (reset) el.currentTime = 0; } catch {}
    },
    setVolume01(v) {
      vol01 = clamp01(v);
      if (gain) gain.gain.value = vol01;
      if (!useWA && audioEl) audioEl.volume = vol01; // Fallback
    },
    getVolume01() {
      if (gain) return clamp01(gain.gain.value);
      return clamp01(audioEl?.volume ?? vol01);
    },
    mute() {
      lastNonZero = this.getVolume01() || lastNonZero || 0.4;
      this.setVolume01(0); // ミュートは 0 に
    },
    unmute() {
      this.setVolume01(Math.max(0.01, lastNonZero || 0.4)); // 最低1%復帰
    },
    isMuted() { return this.getVolume01() <= 0.001; },
    element() { return ensureNodes(); }
  };
})();

/* ---------------- 検索UI（既存） ---------------- */
let searchMode = "song";     // "song" | "artist"
let artistPhase = 0;         // 0=アーティスト候補, 1=楽曲候補
let selectedArtistId = null;
let playerControlsEnabled = true;

window.onload = async function () {
  setSearchMode("song");
  await loadSettings();

  const songInput = document.getElementById("songName");
  const artistInput = document.getElementById("artistName");
  songInput.addEventListener("input", searchSongs);
  artistInput.addEventListener("input", searchSongs);

  // 簡易ローディング
  if (!document.getElementById("loadingIndicator")) {
    const loader = document.createElement("div");
    loader.id = "loadingIndicator";
    loader.style.cssText =
      "display:none; position:fixed; inset:0; background:rgba(255,255,255,.5); z-index:1200; align-items:center; justify-content:center; font-weight:bold;";
    loader.innerHTML =
      '<div style="padding:12px 16px; background:#fff; border:1px solid #ddd; border-radius:8px;">検索中...</div>';
    document.body.appendChild(loader);
  }
};

async function loadSettings() {
  try {
    const r = await fetch("/settings");
    const s = await r.json();
    playerControlsEnabled = s.playerControlsEnabled !== false;
  } catch {
    playerControlsEnabled = true;
  }
}

/* ========== 検索 ========== */
function setSearchMode(mode) {
  searchMode = mode; artistPhase = 0; selectedArtistId = null;
  ["songName","artistName"].forEach(id => { const el = document.getElementById(id); if (el) el.value=""; });
  ["suggestions","selectedLabel","selectedSong","selectedArtist"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = "";
  });
  stopPlayback(true);

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
function reSearch(){ searchSongs(); }

async function searchSongs() {
  const list = document.getElementById("suggestions");
  list.innerHTML = ""; showLoading();
  try {
    if (searchMode === "artist") {
      const q = document.getElementById("songName").value.trim();
      if (artistPhase === 0) {
        if (!q) return;
        const res = await fetch(`/search?mode=artist&query=${encodeURIComponent(q)}`);
        const artists = await res.json();
        artists.forEach(a => {
          const item = document.createElement("div");
          item.className = "suggestion-item";
          item.innerHTML = `<img src="${a.artworkUrl}" alt="Artist"><div><strong>${a.trackName}</strong></div>`;
          item.onclick = () => selectArtist(a);
          list.appendChild(item);
        });
      } else {
        await fetchArtistTracksAndShow();
      }
    } else {
      const songQ = document.getElementById("songName").value.trim();
      const artistQ = document.getElementById("artistName").value.trim();
      if (!songQ) return;
      const res = await fetch(`/search?query=${encodeURIComponent(songQ)}&artist=${encodeURIComponent(artistQ)}`);
      const songs = await res.json();
      songs.forEach(s => {
        const item = document.createElement("div");
        item.className = "suggestion-item";
        item.innerHTML = `<img src="${s.artworkUrl}" alt="Cover"><div><strong>${s.trackName}</strong><br><small>${s.artistName}</small></div>`;
        item.onclick = () => selectSong(s);
        list.appendChild(item);
      });
    }
  } catch(e){ console.error("検索エラー:", e); }
  finally { hideLoading(); }
}

async function selectArtist(artist) {
  selectedArtistId = artist.artistId; artistPhase = 1;
  document.getElementById("selectedArtist").innerHTML =
    `<div class="selected-artist-card"><img src="${artist.artworkUrl}" alt="Artist"><div>${artist.artistName || artist.trackName}</div></div>`;
  await fetchArtistTracksAndShow();
}

async function fetchArtistTracksAndShow() {
  if (!selectedArtistId) return; showLoading();
  try {
    const res = await fetch(`/search?mode=artist&artistId=${encodeURIComponent(selectedArtistId)}`);
    const songs = await res.json();
    const cont = document.getElementById("suggestions"); cont.innerHTML = "";
    songs.forEach(s => {
      const item = document.createElement("div");
      item.className = "suggestion-item";
      item.innerHTML = `<img src="${s.artworkUrl}" alt="Cover"><div><strong>${s.trackName}</strong><br><small>${s.artistName}</small></div>`;
      item.onclick = () => selectSong(s);
      cont.appendChild(item);
    });
  } catch(e){ console.error("アーティスト曲取得エラー:", e); }
  finally { hideLoading(); }
}

/* ========== 曲を選択 → レガシーカードに情報を詰める ========== */

function selectSong(song) {
  const wrap = document.getElementById("selectedSong");
  const label = document.getElementById("selectedLabel");
  if (label) label.textContent = "選択中の曲";
  document.getElementById("suggestions").innerHTML = "";

  const artwork = song.artworkUrl || "";
  const title   = song.trackName || "(曲名なし)";
  const artist  = song.artistName || "アーティスト不明";

  // カードHTML
  wrap.innerHTML = `
    <div class="selected-song-card" style="background:#f8f8f8;border:1px solid rgba(0,0,0,.08);border-radius:14px;padding:8px 10px;">
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:6px;">
        <img src="${artwork}" alt="Cover" style="width:48px;height:48px;border-radius:6px;object-fit:cover;background:#eee;">
        <div style="min-width:0;flex:1;">
          <div style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${title}</div>
          <div style="font-size:12px;color:#555;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${artist}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <button type="button" class="play" title="再生" style="background:none;border:none;font-size:18px;cursor:pointer;color:#111;">▶</button>
        <button type="button" class="vol-btn" title="ミュート/解除" style="background:none;border:none;font-size:16px;cursor:pointer;color:#111;">🔊</button>
        <input type="range" class="vol-range" min="0" max="1" step="0.01" value="0.8" style="flex:1;">
        <button type="button" onclick="clearSelection()" style="background:none;border:none;font-size:16px;margin-left:auto;cursor:pointer;">×</button>
      </div>
    </div>
  `;

  // hidden fields（送信用）
  setHidden("appleMusicUrlHidden","appleMusicUrl", song.trackViewUrl);
  setHidden("artworkUrlHidden","artworkUrl", artwork);
  setHidden("previewUrlHidden","previewUrl", song.previewUrl);

  // 再生制御のアタッチ
  const card = wrap.querySelector(".selected-song-card");
  const playBtn = card.querySelector(".play");
  const volBtn = card.querySelector(".vol-btn");
  const volRange = card.querySelector(".vol-range");

  // 曲を読み込んで自動再生
  if (song.previewUrl) {
    AudioManager.load(song.previewUrl);
    AudioManager.play().then(() => {
      playBtn.textContent = "■";
      updateVolumeIcon(volBtn, AudioManager.getVolume01(), AudioManager.isMuted());
      const nowVol = AudioManager.getVolume01();
      if (volRange) volRange.value = nowVol.toFixed(2);
    }).catch(() => {
      // 再生できなかったら▶に戻す
      playBtn.textContent = "▶";
    });
  } else {
    // プレビューがない場合は▶のまま
    updateVolumeIcon(volBtn, AudioManager.getVolume01(), AudioManager.isMuted());
    if (volRange) volRange.value = AudioManager.getVolume01().toFixed(2);
  }

  // 再生/停止
  playBtn.addEventListener("click", async () => {
    const el = AudioManager.element();
    if (el.paused) {
      try {
        await AudioManager.play();
        playBtn.textContent = "■";
      } catch(e) { console.warn(e); }
    } else {
      AudioManager.pause(false);
      playBtn.textContent = "▶";
    }
  });

  // 音量スライダー
  volRange.addEventListener("input", (ev) => {
    const v = Number(ev.target.value);
    AudioManager.setVolume01(v);
    updateVolumeIcon(volBtn, v, v <= 0.001);
  });

  // ミュートボタン
  volBtn.addEventListener("click", () => {
    if (AudioManager.isMuted()) {
      AudioManager.unmute();
      const v = AudioManager.getVolume01();
      if (volRange) volRange.value = v.toFixed(2);
      updateVolumeIcon(volBtn, v, false);
    } else {
      AudioManager.mute();
      if (volRange) volRange.value = "0";
      updateVolumeIcon(volBtn, 0, true);
    }
  });
}

// ボリュームのアイコンを音量に応じて変える
function updateVolumeIcon(btn, vol, muted){
  if (!btn) return;
  if (muted || vol <= 0.001) {
    btn.textContent = "🔇";
  } else if (vol < 0.33) {
    btn.textContent = "🔈";
  } else if (vol < 0.66) {
    btn.textContent = "🔉";
  } else {
    btn.textContent = "🔊";
  }
}
/* ---- 共通 ---- */
function setHidden(id,name,val){
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("input");
    el.type = "hidden";
    el.id = id;
    el.name = name;
    document.getElementById("requestForm").appendChild(el);
  }
  el.value = val || "";
}
function clearSelection(){
  stopPlayback(true);
  document.getElementById("selectedSong").innerHTML = "";
  document.getElementById("selectedLabel").innerHTML = "";
  ["previewUrlHidden","appleMusicUrlHidden","artworkUrlHidden"].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = "";
  });
}
function stopPlayback(resetSrc){
  try { AudioManager.pause(resetSrc); } catch {}
}

/* ====== 入力欄 × ボタン対策 ====== */
function clearInput(inputId){
  const el = document.getElementById(inputId);
  if (!el) return;
  el.value = "";
  // 入力イベントを発火してUI更新（候補リスト等）
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
}

/* ---- ローディング ---- */
function showLoading(){ const el = document.getElementById("loadingIndicator"); if (el) el.style.display = "flex"; }
function hideLoading(){ const el = document.getElementById("loadingIndicator"); if (el) el.style.display = "none"; }

/* ---- 管理ログイン API（保持） ---- */
async function adminLogin(password){
  if (!password) return;
  try {
    const res = await fetch("/admin-login", {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (!data.success) {
      if (data.reason === "bad_password") alert("管理者パスワードが違います");
      if (data.reason === "locked") alert("管理者ログイン試行の上限に達しました");
    }
  } catch(e){ console.error("管理者ログインエラー:", e); }
}


/* === Carousel UI === */
let currentList = [];
let currentIndex = 0;
let currentPreviewUrl = "";

// Build DOM nodes if missing
function ensureCarouselDom(){
  const wrap = document.getElementById("carouselWrap");
  const track = document.getElementById("carouselTrack");
  const pc = document.getElementById("playerControls");
  if (wrap && track && pc) return { wrap, track, pc };
  return null;
}

function ensurePlayerUIVisible(show){
  const pc = document.getElementById("playerControls");
  const wrap = document.getElementById("carouselWrap");
  if (pc) pc.style.display = show ? "block" : "none";
  if (wrap) wrap.style.display = show ? "grid" : "none";
}

function cardNode(song, idx){
  const div = document.createElement("div");
  div.className = "result-card";
  div.setAttribute("data-index", String(idx));
  div.innerHTML = `
    <img class="cover" alt="" src="${song.artworkUrl || ""}"/>
    <div class="title">${(song.trackName||"").replace(/</g,"&lt;")}</div>
    <div class="artist">${(song.artistName||"").replace(/</g,"&lt;")}</div>
  `;
  div.addEventListener("click", ()=> selectCarouselIndex(idx, true));
  return div;
}

function renderCarousel(list){
  const nodes = ensureCarouselDom();
  if (!nodes) return;
  const { wrap, track } = nodes;
  track.innerHTML = "";
  currentList = list || [];
  currentIndex = 0;
  currentPreviewUrl = "";
  for (let i=0;i<currentList.length;i++){
    track.appendChild(cardNode(currentList[i], i));
  }
  updateSelection(0);
  ensurePlayerUIVisible(currentList.length>0);
  scrollToIndex(0, {smooth:false});
}

function updateSelection(i){
  currentIndex = Math.max(0, Math.min(currentList.length-1, i));
  const cards = document.querySelectorAll(".result-card");
  cards.forEach(c => c.classList.remove("selected"));
  const sel = document.querySelector(`.result-card[data-index="${currentIndex}"]`);
  if (sel) sel.classList.add("selected");

  // hidden inputs only（検索入力は変更しない）
  const song = currentList[currentIndex] || {};
  const hApple = document.getElementById("appleMusicUrlHidden");
  const hArt   = document.getElementById("artworkUrlHidden");
  const hPrev  = document.getElementById("previewUrlHidden");
  if (hApple) hApple.value = song.trackViewUrl || "";
  if (hArt)   hArt.value   = song.artworkUrl || "";
  if (hPrev)  hPrev.value  = song.previewUrl || "";

  // audio 準備
  currentPreviewUrl = song.previewUrl || "";
  if (currentPreviewUrl){
    // load して ended は選択維持
    AudioManager.load(currentPreviewUrl);
    const el = AudioManager.element();
    el.onended = ()=> { pauseSelected(); el.currentTime = 0; }; // 勝手に次へ送らない
  }
}

function scrollToIndex(i, {smooth=true}={}){
  const track = document.getElementById("carouselTrack");
  const sel = document.querySelector(`.result-card[data-index="${i}"]`);
  if (!track || !sel) return;
  const rect = sel.getBoundingClientRect();
  const pr = track.getBoundingClientRect();
  const delta = (rect.left + rect.width/2) - (pr.left + pr.width/2);
  track.scrollBy({ left: delta, behavior: smooth ? "smooth" : "auto" });
}

function selectCarouselIndex(i, autoPlay){
  i = Math.max(0, Math.min(currentList.length-1, i));
  updateSelection(i);
  scrollToIndex(i, {smooth:true});
  if (autoPlay && currentPreviewUrl){
    const el = AudioManager.element();
    const onCanPlay = ()=>{ el.removeEventListener("canplay", onCanPlay); AudioManager.play().catch(()=>{}); };
    el.addEventListener("canplay", onCanPlay, { once: true });
    try{ el.load(); }catch{}
  }
}

function setupCarouselInteractions(){
  const track = document.getElementById("carouselTrack");
  if (!track) return;
  let scrollTimer = null;
  track.addEventListener("scroll", ()=>{
    // スワイプ後に最寄りカードへスナップ（抑制）
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(()=>{
      const cards = [...document.querySelectorAll(".result-card")];
      if (!cards.length) return;
      const pr = track.getBoundingClientRect();
      // 最も中心に近いカードを選択
      let best = 0, bestDist = 1e9;
      cards.forEach((c, idx)=>{
        const r = c.getBoundingClientRect();
        const dist = Math.abs((r.left + r.width/2) - (pr.left + pr.width/2));
        if (dist < bestDist) { bestDist = dist; best = idx; }
      });
      selectCarouselIndex(best, false);
    }, 120);
  }, { passive: true });
}

// 再生UI
function setupPlayerControls(){
  const playBtn = document.getElementById("playPauseBtn");
  const volBtn  = document.getElementById("volumeBtn");
  const volBar  = document.getElementById("volumeBar");
  const seek    = document.getElementById("seekBar");
  const timeLb  = document.getElementById("timeLabel");
  const el      = AudioManager.element();

  if (playBtn){
    playBtn.addEventListener("click", async ()=>{
      if (el.paused) { await AudioManager.play().catch(()=>{}); playBtn.textContent = "⏸"; }
      else { pauseSelected(); }
    });
  }
  if (volBtn){
    volBtn.addEventListener("click", ()=>{
      if (AudioManager.isMuted()) { AudioManager.unmute(); volBtn.textContent = "🔊"; }
      else { AudioManager.mute(); volBtn.textContent = "🔈"; }
    });
  }
  // 長押し0.05秒でドラッグモード（どこでもドラッグ）
  function attachPressDrag(rangeEl, onChange){
    let active = false, holdTimer = null;
    const setFrom = (clientX)=>{
      const rc = rangeEl.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (clientX - rc.left) / rc.width));
      const val = Math.round(f * Number(rangeEl.max||1000));
      rangeEl.value = String(val);
      onChange(f);
    };
    rangeEl.addEventListener("pointerdown", (e)=>{
      rangeEl.classList.add("active");
      holdTimer = setTimeout(()=>{ active = true; }, 50);
      setFrom(e.clientX);
      rangeEl.setPointerCapture(e.pointerId);
    });
    rangeEl.addEventListener("pointermove", (e)=>{ if (active) setFrom(e.clientX); });
    const release = ()=>{ active = false; clearTimeout(holdTimer); rangeEl.classList.remove("active"); };
    rangeEl.addEventListener("pointerup", release);
    rangeEl.addEventListener("pointercancel", release);
    rangeEl.addEventListener("lostpointercapture", release);
  }

  if (volBar){
    attachPressDrag(volBar, (f)=>{
      const v01 = Math.max(0.01, Math.min(1, f));
      AudioManager.setVolume01(v01);
      volBtn && (volBtn.textContent = (v01 <= 0.011 ? "🔈":"🔊"));
      // 濃い灰色進捗
      volBar.style.setProperty("--prog", (f*100)+"%");
    });
    const init = Math.round(AudioManager.getVolume01()*100);
    volBar.value = String(Math.max(1, init || 40));
    volBar.style.setProperty("--prog", (Math.max(0.01, (init||40)/100)*100)+"%");
  }
  if (seek){
    attachPressDrag(seek, (f)=>{
      try { el.currentTime = (el.duration||0) * f; } catch {}
      seek.style.setProperty("--prog", (f*100)+"%");
    });
    let seeking = false;
    seek.addEventListener("input", ()=>{
      seeking = true;
      const f = Number(seek.value)/Number(seek.max||1000);
      try { el.currentTime = (el.duration||0) * f; } catch {}
      seek.style.setProperty("--prog", (f*100)+"%");
    });
    seek.addEventListener("change", ()=> seeking=false);
    el.addEventListener("timeupdate", ()=>{
      if (!seeking && isFinite(el.duration) && el.duration>0){
        const f = (el.currentTime / el.duration);
        seek.value = String(Math.round(f * (Number(seek.max||1000))));
        seek.style.setProperty("--prog", (f*100)+"%");
      }
      if (timeLb) timeLb.textContent = msToLabel(el.currentTime*1000) + " / " + msToLabel((el.duration||0)*1000);
    });
    el.addEventListener("ended", ()=>{ pauseSelected(); el.currentTime = 0; });
  }
}

function playSelected(){
  if (!currentPreviewUrl) return;
  AudioManager.play().catch(()=>{});
  const btn = document.getElementById("playPauseBtn");
  if (btn) btn.textContent = "⏸";
}
function pauseSelected(){
  AudioManager.pause(false);
  const btn = document.getElementById("playPauseBtn");
  if (btn) btn.textContent = "▶";
}

// bootstrap after DOM ready
document.addEventListener("DOMContentLoaded", ()=>{
  ensureCarouselDom();
  setupPlayerControls();
  setupCarouselInteractions();
});

// --- search override: render carousel ---
const __orig_searchSongs = (typeof searchSongs === "function") ? searchSongs : null;
searchSongs = async function(){
  const listDiv = document.getElementById("suggestions");
  if (listDiv) listDiv.innerHTML = ""; // 旧リスト非表示
  showLoading && showLoading();
  try {
    const artistMode = (typeof searchMode !== "undefined" && searchMode === "artist");
    if (artistMode) {
      const q = (document.getElementById("songName")?.value||"").trim();
      if (!q) { ensurePlayerUIVisible(false); return; }
      const res = await fetch(`/search?mode=artist&query=${encodeURIComponent(q)}`);
      const artists = await res.json();
      renderCarousel(artists.map(a => ({
        artworkUrl: a.artworkUrl,
        trackName: a.artistName||a.trackName,
        artistName: a.artistName||"",
        trackViewUrl: "",
        previewUrl: ""
      })));
      return;
    }
    // mode=song
    const q = (document.getElementById("songName")?.value||"").trim();
    const artist = (document.getElementById("artistName")?.value||"").trim();
    if (!q && !artist) { ensurePlayerUIVisible(false); return; }
    const u = new URLSearchParams({ query: q, artist, limit: "30" });
    const resp = await fetch(`/search?${u.toString()}`);
    const songs = await resp.json();
    renderCarousel(songs);
  } catch(e) {
    console.error(e);
  } finally {
    hideLoading && hideLoading();
  }
};


/* === Boot /me fetch === */
document.addEventListener("DOMContentLoaded", ()=>{
  fetch("/me").then(r=>r.json()).then(d=>{
    const info = document.getElementById("token-info");
    if (info){
      if (d && d.loggedIn && d.user){
        info.textContent = `残りトークン: ${d.user.tokens}`;
      }else{
        info.textContent = `未ログイン`;
      }
    }
  }).catch(()=>{});
});
