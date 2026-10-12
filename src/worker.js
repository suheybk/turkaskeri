/* Türk Askeri - çok oyunculu sunucu (Cloudflare Worker + Durable Objects)
   - /api/register, /api/login, /api/me, /api/profile : hesaplar
   - /api/room (POST) : oda kur (isteğe bağlı şifre)  |  /api/room/KOD (GET) : oda bilgisi
   - /ws?room=KOD : oyun bağlantısı (WebSocket)
   Kalan her şey statik dosya olarak sunulur (public/). */

const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const cleanName = (s) => String(s || '').replace(/[^\p{L}\p{N}_ .-]/gu, '').trim().slice(0, 16);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === '/api/ping') return J({ ok: true, ta: 1 });

      if (p === '/api/register' || p === '/api/login' || p === '/api/me' || p === '/api/profile') {
        const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName('main'));
        return await stub.fetch(new Request('https://do' + p.slice(4), { method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : await req.text() }));
      }

      if (p === '/api/room' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        for (let i = 0; i < 8; i++) {
          let code = '';
          for (let k = 0; k < 5; k++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
          const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
          const r = await stub.fetch('https://do/init', { method: 'POST', body: JSON.stringify({ pw: String(b.pw || '').slice(0, 24) }) });
          if (r.status === 200) return J({ ok: true, code });
        }
        return J({ ok: false, err: 'kod_uretilemedi' }, 500);
      }

      const m = /^\/api\/room\/([A-Za-z0-9]{3,8})$/.exec(p);
      if (m && req.method === 'GET') {
        const code = m[1].toUpperCase();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const r = await stub.fetch('https://do/info?pw=' + encodeURIComponent(url.searchParams.get('pw') || ''));
        return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
      }

      if (p === '/ws') {
        if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket gerekli', { status: 426 });
        const code = String(url.searchParams.get('room') || '').toUpperCase();
        if (!/^[A-Z0-9]{3,8}$/.test(code)) return new Response('kod', { status: 400 });
        let name = cleanName(url.searchParams.get('name')) || 'Misafir';
        const token = url.searchParams.get('token');
        if (token) {
          const acc = env.ACCOUNTS.get(env.ACCOUNTS.idFromName('main'));
          const r = await acc.fetch('https://do/me', { headers: { authorization: 'Bearer ' + token } });
          if (r.status === 200) name = (await r.json()).name;
        }
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const h = new Headers(req.headers);
        h.set('x-name', encodeURIComponent(name));
        return await stub.fetch(new Request('https://do/ws?pw=' + encodeURIComponent(url.searchParams.get('pw') || ''), { headers: h }));
      }

      if (env.ASSETS) return env.ASSETS.fetch(req);
      return new Response('yok', { status: 404 });
    } catch (e) {
      return J({ ok: false, err: 'sunucu', msg: String(e && e.message || e) }, 500);
    }
  },
};

/* ------------------------------------------------------------------ */
/* Hesaplar                                                            */
/* ------------------------------------------------------------------ */
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));
async function hashPw(pw, saltHex) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations: 100000 }, key, 256);
  return hex(bits);
}
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const cleanProf = (p) => {
  const n = (v, a, b, d) => { v = Math.floor(+v); return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
  const lo = Array.isArray(p && p.loadout) ? p.loadout.slice(0, 3).map((x) => String(x).slice(0, 20)) : null;
  return { xp: n(p && p.xp, 0, 1e6, 0), level: n(p && p.level, 1, 20, 1), seen: n(p && p.seen, 1, 20, 1), loadout: lo };
};

export class Accounts {
  constructor(state) { this.s = state.storage; }
  async auth(req) {
    const t = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!t) return null;
    const rec = await this.s.get('t:' + t);
    if (!rec || rec.exp < Date.now()) return null;
    return rec.u;
  }
  async newToken(ukey) {
    const t = randHex(24);
    await this.s.put('t:' + t, { u: ukey, exp: Date.now() + 90 * 864e5 });
    return t;
  }
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = req.method === 'GET' ? {} : await req.json().catch(() => ({}));
    if (path === '/register') {
      /* Kayıtta sınır yoktu: tek bir istemci binlerce hesap açıp depoyu şişirebilirdi.
         Cloudflare gerçek istemci adresini `cf-connecting-ip` ile verir. */
      const ip = req.headers.get('cf-connecting-ip') || 'bilinmeyen';
      const rl = (await this.s.get('r:' + ip)) || { n: 0, t: 0 };
      if (Date.now() - rl.t > 3600e3) { rl.n = 0; rl.t = Date.now(); }
      if (rl.n >= 5) return J({ ok: false, err: 'Bu adresten çok fazla hesap açıldı. Bir saat sonra tekrar dene.' }, 429);
      const name = cleanName(body.u), pw = String(body.p || '');
      if (name.length < 3) return J({ ok: false, err: 'Kullanıcı adı en az 3 harf olsun.' }, 400);
      if (pw.length < 4) return J({ ok: false, err: 'Şifre en az 4 karakter olsun.' }, 400);
      const ukey = name.toLocaleLowerCase('tr');
      if (await this.s.get('u:' + ukey)) return J({ ok: false, err: 'Bu kullanıcı adı alınmış.' }, 409);
      const salt = randHex(16);
      const prof = body.prof ? cleanProf(body.prof) : null;
      await this.s.put('u:' + ukey, { name, salt, hash: await hashPw(pw, salt), prof, created: Date.now() });
      rl.n++; await this.s.put('r:' + ip, rl);          // sayaç yalnızca başarılı kayıtta artar
      return J({ ok: true, name, token: await this.newToken(ukey), prof });
    }
    if (path === '/login') {
      const ukey = cleanName(body.u).toLocaleLowerCase('tr');
      const fl = (await this.s.get('f:' + ukey)) || { n: 0, until: 0 };
      if (fl.until > Date.now()) return J({ ok: false, err: 'Çok fazla deneme. Birkaç dakika sonra tekrar dene.' }, 429);
      const rec = await this.s.get('u:' + ukey);
      if (!rec || (await hashPw(String(body.p || ''), rec.salt)) !== rec.hash) {
        fl.n++; if (fl.n >= 8) { fl.n = 0; fl.until = Date.now() + 5 * 60e3; }
        await this.s.put('f:' + ukey, fl);
        return J({ ok: false, err: 'Kullanıcı adı veya şifre yanlış.' }, 401);
      }
      await this.s.delete('f:' + ukey);
      return J({ ok: true, name: rec.name, token: await this.newToken(ukey), prof: rec.prof });
    }
    if (path === '/me') {
      const u = await this.auth(req); if (!u) return J({ ok: false }, 401);
      const rec = await this.s.get('u:' + u); if (!rec) return J({ ok: false }, 401);
      return J({ ok: true, name: rec.name, prof: rec.prof });
    }
    if (path === '/profile') {
      const u = await this.auth(req); if (!u) return J({ ok: false }, 401);
      const rec = await this.s.get('u:' + u); if (!rec) return J({ ok: false }, 401);
      rec.prof = cleanProf(body); await this.s.put('u:' + u, rec);
      return J({ ok: true });
    }
    return J({ ok: false }, 404);
  }
}

/* ------------------------------------------------------------------ */
/* Oda: takım savaşı (TDM) ya da Battle Royale, insan + bot                */
/* ------------------------------------------------------------------ */
const TARGET = 30, MATCH = 360, MAXH = 8, PERTEAM = 4, BRMAX = 16;
const BOTNAMES = ['Kaan', 'Yağız', 'Tolga', 'Efe', 'Bora', 'Tuna', 'Arda', 'Demir', 'Ozan', 'Berk', 'Mert', 'Ilgaz', 'Barış', 'Cem', 'Alper', 'Umut', 'Kerem', 'Onur', 'Selim', 'Emre', 'Deniz', 'Rüzgar'];
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const sid = (v) => String(v == null ? '' : v).slice(0, 24);

export class Room {
  constructor() {
    this.inited = false; this.pw = ''; this.players = new Map(); this.bots = new Map();
    this.nextId = 1; this.nextBot = 101; this.mode = 'tdm'; this.phase = 'lobby';
    this.score = { a: 0, o: 0 }; this.left = MATCH; this.host = null; this.timer = null; this.tick = 0;
    this.pwFail = { n: 0, until: 0 };
    this.vote = null; this.picked = new Set(); this.veh = new Map(); this.alive = 0; this.seed = 1;
  }
  hpFor(e) { return this.mode === 'br' ? 100 : (e.team === 'o' ? 90 : 100); }
  ent(id) { return this.players.get(id) || this.bots.get(id); }
  all() { return [...this.players.values(), ...this.bots.values()]; }
  pub(e) { return { id: e.id, name: e.name, team: e.team, kills: e.kills, deaths: e.deaths, alive: e.alive, bot: !!e.bot, spec: !!e.spec }; }
  teamCount(t) { let c = 0; for (const e of this.all()) if (e.team === t && !e.spec) c++; return c; }
  send(p, o) { try { p.ws.send(JSON.stringify(o)); } catch (e) { } }
  bcast(o, except) { const s = JSON.stringify(o); for (const p of this.players.values()) if (p !== except) { try { p.ws.send(s); } catch (e) { } } }
  sendLobby() { this.bcast({ t: 'lobby', mode: this.mode, host: this.host, phase: this.phase, ents: this.all().filter((e) => !e.spec).map((e) => this.pub(e)) }); }

  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === '/init') {
      if (this.inited) return J({ ok: false }, 409);
      const b = await req.json().catch(() => ({}));
      this.inited = true; this.pw = String(b.pw || '').slice(0, 24);
      return J({ ok: true });
    }
    if (!this.inited) return J({ exists: false }, 404);
    const pwGiven = u.searchParams.get('pw') || '';
    /* Yanlış şifre sayılır; BOŞ şifre sayılmaz (istemci `needsPw`i öğrenmek için boş sorguyla gelir). */
    if (this.pw && pwGiven) {
      if (this.pwFail.until > Date.now())
        return J({ err: 'cok_deneme', retry: Math.ceil((this.pwFail.until - Date.now()) / 1000) }, 429);
      if (pwGiven !== this.pw) {
        if (++this.pwFail.n >= 10) { this.pwFail.n = 0; this.pwFail.until = Date.now() + 60e3; }
      } else this.pwFail.n = 0;
    }
    if (u.pathname === '/info') {
      return J({ exists: true, needsPw: !!this.pw, pwOk: !this.pw || pwGiven === this.pw, count: this.players.size, max: MAXH, full: this.players.size >= MAXH, phase: this.phase, mode: this.mode });
    }
    if (u.pathname === '/ws') {
      if (this.pw && pwGiven !== this.pw) return J({ err: 'pw' }, 403);
      if (this.players.size >= MAXH) return J({ err: 'full' }, 409);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      let name = decodeURIComponent(req.headers.get('x-name') || 'Misafir') || 'Misafir';
      const taken = new Set(this.all().map((p) => p.name.toLocaleLowerCase('tr')));
      if (taken.has(name.toLocaleLowerCase('tr'))) { let i = 2; while (taken.has((name + ' ' + i).toLocaleLowerCase('tr'))) i++; name = name + ' ' + i; }
      this.addPlayer(server, name);
      return new Response(null, { status: 101, webSocket: client });
    }
    return J({}, 404);
  }

  addPlayer(ws, name) {
    const p = { id: this.nextId++, name, ws, team: 'a', kills: 0, deaths: 0, alive: true, hp: 100, armor: 0, lastHit: 0, bot: false, spec: false, sn: 0, mc: 0 };
    // takım / yer aç
    if (this.mode === 'tdm') {
      let t = this.teamCount('a') <= this.teamCount('o') ? 'a' : 'o';
      if (this.teamCount(t) >= PERTEAM) t = t === 'a' ? 'o' : 'a';
      if (this.teamCount(t) >= PERTEAM) { const b = [...this.bots.values()].pop(); if (b) { this.bots.delete(b.id); t = b.team; this.bcast({ t: 'botgone', id: b.id }); } }
      p.team = t;
    } else if (this.all().filter((e) => !e.spec).length >= BRMAX) { const b = [...this.bots.values()].pop(); if (b) { this.bots.delete(b.id); this.bcast({ t: 'botgone', id: b.id }); } }
    if (this.phase === 'play' && this.mode === 'br') { p.spec = true; p.alive = false; }
    p.hp = this.hpFor(p);
    this.players.set(p.id, p);
    if (!this.host || !this.players.has(this.host)) this.host = p.id;
    this.send(p, { t: 'welcome', id: p.id, host: this.host, phase: this.phase, mode: this.mode, seed: this.seed, score: this.score, left: this.left, pwSet: !!this.pw, ents: this.all().filter((e) => !e.spec).map((e) => this.pub(e)), spec: p.spec });
    if (this.phase === 'play') this.bcast({ t: 'join', p: this.pub(p) }, p); else this.sendLobby();
    ws.addEventListener('message', (ev) => this.onMsg(p, ev.data));
    const gone = () => this.removePlayer(p);
    ws.addEventListener('close', gone); ws.addEventListener('error', gone);
  }
  removePlayer(p) {
    if (!this.players.has(p.id)) return;
    if (this.phase === 'play' && this.mode === 'br' && p.alive) this.die(p, null, 0, 'left');
    this.players.delete(p.id); this.freeVeh(p.id);
    const oldHost = this.host;
    if (this.host === p.id) this.host = this.players.size ? this.players.keys().next().value : null;
    if (this.vote) { if (oldHost === p.id) this.cancelVote('Kurucu ayrıldı.'); else { this.vote.rej.delete(p.id); this.vote.acc.delete(p.id); this.vote.voted.delete(p.id); this.maybeFinishVote(); } }
    if (!this.players.size) { this.stopTimer(); this.phase = 'lobby'; this.score = { a: 0, o: 0 }; this.bots.clear(); this.vote = null; return; }
    this.bcast({ t: 'leave', id: p.id, host: this.host });
    if (this.phase !== 'play') this.sendLobby();
    else if (this.mode === 'tdm') {/* oyun sürer */ }
  }
  stopTimer() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
  freeVeh(pid) { for (const [i, o] of [...this.veh]) if (o === pid) { this.veh.delete(i); this.bcast({ t: 'vfree', i }); } }

  /* ---- oylama ve başlatma ---- */
  startVote(p) {
    if (this.phase === 'play' || this.vote) return;
    const total = this.all().filter((e) => !e.spec).length;
    if (this.mode === 'br' && total < 2) return this.send(p, { t: 'err', msg: 'Battle Royale için en az 2 oyuncu (bot dahil) gerekir. Bot ekle.' });
    if (this.players.size <= 1) return this.startMatch();
    const humans = this.players.size;
    this.vote = { acc: new Set([p.id]), rej: new Set(), voted: new Set([p.id]), timer: setTimeout(() => this.endVote(), 5000) };
    this.bcast({ t: 'vote', ms: 5000, mode: this.mode, host: p.name, humans, bots: this.bots.size });
  }
  maybeFinishVote() { if (this.vote && this.vote.voted.size >= this.players.size) this.endVote(); }
  cancelVote(msg) { if (!this.vote) return; clearTimeout(this.vote.timer); this.vote = null; this.bcast({ t: 'voteend', ok: false, rej: 0, acc: 0, msg }); }
  endVote() {
    const v = this.vote; if (!v) return; clearTimeout(v.timer); this.vote = null;
    const humans = this.players.size, rej = v.rej.size, acc = humans - rej;
    if (rej >= acc) this.bcast({ t: 'voteend', ok: false, rej, acc, msg: 'Oyuncular teklifi reddetti.' });
    else { this.bcast({ t: 'voteend', ok: true, rej, acc }); this.startMatch(); }
  }
  startMatch() {
    this.phase = 'play'; this.score = { a: 0, o: 0 }; this.left = MATCH; this.seed = (Math.random() * 2147483647) | 0;
    this.picked.clear(); this.veh.clear();
    for (const e of this.all()) { e.kills = 0; e.deaths = 0; e.alive = true; e.spec = false; e.hp = this.hpFor(e); e.lastHit = 0; e.place = 0; e.armor = 0; }
    this.alive = this.all().length;
    this.bcast({ t: 'start', mode: this.mode, seed: this.seed, left: this.left, score: this.score, ents: this.all().map((e) => this.pub(e)) });
    this.stopTimer(); this.tick = 0; this.timer = setInterval(() => this.onTick(), 1000);
  }
  onTick() {
    if (this.phase !== 'play') return this.stopTimer();
    this.tick++; const now = Date.now();
    for (const e of this.all()) {
      const mx = this.hpFor(e);
      if (e.alive && e.hp < mx && now - e.lastHit > 5000) { e.hp = Math.min(mx, e.hp + 18); if (!e.bot) this.send(e, { t: 'hp', hp: e.hp, ar: e.armor }); }
    }
    if (this.mode === 'tdm') {
      this.left--;
      if (this.tick % 3 === 0) this.bcast({ t: 'time', left: this.left });
      if (this.left <= 0) this.endMatch();
    }
  }
  endMatch() {
    if (this.phase !== 'play') return;
    this.phase = 'end'; this.stopTimer();
    let win = null;
    if (this.mode === 'tdm') win = this.score.a === this.score.o ? null : (this.score.a > this.score.o ? 'a' : 'o');
    else { const w = this.all().find((e) => e.alive && !e.spec); win = w ? w.id : 0; if (w) w.place = 1; }
    this.bcast({ t: 'end', mode: this.mode, win, score: this.score, ents: this.all().filter((e) => !e.spec).map((e) => Object.assign(this.pub(e), { place: e.place || 0 })) });
    this.sendLobby();
  }
  die(v, a, head, why) {
    if (!v.alive) return;
    v.alive = false; v.deaths++;
    const self = a === v;
    if (a && !self) { a.kills++; if (this.mode === 'tdm') this.score[a.team]++; }
    let place = 0;
    if (this.mode === 'br') { place = this.alive; this.alive--; v.place = place; }
    if (!v.bot) this.freeVeh(v.id);
    this.bcast({ t: 'kill', k: a ? a.id : 0, v: v.id, head: head ? 1 : 0, score: this.score, why: why || '', place });
    if (this.mode === 'tdm') {
      setTimeout(() => { if (this.phase === 'play' && this.ent(v.id)) { v.alive = true; v.hp = this.hpFor(v); this.bcast({ t: 'resp', id: v.id, hp: v.hp }); } }, 3000);
      if (this.score.a >= TARGET || this.score.o >= TARGET) this.endMatch();
    } else if (this.alive <= 1) this.endMatch();
  }

  /* ---- gelen iletiler ---- */
  onMsg(p, data) {
    if (typeof data !== 'string' || data.length > 6000) return;
    /* Hız sınırı: her paket odadakilere röle edilir. Bu bir hile önlemi değil, DoS önlemi. */
    const sn = (Date.now() / 1000) | 0;
    if (sn !== p.sn) { p.sn = sn; p.mc = 0; }
    if (++p.mc > 120) return;
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    const isHost = p.id === this.host;
    const lobbyOK = this.phase !== 'play' && !this.vote;
    switch (m.t) {
      /* kurucu ayarları */
      case 'mode': if (isHost && lobbyOK && (m.mode === 'tdm' || m.mode === 'br')) { this.mode = m.mode; this.normalize(); this.sendLobby(); } break;
      case 'addbot': if (isHost && lobbyOK) { this.addBot(m.team === 'o' ? 'o' : 'a'); this.sendLobby(); } break;
      case 'fillbots': if (isHost && lobbyOK) { this.fillBots(); this.sendLobby(); } break;
      case 'clearbots': if (isHost && lobbyOK) { this.bots.clear(); this.sendLobby(); } break;
      case 'rmbot': if (isHost && lobbyOK) { this.bots.delete(num(m.id)); this.sendLobby(); } break;
      case 'setteam': if (isHost && lobbyOK && this.mode === 'tdm') {
        const e = this.ent(num(m.id)); const t = m.team === 'o' ? 'o' : 'a';
        if (e && e.team !== t) { if (this.teamCount(t) >= PERTEAM) return this.send(p, { t: 'err', msg: 'O takım dolu.' }); e.team = t; this.sendLobby(); }
      } break;
      case 'start': if (isHost && lobbyOK) this.startVote(p); break;
      case 'ballot': {
        if (!this.vote || isHost || this.vote.voted.has(p.id)) return;
        this.vote.voted.add(p.id); (m.ok ? this.vote.acc : this.vote.rej).add(p.id);
        this.bcast({ t: 'ballots', rej: this.vote.rej.size, acc: this.players.size - this.vote.rej.size });
        this.maybeFinishVote(); break;
      }
      /* oyun içi */
      case 'st': {
        if (p.spec) return;
        this.bcast({ t: 'st', id: p.id, x: num(m.x), y: num(m.y), z: num(m.z), yaw: num(m.yaw), w: sid(m.w), s: num(m.s), a: m.a ? 1 : 0, iv: m.iv ? 1 : 0 }, p);
        break;
      }
      case 'bs': if (isHost && this.phase === 'play' && Array.isArray(m.b)) this.bcast({ t: 'bs', b: m.b.slice(0, 24) }, p); break;
      case 'sh': {
        if (this.phase !== 'play') return;
        let id = p.id; if (m.bot != null) { if (!isHost || !this.bots.has(num(m.bot))) return; id = num(m.bot); } else if (!p.alive) return;
        this.bcast({ t: 'sh', id, ax: num(m.ax), ay: num(m.ay), az: num(m.az), bx: num(m.bx), by: num(m.by), bz: num(m.bz), w: sid(m.w) }, p);
        break;
      }
      case 'nade': {
        if (this.phase !== 'play') return;
        let id = p.id; if (m.bot != null) { if (!isHost || !this.bots.has(num(m.bot))) return; id = num(m.bot); } else if (!p.alive) return;
        this.bcast({ t: 'nade', id, k: m.k === 'smoke' ? 'smoke' : 'frag', x: num(m.x), y: num(m.y), z: num(m.z), vx: num(m.vx), vy: num(m.vy), vz: num(m.vz) }, p);
        break;
      }
      case 'hit': {
        if (this.phase !== 'play') return;
        const v = this.ent(num(m.to, -1)); if (!v || !v.alive || v.spec) return;
        let a = null, why = '';
        if (m.z) { if (!(v === p || (isHost && v.bot))) return; why = 'zone'; }
        else if (m.bot != null) { if (!isHost) return; a = this.bots.get(num(m.bot)); if (!a || !a.alive) return; }
        else { a = p; if (!p.alive) return; }
        if (a && a !== v && this.mode === 'tdm' && a.team === v.team) return;
        let d = Math.min(260, Math.max(0, num(m.d))); if (d <= 0) return;
        if (v.armor > 0) { const ab = Math.min(v.armor, d * 0.6); v.armor -= ab; d -= ab; }
        v.hp -= d; v.lastHit = Date.now();
        if (v.hp <= 0) this.die(v, a, m.h, why);
        else if (!v.bot) this.send(v, { t: 'hp', hp: v.hp, ar: v.armor });
        break;
      }
      /* Battle Royale: eşya ve araç */
      case 'pick': {
        if (this.mode !== 'br' || this.phase !== 'play' || !p.alive) return; const id = sid(m.id);
        if (this.picked.has(id)) return this.send(p, { t: 'pickno', id });
        if (this.picked.size < 4000) this.picked.add(id);
        this.bcast({ t: 'picked', id, by: p.id });
        break;
      }
      case 'item': {
        if (this.mode !== 'br' || this.phase !== 'play' || !p.alive) return;
        if (m.k === 'hp') p.hp = Math.min(100, p.hp + 60); else if (m.k === 'ar') p.armor = Math.min(100, p.armor + 50); else return;
        this.send(p, { t: 'hp', hp: p.hp, ar: p.armor }); break;
      }
      case 'drop': if (this.mode === 'br' && this.phase === 'play') this.bcast({ t: 'drop', id: sid(m.id), type: sid(m.type), wid: sid(m.wid), x: num(m.x), z: num(m.z) }, p); break;
      case 'venter': {
        if (this.mode !== 'br' || this.phase !== 'play' || !p.alive) return; const i = num(m.i, -1);
        if (i < 0 || i > 40 || this.veh.has(i)) return this.send(p, { t: 'vdeny', i });
        this.veh.set(i, p.id); this.bcast({ t: 'venter', i, id: p.id });
        break;
      }
      case 'vleave': {
        const i = num(m.i, -1); if (this.veh.get(i) !== p.id) return; this.veh.delete(i);
        this.bcast({ t: 'vleave', i, x: num(m.x), y: num(m.y), z: num(m.z), yaw: num(m.yaw) }, p);
        break;
      }
      case 'vst': {
        const i = num(m.i, -1); if (this.veh.get(i) !== p.id) return;
        this.bcast({ t: 'vst', i, x: num(m.x), y: num(m.y), z: num(m.z), yaw: num(m.yaw), pv: num(m.pv), roll: num(m.roll), spd: num(m.spd), rot: num(m.rot), thr: num(m.thr) }, p);
        break;
      }
    }
  }
  /* ---- bot yönetimi ---- */
  botName() { const used = new Set(this.all().map((e) => e.name)); const free = BOTNAMES.filter((n) => !used.has(n)); return free.length ? free[Math.floor(Math.random() * free.length)] : 'Bot' + this.nextBot; }
  limit() { return this.mode === 'br' ? BRMAX : PERTEAM * 2; }
  addBot(team) {
    const total = this.all().filter((e) => !e.spec).length;
    if (this.mode === 'tdm') { if (this.teamCount(team) >= PERTEAM) team = team === 'a' ? 'o' : 'a'; if (this.teamCount(team) >= PERTEAM) return false; }
    else if (total >= BRMAX) return false;
    const b = { id: this.nextBot++, name: this.botName(), team, kills: 0, deaths: 0, alive: true, hp: 100, armor: 0, lastHit: 0, bot: true, spec: false };
    this.bots.set(b.id, b); return true;
  }
  fillBots() {
    if (this.mode === 'tdm') { while (this.teamCount('a') < PERTEAM) if (!this.addBot('a')) break; while (this.teamCount('o') < PERTEAM) if (!this.addBot('o')) break; }
    else { let n = 0; while (this.all().filter((e) => !e.spec).length < BRMAX && n++ < 20) if (!this.addBot(n % 2 ? 'a' : 'o')) break; }
  }
  normalize() { // mod değişince sığmayanları at
    if (this.mode === 'tdm') {
      for (const t of ['a', 'o']) { while (this.teamCount(t) > PERTEAM) { const b = [...this.bots.values()].reverse().find((x) => x.team === t); if (!b) break; this.bots.delete(b.id); } }
      for (const p of this.players.values()) if (this.teamCount(p.team) > PERTEAM) p.team = p.team === 'a' ? 'o' : 'a';
    } else { while (this.all().length > BRMAX) { const b = [...this.bots.values()].pop(); if (!b) break; this.bots.delete(b.id); } }
  }
}
