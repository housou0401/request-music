    // ------- 管理者ボタン（権限があれば即 /admin） -------
    async function goAdmin() {
      try {
        const me = await fetch('/me').then(r=>r.json());
        if ((me?.loggedIn && (me.user?.role === 'admin' || me.user?.role === 'site_admin')) || (me?.loggedIn && me?.adminSession === true)) {
          location.href = '/admin';
        } else {
          alert('管理者権限がありません。');
        }
      } catch {
        alert('状態を確認できませんでした。');
      }
    }

    // ------- 設定反映（メンテ/募集） -------
    async function applySettingsToUI() {
      try {
        const data = await (await fetch("/settings")).json();

        const maint = document.getElementById("maintenanceOverlay");
        if (maint) { if (data.maintenance) maint.classList.add("show"); else maint.classList.remove("show"); }

        const titleEl = document.getElementById("frontendTitle");
        const modeToggle = document.getElementById("modeToggle");
        const form = document.getElementById("requestForm");
        const stopHost = document.getElementById("stopCardHost");

        if (!data.recruiting) {
          if (titleEl) { titleEl.textContent = "現在募集を終了しています"; titleEl.style.color = "#d00000"; }
          if (modeToggle) modeToggle.classList.add("ux-hidden");
          if (form) Array.from(form.querySelectorAll("input,button,select,textarea")).forEach(el => el.disabled = true);
          if (stopHost) {
            stopHost.innerHTML = `
              <div class="ux-stop-card">
                <div class="ux-stop-title">現在募集を終了しています</div>
                <div class="ux-stop-reason">${data.reason ? ("理由: " + String(data.reason)) : ""}</div>
              </div>`;
          }
        } else {
          titleEl && (titleEl.style.color = "");
          modeToggle && modeToggle.classList.remove("ux-hidden");
          if (form) Array.from(form.querySelectorAll("input,button,select,textarea")).forEach(el => el.disabled = false);
          stopHost && (stopHost.innerHTML = "");
        }

        if (data.frontendTitle) document.getElementById("frontendTitle").textContent = data.frontendTitle;
      } catch (e) {
        console.error("設定反映エラー:", e);
      }
    }

    // ------- ユーザ/トークン -------
    async function fetchMe() {
      try { const r = await fetch('/me'); return await r.json(); }
      catch { return { loggedIn:false }; }
    }



// ---- Penalty UI (Warning / Timed Ban / Permanent Ban) ----
function _ovShow(id){ const el=document.getElementById(id); if(el){ el.classList.add('show'); el.setAttribute('aria-hidden','false'); } }
function _ovHide(id){ const el=document.getElementById(id); if(el){ el.classList.remove('show'); el.setAttribute('aria-hidden','true'); } }
function _setText(id, txt){ const el=document.getElementById(id); if(el) el.textContent = (txt==null? '' : String(txt)); }

function _disableMainForm(disabled){
  const form = document.getElementById('myForm') || document.querySelector('form');
  if(!form) return;
  form.querySelectorAll('input,button,select,textarea').forEach(el=>{
    if (el.id === 'adminBtn') return;
    if (el.id === 'reqTermsOpenBtn' || el.id === 'reqTermsCancelBtn' || el.id === 'reqTermsAgreeBtn') return;
    if (el.id === 'warningOkBtn' || el.id === 'warningCloseX' || el.id === 'banOkBtn' || el.id === 'banCloseX') return;
    try{ el.disabled = !!disabled; }catch{}
  });
}

function applyPenaltyUI(me){
  try{
    const pen = me && me.penalty ? me.penalty : null;
    // 管理者が「なりすまし」で閲覧している場合は UI 停止を出さない
    if (me.adminSession && me.impersonating){ _ovHide('warningOverlay'); _ovHide('banOverlay'); _disableMainForm(false); return; }
    if (!me || !me.loggedIn || !pen){
      _ovHide('warningOverlay'); _ovHide('banOverlay');
      _disableMainForm(false);
      return;
    }

    // ban
    if (pen.banned){
      const until = pen.permanentBan ? '永久停止' : (pen.banUntil ? ('解除予定: ' + new Date(pen.banUntil).toLocaleString('ja-JP', { timeZone:'Asia/Tokyo' })) : '');
      _setText('banUntilText', until);
      _setText('banReasonText', pen.banReason || '現在利用が制限されています。');
      _ovShow('banOverlay');
      _ovHide('warningOverlay');
      _disableMainForm(true);
      return;
    } else {
      _ovHide('banOverlay');
      _disableMainForm(false);
    }

    // warning
    if (pen.warningPending){
      _setText('warningText', pen.warningMessage || '運営から注意があります。');
      _ovShow('warningOverlay');
    } else {
      _ovHide('warningOverlay');
    }
  }catch{
    _ovHide('warningOverlay'); _ovHide('banOverlay');
  }
}

// warning ack
async function ackWarningAndClose(){
  try{ await fetch('/penalty/warning-ack', { method:'POST' }); }catch{}
  _ovHide('warningOverlay');
}
document.addEventListener('click', (e)=>{
  const t = e.target;
  if (!t) return;
  if (t.id === 'warningOkBtn') { ackWarningAndClose(); }
  if (t.id === 'warningCloseX') { ackWarningAndClose(); }
  if (t.id === 'banOkBtn' || t.id === 'banCloseX') { _ovHide('banOverlay'); }
});
// ---- リクエスト送信用 利用規約 ----
let __reqTermsCache = null; // {termsText, termsVersion}
let __reqTermsPending = null; // { type:'register'|'submit', payload:{} }

async function fetchRequestTerms() {
  try {
    const r = await fetch('/request-terms');
    const j = await r.json();
    return { termsText: String(j.termsText ?? ''), termsVersion: Number(j.termsVersion ?? 1) || 1 };
  } catch {
    return { termsText: '', termsVersion: 1 };
  }
}
async function ensureReqTermsLoaded(force=false) {
  if (force || !__reqTermsCache) __reqTermsCache = await fetchRequestTerms();
  return __reqTermsCache;
}

function showReqTermsOverlay() {
  document.getElementById('reqTermsOverlay')?.classList.add('show');
  document.getElementById('reqTermsOverlay')?.setAttribute('aria-hidden','false');
}
function hideReqTermsOverlay() {
  document.getElementById('reqTermsOverlay')?.classList.remove('show');
  document.getElementById('reqTermsOverlay')?.setAttribute('aria-hidden','true');
}
function showReqTermsView() {
  document.getElementById('reqTermsView')?.classList.add('show');
  document.getElementById('reqTermsView')?.setAttribute('aria-hidden','false');
}
function hideReqTermsView() {
  document.getElementById('reqTermsView')?.classList.remove('show');
  document.getElementById('reqTermsView')?.setAttribute('aria-hidden','true');
}

async function openReqTermsModal(type, payload) {
  __reqTermsPending = { type, payload, auto: !!(payload && payload.auto), autoVersion: (payload && payload.autoVersion) ? Number(payload.autoVersion) : null };
  const rt = await ensureReqTermsLoaded();
  const box = document.getElementById('reqTermsText');
  if (box) box.textContent = rt.termsText || '（利用規約が設定されていません）';
  showReqTermsOverlay();
}

async function acceptReqTermsAndContinue() {
  const rt = await ensureReqTermsLoaded();
  const pending = __reqTermsPending;
  if (!pending) { hideReqTermsOverlay(); hideReqTermsView(); return; }

  if (pending.type === 'register') {
    await performRegister(pending.payload.username, pending.payload.adminPassword, rt.termsVersion);
    return;
  }
  if (pending.type === 'submit') {
    try {
      const r = await fetch('/request-terms/accept', { method:'POST' });
      const j = await r.json().catch(()=>({}));
      if (!j.ok) {
        alert('同意の保存に失敗しました。もう一度お試しください。');
        return;
      }
      hideReqTermsView();
      hideReqTermsOverlay();
      __reqTermsPending = null;
      try { sessionStorage.removeItem('reqTermsDismissedVersion'); } catch {}

      // 同意したので再送（submit時のみ）
      const f = pending.payload && pending.payload.form;
      if (f && typeof f.requestSubmit === 'function') {
        window.__reqTermsBypassOnce = true;
        f.requestSubmit();
      }
      return;
    } catch(e) {
      alert('通信エラー: ' + e.message);
    }
  }
}



// リクエスト送信用 利用規約: バージョン更新時は全ユーザーに表示（admin / site_admin は除外）
async function maybeShowUpdatedRequestTerms(me){
  try{
    if (!me || !me.loggedIn) return;
    const role = me.user && me.user.role;
    if (me.adminSession === true || role === 'admin' || role === 'site_admin') return;

    const cur = Number((me.settings && me.settings.requestTermsVersion) ?? 1) || 1;
    const accepted = Number((me.user && me.user.requestTermsAcceptedVersion) ?? 0) || 0;

    if (accepted >= cur) { try{ sessionStorage.removeItem('reqTermsDismissedVersion'); } catch{}; return; }

    const dismissed = Number(sessionStorage.getItem('reqTermsDismissedVersion') || 0) || 0;
    if (dismissed === cur) return;

    await ensureReqTermsLoaded(true);
    await openReqTermsModal('submit', { form: null, auto: true, autoVersion: cur });
  }catch{}
}

    function setAdminButtonVisible(me){
      const btn = document.getElementById('adminBtn');
      if (!btn) return;
      const ok = !!(me && me.loggedIn && ((me.user?.role === 'admin' || me.user?.role === 'site_admin') || me.adminSession === true));
      btn.classList.toggle('ux-hidden', !ok);
    }

    function setSupportButtonVisible(me){
      const a = document.getElementById('supportLink');
      if (!a) return;
      const ok = !!(me && me.loggedIn);
      a.classList.toggle('ux-hidden', !ok);
    }

    function updateTokenInfo(me) {
      const el = document.getElementById('token-info');
      if (!el) return;
      if (!me || !me.loggedIn) { el.textContent = '未登録です。'; return; }
      const name = me.user?.username || 'ユーザー';
      if (me.user?.role === 'admin') {
        el.textContent = `${name} さん 今月の残りトークン: 無制限（管理者）`;
      } else {
        el.textContent = `${name} さんの今月の残りトークン: ${me.user?.tokens ?? 0}`;
      }
    }
    async function ensureRegistered() {
      const me = await fetchMe();
      setAdminButtonVisible(me);
      setSupportButtonVisible(me);
      if (!me.loggedIn) { document.getElementById('welcomeOverlay')?.classList.add('show'); }
      else { updateTokenInfo(me); }
      applyPenaltyUI(me);
      await maybeShowUpdatedRequestTerms(me);
    }

    // BFCache(戻る/進む) で復帰したときにも管理者表示を復元
    window.addEventListener('pageshow', (e) => {
      if (e && e.persisted) ensureRegistered();
    });

// ------- 管理者パス残回数表示 -------
    async function refreshAdminTryInfo() {
      try {
        const r = await fetch('/auth/status');
        const s = await r.json();
        const left = typeof s.adminRegRemaining === 'number' ? s.adminRegRemaining : 3;
        const el = document.getElementById('adminTryInfo');
        if (el) el.textContent = `管理者パスワード残り: ${left} 回`;
        return left;
      } catch {
        const el = document.getElementById('adminTryInfo');
        if (el) el.textContent = `管理者パスワード残り: 3 回`;
        return 3;
      }
    }

    // ------- 登録（利用規約の同意が必須） -------
async function performRegister(username, adminPassword, requestTermsVersion) {
  try {
    const res = await fetch('/register', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ username, adminPassword: adminPassword || undefined, requestTermsVersion })
    });
    const data = await res.json();

    if (data.ok) {
      const roleJa = data.role === 'admin' ? '管理者' : (data.role === 'site_admin' ? 'サイト管理者' : 'ユーザー');
      const nameForAlert = data.username || username || 'ユーザー';
      alert(`✅${roleJa}でログインしました
${nameForAlert} さんようこそ！`);
      document.getElementById('welcomeOverlay')?.classList.remove('show');
      hideReqTermsOverlay();
      hideReqTermsView();
      __reqTermsPending = null;

      const me = await fetchMe();
      setAdminButtonVisible(me);
      setSupportButtonVisible(me);
      updateTokenInfo(me);
      return;
    }

    if (data.reason === 'request_terms_required') {
      // 管理画面でバージョンが更新された等
      await ensureReqTermsLoaded(true);
      alert('利用規約が更新されています。再度ご確認のうえ同意してください。');
      await openReqTermsModal('register', { username, adminPassword });
      return;
    }

    if (data.reason === 'bad_admin_password') {
      const left = (typeof data.remaining === 'number') ? data.remaining : 0;
      alert(`管理者パスワードが違います。残り ${left} 回`);
      const uiPass = document.getElementById('adminPassInput');
      if (uiPass) { uiPass.value = ''; uiPass.focus(); }
      await refreshAdminTryInfo();
      return;
    }
    if (data.reason === 'locked') {
      alert('管理者パスワードの試行上限に達しました。パスワード欄を空にしてユーザーとして登録してください。');
      const uiPass = document.getElementById('adminPassInput');
      if (uiPass) { uiPass.value = ''; uiPass.blur(); }
      await refreshAdminTryInfo();
      return;
    }
    if (data.reason === 'username_required') {
      alert('ユーザー名を入力してください。');
      document.getElementById('usernameInput')?.focus();
      return;
    }
    if (data.reason === 'username_too_short') {
      alert('ユーザー名は2文字以上で入力してください。');
      document.getElementById('usernameInput')?.focus();
      return;
    }
    if (data.reason === 'username_too_long') {
      alert('ユーザー名が長すぎます。（最大24文字）');
      document.getElementById('usernameInput')?.focus();
      return;
    }
    if (data.reason === 'username_invalid') {
      alert('ユーザー名に使えない文字が含まれています。');
      document.getElementById('usernameInput')?.focus();
      return;
    }
    if (data.reason === 'username_taken') {
      alert('そのユーザー名はすでに使用されています。管理運営上、同じユーザー名を使用することはできません。');
      document.getElementById('usernameInput')?.focus();
      return;
    }
    alert('登録に失敗しました。もう一度お試しください。');
  } catch (e) {
    alert('通信エラー: ' + e.message);
  }
}

async function registerNow() {
  const uiName = document.getElementById('usernameInput');
  const uiPass = document.getElementById('adminPassInput');
  const username = (uiName?.value ?? '').trim();
  if (!username) { alert('ユーザー名を入力してください。'); uiName && uiName.focus(); return; }
  if (username.length < 2) { alert('ユーザー名は2文字以上で入力してください。'); uiName && uiName.focus(); return; }
  const adminPassword = (uiPass?.value ?? '').trim();

  // 利用規約の同意モーダルへ
  await openReqTermsModal('register', { username, adminPassword: adminPassword || undefined });
}

    // ------- 旧UIで新エンジンを使う：バインド処理 -------
    const audioEl = document.getElementById('amPreviewAudio');
    let lastVolume = 0.8; audioEl.volume = lastVolume;

    function proxied(url) {
      return `/preview?url=${encodeURIComponent(url)}`;
    }

    // 曲選択後に hidden からプレビューURLを取り出して audio に設定
    function setLegacyPreviewFromHidden() {
      const pv = document.getElementById('previewUrlHidden')?.value?.trim();
      if (!pv) { audioEl.pause(); audioEl.removeAttribute('src'); return; }
      const src = proxied(pv);
      if (audioEl.src !== location.origin + src && audioEl.src !== src) {
        audioEl.src = src;
        try { audioEl.load(); } catch {}
      }
    }

    // 旧UIの再生ボタン＆音量スライダーを検出してバインド
    function wireLegacyPlayerControls() {
      const host = document.getElementById('selectedSong') || document.getElementById('selectedLabel') || document;
      if (!host) return;

      // 再生ボタン候補（文字が「再生」を含む、または▶系、またはそれっぽいクラス）
      const playBtn =
        host.querySelector('button.play, button.play-btn, button#playButton, button[title*="再生"], button[aria-label*="再生"], button') ||
        null;

      // 音量スライダー候補（rangeで 0〜1 / step 0.01 っぽいものを優先）
      let vol = null;
      const ranges = host.querySelectorAll('input[type="range"]');
      for (const r of ranges) {
        const max = (r.getAttribute('max') || '').trim();
        const step = (r.getAttribute('step') || '').trim();
        if (max === '1' || step === '0.01' || r.id?.toLowerCase().includes('volume')) { vol = r; break; }
      }
      if (!vol && ranges.length === 1) vol = ranges[0];

      // --- イベントを一旦解除してから再バインド（同じDOMに何度も付くのを防止）
      if (playBtn) {
        playBtn._bound && playBtn.removeEventListener('click', playBtn._bound);
        playBtn._bound = () => {
          if (!audioEl.src) setLegacyPreviewFromHidden();
          if (audioEl.paused) audioEl.play();
          else audioEl.pause();
        };
        playBtn.addEventListener('click', playBtn._bound);
      }

      if (vol) {
        vol._bound && vol.removeEventListener('input', vol._bound);
        vol._bound = (e) => {
          const v = Number(e.target.value);
          if (!Number.isNaN(v)) { lastVolume = Math.min(1, Math.max(0, v)); audioEl.volume = lastVolume; }
        };
        vol.addEventListener('input', vol._bound);
        // 初期反映
        try { if (typeof vol.value !== 'undefined') vol.value = lastVolume; } catch {}
      }

      // 再生状態に応じてボタン表示を軽くトグル（デザインを壊さないよう最小限）
      function syncBtnUI(playing) {
        if (!playBtn) return;
        playBtn.dataset.playing = playing ? '1' : '0';
        // 文字が「再生」「一時停止」の場合だけトグル（アイコン系は触らない）
        const txt = (playBtn.textContent || '').trim();
        if (txt === '再生' && playing) playBtn.textContent = '一時停止';
        else if (txt === '一時停止' && !playing) playBtn.textContent = '再生';
      }
      audioEl.onplay = () => syncBtnUI(true);
      audioEl.onpause = () => syncBtnUI(false);
      audioEl.onended = () => syncBtnUI(false);
    }

    // `skript.js` 側の選択関数にフックして、曲選択のたびにURLをセット＆UI再バインド
    function tryHookSelection(fnName) {
      if (typeof window[fnName] === 'function') {
        const orig = window[fnName];
        window[fnName] = function(...args) {
          const r = orig.apply(this, args);
          setTimeout(() => {
            setLegacyPreviewFromHidden();
            wireLegacyPlayerControls();
          }, 0);
          return r;
        };
      }
    }

    // `#selectedSong` が差し替わるたびに再バインド
    function observeSelectedSong() {
      const tgt = document.getElementById('selectedSong') || document.body;
      const mo = new MutationObserver(() => {
        setLegacyPreviewFromHidden();
        wireLegacyPlayerControls();
      });
      mo.observe(tgt, { childList: true, subtree: true });
    }

    // ------- 検索の並び替え（クッキー保存 → サーバ側でソート適用） -------
    function setSearchSortCookie(val) {
      const maxAge = 60*60*24*180; // 180日
      document.cookie = `searchSort=${encodeURIComponent(val)}; path=/; max-age=${maxAge}`;
    }

    
    async function startRefillCountdown() {
      try {
        const s = await (await fetch("/settings")).json();
        const day = Number(s.refillDay ?? 1);
        const hour = Number(s.refillHour ?? 0);
        const minute = Number(s.refillMinute ?? 0);
        const tz = s.refillTimezone || "Asia/Tokyo";
        const out = document.getElementById("token-countdown");
        if (!out) return;

        function nextRefillEpoch() {
          const now = new Date();
          // JST(+9) only (Asia/Tokyo; no DST)
          const jstNow = new Date(now.getTime() + 9*60*60*1000);
          let y = jstNow.getUTCFullYear();
          let m = jstNow.getUTCMonth() + 1;
          const last = new Date(y, m, 0).getDate();
          const d = Math.min(day, last);
          function build(y,m){ return Date.UTC(y, m-1, d, hour-9, minute, 0); } // UTC epoch
          let target = build(y, m);
          if (now.getTime() >= target) {
            if (m === 12) { y += 1; m = 1; } else { m += 1; }
            const last2 = new Date(y, m, 0).getDate();
            const d2 = Math.min(day, last2);
            target = Date.UTC(y, m-1, d2, hour-9, minute, 0);
          }
          return target;
        }

        function fmtLeft(ms) {
          if (ms <= 0) return "まもなく配布されます";
          const totalSec = Math.floor(ms/1000);
          const days = Math.floor(totalSec / 86400);
          const hrs = Math.floor((totalSec % 86400) / 3600);
          const mins = Math.floor((totalSec % 3600) / 60);
          const secs = totalSec % 60;
          if (days > 0) return `次回配布まで: ${days}日 ${String(hrs).padStart(2,"0")}:${String(mins).padStart(2,"0")}:${String(secs).padStart(2,"0")}`;
          return `次回配布まで: ${String(hrs).padStart(2,"0")}:${String(mins).padStart(2,"0")}:${String(secs).padStart(2,"0")}`;
        }

        function tick() {
          const target = nextRefillEpoch();
          const ms = target - Date.now();
          out.textContent = fmtLeft(ms) + " (Asia/Tokyo)";
        }
        tick();
        setInterval(tick, 1000);
      } catch (e) {
        console.warn("countdown init failed:", e);
      }
    }
    
    document.addEventListener('DOMContentLoaded', () => {
      applySettingsToUI();
      ensureRegistered();
      startRefillCountdown();
      refreshAdminTryInfo();

// リクエスト送信用 利用規約: ボタン配線
document.getElementById('reqTermsOpenBtn')?.addEventListener('click', async () => {
  const rt = await ensureReqTermsLoaded();
  const box = document.getElementById('reqTermsText');
  if (box) box.textContent = rt.termsText || '（利用規約が設定されていません）';
  showReqTermsView();
});
const closeTermsAll = () => {
  try {
    if (__reqTermsPending && __reqTermsPending.autoVersion) {
      sessionStorage.setItem('reqTermsDismissedVersion', String(__reqTermsPending.autoVersion));
    }
  } catch {}
  hideReqTermsView(); hideReqTermsOverlay(); __reqTermsPending = null;
};
document.getElementById('reqTermsCloseBtn')?.addEventListener('click', closeTermsAll);
document.getElementById('reqTermsCancelBtn')?.addEventListener('click', closeTermsAll);
document.getElementById('reqTermsViewCloseBtn')?.addEventListener('click', hideReqTermsView);
document.getElementById('reqTermsViewCloseX')?.addEventListener('click', hideReqTermsView);
document.getElementById('reqTermsAgreeBtn')?.addEventListener('click', acceptReqTermsAndContinue);
document.getElementById('reqTermsViewAgreeBtn')?.addEventListener('click', acceptReqTermsAndContinue);

// 送信時も利用規約同意チェック（バージョン更新時の再同意含む）
const reqForm = document.getElementById('requestForm');
if (reqForm) {
  reqForm.addEventListener('submit', async (ev) => {
    if (window.__reqTermsBypassOnce) { window.__reqTermsBypassOnce = false; return; }
    const me = await fetchMe();
    if (!me || !me.loggedIn) return;
    const role = me.user?.role;
    if (me.adminSession === true || role === 'admin' || role === 'site_admin') return;

    const rt = await ensureReqTermsLoaded();
    const accepted = Number(me.user?.requestTermsAcceptedVersion ?? 0);
    if (accepted < Number(rt.termsVersion ?? 1)) {
      ev.preventDefault();
      await openReqTermsModal('submit', { form: reqForm });
    }
  }, true); // capture
}

      // ソート選択の初期化
      const sel = document.getElementById('searchSort');
      if (sel) {
        const m = document.cookie.match(/(?:^|;\s*)searchSort=([^;]+)/);
        if (m) { try { sel.value = decodeURIComponent(m[1]); } catch {} }
        sel.addEventListener('change', () => {
          setSearchSortCookie(sel.value);
          if (typeof window.searchSongs === 'function') window.searchSongs();
        });
      }

      // 送信後はトークン表示を更新
      document.getElementById('requestForm')?.addEventListener('submit', () => {
        setTimeout(async () => { updateTokenInfo(await fetchMe()); }, 900);
      });

      // 登録
      document.addEventListener('click', (e) => {
        if (e.target && e.target.id === 'registerBtn') registerNow();
      });

      // 旧UI用フック
      ["selectSong","chooseSong","onSongSelect","applySelection","selectArtist","onPick"].forEach(tryHookSelection);
      observeSelectedSong();
      setLegacyPreviewFromHidden();
      wireLegacyPlayerControls();
    });
  
