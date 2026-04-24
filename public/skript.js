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
function scrollToIndex(i) {
    const wrap = document.getElementById("resultsCarousel");
    const track = document.getElementById("carouselTrack");
    const card = track?.querySelector(`.result-card[data-index="${i}"]`);
    if (!wrap || !track || !card)
        return;
    const left = card.offsetLeft - (wrap.clientWidth / 2 - card.clientWidth / 2);
    wrap.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
}
function buildEdgeSpacers() {
    const wrap = document.getElementById("resultsCarousel");
    const track = document.getElementById("carouselTrack");
    if (!wrap || !track)
        return;
    track.querySelectorAll(".edge-spacer").forEach(e => e.remove());
    const firstCard = track.querySelector(".result-card");
    if (!firstCard)
        return;
    const cardW = firstCard.clientWidth || 0;
    const pad = Math.max(0, (wrap.clientWidth - cardW) / 2);
    const L = document.createElement("div");
    L.className = "edge-spacer";
    L.style.width = pad + "px";
    const R = document.createElement("div");
    R.className = "edge-spacer";
    R.style.width = pad + "px";
    track.prepend(L);
    track.appendChild(R);
}
function snapToNearest() {
    const wrap = document.getElementById("resultsCarousel");
    const cards = Array.from(document.querySelectorAll(".result-card"));
    if (!wrap || !cards.length)
        return;
    const rect = wrap.getBoundingClientRect();
    const center = rect.left + rect.width / 2;
    let nearest = { i: -1, d: 1e9 };
    cards.forEach((c, idx) => {
        const r = c.getBoundingClientRect();
        const mid = r.left + r.width / 2;
        const d = Math.abs(mid - center);
        if (d < nearest.d)
            nearest = { i: idx, d };
    });
    if (nearest.i >= 0) {
        selectCarouselIndex(nearest.i, false);
    }
}
function installLongPressSlider(selector, onChange) {
    const el = document.querySelector(selector);
    if (!el)
        return;
    let holding = false, timer = null;
    const computeFrac = (evt) => {
        const r = el.getBoundingClientRect();
        const x = (evt.clientX ?? (evt.touches && evt.touches[0]?.clientX) ?? 0) - r.left;
        return Math.max(0, Math.min(1, x / Math.max(1, r.width)));
    };
    const updateByEvt = (evt) => {
        const f = computeFrac(evt);
        const val = Math.round(f * (Number(el.max || 1000)));
        el.value = String(val);
        el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const start = (evt) => {
        timer = setTimeout(() => {
            holding = true;
            el.classList.add("active");
            updateByEvt(evt);
        }, 100);
    };
    const move = (evt) => {
        if (!holding)
            return;
        evt.preventDefault();
        updateByEvt(evt);
    };
    const end = (_evt) => {
        clearTimeout(timer);
        timer = null;
        if (holding) {
            holding = false;
            el.classList.remove("active");
        }
    };
    el.addEventListener("pointerdown", start);
    el.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
}
let scrollTimer = null;
document.getElementById("resultsCarousel")?.addEventListener("scroll", () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => snapToNearest(), 120);
}, { passive: true });
window.addEventListener("DOMContentLoaded", () => {
    installLongPressSlider('#seekBar', 'seek');
    installLongPressSlider('#volumeBar', 'volume');
});
function setRangeProgress(el, frac) {
    if (!el)
        return;
    const f = Math.max(0, Math.min(1, Number(frac) || 0));
    el.style.setProperty('--prog', (Math.round(f * 100)) + '%');
}
function installDragSlider(selector, onChange) {
    const el = document.querySelector(selector);
    if (!el)
        return;
    let dragging = false;
    const getFrac = (evt) => {
        const r = el.getBoundingClientRect();
        const clientX = (evt.touches && evt.touches[0]?.clientX) || evt.clientX || 0;
        return Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
    };
    const updateFromEvt = (evt) => {
        const f = getFrac(evt);
        el.value = String(Math.round(f * (Number(el.max || 1000))));
        el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const down = (e) => { dragging = true; el.classList.add("active"); updateFromEvt(e); };
    const move = (e) => { if (!dragging)
        return; e.preventDefault(); updateFromEvt(e); };
    const up = (_) => { if (dragging) {
        dragging = false;
        el.classList.remove("active");
    } };
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
}
window.addEventListener('DOMContentLoaded', () => {
    const seek = document.getElementById('seekBar');
    const vol = document.getElementById('volumeBar');
    const playBtn = document.getElementById('playPauseBtn');
    const volBtn = document.getElementById('volumeBtn');
    setRangeProgress(seek, 0);
    setRangeProgress(vol, (typeof AudioManager?.getVolume01 === 'function') ? AudioManager.getVolume01() : 0.4);
    installDragSlider('#seekBar');
    installDragSlider('#volumeBar');
    if (seek) {
        let seeking = false;
        seek.addEventListener('input', () => {
            const el = (typeof AudioManager?.element === 'function') ? AudioManager.element() : null;
            const f = Number(seek.value) / Number(seek.max || 1000);
            setRangeProgress(seek, f);
            if (el && isFinite(el.duration) && el.duration > 0) {
                try {
                    el.currentTime = el.duration * f;
                }
                catch { }
            }
        });
        const el = (typeof AudioManager?.element === 'function') ? AudioManager.element() : null;
        if (el) {
            el.addEventListener('timeupdate', () => {
                if (isFinite(el.duration) && el.duration > 0) {
                    const f = el.currentTime / el.duration;
                    seek.value = String(Math.round(f * (Number(seek.max || 1000))));
                    setRangeProgress(seek, f);
                }
            });
            el.addEventListener('loadedmetadata', () => { setRangeProgress(seek, 0); seek.value = "0"; });
            el.addEventListener('ended', () => { setRangeProgress(seek, 0); seek.value = "0"; if (playBtn)
                playBtn.textContent = '▶'; });
        }
    }
    if (vol) {
        vol.addEventListener('input', () => {
            const f = Number(vol.value) / Number(vol.max || 100);
            setRangeProgress(vol, f);
            if (typeof AudioManager?.setVolume01 === 'function') {
                AudioManager.setVolume01(f);
            }
            if (volBtn)
                updateVolumeIcon(volBtn, f, f <= 0.001);
        });
        const v0 = (typeof AudioManager?.getVolume01 === 'function') ? AudioManager.getVolume01() : 0.4;
        vol.value = String(Math.round(v0 * (Number(vol.max || 100))));
        setRangeProgress(vol, v0);
    }
    if (playBtn) {
        playBtn.addEventListener('click', async () => {
            const el = (typeof AudioManager?.element === 'function') ? AudioManager.element() : null;
            if (!el)
                return;
            if (el.paused) {
                try {
                    await AudioManager.play();
                    playBtn.textContent = '⏸';
                }
                catch { }
            }
            else {
                AudioManager.pause(false);
                playBtn.textContent = '▶';
            }
        });
    }
    if (volBtn) {
        volBtn.addEventListener('click', () => {
            if (typeof AudioManager?.isMuted === 'function' && typeof AudioManager?.mute === 'function') {
                if (AudioManager.isMuted()) {
                    AudioManager.unmute?.();
                }
                else {
                    AudioManager.mute();
                }
                const v = AudioManager.getVolume01?.() ?? 0;
                if (vol) {
                    vol.value = String(Math.round(v * (Number(vol.max || 100))));
                    setRangeProgress(vol, v);
                }
                updateVolumeIcon(volBtn, v, v <= 0.001);
            }
        });
    }
});
function buildEdgeSpacers() {
    const wrap = document.getElementById("resultsCarousel");
    const track = document.getElementById("carouselTrack");
    if (!wrap || !track)
        return;
    track.querySelectorAll(".edge-spacer").forEach(n => n.remove());
    const card = track.querySelector(".result-card");
    if (!card)
        return;
    const pad = Math.max(0, (wrap.clientWidth - card.clientWidth) / 2);
    const L = document.createElement("div");
    L.className = "edge-spacer";
    L.style.width = pad + "px";
    const R = document.createElement("div");
    R.className = "edge-spacer";
    R.style.width = pad + "px";
    track.prepend(L);
    track.appendChild(R);
}
function snapToNearest() {
    const wrap = document.getElementById("resultsCarousel");
    const cards = Array.from(document.querySelectorAll(".result-card"));
    if (!wrap || !cards.length)
        return;
    const center = wrap.getBoundingClientRect().left + wrap.clientWidth / 2;
    let best = -1, bestD = 1e9;
    cards.forEach((c, i) => {
        const r = c.getBoundingClientRect();
        const mid = r.left + r.width / 2;
        const d = Math.abs(mid - center);
        if (d < bestD) {
            bestD = d;
            best = i;
        }
    });
    if (best >= 0) {
        (typeof selectCarouselIndex === 'function') && selectCarouselIndex(best, false);
    }
}
(function enableDragScroll() {
    const wrap = document.getElementById("resultsCarousel");
    if (!wrap)
        return;
    const isCoarse = window.matchMedia("(pointer: coarse)").matches;
    let t = null;
    const onScroll = () => { clearTimeout(t); t = setTimeout(() => (window.snapToNearest && snapToNearest()), 80); };
    wrap.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", () => { setTimeout(window.buildEdgeSpacers || function () { }, 0); });
    if (isCoarse) {
        wrap.style.touchAction = "pan-x";
        setTimeout(window.buildEdgeSpacers || function () { }, 0);
        return;
    }
    let dragging = false, startX = 0, startScroll = 0;
    wrap.addEventListener("pointerdown", (e) => {
        dragging = true;
        startX = e.clientX;
        startScroll = wrap.scrollLeft;
        wrap.style.scrollSnapType = "none";
    });
    wrap.addEventListener("pointermove", (e) => {
        if (!dragging)
            return;
        e.preventDefault();
        wrap.scrollLeft = startScroll + (startX - e.clientX);
    }, { passive: false });
    wrap.addEventListener("pointerup", () => {
        dragging = false;
        wrap.style.scrollSnapType = "x mandatory";
        window.snapToNearest && snapToNearest();
    });
    setTimeout(window.buildEdgeSpacers || function () { }, 0);
})();
window.addEventListener('DOMContentLoaded', () => {
    const seek = document.getElementById('seekBar');
    const vol = document.getElementById('volumeBar');
    const playBtn = document.getElementById('playPauseBtn');
    const volBtn = document.getElementById('volumeBtn');
    if (seek) {
        installDragSlider('#seekBar');
        seek.addEventListener('input', () => {
            const el = (typeof AudioManager?.element === 'function') ? AudioManager.element() : null;
            const f = Number(seek.value) / Number(seek.max || 1000);
            setRangeProgress(seek, f);
            if (el && isFinite(el.duration) && el.duration > 0) {
                try {
                    el.currentTime = el.duration * f;
                }
                catch { }
            }
        });
        const el = (typeof AudioManager?.element === 'function') ? AudioManager.element() : null;
        if (el) {
            el.addEventListener('timeupdate', () => {
                if (isFinite(el.duration) && el.duration > 0) {
                    const f = el.currentTime / el.duration;
                    seek.value = String(Math.round(f * (Number(seek.max || 1000))));
                    setRangeProgress(seek, f);
                }
            });
            el.addEventListener('loadedmetadata', () => { setRangeProgress(seek, 0); seek.value = "0"; });
        }
    }
    if (vol) {
        installDragSlider('#volumeBar');
        vol.addEventListener('input', () => {
            const f = Number(vol.value) / Number(vol.max || 100);
            setRangeProgress(vol, f);
            if (typeof AudioManager?.setVolume01 === 'function') {
                AudioManager.setVolume01(f);
            }
            if (volBtn)
                updateVolumeIcon(volBtn, f, f <= 0.001);
        });
        const v0 = (typeof AudioManager?.getVolume01 === 'function') ? AudioManager.getVolume01() : 0.4;
        vol.value = String(Math.round(v0 * (Number(vol.max || 100))));
        setRangeProgress(vol, v0);
    }
    if (playBtn) {
        playBtn.style.color = '#4b5563';
    }
    if (volBtn) {
        const v = (typeof AudioManager?.getVolume01 === 'function') ? AudioManager.getVolume01() : 0.4;
        updateVolumeIcon(volBtn, v, v <= 0.001);
        volBtn.style.color = '#4b5563';
    }
});
window.addEventListener('DOMContentLoaded', () => {
    const seek = document.getElementById('seekBar');
    const vol = document.getElementById('volumeBar');
    const playBtn = document.getElementById('playPauseBtn');
    const volBtn = document.getElementById('volumeBtn');
    if (seek) {
        installDragSlider('#seekBar');
        setRangeProgress(seek, Number(seek.value) / Number(seek.max || 1000));
    }
    if (vol) {
        installDragSlider('#volumeBar');
        setRangeProgress(vol, Number(vol.value) / Number(vol.max || 100));
    }
    if (playBtn) {
        playBtn.style.color = '#4b5563';
    }
    if (volBtn) {
        try {
            const v = (typeof AudioManager?.getVolume01 === 'function') ? AudioManager.getVolume01() : 0.4;
            if (typeof updateVolumeIcon === 'function')
                updateVolumeIcon(volBtn, v, v <= 0.001);
        }
        catch { }
        volBtn.style.color = '#4b5563';
    }
});
(function () {
    try {
        if (typeof AudioManager === "object" && AudioManager && typeof AudioManager.element === "function") {
            const _el = AudioManager.element();
            const originalPlay = AudioManager.play?.bind(AudioManager);
            AudioManager.play = async function () {
                const el = AudioManager.element();
                if (!el)
                    return;
                try {
                    const AC = window.AudioContext || window.webkitAudioContext;
                    if (AC && this._ctx && this._ctx.state === "suspended")
                        await this._ctx.resume();
                }
                catch { }
                if (el.readyState < 2) {
                    await new Promise((resolve) => {
                        const oncp = () => { el.removeEventListener("canplay", oncp, { once: true }); resolve(); };
                        el.addEventListener("canplay", oncp, { once: true });
                    });
                }
                return el.play();
            };
            const guardEnded = () => {
                const el = AudioManager.element();
                if (!el)
                    return;
                const handler = (ev) => {
                    try {
                        ev.stopImmediatePropagation?.();
                        ev.stopPropagation?.();
                    }
                    catch { }
                    const btn = document.getElementById('playPauseBtn');
                    if (btn)
                        btn.textContent = '▶';
                };
                el.addEventListener("ended", handler, { capture: true });
            };
            guardEnded();
            setTimeout(guardEnded, 200);
            setTimeout(guardEnded, 800);
        }
    }
    catch (e) {
        console.warn("v9.2 override error", e);
    }
})();
(function () {
    try {
        var AM = (typeof window !== "undefined") ? window.AudioManager : null;
        if (!AM || typeof AM.element !== "function")
            return;
        var el = AM.element();
        if (!el)
            return;
        Array.prototype.forEach.call(document.querySelectorAll("audio"), function (a) {
            if (a !== el) {
                try {
                    a.pause();
                }
                catch (e) { }
            }
        });
        if (typeof AM._playToken !== "number")
            AM._playToken = 0;
        var _load = (typeof AM.load === "function") ? AM.load.bind(AM) : null;
        AM.load = function (url) {
            var audio = AM.element();
            var my = (++AM._playToken);
            try {
                audio.pause();
                audio.currentTime = 0;
            }
            catch (e) { }
            audio.src = "/preview?url=" + encodeURIComponent(url || "");
            try {
                audio.load();
            }
            catch (e) { }
            audio._playTokenSnapshot = my;
        };
        var _play = (typeof AM.play === "function") ? AM.play.bind(AM) : null;
        AM.play = async function () {
            var audio = AM.element();
            if (!audio)
                return;
            try {
                var AC = window.AudioContext || window.webkitAudioContext;
                if (AC && AM._ctx && AM._ctx.state === "suspended")
                    await AM._ctx.resume();
            }
            catch (e) { }
            if (audio.readyState < 2) {
                await new Promise(function (res) {
                    var oncp = function () { audio.removeEventListener("canplay", oncp); res(); };
                    audio.addEventListener("canplay", oncp, { once: true });
                });
            }
            if (audio._playTokenSnapshot !== AM._playToken)
                return;
            try {
                return await audio.play();
            }
            catch (e) {
                console.warn("playback-hotfix-v10: play failed", e);
            }
        };
        function attachEndedGuard() {
            var a = AM.element();
            if (!a)
                return;
            var handler = function (ev) {
                try {
                    if (ev && ev.stopImmediatePropagation)
                        ev.stopImmediatePropagation();
                    if (ev && ev.stopPropagation)
                        ev.stopPropagation();
                }
                catch (e) { }
                var btn = document.getElementById("playPauseBtn");
                if (btn)
                    btn.textContent = "▶";
            };
            a.addEventListener("ended", handler, { capture: true });
        }
        attachEndedGuard();
        setTimeout(attachEndedGuard, 150);
        setTimeout(attachEndedGuard, 600);
    }
    catch (e) {
        console.warn("playback-hotfix-v10 error", e);
    }
})();
(function () {
    const onReady = (fn) => {
        if (document.readyState === 'loading')
            document.addEventListener('DOMContentLoaded', fn, { once: true });
        else
            fn();
    };
    function waitForMediaReady(audio, timeoutMs = 2500) {
        return new Promise((resolve, reject) => {
            if (!audio)
                return reject(new Error('audio_missing'));
            if (audio.readyState >= 2)
                return resolve();
            let done = false;
            const cleanup = () => {
                audio.removeEventListener('canplay', onReady);
                audio.removeEventListener('loadedmetadata', onReady);
                audio.removeEventListener('error', onError);
                clearTimeout(timer);
            };
            const onReady = () => {
                if (done)
                    return;
                done = true;
                cleanup();
                resolve();
            };
            const onError = () => {
                if (done)
                    return;
                done = true;
                cleanup();
                reject(audio.error || new Error('media_error'));
            };
            const timer = setTimeout(() => {
                if (done)
                    return;
                done = true;
                cleanup();
                reject(new Error('media_timeout'));
            }, timeoutMs);
            audio.addEventListener('canplay', onReady, { once: true });
            audio.addEventListener('loadedmetadata', onReady, { once: true });
            audio.addEventListener('error', onError, { once: true });
        });
    }
    function enhanceAudioManager() {
        const AM = window.AudioManager;
        if (!AM || typeof AM.element !== 'function')
            return;
        const audio = AM.element();
        if (!audio)
            return;
        audio.preload = 'auto';
        audio.playsInline = true;
        audio.setAttribute('playsinline', '');
        audio.setAttribute('webkit-playsinline', '');
        audio.crossOrigin = 'anonymous';
        if (typeof AM._loadToken !== 'number')
            AM._loadToken = 0;
        AM._userUnlocked = false;
        AM.unlock = async function () {
            const el = AM.element();
            try {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                if (Ctx && el && typeof el.play === 'function') {
                    try {
                        await el.play();
                    }
                    catch { }
                    try {
                        el.pause();
                    }
                    catch { }
                    try {
                        el.currentTime = 0;
                    }
                    catch { }
                }
            }
            catch { }
            AM._userUnlocked = true;
        };
        const unlockOnce = () => {
            AM.unlock?.();
            window.removeEventListener('pointerdown', unlockOnce, true);
            window.removeEventListener('touchstart', unlockOnce, true);
            window.removeEventListener('click', unlockOnce, true);
        };
        window.addEventListener('pointerdown', unlockOnce, true);
        window.addEventListener('touchstart', unlockOnce, true);
        window.addEventListener('click', unlockOnce, true);
        AM.load = function (url) {
            const el = AM.element();
            const token = ++AM._loadToken;
            AM._currentUrl = url || '';
            el._loadToken = token;
            try {
                el.pause();
            }
            catch { }
            try {
                el.currentTime = 0;
            }
            catch { }
            try {
                el.removeAttribute('src');
                el.load();
            }
            catch { }
            if (!url)
                return token;
            el.src = `/preview?url=${encodeURIComponent(url)}`;
            try {
                el.load();
            }
            catch { }
            return token;
        };
        AM.play = async function (expectedToken) {
            const el = AM.element();
            const token = expectedToken ?? el?._loadToken ?? AM._loadToken;
            if (!el || !el.src)
                throw new Error('preview_not_loaded');
            if (el._loadToken !== token)
                return false;
            try {
                await waitForMediaReady(el);
            }
            catch (err) {
                if (el._loadToken !== token)
                    return false;
                throw err;
            }
            if (el._loadToken !== token)
                return false;
            const p = el.play();
            if (p && typeof p.then === 'function')
                await p;
            return true;
        };
        AM.pause = function (reset = false) {
            const el = AM.element();
            try {
                el.pause();
            }
            catch { }
            if (reset) {
                try {
                    el.currentTime = 0;
                }
                catch { }
            }
        };
        audio.onended = null;
        audio.addEventListener('ended', () => {
            const btn = document.getElementById('playPauseBtn');
            if (btn)
                btn.textContent = '▶';
        });
        audio.addEventListener('error', (e) => {
            console.warn('preview playback error', e, audio.error);
            const btn = document.getElementById('playPauseBtn');
            if (btn)
                btn.textContent = '▶';
        });
    }
    function replaceCarouselNode() {
        const oldWrap = document.getElementById('resultsCarousel');
        if (!oldWrap || oldWrap.dataset.v11 === '1')
            return oldWrap;
        const newWrap = oldWrap.cloneNode(true);
        newWrap.dataset.v11 = '1';
        oldWrap.parentNode.replaceChild(newWrap, oldWrap);
        return newWrap;
    }
    function installNativeCarousel() {
        const wrap = replaceCarouselNode();
        const track = document.getElementById('carouselTrack');
        if (!wrap || !track)
            return;
        let rafId = 0;
        let snapTimer = 0;
        const cards = () => Array.from(track.querySelectorAll('.result-card'));
        const update3D = () => {
            rafId = 0;
            const rect = wrap.getBoundingClientRect();
            const center = rect.left + rect.width / 2;
            let nearest = { index: -1, dist: Infinity };
            cards().forEach((card, index) => {
                const r = card.getBoundingClientRect();
                const mid = r.left + r.width / 2;
                const dx = (mid - center) / Math.max(rect.width, 1);
                const dist = Math.abs(dx);
                const scale = 0.82 + Math.max(0, 0.22 * (1 - Math.min(1, dist * 2.2)));
                const ry = -12 * dx;
                card.style.setProperty('--scale', scale.toFixed(3));
                card.style.setProperty('--ry', `${ry.toFixed(2)}deg`);
                if (dist < nearest.dist)
                    nearest = { index, dist };
            });
            cards().forEach((card, index) => card.classList.toggle('selected', index === nearest.index));
        };
        const request3D = () => {
            if (rafId)
                return;
            rafId = requestAnimationFrame(update3D);
        };
        const snapToNearest = () => {
            const list = cards();
            if (!list.length)
                return;
            const rect = wrap.getBoundingClientRect();
            const center = rect.left + rect.width / 2;
            let best = { index: -1, dist: Infinity };
            list.forEach((card, index) => {
                const r = card.getBoundingClientRect();
                const mid = r.left + r.width / 2;
                const dist = Math.abs(mid - center);
                if (dist < best.dist)
                    best = { index, dist };
            });
            if (best.index >= 0 && typeof window.selectCarouselIndex === 'function') {
                window.selectCarouselIndex(best.index, false, { skipScroll: true });
            }
        };
        wrap.addEventListener('scroll', () => {
            request3D();
            clearTimeout(snapTimer);
            snapTimer = setTimeout(snapToNearest, 90);
        }, { passive: true });
        window.addEventListener('resize', () => {
            if (typeof window.buildEdgeSpacers === 'function')
                window.buildEdgeSpacers();
            request3D();
        });
        wrap._request3D = request3D;
        request3D();
    }
    function setPlayButtonState(isPlaying) {
        const btn = document.getElementById('playPauseBtn');
        if (btn)
            btn.textContent = isPlaying ? '⏸' : '▶';
    }
    function overrideSelectionFlow() {
        const AM = window.AudioManager;
        if (!AM)
            return;
        window.playSelected = async function () {
            if (!window.currentPreviewUrl)
                return;
            try {
                setPlayButtonState(true);
                const audio = AM.element();
                const token = audio?._loadToken;
                const ok = await AM.play(token);
                if (!ok)
                    setPlayButtonState(false);
            }
            catch (e) {
                console.warn('playSelected failed', e);
                setPlayButtonState(false);
            }
        };
        window.pauseSelected = function () {
            AM.pause(false);
            setPlayButtonState(false);
        };
        const originalSelect = window.selectCarouselIndex;
        window.selectCarouselIndex = function (i, autoPlay = false, opts = {}) {
            const result = originalSelect ? originalSelect(i, false) : undefined;
            if (opts?.skipScroll !== true && typeof window.scrollToIndex === 'function') {
                window.scrollToIndex(i);
            }
            const song = Array.isArray(window.currentList) ? window.currentList[i] || {} : {};
            window.currentPreviewUrl = song.previewUrl || '';
            if (window.currentPreviewUrl) {
                const token = AM.load(window.currentPreviewUrl);
                if (autoPlay) {
                    Promise.resolve().then(async () => {
                        try {
                            setPlayButtonState(true);
                            const ok = await AM.play(token);
                            if (!ok)
                                setPlayButtonState(false);
                        }
                        catch (e) {
                            console.warn('autoplay failed', e);
                            setPlayButtonState(false);
                        }
                    });
                }
                else {
                    setPlayButtonState(false);
                }
            }
            else {
                setPlayButtonState(false);
            }
            return result;
        };
    }
    function overrideRenderCarousel() {
        window.renderCarousel = function (list) {
            window.currentList = Array.isArray(list) ? list.slice(0, 30) : [];
            const wrap = replaceCarouselNode();
            const track = document.getElementById('carouselTrack');
            if (!wrap || !track)
                return;
            track.innerHTML = '';
            window.currentIndex = -1;
            window.currentPreviewUrl = '';
            window.currentList.forEach((s, i) => {
                const card = document.createElement('button');
                card.type = 'button';
                card.className = 'result-card';
                card.dataset.index = String(i);
                card.innerHTML = `
          <img class="cover" src="${s.artworkUrl || ''}" alt="Cover">
          <div class="title">${s.trackName || ''}</div>
          <div class="artist">${s.artistName || ''}</div>
        `;
                card.addEventListener('click', () => window.selectCarouselIndex(i, true));
                track.appendChild(card);
            });
            if (typeof window.buildEdgeSpacers === 'function')
                window.buildEdgeSpacers();
            installNativeCarousel();
            window.ensurePlayerUIVisible?.(window.currentList.length > 0);
            if (window.currentList.length > 0) {
                requestAnimationFrame(() => {
                    window.selectCarouselIndex(0, false);
                    window.scrollToIndex?.(0);
                    document.getElementById('resultsCarousel')?._request3D?.();
                });
            }
        };
    }
    function overrideSetupPlayerControls() {
        window.setupPlayerControls = function () {
            const AM = window.AudioManager;
            if (!AM)
                return;
            const playBtn = document.getElementById('playPauseBtn');
            const volBtn = document.getElementById('volumeBtn');
            const volBar = document.getElementById('volumeBar');
            const seek = document.getElementById('seekBar');
            const timeLabel = document.getElementById('timeLabel');
            const audio = AM.element();
            if (!audio)
                return;
            if (playBtn && !playBtn.dataset.v11Bound) {
                playBtn.dataset.v11Bound = '1';
                playBtn.onclick = async () => {
                    if (!audio.src && window.currentPreviewUrl)
                        AM.load(window.currentPreviewUrl);
                    if (audio.paused)
                        await window.playSelected?.();
                    else
                        window.pauseSelected?.();
                };
            }
            if (volBtn && !volBtn.dataset.v11Bound) {
                volBtn.dataset.v11Bound = '1';
                volBtn.onclick = () => {
                    if (AM.isMuted())
                        AM.unmute();
                    else
                        AM.mute();
                    const v = AM.getVolume01?.() ?? 0;
                    if (volBar)
                        volBar.value = String(Math.round(v * Number(volBar.max || 100)));
                    if (typeof window.updateVolumeIcon === 'function')
                        window.updateVolumeIcon(volBtn, v, v <= 0.001);
                };
            }
            if (volBar && !volBar.dataset.v11Bound) {
                volBar.dataset.v11Bound = '1';
                volBar.value = String(Math.round((AM.getVolume01?.() ?? 0.4) * Number(volBar.max || 100)));
                volBar.addEventListener('input', () => {
                    const v = Math.max(0, Math.min(1, Number(volBar.value) / Number(volBar.max || 100)));
                    AM.setVolume01(v);
                    if (typeof window.setRangeProgress === 'function')
                        window.setRangeProgress(volBar, v);
                    if (typeof window.updateVolumeIcon === 'function')
                        window.updateVolumeIcon(volBtn, v, v <= 0.001);
                });
            }
            if (seek && !seek.dataset.v11Bound) {
                seek.dataset.v11Bound = '1';
                seek.addEventListener('input', () => {
                    const duration = audio.duration || 0;
                    const f = Number(seek.value) / Number(seek.max || 1000);
                    if (Number.isFinite(duration) && duration > 0) {
                        try {
                            audio.currentTime = duration * f;
                        }
                        catch { }
                    }
                    if (typeof window.setRangeProgress === 'function')
                        window.setRangeProgress(seek, f);
                });
            }
            audio.onended = () => setPlayButtonState(false);
            audio.ontimeupdate = () => {
                const duration = audio.duration || 0;
                const current = audio.currentTime || 0;
                if (seek && Number.isFinite(duration) && duration > 0) {
                    const f = current / duration;
                    seek.value = String(Math.round(f * Number(seek.max || 1000)));
                    if (typeof window.setRangeProgress === 'function')
                        window.setRangeProgress(seek, f);
                }
                if (timeLabel)
                    timeLabel.textContent = `${window.msToLabel?.(current * 1000) || '0:00'} / ${window.msToLabel?.(duration * 1000) || '0:00'}`;
            };
            audio.onloadedmetadata = () => {
                if (seek) {
                    seek.value = '0';
                    if (typeof window.setRangeProgress === 'function')
                        window.setRangeProgress(seek, 0);
                }
                if (timeLabel)
                    timeLabel.textContent = `0:00 / ${window.msToLabel?.((audio.duration || 0) * 1000) || '0:00'}`;
            };
            const v = AM.getVolume01?.() ?? 0.4;
            if (volBar) {
                volBar.value = String(Math.round(v * Number(volBar.max || 100)));
                if (typeof window.setRangeProgress === 'function')
                    window.setRangeProgress(volBar, v);
            }
            if (typeof window.updateVolumeIcon === 'function' && volBtn)
                window.updateVolumeIcon(volBtn, v, v <= 0.001);
            setPlayButtonState(!audio.paused && !!audio.src);
        };
    }
    onReady(() => {
        enhanceAudioManager();
        overrideSelectionFlow();
        overrideRenderCarousel();
        overrideSetupPlayerControls();
        replaceCarouselNode();
        installNativeCarousel();
        window.setupPlayerControls?.();
    });
})();
(function () {
    function onReady(fn) {
        if (document.readyState === 'loading')
            document.addEventListener('DOMContentLoaded', fn, { once: true });
        else
            fn();
    }
    function setPlayButtonState(isPlaying) {
        var btn = document.getElementById('playPauseBtn');
        if (btn)
            btn.textContent = isPlaying ? '⏸' : '▶';
    }
    function installMobileCarousel() {
        var oldWrap = document.getElementById('resultsCarousel');
        if (!oldWrap)
            return;
        var newWrap = oldWrap.cloneNode(true);
        newWrap.dataset.v12 = '1';
        oldWrap.parentNode.replaceChild(newWrap, oldWrap);
        var wrap = newWrap;
        var track = document.getElementById('carouselTrack');
        if (!track)
            return;
        wrap.style.scrollSnapType = 'none';
        wrap.style.webkitOverflowScrolling = 'touch';
        wrap.style.overflowX = 'auto';
        wrap.style.touchAction = 'pan-x';
        var rafId = 0;
        function cards() { return Array.from(track.querySelectorAll('.result-card')); }
        function update3D() {
            rafId = 0;
            var rect = wrap.getBoundingClientRect();
            var center = rect.left + rect.width / 2;
            cards().forEach(function (card) {
                var r = card.getBoundingClientRect();
                var mid = r.left + r.width / 2;
                var dx = (mid - center) / Math.max(rect.width, 1);
                var dist = Math.abs(dx);
                var scale = 0.84 + Math.max(0, 0.18 * (1 - Math.min(1, dist * 2.2)));
                var ry = -10 * dx;
                card.style.setProperty('--scale', scale.toFixed(3));
                card.style.setProperty('--ry', ry.toFixed(2) + 'deg');
            });
        }
        function request3D() {
            if (rafId)
                return;
            rafId = requestAnimationFrame(update3D);
        }
        cards().forEach(function (card) {
            var idx = Number(card.dataset.index || '-1');
            card.onclick = function () {
                if (idx >= 0 && typeof window.selectCarouselIndex === 'function')
                    window.selectCarouselIndex(idx, true, { skipScroll: false });
            };
        });
        wrap.addEventListener('scroll', request3D, { passive: true });
        window.addEventListener('resize', function () {
            if (typeof window.buildEdgeSpacers === 'function')
                window.buildEdgeSpacers();
            request3D();
        });
        wrap._request3D = request3D;
        if (typeof window.buildEdgeSpacers === 'function')
            window.buildEdgeSpacers();
        requestAnimationFrame(function () { request3D(); });
    }
    function patchScrollHelpers() {
        window.scrollToIndex = function (i) {
            var wrap = document.getElementById('resultsCarousel');
            var track = document.getElementById('carouselTrack');
            var card = track && track.querySelector('.result-card[data-index="' + i + '"]');
            if (!wrap || !track || !card)
                return;
            var left = card.offsetLeft - (wrap.clientWidth / 2 - card.clientWidth / 2);
            wrap.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
        };
        window.snapToNearest = function () { };
    }
    function patchRenderCarousel() {
        var original = window.renderCarousel;
        if (typeof original !== 'function')
            return;
        window.renderCarousel = function (list) {
            var result = original(list);
            requestAnimationFrame(function () { installMobileCarousel(); });
            return result;
        };
    }
    function patchSelection() {
        var original = window.selectCarouselIndex;
        if (typeof original !== 'function')
            return;
        window.selectCarouselIndex = function (i, autoPlay, opts) {
            var result = original(i, autoPlay, opts);
            var track = document.getElementById('carouselTrack');
            if (track) {
                Array.from(track.querySelectorAll('.result-card')).forEach(function (card, index) {
                    card.classList.toggle('selected', index === i);
                });
            }
            return result;
        };
    }
    function patchPlayback() {
        var AM = window.AudioManager;
        if (!AM)
            return;
        var audio = AM.element && AM.element();
        if (!audio)
            return;
        audio.onended = function () { setPlayButtonState(false); };
        audio.onerror = function () { setPlayButtonState(false); };
    }
    onReady(function () {
        patchScrollHelpers();
        patchSelection();
        patchRenderCarousel();
        patchPlayback();
        installMobileCarousel();
    });
})();

/* Search and playback */
function truncateCardText(value, max) {
    const text = String(value || '').trim();
    if (text.length <= max) return text;
    return text.slice(0, Math.max(1, max - 1)) + '…';
}

/* Carousel selection */
function getCarouselWrap() {
    return document.getElementById('resultsCarousel');
}
function getCarouselTrack() {
    return document.getElementById('carouselTrack');
}
function getCarouselCards() {
    return Array.from(document.querySelectorAll('.result-card'));
}
function getNearestCarouselIndex() {
    const wrap = getCarouselWrap();
    const cards = getCarouselCards();
    if (!wrap || !cards.length) return -1;
    const rect = wrap.getBoundingClientRect();
    const center = rect.left + rect.width / 2;
    let nearest = { i: -1, d: Number.POSITIVE_INFINITY };
    cards.forEach((card, idx) => {
        const box = card.getBoundingClientRect();
        const mid = box.left + box.width / 2;
        const dist = Math.abs(mid - center);
        if (dist < nearest.d) nearest = { i: idx, d: dist };
    });
    return nearest.i;
}
function centerCardAt(index, behavior = 'smooth') {
    const wrap = getCarouselWrap();
    const track = getCarouselTrack();
    const card = track == null ? void 0 : track.querySelector(`.result-card[data-index="${index}"]`);
    if (!wrap || !track || !card) return;
    const left = card.offsetLeft - (wrap.clientWidth / 2 - card.clientWidth / 2);
    wrap.scrollTo({ left: Math.max(0, left), behavior });
}
function updateCarouselVisuals() {
    const wrap = getCarouselWrap();
    const cards = getCarouselCards();
    if (!wrap || !cards.length) return;
    const rect = wrap.getBoundingClientRect();
    const center = rect.left + rect.width / 2;
    let nearest = -1;
    let best = Number.POSITIVE_INFINITY;
    cards.forEach((card, idx) => {
        const box = card.getBoundingClientRect();
        const mid = box.left + box.width / 2;
        const dx = (mid - center) / Math.max(1, rect.width);
        const dist = Math.abs(dx);
        const scale = 0.8 + Math.max(0, 0.34 * (1 - Math.min(1, dist * 1.9)));
        const ry = -14 * dx;
        card.style.setProperty('--scale', scale.toFixed(3));
        card.style.setProperty('--ry', ry.toFixed(3) + 'deg');
        if (dist < best) {
            best = dist;
            nearest = idx;
        }
    });
    cards.forEach((card, idx) => card.classList.toggle('selected', idx === nearest));
}
function applyCarouselSelection(index, autoPlay = false, center = true, behavior = 'smooth') {
    if (!currentList.length) return;
    const safeIndex = Math.max(0, Math.min(index, currentList.length - 1));
    const song = currentList[safeIndex] || {};
    const sameCard = safeIndex === currentIndex;
    currentIndex = safeIndex;
    getCarouselCards().forEach((card, idx) => card.classList.toggle('selected', idx === safeIndex));
    if (center) centerCardAt(safeIndex, behavior);
    const hApple = document.getElementById('appleMusicUrlHidden');
    const hArt = document.getElementById('artworkUrlHidden');
    const hPrev = document.getElementById('previewUrlHidden');
    if (hApple) hApple.value = song.trackViewUrl || '';
    if (hArt) hArt.value = song.artworkUrl || '';
    if (hPrev) hPrev.value = song.previewUrl || '';
    currentPreviewUrl = song.previewUrl || '';
    if (!currentPreviewUrl) return;
    if (!sameCard) AudioManager.load(currentPreviewUrl);
    if (autoPlay) playSelected();
}

/* Carousel render */
function bindNativeCarouselSelection() {
    const wrap = getCarouselWrap();
    if (!wrap || wrap.dataset.nativeCenterBound === '1') return;
    wrap.dataset.nativeCenterBound = '1';
    let rafId = 0;
    let scrollTimer = 0;
    const onScroll = () => {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
            rafId = 0;
            updateCarouselVisuals();
        });
        window.clearTimeout(scrollTimer);
        scrollTimer = window.setTimeout(() => {
            const nearest = getNearestCarouselIndex();
            if (nearest >= 0) applyCarouselSelection(nearest, true, true, 'smooth');
        }, 110);
    };
    wrap.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', () => {
        buildEdgeSpacers();
        updateCarouselVisuals();
        const nearest = getNearestCarouselIndex();
        if (nearest >= 0) applyCarouselSelection(nearest, false, true, 'auto');
    }, { passive: true });
}
function renderCarousel(list) {
    currentList = Array.isArray(list) ? list.slice(0, 30) : [];
    currentIndex = -1;
    currentPreviewUrl = '';
    const track = getCarouselTrack();
    const wrap = getCarouselWrap();
    if (!track || !wrap) return;
    track.innerHTML = '';
    currentList.forEach((song, index) => {
        const card = document.createElement('div');
        card.className = 'result-card';
        card.dataset.index = String(index);
        card.innerHTML = `
      <img class="cover" src="${song.artworkUrl || ''}" alt="Cover">
      <div class="title">${truncateCardText(song.trackName || '', 26)}</div>
      <div class="artist">${truncateCardText(song.artistName || '', 24)}</div>
    `;
        card.addEventListener('click', () => applyCarouselSelection(index, true, true, 'smooth'));
        track.appendChild(card);
    });
    ensurePlayerUIVisible(currentList.length > 0);
    requestAnimationFrame(() => {
        buildEdgeSpacers();
        bindNativeCarouselSelection();
        updateCarouselVisuals();
        if (currentList.length) applyCarouselSelection(0, false, true, 'auto');
    });
}
function selectCarouselIndex(index, autoPlay = false) {
    applyCarouselSelection(index, autoPlay, true, 'smooth');
}
function scrollToIndex(index) {
    centerCardAt(index, 'smooth');
}
window.addEventListener('DOMContentLoaded', () => {
    const wrap = document.getElementById('resultsCarousel');
    if (wrap && wrap.parentNode && !wrap.dataset.listenersReset) {
        const clone = wrap.cloneNode(true);
        clone.dataset.listenersReset = '1';
        wrap.parentNode.replaceChild(clone, wrap);
    }
    bindNativeCarouselSelection();
});

