
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


/* =========================================================
   新・横スクロール 3D カード表示 & プレイヤー制御
   - 画像 → 曲名 → 小さくアーティスト名（中央ぞろえ）
   - 横に最大5枚（カード幅で調整）
   - スワイプ/スクロールで移動し、選択も切り替え
   - 先頭ヒット時は 0 番目を選択し大きく表示
   ========================================================= */

let currentList = [];
let currentIndex = -1;
let currentPreviewUrl = "";

const $ = (sel)=>document.querySelector(sel);
const $$ = (sel)=>Array.from(document.querySelectorAll(sel));

function ensurePlayerUIVisible(show) {
  const car = $("#resultsCarousel");
  const pc  = $("#playerControls");
  if (car) car.classList.toggle("ux-hidden", !show);
  if (pc)  pc.classList.toggle("ux-hidden", !show);
}

function msToLabel(ms) {
  if (!isFinite(ms) || ms<=0) return "0:00";
  const sec = Math.floor(ms/1000);
  const m = Math.floor(sec/60);
  const s = sec%60;
  return m + ":" + String(s).padStart(2,"0");
}

function renderCarousel(list) {
  currentList = Array.isArray(list) ? list.slice(0, 30) : [];
  const track = $("#carouselTrack");
  if (!track) return;
  track.innerHTML = "";

  // カードDOMを生成
  currentList.forEach((s, i)=> {
    const card = document.createElement("div");
    card.className = "result-card";
    card.dataset.index = String(i);
    card.innerHTML = `
      <img class="cover" src="${s.artworkUrl || ""}" alt="Cover">
      <div class="title">${s.trackName || ""}</div>
      <div class="artist">${s.artistName || ""}</div>
    `;
    card.addEventListener("click", ()=> selectCarouselIndex(i, true));
    track.appendChild(card);
  });

  // スクロール時の 3D/スケール更新
  const wrap = $("#resultsCarousel");
  function update3D() {
    const cards = $$(".result-card");
    const rect = wrap.getBoundingClientRect();
    const center = rect.left + rect.width/2;
    let nearest = {i: -1, d: 1e9};
    cards.forEach((c, idx)=>{
      const r = c.getBoundingClientRect();
      const mid = r.left + r.width/2;
      const dx = (mid - center) / rect.width; // -0.5 .. 0.5 くらい
      const dist = Math.abs(dx);
      const scale = 0.78 + Math.max(0, 0.30 * (1 - Math.min(1, dist*2)));
      const ry = -16 * dx; // 左右に少し傾ける
      c.style.setProperty("--scale", scale.toFixed(3));
      c.style.setProperty("--ry", ry.toFixed(3) + "deg");
      if (dist < nearest.d) nearest = {i: idx, d: dist};
    });
    // 選択のハイライト
    $$(".result-card").forEach(c => c.classList.remove("selected"));
    if (nearest.i >= 0) {
      $$(".result-card")[nearest.i].classList.add("selected");
    }
  }
  wrap.addEventListener("scroll", update3D, {passive:true});
  window.addEventListener("resize", update3D);

  // スワイプ操作（簡易）
  let startX = 0, startScroll = 0, dragging=false;
  wrap.addEventListener("pointerdown", (e)=>{
    dragging = true;
    startX = e.clientX;
    startScroll = wrap.scrollLeft;
    wrap.style.scrollSnapType = "none";
    wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener("pointermove", (e)=>{
    if (!dragging) return;
    const dx = startX - e.clientX;
    wrap.scrollLeft = startScroll + dx;
  });
  wrap.addEventListener("pointerup", (e)=>{
    dragging = false;
    wrap.style.scrollSnapType = "x mandatory";
    // スクロール後に最も中央のカードを選択
    setTimeout(()=> {
      const cards = $$(".result-card");
      if (!cards.length) return;
      const rect = wrap.getBoundingClientRect();
      const center = rect.left + rect.width/2;
      let nearest = {i: -1, d: 1e9};
      cards.forEach((c, idx)=>{
        const r = c.getBoundingClientRect();
        const mid = r.left + r.width/2;
        const d = Math.abs(mid - center);
        if (d < nearest.d) nearest = {i: idx, d};
      });
      if (nearest.i >= 0) selectCarouselIndex(nearest.i, true);
    }, 30);
  });

  // 初期選択: 0 番目
  ensurePlayerUIVisible(currentList.length > 0);
  if (currentList.length > 0) {
    // 先頭カードへスクロール & 選択
    setTimeout(()=>{
      const first = track.querySelector('.result-card[data-index="0"]');
      if (first) {
        first.scrollIntoView({behavior:"instant", inline:"center", block:"nearest"});
      }
      selectCarouselIndex(0, false);
      update3D();
    }, 0);
  }
}

function selectCarouselIndex(i, autoPlay=false) {
  i = Math.max(0, Math.min(i, currentList.length-1));
  currentIndex = i;

  // 見た目更新
  const cards = $$(".result-card");
  cards.forEach(c => c.classList.remove("selected"));
  const sel = cards[i];
  if (sel) {
    sel.classList.add("selected");
    sel.scrollIntoView({behavior:"smooth", inline:"center", block:"nearest"});
  }

  // hidden 入力とフォームUI更新
  const song = currentList[i] || {};
  const hApple = $("#appleMusicUrlHidden");
  const hArt   = $("#artworkUrlHidden");
  const hPrev  = $("#previewUrlHidden");
  if (hApple) hApple.value = song.trackViewUrl || "";
  if (hArt)   hArt.value   = song.artworkUrl || "";
  if (hPrev)  hPrev.value  = song.previewUrl || "";
  /* 検索入力は維持するため更新しない */

  // プレーヤー準備
  currentPreviewUrl = song.previewUrl || "";
  if (currentPreviewUrl) {
    AudioManager.load(currentPreviewUrl);
    if (autoPlay) playSelected();
  }
}

function playSelected() {
  if (!currentPreviewUrl) return;
  AudioManager.play().catch(()=>{});
  const btn = $("#playPauseBtn");
  if (btn) btn.textContent = "⏸";
}
function pauseSelected() {
  AudioManager.pause(false);
  const btn = $("#playPauseBtn");
  if (btn) btn.textContent = "▶";
}

function setupPlayerControls() {
  const playBtn = $("#playPauseBtn");
  const volBtn  = $("#volumeBtn");
  const volBar  = $("#volumeBar");
  const seek    = $("#seekBar");
  const timeLb  = $("#timeLabel");
  const el      = AudioManager.element();

  if (playBtn) {
    playBtn.addEventListener("click", async ()=>{
      if (el.paused) { await AudioManager.play().catch(()=>{}); playBtn.textContent = "⏸"; }
      else { pauseSelected(); }
    });
  }
  if (volBtn) {
    volBtn.addEventListener("click", ()=>{
      if (AudioManager.isMuted()) { AudioManager.unmute(); volBtn.textContent = "🔊"; }
      else { AudioManager.mute(); volBtn.textContent = "🔈"; }
    });
  }
  if (volBar) {
    volBar.addEventListener("input", ()=>{
      const v01 = Math.max(0.01, Math.min(1, Number(volBar.value)/100));
      AudioManager.setVolume01(v01);
      if (v01 <= 0.011) { volBtn.textContent = "🔈"; } else { volBtn.textContent = "🔊"; }
    });
    // 初期値反映
    const init = Math.round(AudioManager.getVolume01()*100);
    volBar.value = String(Math.max(1, init || 40));
  }
  if (seek) {
    let seeking = false;
    seek.addEventListener("input", ()=>{
      seeking = true;
      const frac = Number(seek.value)/Number(seek.max || 1000);
      try { el.currentTime = (el.duration||0) * frac; } catch {}
    });
    seek.addEventListener("change", ()=> seeking=false);
    el.addEventListener("timeupdate", ()=>{
      if (!seeking && isFinite(el.duration) && el.duration>0) {
        const frac = (el.currentTime / el.duration);
        seek.value = String(Math.round(frac * (Number(seek.max||1000))));
      }
      timeLb.textContent = msToLabel(el.currentTime*1000) + " / " + msToLabel((el.duration||0)*1000);
    });
    el.addEventListener("ended", ()=>{
      pauseSelected();
      // 自動で次へ
      if (currentIndex+1 < currentList.length) {
        selectCarouselIndex(currentIndex+1, true);
      }
    });
  }
}

// 検索結果の表示をカードUIへ差し替え
const _orig_searchSongs = searchSongs;
searchSongs = async function() {
  const list = document.getElementById("suggestions");
  if (list) list.innerHTML = ""; // リストは使わない
  showLoading && showLoading();
    try { if (window._searchAbortCtl) { window._searchAbortCtl.abort(); } } catch (e) {}
    const _ctl = new AbortController();
    window._searchAbortCtl = _ctl;
    let _ctlTimer = setTimeout(()=>{ try{ _ctl.abort(); }catch(_){} }, 12000);
    const _opt = { signal: _ctl.signal };
  try {
    if (searchMode === "artist") {
      const q = document.getElementById("songName").value.trim();
      if (artistPhase === 0) {
        if (!q) { ensurePlayerUIVisible(false); return; }
        const res = await fetch(`/search?mode=artist&query=${encodeURIComponent(q, _opt)}`);
        const artists = await res.json();
        // アーティスト一覧をカードで
        renderCarousel(artists.map(a => ({
          artworkUrl: a.artworkUrl,
          trackName: a.artistName || a.trackName,
          artistName: a.artistName || a.trackName,
          trackViewUrl: "", previewUrl: ""
        })));
      } else {
        if (!selectedArtistId) { ensurePlayerUIVisible(false); return; }
        const res = await fetch(`/search?mode=artist&artistId=${encodeURIComponent(selectedArtistId, _opt)}`);
        const songs = await res.json();
        renderCarousel(songs);
      }
    } else {
      const songQ = document.getElementById("songName").value.trim();
      const artistQ = document.getElementById("artistName").value.trim();
      if (!songQ) { ensurePlayerUIVisible(false); return; }
      const res = await fetch(`/search?query=${encodeURIComponent(songQ, _opt)}&artist=${encodeURIComponent(artistQ)}`);
      const songs = await res.json();
      renderCarousel(songs);
    }
  } catch(e) {
    console.error("検索エラー:", e);
    ensurePlayerUIVisible(false);
  } finally { try{ clearTimeout(_ctlTimer); }catch(_){} hideLoading && hideLoading(); }
};

// 初期化：プレイヤーUIイベント
window.addEventListener("DOMContentLoaded", setupPlayerControls);
