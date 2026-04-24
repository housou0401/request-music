const AudioManager = (() => {
    let audioEl = null;
    let ctx = null;
    let source = null;
    let gain = null;
    let useWA = false;
    let lastNonZero = 0.4;
    let vol01 = 0.4;
    let playToken = 0;
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    function ensureNodes() {
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
        document.querySelectorAll("audio").forEach(a => {
            if (a !== audioEl) {
                try {
                    a.pause();
                }
                catch { }
            }
        });
        if (!ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (AC)
                ctx = new AC();
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
            }
            catch (e) {
                useWA = !!gain;
            }
        }
        if (useWA) {
            audioEl.volume = 1.0;
        }
        else {
            audioEl.volume = vol01;
        }
        try {
            audioEl.onended = () => {
                const btn = document.getElementById('playPauseBtn');
                if (btn)
                    btn.textContent = '▶';
            };
        }
        catch { }
        return audioEl;
    }
    return {
        load(url) {
            const myToken = (++playToken);
            const el = ensureNodes();
            try {
                el.pause();
                el.currentTime = 0;
            }
            catch { }
            document.querySelectorAll("audio").forEach(a => { if (a !== el) {
                try {
                    a.pause();
                }
                catch { }
            } });
            el.src = `/preview?url=${encodeURIComponent(url)}`;
            try {
                el.load();
            }
            catch { }
        },
        async play() {
            const el = ensureNodes();
            if (ctx && ctx.state === "suspended")
                await ctx.resume();
            return el.play();
        },
        pause(reset = false) {
            const el = ensureNodes();
            try {
                el.pause();
                if (reset)
                    el.currentTime = 0;
            }
            catch { }
        },
        setVolume01(v) {
            vol01 = clamp01(v);
            if (gain)
                gain.gain.value = vol01;
            if (!useWA && audioEl)
                audioEl.volume = vol01;
        },
        getVolume01() {
            if (gain)
                return clamp01(gain.gain.value);
            return clamp01(audioEl?.volume ?? vol01);
        },
        mute() {
            lastNonZero = this.getVolume01() || lastNonZero || 0.4;
            this.setVolume01(0);
        },
        unmute() {
            this.setVolume01(Math.max(0.01, lastNonZero || 0.4));
        },
        isMuted() { return this.getVolume01() <= 0.001; },
        element() { return ensureNodes(); }
    };
})();
if (typeof window !== "undefined")
    window.AudioManager = AudioManager;
let searchMode = "song";
let artistPhase = 0;
let selectedArtistId = null;
let lockedArtistQuery = "";
let playerControlsEnabled = true;
window.onload = async function () {
    setSearchMode("song");
    await loadSettings();
    await refreshThemeStatus();
    const songInput = document.getElementById("songName");
    const artistInput = document.getElementById("artistName");
    songInput.addEventListener("input", searchSongs);
    artistInput.addEventListener("input", searchSongs);
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
    }
    catch {
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
            if (link)
                link.style.display = "none";
            if (banner)
                banner.style.display = "none";
            return;
        }
        if (link)
            link.style.display = "inline-flex";
        if (banner) {
            const titleEl = document.getElementById("themeTitleText");
            const descEl = document.getElementById("themeDescText");
            const perEl = document.getElementById("themePeriodText");
            if (titleEl)
                titleEl.textContent = `🎉 テーマ開催中：${s.title || ""}`;
            if (descEl)
                descEl.textContent = s.description || "";
            if (perEl) {
                const start = s.startAtISO ? new Date(s.startAtISO).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "";
                const end = s.endAtISO ? new Date(s.endAtISO).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "";
                perEl.textContent = (start && end) ? `${start} 〜 ${end}` : "";
            }
            banner.style.display = "block";
        }
    }
    catch (e) {
    }
}
function setSearchMode(mode) {
    searchMode = mode;
    artistPhase = 0;
    selectedArtistId = null;
    lockedArtistQuery = "";
    ["songName", "artistName"].forEach(id => { const el = document.getElementById(id); if (el)
        el.value = ""; });
    ["suggestions", "selectedLabel", "selectedSong", "selectedArtist"].forEach(id => {
        const el = document.getElementById(id);
        if (el)
            el.innerHTML = "";
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
    }
    else {
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
function reSearch() { searchSongs(); }
async function searchSongs() {
    const list = document.getElementById("suggestions");
    list.innerHTML = "";
    showLoading();
    try {
        if (searchMode === "artist") {
            const q = document.getElementById("songName").value.trim();
            if (artistPhase === 1 && lockedArtistQuery && q !== lockedArtistQuery) {
                artistPhase = 0;
                selectedArtistId = null;
                lockedArtistQuery = "";
                const sel = document.getElementById("selectedArtist");
                if (sel)
                    sel.innerHTML = "";
            }
            if (artistPhase === 0) {
                if (!q)
                    return;
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
                    }
                    else {
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
            else {
                await fetchArtistTracksAndShow();
            }
        }
        else {
            const songQ = document.getElementById("songName").value.trim();
            const artistQ = document.getElementById("artistName").value.trim();
            if (!songQ)
                return;
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
    }
    catch (e) {
        console.error("検索エラー:", e);
    }
    finally {
        hideLoading();
    }
}
async function selectArtist(artist) {
    selectedArtistId = artist.artistId;
    artistPhase = 1;
    const input = document.getElementById("songName");
    if (input) {
        input.value = (artist.artistName || artist.trackName || input.value || "").trim();
        lockedArtistQuery = input.value.trim();
    }
    else {
        lockedArtistQuery = (artist.artistName || artist.trackName || "").trim();
    }
    const selBox = document.getElementById("selectedArtist");
    if (selBox)
        selBox.innerHTML = "";
    await fetchArtistTracksAndShow();
}
async function fetchArtistTracksAndShow() {
    if (!selectedArtistId) {
        ensurePlayerUIVisible(false);
        return;
    }
    showLoading && showLoading();
    try {
        const res = await fetch(`/search?mode=artist&artistId=${encodeURIComponent(selectedArtistId)}`);
        const songs = await res.json();
        const cont = document.getElementById("suggestions");
        if (cont)
            cont.innerHTML = "";
        renderCarousel(songs);
    }
    catch (e) {
        console.error("アーティスト曲取得エラー:", e);
        ensurePlayerUIVisible(false);
    }
    finally {
        hideLoading && hideLoading();
    }
}
function selectSong(song) {
    const wrap = document.getElementById("selectedSong");
    const label = document.getElementById("selectedLabel");
    if (label)
        label.textContent = "選択中の曲";
    document.getElementById("suggestions").innerHTML = "";
    const artwork = song.artworkUrl || "";
    const title = song.trackName || "(曲名なし)";
    const artist = song.artistName || "アーティスト不明";
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
    setHidden("appleMusicUrlHidden", "appleMusicUrl", song.trackViewUrl);
    setHidden("artworkUrlHidden", "artworkUrl", artwork);
    setHidden("previewUrlHidden", "previewUrl", song.previewUrl);
    const card = wrap.querySelector(".selected-song-card");
    const playBtn = card.querySelector(".play");
    const volBtn = card.querySelector(".vol-btn");
    const volRange = card.querySelector(".vol-range");
    if (song.previewUrl) {
        AudioManager.load(song.previewUrl);
        AudioManager.play().then(() => {
            playBtn.textContent = "■";
            updateVolumeIcon(volBtn, AudioManager.getVolume01(), AudioManager.isMuted());
            const nowVol = AudioManager.getVolume01();
            if (volRange)
                volRange.value = nowVol.toFixed(2);
        }).catch(() => {
            playBtn.textContent = "▶";
        });
    }
    else {
        updateVolumeIcon(volBtn, AudioManager.getVolume01(), AudioManager.isMuted());
        if (volRange)
            volRange.value = AudioManager.getVolume01().toFixed(2);
    }
    playBtn.addEventListener("click", async () => {
        const el = AudioManager.element();
        if (el.paused) {
            try {
                await AudioManager.play();
                playBtn.textContent = "■";
            }
            catch (e) {
                console.warn(e);
            }
        }
        else {
            AudioManager.pause(false);
            playBtn.textContent = "▶";
        }
    });
    volRange.addEventListener("input", (ev) => {
        const v = Number(ev.target.value);
        AudioManager.setVolume01(v);
        updateVolumeIcon(volBtn, v, v <= 0.001);
    });
    volBtn.addEventListener("click", () => {
        if (AudioManager.isMuted()) {
            AudioManager.unmute();
            const v = AudioManager.getVolume01();
            if (volRange)
                volRange.value = v.toFixed(2);
            updateVolumeIcon(volBtn, v, false);
        }
        else {
            AudioManager.mute();
            if (volRange)
                volRange.value = "0";
            updateVolumeIcon(volBtn, 0, true);
        }
    });
}
function updateVolumeIcon(btn, vol, muted) {
    if (!btn)
        return;
    if (muted || vol <= 0.001) {
        btn.textContent = "🔇";
    }
    else if (vol < 0.33) {
        btn.textContent = "🔈";
    }
    else if (vol < 0.66) {
        btn.textContent = "🔉";
    }
    else {
        btn.textContent = "🔊";
    }
}
function setHidden(id, name, val) {
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
function clearSelection() {
    stopPlayback(true);
    document.getElementById("selectedSong").innerHTML = "";
    document.getElementById("selectedLabel").innerHTML = "";
    ["previewUrlHidden", "appleMusicUrlHidden", "artworkUrlHidden"].forEach(id => {
        const el = document.getElementById(id);
        if (el)
            el.value = "";
    });
}
function stopPlayback(resetSrc) {
    try {
        AudioManager.pause(resetSrc);
    }
    catch { }
}
function clearInput(inputId) {
    const el = document.getElementById(inputId);
    if (!el)
        return;
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.focus();
}
function showLoading() { const el = document.getElementById("loadingIndicator"); if (el)
    el.style.display = "flex"; }
function hideLoading() { const el = document.getElementById("loadingIndicator"); if (el)
    el.style.display = "none"; }
async function adminLogin(password) {
    if (!password)
        return;
    try {
        const res = await fetch("/admin-login", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password })
        });
        const data = await res.json();
        if (!data.success) {
            if (data.reason === "bad_password")
                alert("管理者パスワードが違います");
            if (data.reason === "locked")
                alert("管理者ログイン試行の上限に達しました");
        }
    }
    catch (e) {
        console.error("管理者ログインエラー:", e);
    }
}
let currentList = [];
let currentIndex = -1;
let currentPreviewUrl = "";
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
function ensurePlayerUIVisible(show) {
    const car = $("#resultsCarousel");
    const pc = $("#playerControls");
    if (car)
        car.classList.toggle("ux-hidden", !show);
    if (pc)
        pc.classList.toggle("ux-hidden", !show);
}
function msToLabel(ms) {
    if (!isFinite(ms) || ms <= 0)
        return "0:00";
    const sec = Math.floor(ms / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ":" + String(s).padStart(2, "0");
}
function renderCarousel(list) {
    currentList = Array.isArray(list) ? list.slice(0, 30) : [];
    const track = $("#carouselTrack");
    const wrap = $("#resultsCarousel");
    if (!track || !wrap)
        return;
    track.innerHTML = "";
    currentList.forEach((s, i) => {
        const card = document.createElement("div");
        card.className = "result-card";
        card.dataset.index = String(i);
        card.innerHTML = `
      <img class="cover" src="${s.artworkUrl || ""}" alt="Cover">
      <div class="title">${s.trackName || ""}</div>
      <div class="artist">${s.artistName || ""}</div>
    `;
        card.addEventListener("click", () => selectCarouselIndex(i, true));
        track.appendChild(card);
    });
    setTimeout(buildEdgeSpacers, 0);
    setTimeout(() => { const t = document.getElementById('carouselTrack'); if (t) {
        t.style.alignItems = 'center';
    } }, 0);
    const update3D = () => {
        const cards = $$(".result-card");
        const rect = wrap.getBoundingClientRect();
        const center = rect.left + rect.width / 2;
        let nearest = { i: -1, d: 1e9 };
        cards.forEach((c, idx) => {
            const r = c.getBoundingClientRect();
            const mid = r.left + r.width / 2;
            const dx = (mid - center) / rect.width;
            const dist = Math.abs(dx);
            const scale = 0.78 + Math.max(0, 0.30 * (1 - Math.min(1, dist * 2)));
            const ry = -16 * dx;
            c.style.setProperty("--scale", scale.toFixed(3));
            c.style.setProperty("--ry", ry.toFixed(3) + "deg");
            if (dist < nearest.d)
                nearest = { i: idx, d: dist };
        });
        cards.forEach(c => c.classList.remove("selected"));
        if (nearest.i >= 0)
            cards[nearest.i].classList.add("selected");
    };
    wrap._update3D = update3D;
    if (!wrap._update3DBound) {
        wrap.addEventListener("scroll", () => {
            if (typeof wrap._update3D === 'function')
                wrap._update3D();
        }, { passive: true });
        window.addEventListener("resize", () => {
            setTimeout(buildEdgeSpacers, 0);
            if (typeof wrap._update3D === 'function')
                wrap._update3D();
        });
        wrap._update3DBound = true;
    }
    if (!wrap._dragBound) {
        let dragging = false, startX = 0, startScroll = 0;
        let rafId = 0, pendingScrollLeft = null;
        let snapTimer = null;
        const scheduleSnap = () => {
            clearTimeout(snapTimer);
            snapTimer = setTimeout(() => {
                if (typeof snapToNearest === 'function')
                    snapToNearest();
            }, 90);
        };
        wrap.addEventListener('scroll', scheduleSnap, { passive: true });
        const applyScroll = () => {
            rafId = 0;
            if (pendingScrollLeft == null)
                return;
            wrap.scrollLeft = pendingScrollLeft;
            pendingScrollLeft = null;
        };
        wrap.addEventListener("pointerdown", (e) => {
            if (e.pointerType && e.pointerType !== 'mouse')
                return;
            dragging = true;
            startX = e.clientX;
            startScroll = wrap.scrollLeft;
            wrap.style.scrollSnapType = "none";
            wrap.classList.add('dragging');
            try {
                wrap.setPointerCapture(e.pointerId);
            }
            catch { }
        });
        wrap.addEventListener("pointermove", (e) => {
            if (!dragging)
                return;
            e.preventDefault();
            const dx = startX - e.clientX;
            pendingScrollLeft = startScroll + dx;
            if (!rafId)
                rafId = requestAnimationFrame(applyScroll);
        }, { passive: false });
        const endDrag = () => {
            if (!dragging)
                return;
            dragging = false;
            wrap.style.scrollSnapType = "x mandatory";
            wrap.classList.remove('dragging');
            scheduleSnap();
        };
        wrap.addEventListener("pointerup", endDrag);
        wrap.addEventListener("pointercancel", endDrag);
        wrap.addEventListener("lostpointercapture", endDrag);
        wrap._dragBound = true;
    }
    ensurePlayerUIVisible(currentList.length > 0);
    if (currentList.length > 0) {
        setTimeout(() => {
            const first = track.querySelector('.result-card[data-index="0"]');
            if (first) {
                first.scrollIntoView({ behavior: "instant", inline: "center", block: "nearest" });
            }
            selectCarouselIndex(0, false);
            update3D();
        }, 0);
    }
}
function selectCarouselIndex(i, autoPlay = false) {
    i = Math.max(0, Math.min(i, currentList.length - 1));
    currentIndex = i;
    const cards = $$(".result-card");
    cards.forEach(c => c.classList.remove("selected"));
    const sel = cards[i];
    if (sel) {
        sel.classList.add("selected");
        scrollToIndex(i);
    }
    const song = currentList[i] || {};
    const hApple = $("#appleMusicUrlHidden");
    const hArt = $("#artworkUrlHidden");
    const hPrev = $("#previewUrlHidden");
    if (hApple)
        hApple.value = song.trackViewUrl || "";
    if (hArt)
        hArt.value = song.artworkUrl || "";
    if (hPrev)
        hPrev.value = song.previewUrl || "";
    currentPreviewUrl = song.previewUrl || "";
    if (currentPreviewUrl) {
        AudioManager.load(currentPreviewUrl);
        if (autoPlay)
            playSelected();
    }
}
function playSelected() {
    if (!currentPreviewUrl)
        return;
    AudioManager.play().catch(() => { });
    const btn = $("#playPauseBtn");
    if (btn)
        btn.textContent = "⏸";
}
function pauseSelected() {
    AudioManager.pause(false);
    const btn = $("#playPauseBtn");
    if (btn)
        btn.textContent = "▶";
}
function setupPlayerControls() {
    const playBtn = $("#playPauseBtn");
    const volBtn = $("#volumeBtn");
    const volBar = $("#volumeBar");
    const seek = $("#seekBar");
    const timeLb = $("#timeLabel");
    const el = AudioManager.element();
    if (playBtn) {
        playBtn.addEventListener("click", async () => {
            if (el.paused) {
                await AudioManager.play().catch(() => { });
                playBtn.textContent = "⏸";
            }
            else {
                pauseSelected();
            }
        });
    }
    if (volBtn) {
        volBtn.addEventListener("click", () => {
            if (AudioManager.isMuted()) {
                AudioManager.unmute();
                volBtn.textContent = "🔊";
            }
            else {
                AudioManager.mute();
                volBtn.textContent = "🔈";
            }
        });
    }
    if (volBar) {
        volBar.addEventListener("input", () => {
            const v01 = Math.max(0.01, Math.min(1, Number(volBar.value) / 100));
            AudioManager.setVolume01(v01);
            if (v01 <= 0.011) {
                volBtn.textContent = "🔈";
            }
            else {
                volBtn.textContent = "🔊";
            }
        });
        const init = Math.round(AudioManager.getVolume01() * 100);
        volBar.value = String(Math.max(1, init || 40));
    }
    if (seek) {
        let seeking = false;
        seek.addEventListener("input", () => {
            seeking = true;
            const frac = Number(seek.value) / Number(seek.max || 1000);
            try {
                el.currentTime = (el.duration || 0) * frac;
            }
            catch { }
        });
        seek.addEventListener("change", () => seeking = false);
        el.addEventListener("timeupdate", () => {
            if (!seeking && isFinite(el.duration) && el.duration > 0) {
                const frac = (el.currentTime / el.duration);
                seek.value = String(Math.round(frac * (Number(seek.max || 1000))));
            }
            timeLb.textContent = msToLabel(el.currentTime * 1000) + " / " + msToLabel((el.duration || 0) * 1000);
        });
        el.addEventListener("ended", () => {
            pauseSelected();
            if (currentIndex + 1 < currentList.length) {
                selectCarouselIndex(currentIndex + 1, true);
            }
        });
    }
}
const _orig_searchSongs = searchSongs;
searchSongs = async function () {
    const list = document.getElementById("suggestions");
    if (list)
        list.innerHTML = "";
    showLoading && showLoading();
    try {
        if (searchMode === "artist") {
            const q = document.getElementById("songName").value.trim();
            if (artistPhase === 1 && lockedArtistQuery && q !== lockedArtistQuery) {
                artistPhase = 0;
                selectedArtistId = null;
                lockedArtistQuery = "";
                const sel = document.getElementById("selectedArtist");
                if (sel)
                    sel.innerHTML = "";
                stopPlayback(true);
            }
            if (artistPhase === 0) {
                if (!q) {
                    ensurePlayerUIVisible(false);
                    return;
                }
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
                        }
                        else {
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
            }
            else {
                await fetchArtistTracksAndShow();
            }
        }
        else {
            const songQ = document.getElementById("songName").value.trim();
            const artistQ = document.getElementById("artistName").value.trim();
            if (!songQ) {
                ensurePlayerUIVisible(false);
                return;
            }
            const res = await fetch(`/search?query=${encodeURIComponent(songQ)}&artist=${encodeURIComponent(artistQ)}`);
            const songs = await res.json();
            if (list)
                list.innerHTML = "";
            renderCarousel(songs);
        }
    }
    catch (e) {
        console.error("検索エラー:", e);
        ensurePlayerUIVisible(false);
    }
    finally {
        hideLoading && hideLoading();
    }
};
window.addEventListener("DOMContentLoaded", setupPlayerControls);

/* Mobile carousel/player */
(function () {
  const state = { list: [], index: -1, previewUrl: '', scrollTimer: 0, raf: 0, playSeq: 0, tick: 0 };

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  function wrap() { return document.getElementById('resultsCarousel'); }
  function track() { return document.getElementById('carouselTrack'); }
  function cards() { return Array.from((track() || document).querySelectorAll('.result-card')); }
  function esc(v) { return String(v || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function cut(v, max) {
    const s = String(v || '').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  function clampIndex(i) {
    if (!state.list.length) return -1;
    return Math.max(0, Math.min(Number(i) || 0, state.list.length - 1));
  }
  function showPlayer(show) {
    document.getElementById('resultsCarousel')?.classList.toggle('ux-hidden', !show);
    document.getElementById('playerControls')?.classList.toggle('ux-hidden', !show);
  }
  function formatTime(sec) {
    const n = Math.max(0, Math.floor(Number(sec) || 0));
    return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0');
  }
  function setRange(el, frac) {
    if (!el) return;
    const f = Math.max(0, Math.min(1, Number(frac) || 0));
    el.style.setProperty('--prog', Math.round(f * 100) + '%');
  }
  function audio() {
    const AM = window.AudioManager;
    if (!AM || typeof AM.element !== 'function') return null;
    return AM.element();
  }
  function setButton(playing) {
    const btn = document.getElementById('playPauseBtn');
    if (btn) btn.textContent = playing ? '■' : '▶';
  }
  function updatePlayer() {
    const a = audio();
    if (!a) return;
    const seek = document.getElementById('seekBar');
    const label = document.getElementById('timeLabel');
    const duration = Number.isFinite(a.duration) ? a.duration : 0;
    const current = Number.isFinite(a.currentTime) ? a.currentTime : 0;
    const frac = duration > 0 ? current / duration : 0;
    if (seek && !seek.dataset.dragging) {
      seek.value = String(Math.round(frac * Number(seek.max || 1000)));
      setRange(seek, frac);
    }
    if (label) label.textContent = formatTime(current) + ' / ' + formatTime(duration);
    setButton(!!a.src && !a.paused && !a.ended);
  }
  function startTicker() {
    if (state.tick) return;
    const loop = () => {
      updatePlayer();
      const a = audio();
      if (a && !a.paused && !a.ended) state.tick = requestAnimationFrame(loop);
      else state.tick = 0;
    };
    state.tick = requestAnimationFrame(loop);
  }
  function bindAudio() {
    const a = audio();
    if (!a || a.dataset.rmMobileBound === '1') return a;
    a.dataset.rmMobileBound = '1';
    ['loadedmetadata', 'durationchange', 'timeupdate', 'seeked', 'play', 'pause', 'error', 'waiting', 'canplay'].forEach(name => {
      a.addEventListener(name, () => { updatePlayer(); if (name === 'play') startTicker(); });
    });
    a.addEventListener('ended', ev => {
      try { ev.stopImmediatePropagation(); ev.stopPropagation(); } catch {}
      updatePlayer();
      setButton(false);
    }, true);
    return a;
  }
  function nearestIndex() {
    const w = wrap();
    const list = cards();
    if (!w || !list.length) return -1;
    const r = w.getBoundingClientRect();
    const center = r.left + r.width / 2;
    let best = -1;
    let dist = Infinity;
    list.forEach((card, i) => {
      const cr = card.getBoundingClientRect();
      const d = Math.abs((cr.left + cr.width / 2) - center);
      if (d < dist) { dist = d; best = i; }
    });
    return best;
  }
  function updateCards(markNearest) {
    const w = wrap();
    const list = cards();
    if (!w || !list.length) return;
    const r = w.getBoundingClientRect();
    const center = r.left + r.width / 2;
    let nearest = -1;
    let best = Infinity;
    list.forEach((card, i) => {
      const cr = card.getBoundingClientRect();
      const dx = ((cr.left + cr.width / 2) - center) / Math.max(1, r.width);
      const d = Math.abs(dx);
      const scale = 0.84 + Math.max(0, 0.24 * (1 - Math.min(1, d * 2.15)));
      card.style.setProperty('--scale', scale.toFixed(3));
      card.style.setProperty('--ry', (-10 * dx).toFixed(2) + 'deg');
      if (d < best) { best = d; nearest = i; }
    });
    const active = markNearest ? nearest : state.index;
    list.forEach((card, i) => card.classList.toggle('selected', i === active));
  }
  function edgeSpacers() {
    const w = wrap();
    const t = track();
    if (!w || !t) return;
    t.querySelectorAll('.edge-spacer').forEach(el => el.remove());
    const first = t.querySelector('.result-card');
    if (!first) return;
    const pad = Math.max(0, (w.clientWidth - first.offsetWidth) / 2);
    const l = document.createElement('div');
    const r = document.createElement('div');
    l.className = 'edge-spacer';
    r.className = 'edge-spacer';
    l.style.flexBasis = pad + 'px';
    r.style.flexBasis = pad + 'px';
    t.prepend(l);
    t.appendChild(r);
  }
  function setHidden(song) {
    const apple = document.getElementById('appleMusicUrlHidden');
    const art = document.getElementById('artworkUrlHidden');
    const prev = document.getElementById('previewUrlHidden');
    if (apple) apple.value = song.trackViewUrl || song.appleMusicUrl || '';
    if (art) art.value = song.artworkUrl || '';
    if (prev) prev.value = song.previewUrl || '';
  }
  function selectIndex(i, autoplay) {
    const idx = clampIndex(i);
    if (idx < 0) return;
    const song = state.list[idx] || {};
    const changed = state.index !== idx || state.previewUrl !== (song.previewUrl || '');
    state.index = idx;
    state.previewUrl = song.previewUrl || '';
    window.currentIndex = idx;
    window.currentPreviewUrl = state.previewUrl;
    setHidden(song);
    updateCards(false);
    if (changed && state.previewUrl && window.AudioManager) {
      try { window.AudioManager.load(state.previewUrl); } catch {}
      updatePlayer();
    }
    if (autoplay && state.previewUrl) playCurrent();
  }
  function commitCenter(autoplay) {
    const idx = nearestIndex();
    if (idx >= 0) selectIndex(idx, autoplay);
  }
  async function playCurrent() {
    const AM = window.AudioManager;
    if (!AM || !state.previewUrl) return;
    const a = bindAudio();
    if (!a) return;
    const seq = ++state.playSeq;
    try {
      if (!a.src || !a.src.includes(encodeURIComponent(state.previewUrl))) AM.load(state.previewUrl);
      const start = async () => {
        if (seq !== state.playSeq) return;
        await AM.play();
        updatePlayer();
        startTicker();
      };
      if (a.readyState >= 2) await start();
      else a.addEventListener('canplay', start, { once: true });
    } catch {
      setButton(false);
      updatePlayer();
    }
  }
  function scheduleCommit(delay, autoplay) {
    clearTimeout(state.scrollTimer);
    state.scrollTimer = setTimeout(() => commitCenter(autoplay), delay);
  }
  function bindCarousel() {
    const w = wrap();
    if (!w) return;
    let raf = 0;
    w.addEventListener('scroll', () => {
      if (!raf) {
        raf = requestAnimationFrame(() => { raf = 0; updateCards(true); });
      }
      scheduleCommit(150, true);
    }, { passive: true });
    w.addEventListener('touchend', () => scheduleCommit(90, true), { passive: true });
    w.addEventListener('pointerup', () => scheduleCommit(90, true), { passive: true });
    w.addEventListener('click', e => {
      e.preventDefault();
      e.stopImmediatePropagation();
      commitCenter(true);
    }, true);
    if ('onscrollend' in window) w.addEventListener('scrollend', () => commitCenter(true), { passive: true });
  }
  function renderCarousel(list) {
    state.list = Array.isArray(list) ? list.slice(0, 30) : [];
    state.index = -1;
    state.previewUrl = '';
    const oldWrap = wrap();
    if (!oldWrap || !oldWrap.parentNode) return;
    const newWrap = oldWrap.cloneNode(false);
    newWrap.id = 'resultsCarousel';
    newWrap.className = oldWrap.className;
    newWrap.setAttribute('aria-label', oldWrap.getAttribute('aria-label') || '検索結果');
    const t = document.createElement('div');
    t.id = 'carouselTrack';
    t.className = 'carousel-track';
    newWrap.appendChild(t);
    oldWrap.parentNode.replaceChild(newWrap, oldWrap);
    state.list.forEach((song, i) => {
      const card = document.createElement('div');
      card.className = 'result-card';
      card.dataset.index = String(i);
      card.innerHTML = '<img class="cover" src="' + esc(song.artworkUrl || '') + '" alt="Cover">' +
        '<div class="title" title="' + esc(song.trackName || '') + '">' + esc(cut(song.trackName || '', 26)) + '</div>' +
        '<div class="artist" title="' + esc(song.artistName || '') + '">' + esc(cut(song.artistName || '', 22)) + '</div>';
      t.appendChild(card);
    });
    showPlayer(state.list.length > 0);
    bindCarousel();
    requestAnimationFrame(() => {
      edgeSpacers();
      const first = t.querySelector('.result-card[data-index="0"]');
      if (first) newWrap.scrollLeft = Math.max(0, first.offsetLeft - (newWrap.clientWidth / 2 - first.offsetWidth / 2));
      selectIndex(0, false);
      updateCards(false);
    });
  }
  function setupPlayer() {
    bindAudio();
    const AM = window.AudioManager;
    if (!AM) return;
    ['playPauseBtn', 'volumeBtn', 'seekBar', 'volumeBar'].forEach(id => {
      const old = document.getElementById(id);
      if (old && old.parentNode) old.parentNode.replaceChild(old.cloneNode(true), old);
    });
    const playBtn = document.getElementById('playPauseBtn');
    const volumeButton = document.getElementById('volumeBtn');
    const seekBar = document.getElementById('seekBar');
    const volumeBar = document.getElementById('volumeBar');
    if (playBtn) {
      playBtn.textContent = '▶';
      playBtn.addEventListener('click', async () => {
        const a = bindAudio();
        if (!a) return;
        if (!state.previewUrl) commitCenter(false);
        if (!state.previewUrl) return;
        if (a.paused || a.ended) await playCurrent();
        else { AM.pause(false); updatePlayer(); }
      });
    }
    if (volumeButton && volumeBar) {
      const init = Math.max(0, Math.min(1, AM.getVolume01 ? AM.getVolume01() : 0.4));
      volumeBar.value = String(Math.round(init * Number(volumeBar.max || 100)));
      setRange(volumeBar, init);
      volumeButton.textContent = init <= 0.001 ? '🔈' : '🔊';
      volumeButton.addEventListener('click', () => {
        if (AM.isMuted && AM.isMuted()) AM.unmute(); else AM.mute();
        const v = Math.max(0, Math.min(1, AM.getVolume01 ? AM.getVolume01() : 0));
        volumeBar.value = String(Math.round(v * Number(volumeBar.max || 100)));
        setRange(volumeBar, v);
        volumeButton.textContent = v <= 0.001 ? '🔈' : '🔊';
      });
      volumeBar.addEventListener('input', () => {
        const v = Math.max(0, Math.min(1, Number(volumeBar.value) / Number(volumeBar.max || 100)));
        AM.setVolume01(v);
        setRange(volumeBar, v);
        volumeButton.textContent = v <= 0.001 ? '🔈' : '🔊';
      });
    }
    if (seekBar) {
      const seekTo = () => {
        const a = audio();
        if (!a) return;
        const duration = Number.isFinite(a.duration) ? a.duration : 0;
        const frac = Math.max(0, Math.min(1, Number(seekBar.value) / Number(seekBar.max || 1000)));
        setRange(seekBar, frac);
        if (duration > 0) a.currentTime = duration * frac;
        updatePlayer();
      };
      seekBar.addEventListener('input', () => { seekBar.dataset.dragging = '1'; seekTo(); });
      ['change', 'pointerup', 'touchend'].forEach(name => seekBar.addEventListener(name, () => { seekTo(); delete seekBar.dataset.dragging; }, { passive: name === 'touchend' }));
    }
    updatePlayer();
  }
  ready(() => {
    window.renderCarousel = renderCarousel;
    window.selectCarouselIndex = function (i, autoplay = false) { selectIndex(i, autoplay); };
    window.scrollToIndex = function () {};
    window.playSelected = playCurrent;
    window.pauseSelected = function () { window.AudioManager?.pause(false); updatePlayer(); };
    window.setupPlayerControls = setupPlayer;
    setupPlayer();
  });
})();
