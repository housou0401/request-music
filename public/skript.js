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
  ["suggestions","selectedLabel","selectedSong","selectedArtist"].forEach(id => document.getElementById(id).innerHTML = "");
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

/* ========== 曲を選択 → カード描画 & AudioManagerにURLロード ========== */
function selectSong(song) {
  const wrap = document.getElementById("selectedSong");
  const label = document.getElementById("selectedLabel");
  document.getElementById("suggestions").innerHTML = "";

  // 横並びカード（色は#666 / スライダーは幅280px, 1〜100%）
  const initPercent = Math.max(1, Math.round(AudioManager.getVolume01() * 100)) || 40;
  wrap.innerHTML = `
    <div class="selected-song-card" style="display:flex;align-items:center;gap:10px;padding:8px;border:1px solid rgba(0,0,0,.1);border-radius:12px;background:#f3f3f3;">
      <img src="${song.artworkUrl}" alt="Cover" style="width:50px;height:50px;border-radius:6px;object-fit:cover;">
      <div style="flex:1;min-width:0;">
        <div style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${song.trackName}</div>
        <div style="font-size:12px;color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${song.artistName}</div>
      </div>
      <button type="button" id="playPauseBtn" style="background:none;border:none;cursor:pointer;padding:6px;color:#666;font-size:18px;">▶</button>
      <button type="button" id="volumeBtn"    style="background:none;border:none;cursor:pointer;padding:6px;color:#666;font-size:18px;">${initPercent<=1?'🔇':'🔊'}</button>
      <input type="range" min="1" max="100" step="1" value="${initPercent}" id="volumeSlider" style="width:280px;accent-color:#888;">
      <button type="button" class="clear-btn" onclick="clearSelection()" style="background:none;border:none;cursor:pointer;padding:6px;font-size:16px;color:#666;">×</button>
    </div>
  `;

  // hidden fields（送信用）
  setHidden("appleMusicUrlHidden","appleMusicUrl", song.trackViewUrl);
  setHidden("artworkUrlHidden","artworkUrl", song.artworkUrl);
  setHidden("previewUrlHidden","previewUrl", song.previewUrl);
  setHidden("artistHidden","artist", song.artistName || "");

  // 音源ロード（※自動再生はしない）
  if (playerControlsEnabled && song.previewUrl) {
    AudioManager.load(song.previewUrl);
  }

  // UIイベント（毎回新規にバインド：積み重ね防止）
  const playBtn = document.getElementById("playPauseBtn");
  const volBtn  = document.getElementById("volumeBtn");
  const slider  = document.getElementById("volumeSlider");

  const el = AudioManager.element();
  el.onplay  = () => updatePlayPauseUI();
  el.onpause = () => updatePlayPauseUI();
  el.onended = () => updatePlayPauseUI();

  playBtn.onclick = async (e) => {
    e.preventDefault();
    if (el.paused || el.ended) {
      try { await AudioManager.play(); } catch(err){ console.error("play error:", err); }
    } else {
      AudioManager.pause(false);
    }
    updatePlayPauseUI();
  };

  volBtn.onclick = (e) => {
    e.preventDefault();
    if (AudioManager.isMuted()) {
      AudioManager.unmute();
      const p = Math.max(1, Math.round(AudioManager.getVolume01() * 100));
      slider.value = String(p);
    } else {
      AudioManager.mute();
      slider.value = "1"; // ミュート時は1%に寄せる（0%は使わない仕様）
    }
    updateVolumeIcon();
  };

  // スライダー → 音量（1〜100% を 0.01〜1.00 にマッピング）
  slider.oninput = (e) => {
    const p = Math.max(1, Math.min(100, Number(e.target.value)));
    const v01 = p / 100;
    AudioManager.setVolume01(v01);
    updateVolumeIcon();
  };
  slider.onchange = slider.oninput;

  updatePlayPauseUI();
  updateVolumeIcon();
  label.innerHTML = `<div class="selected-label">${song.trackName}・${song.artistName}</div>`;
}

/* ---- UI更新 ---- */
function updatePlayPauseUI() {
  const btn = document.getElementById("playPauseBtn");
  const el = AudioManager.element();
  if (!btn || !el) return;
  const playing = !el.paused && !el.ended;
  btn.textContent = playing ? "Ⅱ" : "▶";
  btn.style.color = "#666";
}
function updateVolumeIcon() {
  const btn = document.getElementById("volumeBtn");
  if (!btn) return;
  const v = AudioManager.getVolume01();
  btn.textContent = v <= 0.011 ? "🔇" : v < 0.35 ? "🔈" : v < 0.7 ? "🔉" : "🔊";
  btn.style.color = "#666";
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
