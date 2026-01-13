const AudioManager = (() => {
  let audioEl = null;        // <audio>
  let ctx = null;            // AudioContext
  let source = null;         // MediaElementSourceNode
  let gain = null;           // GainNode
  let useWA = false;         // WebAudio を使えているか
  let lastNonZero = 0.4;     // ミュート解除時に戻す音量(0.0-1.0)
  let vol01 = 0.4;
  let playToken = 0;           // 現在の音量(0.0-1.0)

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
      audioEl.volume = 1.0;
    } else {
      audioEl.volume = vol01;  // Fallback
    }
    
    /* v9-ended */
    try {
      audioEl.onended = () => {
        const btn = document.getElementById('playPauseBtn');
        if (btn) btn.textContent = '▶';
      };
    } catch {}
    return audioEl;
  }

  return {
    load(url){
      const myToken = (++playToken);
      const el = ensureNodes();
      try { el.pause(); el.currentTime = 0; } catch {}
      // 他の audio を止める（念のため）
      document.querySelectorAll("audio").forEach(a => { if (a !== el) { try{ a.pause(); }catch{} }});
      el.src = `/preview?url=${encodeURIComponent(url)}`;
      try { el.load(); } catch {}
    },
    async play() { /* v9-playguard */
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
let lockedArtistQuery = ""; // アーティスト確定後、入力が変わったら候補一覧に戻す

let playerControlsEnabled = true;

window.onload = async function () {
  setSearchMode("song");
  await loadSettings();
  await refreshThemeStatus();

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


async function refreshThemeStatus() {
  try {
    const res = await fetch("/theme/status");
    const s = await res.json();
    const link = document.getElementById("theme-link");
    const banner = document.getElementById("themeBanner");
    if (!s || !s.active) {
      if (link) link.style.display = "none";
      if (banner) banner.style.display = "none";
      return;
    }
    if (link) link.style.display = "inline-flex";
    if (banner) {
      const titleEl = document.getElementById("themeTitleText");
      const descEl = document.getElementById("themeDescText");
      const perEl = document.getElementById("themePeriodText");
      if (titleEl) titleEl.textContent = `🎉 テーマ開催中：${s.title || ""}`;
      if (descEl) descEl.textContent = s.description || "";
      if (perEl) {
        const start = s.startAtISO ? new Date(s.startAtISO).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"}) : "";
        const end = s.endAtISO ? new Date(s.endAtISO).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"}) : "";
        perEl.textContent = (start && end) ? `${start} 〜 ${end}` : "";
      }
      banner.style.display = "block";
    }
  } catch (e) {
    // fail silently
  }
}


/* ========== 検索 ========== */
function setSearchMode(mode) {
  searchMode = mode; artistPhase = 0; selectedArtistId = null; lockedArtistQuery = "";
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
  list.innerHTML = "";
  showLoading();

  try {
    if (searchMode === "artist") {
      const q = document.getElementById("songName").value.trim();

      // アーティスト確定後に入力が変わったら、候補一覧へ戻す
      if (artistPhase === 1 && lockedArtistQuery && q !== lockedArtistQuery) {
        artistPhase = 0;
        selectedArtistId = null;
        lockedArtistQuery = "";
        const sel = document.getElementById("selectedArtist");
        if (sel) sel.innerHTML = "";
      }

      if (artistPhase === 0) {
        if (!q) return;

        const res = await fetch(`/search?mode=artist&query=${encodeURIComponent(q)}`);
        const artists = await res.json();

        const wrap = document.createElement("div");
        wrap.className = "artist-list";

        artists.forEach(a => {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "artist-row";

          if (a.artworkUrl) {
            const img = document.createElement("img");
            img.className = "artist-avatar";
            img.src = a.artworkUrl;
            img.alt = "Artist";
            row.appendChild(img);
          } else {
            const ph = document.createElement("div");
            ph.className = "artist-avatar ph";
            ph.textContent = "🎤";
            row.appendChild(ph);
          }

          const meta = document.createElement("div");
          meta.className = "artist-meta";

          const name = document.createElement("div");
          name.className = "artist-name";
          name.textContent = (a.artistName || a.trackName || "").trim() || "（アーティスト）";

          const hint = document.createElement("div");
          hint.className = "artist-hint";
          hint.textContent = "タップして確定";

          meta.appendChild(name);
          meta.appendChild(hint);

          const go = document.createElement("div");
          go.className = "artist-go";
          go.textContent = "›";

          row.appendChild(meta);
          row.appendChild(go);

          row.onclick = () => selectArtist(a);
          wrap.appendChild(row);
        });

        list.appendChild(wrap);
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
  } catch (e) {
    console.error("検索エラー:", e);
  } finally {
    hideLoading();
  }
}



async function selectArtist(artist) {
  selectedArtistId = artist.artistId;
  artistPhase = 1;

  // 入力欄を選んだアーティスト名に揃え、以後この文字列を「確定キー」として保持
  const input = document.getElementById("songName");
  if (input) {
    input.value = (artist.artistName || artist.trackName || input.value || "").trim();
    lockedArtistQuery = input.value.trim();
  } else {
    lockedArtistQuery = (artist.artistName || artist.trackName || "").trim();
  }

  document.getElementById("selectedArtist").innerHTML =
    `<div class="selected-artist-card"><img src="${artist.artworkUrl}" alt="Artist"><div>${artist.artistName || artist.trackName}</div></div>`;
  await fetchArtistTracksAndShow();
}



async function fetchArtistTracksAndShow() {
  if (!selectedArtistId) { ensurePlayerUIVisible(false); return; }
  showLoading && showLoading();
  try {
    const res = await fetch(`/search?mode=artist&artistId=${encodeURIComponent(selectedArtistId)}`);
    const songs = await res.json();
    const cont = document.getElementById("suggestions");
    if (cont) cont.innerHTML = ""; // アーティスト一覧(リスト)を消して、曲一覧へ
    // 曲一覧は従来どおりカード（Carousel）
    renderCarousel(songs);
  } catch (e) {
    console.error("アーティスト曲取得エラー:", e);
    ensurePlayerUIVisible(false);
  } finally {
    hideLoading && hideLoading();
  }
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

function clearInput(inputId){
  const el = document.getElementById(inputId);
  if (!el) return;
  el.value = "";
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
}

/* ---- ローディング ---- */
function showLoading(){ const el = document.getElementById("loadingIndicator"); if (el) el.style.display = "flex"; }
function hideLoading(){ const el = document.getElementById("loadingIndicator"); if (el) el.style.display = "none"; }

/* ---- 管理ログイン API ---- */
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
   横スクロール 3D カード表示 & プレイヤー制御
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

function renderCarousel /* v9-centerfix */(list) {
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

  
  // 端で中央に寄せられるようスペーサー
  setTimeout(buildEdgeSpacers, 0); setTimeout(()=>{ const t=document.getElementById('carouselTrack'); if(t){ t.style.alignItems='center'; }}, 0);
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

  // スワイプ操作
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
    scrollToIndex(i);
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

// 検索結果の表示をカードUIへ差し替え（アーティスト候補はリスト、曲候補はカード）
const _orig_searchSongs = searchSongs;
searchSongs = async function() {
  const list = document.getElementById("suggestions");
  if (list) list.innerHTML = ""; // アーティスト候補フェーズのみここに描画
  showLoading && showLoading();

  try {
    if (searchMode === "artist") {
      const q = document.getElementById("songName").value.trim();

      // アーティスト確定後に入力が変わったら、候補一覧へ戻す
      if (artistPhase === 1 && lockedArtistQuery && q !== lockedArtistQuery) {
        artistPhase = 0;
        selectedArtistId = null;
        lockedArtistQuery = "";
        const sel = document.getElementById("selectedArtist");
        if (sel) sel.innerHTML = "";
        stopPlayback(true);
      }

      if (artistPhase === 0) {
        if (!q) { ensurePlayerUIVisible(false); return; }

        // このフェーズは「アーティスト一覧」だけリスト表示
        ensurePlayerUIVisible(false);

        const res = await fetch(`/search?mode=artist&query=${encodeURIComponent(q)}`);
        const artists = await res.json();

        if (list) {
          const wrap = document.createElement("div");
          wrap.className = "artist-list";

          artists.forEach(a => {
            const row = document.createElement("button");
            row.type = "button";
            row.className = "artist-row";

            if (a.artworkUrl) {
              const img = document.createElement("img");
              img.className = "artist-avatar";
              img.src = a.artworkUrl;
              img.alt = "Artist";
              row.appendChild(img);
            } else {
              const ph = document.createElement("div");
              ph.className = "artist-avatar ph";
              ph.textContent = "🎤";
              row.appendChild(ph);
            }

            const meta = document.createElement("div");
            meta.className = "artist-meta";

            const name = document.createElement("div");
            name.className = "artist-name";
            name.textContent = (a.artistName || a.trackName || "").trim() || "（アーティスト）";

            const hint = document.createElement("div");
            hint.className = "artist-hint";
            hint.textContent = "タップして確定";

            meta.appendChild(name);
            meta.appendChild(hint);

            const go = document.createElement("div");
            go.className = "artist-go";
            go.textContent = "›";

            row.appendChild(meta);
            row.appendChild(go);

            row.onclick = () => selectArtist(a);
            wrap.appendChild(row);
          });

          list.appendChild(wrap);
        }
      } else {
        // 曲一覧フェーズ：従来どおりカード（Carousel）
        await fetchArtistTracksAndShow();
      }
    } else {
      // 曲名(アーティスト)検索：従来どおりカード（Carousel）
      const songQ = document.getElementById("songName").value.trim();
      const artistQ = document.getElementById("artistName").value.trim();
      if (!songQ) { ensurePlayerUIVisible(false); return; }

      const res = await fetch(`/search?query=${encodeURIComponent(songQ)}&artist=${encodeURIComponent(artistQ)}`);
      const songs = await res.json();
      if (list) list.innerHTML = "";
      renderCarousel(songs);
    }
  } catch (e) {
    console.error("検索エラー:", e);
    ensurePlayerUIVisible(false);
  } finally {
    hideLoading && hideLoading();
  }
};

// 初期化：プレイヤーUIイベント

window.addEventListener("DOMContentLoaded", setupPlayerControls);


// ===== Carousel helpers =====
function scrollToIndex(i){
  const wrap = document.getElementById("resultsCarousel");
  const track = document.getElementById("carouselTrack");
  const card = track?.querySelector(`.result-card[data-index="${i}"]`);
  if (!wrap || !track || !card) return;
  const left = card.offsetLeft - (wrap.clientWidth/2 - card.clientWidth/2);
  wrap.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
}

function buildEdgeSpacers(){
  const wrap = document.getElementById("resultsCarousel");
  const track = document.getElementById("carouselTrack");
  if (!wrap || !track) return;
  // remove old spacers
  track.querySelectorAll(".edge-spacer").forEach(e => e.remove());
  const firstCard = track.querySelector(".result-card");
  if (!firstCard) return;
  const cardW = firstCard.clientWidth || 0;
  const pad = Math.max(0, (wrap.clientWidth - cardW)/2);
  const L = document.createElement("div"); L.className = "edge-spacer"; L.style.width = pad + "px";
  const R = document.createElement("div"); R.className = "edge-spacer"; R.style.width = pad + "px";
  track.prepend(L); track.appendChild(R);
}

function snapToNearest(){
  const wrap = document.getElementById("resultsCarousel");
  const cards = Array.from(document.querySelectorAll(".result-card"));
  if (!wrap || !cards.length) return;
  const rect = wrap.getBoundingClientRect();
  const center = rect.left + rect.width/2;
  let nearest = {i:-1, d:1e9};
  cards.forEach((c, idx) => {
    const r = c.getBoundingClientRect();
    const mid = r.left + r.width/2;
    const d = Math.abs(mid - center);
    if (d < nearest.d) nearest = { i: idx, d };
  });
  if (nearest.i >= 0) {
    selectCarouselIndex(nearest.i, false);
  }
}

// ===== Long-press slider (seek/volume) =====
function installLongPressSlider(selector, onChange){
  const el = document.querySelector(selector);
  if (!el) return;
  let holding = false, timer = null;

  const computeFrac = (evt) => {
    const r = el.getBoundingClientRect();
    const x = (evt.clientX ?? (evt.touches && evt.touches[0]?.clientX) ?? 0) - r.left;
    return Math.max(0, Math.min(1, x / Math.max(1, r.width)));
  };

  const updateByEvt = (evt) => {
    const f = computeFrac(evt);
    const val = Math.round(f * (Number(el.max||1000)));
    el.value = String(val);
    el.dispatchEvent(new Event("input", { bubbles:true }));
  };

  const start = (evt) => {
    timer = setTimeout(()=>{
      holding = true;
      el.classList.add("active");
      updateByEvt(evt);
    }, 100); // ≈0.1秒
  };
  const move = (evt) => {
    if (!holding) return;
    evt.preventDefault();
    updateByEvt(evt);
  };
  const end = (_evt) => {
    clearTimeout(timer); timer = null;
    if (holding) { holding = false; el.classList.remove("active"); }
  };

  el.addEventListener("pointerdown", start);
  el.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
}

// スクロール終了を検知して最近傍へスナップ
let scrollTimer = null;
document.getElementById("resultsCarousel")?.addEventListener("scroll", ()=>{
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(()=> snapToNearest(), 120);
}, {passive:true});

window.addEventListener("DOMContentLoaded", ()=>{
  installLongPressSlider('#seekBar', 'seek');
  installLongPressSlider('#volumeBar', 'volume');
});

// === Range progress===
function setRangeProgress(el, frac){
  if (!el) return;
  const f = Math.max(0, Math.min(1, Number(frac)||0));
  el.style.setProperty('--prog', (Math.round(f*100)) + '%');
}

// === 音量バー ===
function installDragSlider(selector, onChange){
  const el = document.querySelector(selector);
  if (!el) return;
  let dragging = false;
  const getFrac = (evt)=>{
    const r = el.getBoundingClientRect();
    const clientX = (evt.touches && evt.touches[0]?.clientX) || evt.clientX || 0;
    return Math.max(0, Math.min(1, (clientX - r.left)/Math.max(1, r.width)));
  };
  const updateFromEvt = (evt)=>{
    const f = getFrac(evt);
    el.value = String(Math.round(f * (Number(el.max||1000))));
    el.dispatchEvent(new Event("input", {bubbles:true}));
  };
  const down = (e)=>{ dragging = true; el.classList.add("active"); updateFromEvt(e); };
  const move = (e)=>{ if (!dragging) return; e.preventDefault(); updateFromEvt(e); };
  const up   = (_)=>{ if (dragging){ dragging=false; el.classList.remove("active"); } };

  el.addEventListener("pointerdown", down);
  window.addEventListener("pointermove", move, {passive:false});
  window.addEventListener("pointerup", up);
}


// === AudioManagerにバーをフックして進捗状況を入力し続ける ===
window.addEventListener('DOMContentLoaded', ()=>{
  const seek = document.getElementById('seekBar');
  const vol  = document.getElementById('volumeBar');
  const playBtn = document.getElementById('playPauseBtn');
  const volBtn  = document.getElementById('volumeBtn');

  // 初期表示を揃える
  setRangeProgress(seek, 0);
  setRangeProgress(vol, (typeof AudioManager?.getVolume01==='function') ? AudioManager.getVolume01() : 0.4);

  // ドラッグスライダー（即時）
  installDragSlider('#seekBar');
  installDragSlider('#volumeBar');

  // 入力時
  if (seek){
    let seeking=false;
    seek.addEventListener('input', ()=>{
      const el = (typeof AudioManager?.element==='function') ? AudioManager.element() : null;
      const f = Number(seek.value)/Number(seek.max||1000);
      setRangeProgress(seek, f);
      if (el && isFinite(el.duration) && el.duration>0){
        try{ el.currentTime = el.duration * f; }catch{}
      }
    });
    // 再生側からの更新
    const el = (typeof AudioManager?.element==='function') ? AudioManager.element() : null;
    if (el){
      el.addEventListener('timeupdate', ()=>{
        if (isFinite(el.duration) && el.duration>0){
          const f = el.currentTime / el.duration;
          seek.value = String(Math.round(f*(Number(seek.max||1000))));
          setRangeProgress(seek, f);
        }
      });
      el.addEventListener('loadedmetadata', ()=>{ setRangeProgress(seek, 0); seek.value = "0"; });
      el.addEventListener('ended', ()=>{ setRangeProgress(seek, 0); seek.value = "0"; if (playBtn) playBtn.textContent='▶'; });
    }
  }
  if (vol){
    vol.addEventListener('input', ()=>{
      const f = Number(vol.value)/Number(vol.max||100);
      setRangeProgress(vol, f);
      if (typeof AudioManager?.setVolume01==='function'){ AudioManager.setVolume01(f); }
      if (volBtn) updateVolumeIcon(volBtn, f, f<=0.001);
    });
    // 初期反映
    const v0 = (typeof AudioManager?.getVolume01==='function') ? AudioManager.getVolume01() : 0.4;
    vol.value = String(Math.round(v0*(Number(vol.max||100))));
    setRangeProgress(vol, v0);
  }

  // ボタンの表示(灰色アイコン)はCSSで。挙動のみここで維持
  if (playBtn){
    playBtn.addEventListener('click', async ()=>{
      const el = (typeof AudioManager?.element==='function') ? AudioManager.element() : null;
      if (!el) return;
      if (el.paused){ try{ await AudioManager.play(); playBtn.textContent='⏸'; }catch{} }
      else { AudioManager.pause(false); playBtn.textContent='▶'; }
    });
  }
  if (volBtn){
    volBtn.addEventListener('click', ()=>{
      if (typeof AudioManager?.isMuted==='function' && typeof AudioManager?.mute==='function'){
        if (AudioManager.isMuted()){ AudioManager.unmute?.(); }
        else { AudioManager.mute(); }
        const v = AudioManager.getVolume01?.() ?? 0;
        if (vol){ vol.value = String(Math.round(v*(Number(vol.max||100)))); setRangeProgress(vol, v); }
        updateVolumeIcon(volBtn, v, v<=0.001);
      }
    });
  }
});


// === Robust snap & edge spacers ===
function buildEdgeSpacers(){
  const wrap = document.getElementById("resultsCarousel");
  const track = document.getElementById("carouselTrack");
  if (!wrap || !track) return;
  track.querySelectorAll(".edge-spacer").forEach(n=>n.remove());
  const card = track.querySelector(".result-card");
  if (!card) return;
  const pad = Math.max(0, (wrap.clientWidth - card.clientWidth)/2);
  const L = document.createElement("div"); L.className="edge-spacer"; L.style.width = pad+"px";
  const R = document.createElement("div"); R.className="edge-spacer"; R.style.width = pad+"px";
  track.prepend(L); track.appendChild(R);
}
function snapToNearest(){
  const wrap = document.getElementById("resultsCarousel");
  const cards = Array.from(document.querySelectorAll(".result-card"));
  if (!wrap || !cards.length) return;
  const center = wrap.getBoundingClientRect().left + wrap.clientWidth/2;
  let best=-1, bestD=1e9;
  cards.forEach((c,i)=>{
    const r=c.getBoundingClientRect(); const mid=r.left+r.width/2;
    const d = Math.abs(mid-center); if (d<bestD){ bestD=d; best=i; }
  });
  if (best>=0){ (typeof selectCarouselIndex==='function') && selectCarouselIndex(best, false); }
}

(function enableDragScroll(){
  const wrap = document.getElementById("resultsCarousel");
  if (!wrap) return;
  const isCoarse = window.matchMedia("(pointer: coarse)").matches;

  let t = null;
  const onScroll = ()=>{ clearTimeout(t); t = setTimeout(()=> (window.snapToNearest && snapToNearest()), 80); };
  wrap.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", ()=>{ setTimeout(window.buildEdgeSpacers||function(){}, 0); });

  if (isCoarse){
    wrap.style.touchAction = "pan-x";
    setTimeout(window.buildEdgeSpacers||function(){}, 0);
    return;
  }

  let dragging=false, startX=0, startScroll=0;
  wrap.addEventListener("pointerdown", (e)=>{
    dragging=true; startX=e.clientX; startScroll=wrap.scrollLeft;
    wrap.style.scrollSnapType="none";
  });
  wrap.addEventListener("pointermove", (e)=>{
    if(!dragging) return; e.preventDefault();
    wrap.scrollLeft = startScroll + (startX - e.clientX);
  }, { passive:false });
  wrap.addEventListener("pointerup", ()=>{
    dragging=false; wrap.style.scrollSnapType="x mandatory";
    window.snapToNearest && snapToNearest();
  });
  setTimeout(window.buildEdgeSpacers||function(){}, 0);
})();

// === Hook: bars install and gray glyph ===
window.addEventListener('DOMContentLoaded', ()=>{
  const seek = document.getElementById('seekBar');
  const vol  = document.getElementById('volumeBar');
  const playBtn = document.getElementById('playPauseBtn');
  const volBtn  = document.getElementById('volumeBtn');

  if (seek) {
    installDragSlider('#seekBar');
    seek.addEventListener('input', ()=>{
      const el = (typeof AudioManager?.element==='function') ? AudioManager.element() : null;
      const f = Number(seek.value)/Number(seek.max||1000);
      setRangeProgress(seek, f);
      if (el && isFinite(el.duration) && el.duration>0){
        try{ el.currentTime = el.duration * f; }catch{}
      }
    });
    const el = (typeof AudioManager?.element==='function') ? AudioManager.element() : null;
    if (el){
      el.addEventListener('timeupdate', ()=>{
        if (isFinite(el.duration) && el.duration>0){
          const f = el.currentTime / el.duration;
          seek.value = String(Math.round(f*(Number(seek.max||1000))));
          setRangeProgress(seek, f);
        }
      });
      el.addEventListener('loadedmetadata', ()=>{ setRangeProgress(seek, 0); seek.value = "0"; });
    }
  }
  if (vol) {
    installDragSlider('#volumeBar');
    vol.addEventListener('input', ()=>{
      const f = Number(vol.value)/Number(vol.max||100);
      setRangeProgress(vol, f);
      if (typeof AudioManager?.setVolume01==='function'){ AudioManager.setVolume01(f); }
      if (volBtn) updateVolumeIcon(volBtn, f, f<=0.001);
    });
    const v0 = (typeof AudioManager?.getVolume01==='function') ? AudioManager.getVolume01() : 0.4;
    vol.value = String(Math.round(v0*(Number(vol.max||100))));
    setRangeProgress(vol, v0);
  }

  if (playBtn){
    playBtn.style.color = '#4b5563';
  }
  if (volBtn){
    const v = (typeof AudioManager?.getVolume01==='function') ? AudioManager.getVolume01() : 0.4;
    updateVolumeIcon(volBtn, v, v<=0.001);
    volBtn.style.color = '#4b5563';
  }
});

/* hook-v7 */
window.addEventListener('DOMContentLoaded', ()=>{
  const seek = document.getElementById('seekBar');
  const vol  = document.getElementById('volumeBar');
  const playBtn = document.getElementById('playPauseBtn');
  const volBtn  = document.getElementById('volumeBtn');

  if (seek){ installDragSlider('#seekBar'); setRangeProgress(seek, Number(seek.value)/Number(seek.max||1000)); }
  if (vol){  installDragSlider('#volumeBar'); setRangeProgress(vol,  Number(vol.value)/Number(vol.max||100)); }

  if (playBtn){ playBtn.style.color = '#4b5563'; }
  if (volBtn){
    try{
      const v = (typeof AudioManager?.getVolume01==='function') ? AudioManager.getVolume01() : 0.4;
      if (typeof updateVolumeIcon==='function') updateVolumeIcon(volBtn, v, v<=0.001);
    }catch{}
    volBtn.style.color = '#4b5563';
  }
});

/* === v9.2: preview stability & no auto-advance on ended (minimal override) === */
(function(){
  try{
    if (typeof AudioManager === "object" && AudioManager && typeof AudioManager.element === "function"){
      // 安定再生版 play を上書き：canplay を待ってから再生
      const _el = AudioManager.element();
      const originalPlay = AudioManager.play?.bind(AudioManager);
      AudioManager.play = async function(){
        const el = AudioManager.element();
        if (!el) return;
        try{
          const AC = window.AudioContext || window.webkitAudioContext;
          if (AC && this._ctx && this._ctx.state === "suspended") await this._ctx.resume();
        }catch{}
        if (el.readyState < 2){
          await new Promise((resolve)=>{
            const oncp = () => { el.removeEventListener("canplay", oncp, { once:true }); resolve(); };
            el.addEventListener("canplay", oncp, { once:true });
          });
        }
        return el.play();
      };

      // 再生終了時に勝手に次へ行くハンドラを抑止（キャプチャで先取り）
      const guardEnded = () => {
        const el = AudioManager.element();
        if (!el) return;
        const handler = (ev) => {
          try{ ev.stopImmediatePropagation?.(); ev.stopPropagation?.(); }catch{}
          const btn = document.getElementById('playPauseBtn');
          if (btn) btn.textContent = '▶';
        };
        el.addEventListener("ended", handler, { capture: true });
      };
      guardEnded();
      // src 変更などで要素が差し替わる可能性があるため、短い間隔で数回だけ再アタッチ
      setTimeout(guardEnded, 200);
      setTimeout(guardEnded, 800);
    }
  }catch(e){ console.warn("v9.2 override error", e); }
})();

//======================= playback-hotfix-v10 (minimal, isolated) =======================

(function(){
  try{
    var AM = (typeof window !== "undefined") ? window.AudioManager : null;
    if (!AM || typeof AM.element !== "function") return;

    // ---- 単一 <audio> の徹底 ----
    var el = AM.element();
    if (!el) return;
    Array.prototype.forEach.call(document.querySelectorAll("audio"), function(a){
      if (a !== el){ try{ a.pause(); }catch(e){} }
    });

    // ---- トークン化 ----
    if (typeof AM._playToken !== "number") AM._playToken = 0;

    // load() を薄くラップ
    var _load = (typeof AM.load === "function") ? AM.load.bind(AM) : null;
    AM.load = function(url){
      var audio = AM.element();
      var my = (++AM._playToken);
      try{ audio.pause(); audio.currentTime = 0; }catch(e){}
      // /preview プロキシ経由で読み込み
      audio.src = "/preview?url=" + encodeURIComponent(url||"");
      try{ audio.load(); }catch(e){}
      audio._playTokenSnapshot = my;
    };

    // play() は canplay 待機 + token 照合
    var _play = (typeof AM.play === "function") ? AM.play.bind(AM) : null;
    AM.play = async function(){
      var audio = AM.element();
      if (!audio) return;
      try{
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC && AM._ctx && AM._ctx.state === "suspended") await AM._ctx.resume();
      }catch(e){}
      if (audio.readyState < 2){
        await new Promise(function(res){
          var oncp = function(){ audio.removeEventListener("canplay", oncp); res(); };
          audio.addEventListener("canplay", oncp, { once:true });
        });
      }
      // 直近の load が自分のものか
      if (audio._playTokenSnapshot !== AM._playToken) return;
      try{ return await audio.play(); }catch(e){ console.warn("playback-hotfix-v10: play failed", e); }
    };

    // ---- ended の自動送りを強制ブロック ----
    function attachEndedGuard(){
      var a = AM.element(); if (!a) return;
      var handler = function(ev){
        try{
          if (ev && ev.stopImmediatePropagation) ev.stopImmediatePropagation();
          if (ev && ev.stopPropagation) ev.stopPropagation();
        }catch(e){}
        var btn = document.getElementById("playPauseBtn");
        if (btn) btn.textContent = "▶";
      };
      a.addEventListener("ended", handler, { capture:true });
    }
    attachEndedGuard();
    setTimeout(attachEndedGuard, 150);
    setTimeout(attachEndedGuard, 600);
  }catch(e){
    console.warn("playback-hotfix-v10 error", e);
  }
})();
/* ===================== /playback-hotfix-v10 ===================== */
