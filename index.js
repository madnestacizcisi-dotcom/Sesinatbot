/**
 * Telegram Voice Chat Joiner - Kalıcı Sesli Sohbet Botu
 * Telefon ile giriş · Sesli sohbette kalıcı otur · Asla inmez
 */

'use strict';

const express = require('express');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');
const fs = require('fs');
const path = require('path');

let RTCPeerConnection, RTCAudioSource;
try {
  const wrtc = require('@roamhq/wrtc');
  RTCPeerConnection = wrtc.RTCPeerConnection;
  RTCAudioSource = wrtc.nonstandard.RTCAudioSource;
} catch (e) {
  console.warn('[WRTC] @roamhq/wrtc yüklenemedi:', e.message);
}

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_ID = 2040;
const API_HASH = 'b18441a1ff607e10a989891a5462e627';
const SESSION_FILE = path.join(__dirname, 'session.txt');
const DATA_FILE = path.join(__dirname, 'data.json');

// ─── Veri yönetimi ─────────────────────────────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {}
  return { chatId: '', logs: [] };
}
function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(appData, null, 2)); } catch (e) {}
}

let appData = loadData();
let logs = appData.logs || [];

function log(msg, type = 'info') {
  const entry = { msg: String(msg), type, time: new Date().toLocaleTimeString('tr-TR') };
  logs.unshift(entry);
  if (logs.length > 300) logs.length = 300;
  appData.logs = logs;
  saveData();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

// ─── Durum ─────────────────────────────────────────────────────────────────
let tgClient = null;
let connected = false;      // Telegram'a bağlı mı?
let authStep = 'idle';      // idle | code_sent | need_2fa | done
let phoneNumber = '';
let phoneCodeHash = '';

let vcActive = false;       // Seste mi?
let vcChatId = '';
let vcPeerConn = null;      // WebRTC bağlantısı
let vcWatchdog = null;      // Watchdog timer (kopunca tekrar girer)
let vcRejoinCount = 0;

// ─── Oturum ────────────────────────────────────────────────────────────────
function saveSession(s) { try { fs.writeFileSync(SESSION_FILE, s, 'utf8'); } catch (e) {} }
function loadSession() {
  try { return fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, 'utf8').trim() : ''; } catch (e) { return ''; }
}

// ─── Otomatik giriş ────────────────────────────────────────────────────────
async function autoLogin() {
  const saved = loadSession();
  if (!saved) { log('Kayıtlı oturum yok. Telefon ile giriş yapın.', 'warn'); return; }
  try {
    tgClient = new TelegramClient(new StringSession(saved), API_ID, API_HASH, { connectionRetries: 5 });
    await tgClient.connect();
    if (await tgClient.isUserAuthorized()) {
      connected = true;
      authStep = 'done';
      log('✅ Oturum otomatik yüklendi.', 'success');
      // Daha önce aktif chat varsa otomatik gir
      if (appData.chatId && appData.vcWasActive) {
        vcChatId = appData.chatId;
        log(`🔄 Önceki ses oturumu geri yükleniyor: ${vcChatId}`, 'info');
        setTimeout(() => joinVoiceChat(vcChatId), 3000);
      }
    }
  } catch (e) {
    log('Oturum yüklenemedi: ' + e.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// VOICE CHAT — SDP Yardımcıları
// ═══════════════════════════════════════════════════════════════════════════

/** WebRTC local SDP'den Telegram'ın beklediği JSON parametrelerini çıkar */
function sdpToParams(sdp) {
  const lines = sdp.split(/\r?\n/);
  let ufrag = '', pwd = '', fingerprint = null, ssrc = 0;
  for (const line of lines) {
    if (line.startsWith('a=ice-ufrag:')) ufrag = line.slice(12).trim();
    else if (line.startsWith('a=ice-pwd:')) pwd = line.slice(10).trim();
    else if (line.startsWith('a=fingerprint:')) {
      const parts = line.slice(14).trim().split(' ');
      fingerprint = { hash: parts[0], fingerprint: parts[1], setup: 'active' };
    } else if (line.startsWith('a=ssrc:') && !line.includes('cname') && !ssrc) {
      ssrc = parseInt(line.slice(7).split(' ')[0], 10) || 0;
    }
  }
  return { ufrag, pwd, fingerprints: fingerprint ? [fingerprint] : [], ssrc, 'ssrc-groups': [] };
}

/**
 * Telegram'ın yanıt parametrelerinden WebRTC için SDP answer üret.
 * localSdp: bizim offer SDP'miz (track bilgilerini almak için referans)
 */
function paramsToAnswerSdp(params, localSdp) {
  const localLines = localSdp.split(/\r?\n/);

  // Local SDP'den m= satırı ve codec bilgilerini al
  let mLineAudio = '', localFmtpLines = [], localRtpmapLines = [], localSetup = '', midLine = '';
  let inAudio = false;
  for (const line of localLines) {
    if (line.startsWith('m=audio')) { inAudio = true; mLineAudio = line; continue; }
    if (line.startsWith('m=') && !line.startsWith('m=audio')) { inAudio = false; }
    if (!inAudio) continue;
    if (line.startsWith('a=rtpmap:')) localRtpmapLines.push(line);
    if (line.startsWith('a=fmtp:')) localFmtpLines.push(line);
    if (line.startsWith('a=setup:')) localSetup = line;
    if (line.startsWith('a=mid:')) midLine = line;
  }

  const ufrag = params.ufrag || '';
  const pwd = params.pwd || '';
  const fp = (params.fingerprints || [])[0] || {};

  // Telegram'ın gönderdiği transport / candidate bilgileri
  const transport = params.transport || {};
  const transportUfrag = transport.ufrag || ufrag;
  const transportPwd = transport.pwd || pwd;
  const transportFp = (transport.fingerprints || [])[0] || fp;
  const candidates = transport.candidates || params.candidates || [];

  let candidateLines = '';
  for (const c of candidates) {
    candidateLines += `a=candidate:${c.foundation || 1} ${c.component || 1} ${c.protocol || 'udp'} ${c.priority || 1} ${c.ip || c.address || '0.0.0.0'} ${c.port || 0} typ ${c.type || 'host'}\r\n`;
  }
  if (!candidateLines) candidateLines = 'a=candidate:1 1 udp 1 0.0.0.0 0 typ host\r\n';

  // Setup: offer=active → answer=passive, offer=passive → answer=active
  const remoteSetup = localSetup.includes('active') ? 'a=setup:passive' : 'a=setup:active';

  const ssrc = params.ssrc || 0;

  let sdp = 'v=0\r\n'
    + 'o=- 0 0 IN IP4 127.0.0.1\r\n'
    + 's=-\r\n'
    + 't=0 0\r\n'
    + 'a=group:BUNDLE 0\r\n'
    + `${mLineAudio || 'm=audio 1 RTP/SAVPF 111'}\r\n`
    + 'c=IN IP4 0.0.0.0\r\n'
    + `a=ice-ufrag:${transportUfrag}\r\n`
    + `a=ice-pwd:${transportPwd}\r\n`
    + (transportFp.fingerprint ? `a=fingerprint:${transportFp.hash || 'sha-256'} ${transportFp.fingerprint}\r\n` : '')
    + `${remoteSetup}\r\n`
    + `${midLine || 'a=mid:0'}\r\n`
    + 'a=recvonly\r\n'
    + localRtpmapLines.map(l => l + '\r\n').join('')
    + localFmtpLines.map(l => l + '\r\n').join('')
    + candidateLines
    + 'a=end-of-candidates\r\n'
    + (ssrc ? `a=ssrc:${ssrc} cname:remote\r\n` : '');

  return sdp;
}

// ═══════════════════════════════════════════════════════════════════════════
// VOICE CHAT — Giriş / Çıkış
// ═══════════════════════════════════════════════════════════════════════════

async function joinVoiceChat(chatId) {
  if (!tgClient || !connected) throw new Error('Telegram bağlantısı yok');
  if (!RTCPeerConnection) throw new Error('@roamhq/wrtc yüklü değil (npm install @roamhq/wrtc)');

  log(`🎙️ Sesli sohbete giriliyor: ${chatId}`, 'info');

  // Eski bağlantıyı temizle
  cleanupWebRTC();

  // ── Grup çağrısını bul ────────────────────────────────────────────────
  const inputPeer = await tgClient.getInputEntity(chatId).catch(e => { throw new Error('Chat bulunamadı: ' + e.message); });

  let callRef;
  try {
    const full = await tgClient.invoke(new Api.channels.GetFullChannel({ channel: inputPeer }));
    callRef = full.fullChat.call;
  } catch (e) {
    try {
      const full = await tgClient.invoke(new Api.messages.GetFullChat({ chatId: inputPeer.chatId }));
      callRef = full.fullChat.call;
    } catch (e2) { throw new Error('Sohbet bilgisi alınamadı: ' + e2.message); }
  }

  if (!callRef) throw new Error('Bu sohbette aktif sesli sohbet bulunamadı. Önce grupta bir ses açın.');

  // ── WebRTC offer oluştur ──────────────────────────────────────────────
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    sdpSemantics: 'unified-plan',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  });
  vcPeerConn = pc;

  // Sessiz ses kaynağı ekle (mikrofon yok, sadece bağlantı için)
  const audioSource = new RTCAudioSource();
  const audioTrack = audioSource.createTrack();
  pc.addTrack(audioTrack);

  // Offer oluştur
  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
  await pc.setLocalDescription(offer);

  // ICE gathering tamamlanana kadar bekle (maks 4 saniye)
  await new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(resolve, 4000);
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); } };
  });

  const localSdp = pc.localDescription.sdp;
  const offerParams = sdpToParams(localSdp);

  if (!offerParams.ufrag || !offerParams.pwd) throw new Error('SDP parametreleri oluşturulamadı');

  log(`📡 WebRTC offer hazır. SSRC: ${offerParams.ssrc}`, 'info');

  // ── Telegram'a katılım isteği ─────────────────────────────────────────
  const joinResult = await tgClient.invoke(new Api.phone.JoinGroupCall({
    call: new Api.InputGroupCall({ id: callRef.id, accessHash: callRef.accessHash }),
    params: new Api.DataJSON({ data: JSON.stringify(offerParams) }),
    muted: true,
    videoStopped: true,
    joinAs: new Api.InputPeerSelf()
  }));

  // ── Answer işle ──────────────────────────────────────────────────────
  let answered = false;
  for (const upd of (joinResult.updates || [])) {
    if (upd.className === 'UpdateGroupCallConnection') {
      try {
        const answerParams = JSON.parse(upd.params.data);
        const answerSdp = paramsToAnswerSdp(answerParams, localSdp);
        await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
        answered = true;
        log('✅ WebRTC answer alındı ve uygulandı.', 'success');
      } catch (e) {
        log('Answer SDP hatası (bağlantı yine de devam eder): ' + e.message, 'warn');
        answered = true; // devam et
      }
      break;
    }
  }
  if (!answered) log('Answer paketi gelmedi, bağlantı kısmi modda.', 'warn');

  // Bağlantı durumunu izle
  pc.onconnectionstatechange = () => {
    log(`🔗 WebRTC durum: ${pc.connectionState}`, 'info');
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState) && vcActive) {
      log('⚠️ WebRTC bağlantısı koptu. 5 saniye sonra tekrar girilecek...', 'warn');
      setTimeout(() => { if (vcActive) rejoinVoiceChat(); }, 5000);
    }
  };

  vcActive = true;
  vcChatId = chatId;
  appData.chatId = chatId;
  appData.vcWasActive = true;
  saveData();

  // Watchdog: her 45 saniyede bir Telegram'da hâlâ aktif mi kontrol et
  startWatchdog(callRef);

  log(`🎙️ Seste oturuyorum: ${chatId}`, 'success');
  vcRejoinCount = 0;
}

function startWatchdog(callRef) {
  clearInterval(vcWatchdog);
  vcWatchdog = setInterval(async () => {
    if (!vcActive || !tgClient) return;
    try {
      await tgClient.invoke(new Api.phone.CheckGroupCall({
        call: new Api.InputGroupCall({ id: callRef.id, accessHash: callRef.accessHash }),
        sources: []
      }));
    } catch (e) {
      // Grup çağrısı bitti veya atıldık → tekrar gir
      if (vcActive) {
        log('⚠️ Watchdog: Grup çağrısı durumu değişti, tekrar giriliyor...', 'warn');
        rejoinVoiceChat();
      }
    }
  }, 45000);
}

async function rejoinVoiceChat() {
  if (!vcActive || !vcChatId) return;
  vcRejoinCount++;
  log(`🔄 Tekrar giriliyor (${vcRejoinCount}. deneme): ${vcChatId}`, 'warn');
  try {
    await joinVoiceChat(vcChatId);
  } catch (e) {
    log('Yeniden giriş hatası: ' + e.message + ' — 15sn sonra tekrar.', 'error');
    setTimeout(() => { if (vcActive) rejoinVoiceChat(); }, 15000);
  }
}

async function leaveVoiceChat() {
  vcActive = false;
  appData.vcWasActive = false;
  saveData();
  clearInterval(vcWatchdog);
  vcWatchdog = null;

  cleanupWebRTC();

  if (tgClient && vcChatId) {
    try {
      const inputPeer = await tgClient.getInputEntity(vcChatId);
      let callRef;
      try {
        const full = await tgClient.invoke(new Api.channels.GetFullChannel({ channel: inputPeer }));
        callRef = full.fullChat.call;
      } catch (e) {}
      if (callRef) {
        await tgClient.invoke(new Api.phone.LeaveGroupCall({
          call: new Api.InputGroupCall({ id: callRef.id, accessHash: callRef.accessHash })
        }));
      }
    } catch (e) { log('LeaveGroupCall hatası: ' + e.message, 'warn'); }
  }
  vcChatId = '';
  log('⏹ Sesten çıkıldı.', 'warn');
}

function cleanupWebRTC() {
  if (vcPeerConn) {
    try { vcPeerConn.close(); } catch (e) {}
    vcPeerConn = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTH API
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/status', (_req, res) => {
  res.json({
    connected,
    authStep,
    vcActive,
    vcChatId,
    vcRejoinCount,
    wrtcAvailable: !!RTCPeerConnection,
    logs: logs.slice(0, 80)
  });
});

app.get('/api/ping', (_req, res) => res.json({ ok: true }));

app.post('/api/auth/send-code', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.json({ ok: false, error: 'Telefon numarası gerekli' });
  try {
    if (tgClient) { try { await tgClient.disconnect(); } catch (e) {} }
    tgClient = new TelegramClient(new StringSession(''), API_ID, API_HASH, { connectionRetries: 5 });
    await tgClient.connect();
    const result = await tgClient.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone);
    phoneNumber = phone;
    phoneCodeHash = result.phoneCodeHash;
    authStep = 'code_sent';
    log(`📱 Kod gönderildi: ${phone}`, 'success');
    res.json({ ok: true });
  } catch (e) {
    log('Kod hatası: ' + e.message, 'error');
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/auth/verify-code', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.json({ ok: false, error: 'Kod gerekli' });
  try {
    await tgClient.invoke(new Api.auth.SignIn({ phoneNumber, phoneCodeHash, phoneCode: code }));
    const s = tgClient.session.save();
    saveSession(s);
    connected = true;
    authStep = 'done';
    log('✅ Giriş başarılı.', 'success');
    res.json({ ok: true });
  } catch (e) {
    if (e.message.includes('SESSION_PASSWORD_NEEDED')) { authStep = 'need_2fa'; return res.json({ ok: true, need2fa: true }); }
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/auth/verify-2fa', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.json({ ok: false, error: '2FA şifresi gerekli' });
  try {
    const { computeCheck } = require('telegram/Password');
    const srp = await tgClient.invoke(new Api.account.GetPassword());
    const check = await computeCheck(srp, password);
    await tgClient.invoke(new Api.auth.CheckPassword({ password: check }));
    const s = tgClient.session.save();
    saveSession(s);
    connected = true;
    authStep = 'done';
    log('✅ 2FA doğrulandı.', 'success');
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  if (vcActive) await leaveVoiceChat().catch(() => {});
  try {
    if (tgClient) {
      try { await tgClient.invoke(new Api.auth.LogOut({})); } catch (e) {}
      try { await tgClient.disconnect(); } catch (e) {}
    }
  } catch (e) {}
  tgClient = null;
  connected = false;
  authStep = 'idle';
  try { if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE); } catch (e) {}
  log('🚪 Çıkış yapıldı.', 'warn');
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// VOICE CHAT API
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/vc/start', async (req, res) => {
  const { chatId } = req.body;
  if (!chatId) return res.json({ ok: false, error: 'Chat ID gerekli' });
  if (!connected) return res.json({ ok: false, error: 'Önce giriş yapın' });
  if (vcActive) return res.json({ ok: false, error: 'Zaten seste' });
  try {
    res.json({ ok: true, message: 'Giriliyor...' });
    await joinVoiceChat(chatId);
  } catch (e) {
    vcActive = false;
    log('Sese giriş hatası: ' + e.message, 'error');
  }
});

app.post('/api/vc/stop', async (req, res) => {
  if (!vcActive) return res.json({ ok: false, error: 'Zaten seste değil' });
  try {
    await leaveVoiceChat();
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// HTML ARAYÜZÜ
// ═══════════════════════════════════════════════════════════════════════════

const HTML = /* html */`<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VC Bot — Telegram Sesli Sohbet</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#07070f;color:#e2e8f0;min-height:100vh}

/* Header */
.header{text-align:center;padding:48px 20px 32px;background:linear-gradient(160deg,#0d0d1f,#0a0a16)}
.badge{display:inline-block;background:#6d28d918;border:1px solid #6d28d940;border-radius:100px;padding:6px 16px;font-size:11px;color:#8b5cf6;margin-bottom:18px;letter-spacing:.5px}
h1{font-size:42px;font-weight:900;background:linear-gradient(135deg,#f8fafc,#a78bfa,#34d399);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.sub{color:#475569;font-size:12px;margin-top:8px}

/* Main layout */
.main{max-width:900px;margin:32px auto;padding:0 20px;display:flex;flex-direction:column;gap:20px}

/* Cards */
.card{background:#0d0d14;border:1px solid #1e1e30;border-radius:20px;padding:24px}
.card-title{font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.8px;margin-bottom:20px;display:flex;align-items:center;gap:8px}

/* VC Status */
.vc-status{text-align:center;padding:32px 20px}
.vc-ring{width:120px;height:120px;border-radius:50%;margin:0 auto 24px;display:flex;align-items:center;justify-content:center;font-size:48px;position:relative;transition:all .4s}
.vc-ring.idle{background:#12121e;border:2px solid #1e1e30}
.vc-ring.active{background:radial-gradient(circle,#6d28d930,#0d0d14);border:2px solid #6d28d960;box-shadow:0 0 40px #6d28d930,0 0 80px #6d28d918;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 40px #6d28d930,0 0 80px #6d28d918}50%{box-shadow:0 0 60px #6d28d950,0 0 120px #6d28d930}}
.vc-label{font-size:22px;font-weight:700;margin-bottom:6px}
.vc-sub{font-size:12px;color:#475569}
.vc-rejoin{font-size:11px;color:#f59e0b;margin-top:6px}

/* Buttons */
.btn{border:none;border-radius:12px;padding:12px 24px;font-weight:700;cursor:pointer;font-size:13px;transition:all .2s;display:inline-flex;align-items:center;gap:8px;justify-content:center}
.btn-full{width:100%}
.btn-start{background:linear-gradient(135deg,#059669,#10b981);color:#fff;font-size:15px;padding:16px}
.btn-start:hover{opacity:.9;transform:translateY(-1px)}
.btn-stop{background:linear-gradient(135deg,#b91c1c,#ef4444);color:#fff;font-size:15px;padding:16px}
.btn-stop:hover{opacity:.9;transform:translateY(-1px)}
.btn-primary{background:linear-gradient(135deg,#6d28d9,#8b5cf6);color:#fff}
.btn-secondary{background:#1e1e30;color:#94a3b8}
.btn-danger{background:linear-gradient(135deg,#b91c1c,#ef4444);color:#fff}
.btn-sm{padding:7px 14px;font-size:11px;border-radius:8px}
.btn:disabled{opacity:.5;cursor:not-allowed;transform:none}

/* Form */
label{font-size:11px;font-weight:600;color:#64748b;display:block;margin-bottom:5px}
input{width:100%;background:#12121e;border:1px solid #1e1e30;border-radius:10px;padding:11px 14px;color:#e2e8f0;font-size:13px;outline:none;transition:border-color .2s}
input:focus{border-color:#6d28d9}
.form-row{margin-bottom:14px}

/* Auth forms toggle */
.auth-section>div{display:none}
.auth-section>div.show{display:block}

/* Status badge */
.sbadge{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:100px;font-size:11px;font-weight:600}
.sbadge-green{background:#10b98118;color:#10b981;border:1px solid #10b98128}
.sbadge-red{background:#ef444418;color:#ef4444;border:1px solid #ef444428}
.sbadge-gray{background:#1e1e30;color:#64748b}
.dot{width:6px;height:6px;border-radius:50%}
.dot-green{background:#10b981;box-shadow:0 0 6px #10b981}
.dot-red{background:#ef4444}
.dot-gray{background:#475569}

/* Connection bar */
.conn-bar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:4px}

/* Logs */
.logs{background:#09090f;border:1px solid #1a1a28;border-radius:12px;padding:14px;max-height:260px;overflow-y:auto;font-family:'Courier New',monospace;font-size:11px}
.log-row{display:flex;gap:10px;padding:3px 0;border-bottom:1px solid #0d0d1800}
.log-time{color:#334155;min-width:58px;flex-shrink:0}
.log-success{color:#34d399}
.log-error{color:#f87171}
.log-warn{color:#fbbf24}
.log-info{color:#64748b}

/* Alert */
.alert{padding:12px 16px;border-radius:10px;font-size:12px;margin-bottom:14px}
.alert-warn{background:#78350f18;border:1px solid #78350f40;color:#fbbf24}
.alert-info{background:#1e40af18;border:1px solid #1e40af40;color:#60a5fa}
</style>
</head>
<body>

<div class="header">
  <div class="badge">🎙 TELEGRAM VC BOT</div>
  <h1>Voice Chat Bot</h1>
  <p class="sub">Telefon ile Giriş · Kalıcı Oturum · Seste Asla İnmez</p>
</div>

<div class="main">

  <!-- Bağlantı Durumu -->
  <div class="card">
    <div class="conn-bar">
      <div class="card-title" style="margin:0">🔌 Bağlantı Durumu</div>
      <div id="conn-badge" class="sbadge sbadge-gray"><div class="dot dot-gray"></div> Bağlı Değil</div>
    </div>
    <div id="wrtc-warn" class="alert alert-warn" style="display:none;margin-top:14px">
      ⚠️ <strong>@roamhq/wrtc</strong> paketi yüklü değil. Sese girebilmek için <code>npm install @roamhq/wrtc</code> çalıştırın.
    </div>
  </div>

  <!-- Auth -->
  <div class="card" id="auth-card">
    <div class="card-title">🔐 Telegram Girişi</div>
    <div class="auth-section">
      <!-- Telefon -->
      <div id="f-phone" class="show">
        <div class="form-row"><label>📱 Telefon Numarası</label><input type="tel" id="inp-phone" placeholder="+905551234567"></div>
        <button class="btn btn-primary btn-full" onclick="sendCode()">📱 Doğrulama Kodu Gönder</button>
      </div>
      <!-- Kod -->
      <div id="f-code">
        <div class="alert alert-info">Telegram uygulamanıza doğrulama kodu gönderildi.</div>
        <div class="form-row"><label>🔢 Doğrulama Kodu</label><input type="text" id="inp-code" placeholder="12345" maxlength="6"></div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary" style="flex:1" onclick="showAuthStep('phone')">← Geri</button>
          <button class="btn btn-primary" style="flex:2" onclick="verifyCode()">✅ Doğrula</button>
        </div>
      </div>
      <!-- 2FA -->
      <div id="f-2fa">
        <div class="alert alert-info">Hesabınızda iki adımlı doğrulama aktif.</div>
        <div class="form-row"><label>🔐 2FA Şifresi</label><input type="password" id="inp-2fa"></div>
        <button class="btn btn-primary btn-full" onclick="verify2FA()">✅ Doğrula</button>
      </div>
      <!-- Bağlı -->
      <div id="f-done">
        <div class="sbadge sbadge-green" style="margin-bottom:14px"><div class="dot dot-green"></div> Telegram'a Bağlı</div>
        <button class="btn btn-danger btn-sm" onclick="logout()">🚪 Çıkış Yap</button>
      </div>
    </div>
  </div>

  <!-- Sesli Sohbet -->
  <div class="card" id="vc-card">
    <div class="card-title">🎙 Sesli Sohbet Kontrolü</div>

    <!-- Chat ID input (sadece seste değilken) -->
    <div id="vc-input-section">
      <div class="form-row">
        <label>🎯 Chat ID veya @username</label>
        <input type="text" id="inp-chatid" placeholder="-1001234567890 veya @grupadi">
      </div>
    </div>

    <!-- Durum görselleştirme -->
    <div class="vc-status">
      <div class="vc-ring" id="vc-ring">🎙</div>
      <div class="vc-label" id="vc-label">Seste Değil</div>
      <div class="vc-sub" id="vc-sub">Başlatmak için Chat ID girin ve butona basın</div>
      <div class="vc-rejoin" id="vc-rejoin"></div>
    </div>

    <div id="vc-btn-container">
      <button class="btn btn-start btn-full" id="btn-start" onclick="startVC()">▶ Sese Gir</button>
    </div>
  </div>

  <!-- Loglar -->
  <div class="card">
    <div class="card-title">📋 Canlı Loglar</div>
    <div class="logs" id="log-box"><div style="text-align:center;padding:20px;color:#334155">Bekleniyor...</div></div>
  </div>

</div>

<script>
let S = { connected: false, authStep: 'idle', vcActive: false, vcChatId: '', vcRejoinCount: 0, wrtcAvailable: true, logs: [] };

// ── Sekme / form ─────────────────────────────────────────────────────────────
function showAuthStep(step) {
  document.querySelectorAll('.auth-section > div').forEach(d => d.classList.remove('show'));
  document.getElementById('f-' + step).classList.add('show');
}

// ── API ───────────────────────────────────────────────────────────────────────
async function api(url, method = 'GET', body = null) {
  try {
    const opt = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opt.body = JSON.stringify(body);
    const r = await fetch(url, opt);
    return await r.json();
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── Auth ─────────────────────────────────────────────────────────────────────
async function sendCode() {
  const phone = document.getElementById('inp-phone').value.trim();
  if (!phone) return alert('Telefon numarası girin!');
  const btn = event.target;
  btn.disabled = true; btn.textContent = 'Gönderiliyor...';
  const res = await api('/api/auth/send-code', 'POST', { phone });
  btn.disabled = false; btn.textContent = '📱 Doğrulama Kodu Gönder';
  if (res.ok) showAuthStep('code');
  else alert('Hata: ' + res.error);
}

async function verifyCode() {
  const code = document.getElementById('inp-code').value.trim();
  if (!code) return alert('Kodu girin!');
  const btn = event.target;
  btn.disabled = true; btn.textContent = 'Doğrulanıyor...';
  const res = await api('/api/auth/verify-code', 'POST', { code });
  btn.disabled = false; btn.textContent = '✅ Doğrula';
  if (res.ok) {
    if (res.need2fa) showAuthStep('2fa');
    else { refresh(); }
  } else alert('Hata: ' + res.error);
}

async function verify2FA() {
  const password = document.getElementById('inp-2fa').value;
  if (!password) return alert('2FA şifresini girin!');
  const btn = event.target;
  btn.disabled = true; btn.textContent = 'Doğrulanıyor...';
  const res = await api('/api/auth/verify-2fa', 'POST', { password });
  btn.disabled = false; btn.textContent = '✅ Doğrula';
  if (res.ok) refresh();
  else alert('Hata: ' + res.error);
}

async function logout() {
  if (!confirm('Çıkış yapılsın mı?')) return;
  await api('/api/auth/logout', 'POST');
  refresh();
}

// ── Voice Chat ────────────────────────────────────────────────────────────────
async function startVC() {
  if (!S.connected) return alert('Önce Telegram hesabınıza giriş yapın!');
  const chatId = document.getElementById('inp-chatid').value.trim();
  if (!chatId) return alert('Chat ID veya @username girin!');
  document.getElementById('btn-start').disabled = true;
  document.getElementById('btn-start').textContent = '⏳ Giriliyor...';
  const res = await api('/api/vc/start', 'POST', { chatId });
  if (!res.ok) {
    alert('Hata: ' + res.error);
    document.getElementById('btn-start').disabled = false;
    document.getElementById('btn-start').innerHTML = '▶ Sese Gir';
  }
  // Sonucu status endpoint'ten alıyoruz
}

async function stopVC() {
  const btn = event.target;
  btn.disabled = true; btn.textContent = '⏳ Çıkılıyor...';
  const res = await api('/api/vc/stop', 'POST');
  if (!res.ok) { alert('Hata: ' + res.error); btn.disabled = false; btn.textContent = '⏹ Sesten Çık'; }
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  // wrtc uyarı
  document.getElementById('wrtc-warn').style.display = S.wrtcAvailable ? 'none' : 'block';

  // Bağlantı badge
  const cb = document.getElementById('conn-badge');
  if (S.connected) {
    cb.className = 'sbadge sbadge-green';
    cb.innerHTML = '<div class="dot dot-green"></div> Telegram Bağlı';
  } else {
    cb.className = 'sbadge sbadge-red';
    cb.innerHTML = '<div class="dot dot-red"></div> Bağlı Değil';
  }

  // Auth form
  if (S.connected) showAuthStep('done');
  else if (S.authStep === 'code_sent') showAuthStep('code');
  else if (S.authStep === 'need_2fa') showAuthStep('2fa');
  else showAuthStep('phone');

  // VC
  const ring = document.getElementById('vc-ring');
  const label = document.getElementById('vc-label');
  const sub = document.getElementById('vc-sub');
  const rejoinEl = document.getElementById('vc-rejoin');
  const inputSec = document.getElementById('vc-input-section');
  const btnContainer = document.getElementById('vc-btn-container');

  if (S.vcActive) {
    ring.className = 'vc-ring active';
    ring.textContent = '🔊';
    label.textContent = 'Seste Oturuyorum';
    sub.textContent = '📍 ' + (S.vcChatId || '');
    rejoinEl.textContent = S.vcRejoinCount > 0 ? ('🔄 Yeniden bağlanma: ' + S.vcRejoinCount) : '';
    inputSec.style.display = 'none';
    btnContainer.innerHTML = '<button class="btn btn-stop btn-full" onclick="stopVC()">⏹ Sesten Çık</button>';
  } else {
    ring.className = 'vc-ring idle';
    ring.textContent = '🎙';
    label.textContent = 'Seste Değil';
    sub.textContent = S.connected ? 'Başlatmak için Chat ID girin ve butona basın' : 'Önce giriş yapın';
    rejoinEl.textContent = '';
    inputSec.style.display = 'block';
    btnContainer.innerHTML = '<button class="btn btn-start btn-full" id="btn-start" onclick="startVC()">▶ Sese Gir</button>';
  }

  // Loglar
  const logBox = document.getElementById('log-box');
  if (!S.logs?.length) {
    logBox.innerHTML = '<div style="text-align:center;padding:20px;color:#334155">Log bekleniyor...</div>';
  } else {
    logBox.innerHTML = S.logs.map(l =>
      \`<div class="log-row"><span class="log-time">[\${l.time}]</span><span class="log-\${l.type||'info'}">\${l.msg}</span></div>\`
    ).join('');
  }
}

async function refresh() {
  const res = await api('/api/status');
  if (res && !res.error) { S = res; render(); }
}

setInterval(refresh, 2000);
refresh();
</script>
</body>
</html>`;

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML);
});

// Keep-alive
setInterval(async () => {
  const host = process.env.RENDER_EXTERNAL_HOSTNAME;
  if (host) { try { await fetch(`https://${host}/api/ping`); } catch (e) {} }
}, 12000);

// ─── Başlangıç ────────────────────────────────────────────────────────────────
autoLogin();

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   🎙 TELEGRAM VOICE CHAT BOT                ║
║   Telefon Girişi · Kalıcı Oturum · VC Bot  ║
║                                              ║
║   🚀 http://localhost:${PORT}                 ║
║   💾 session.txt + data.json                ║
╚══════════════════════════════════════════════╝
  `);
});
