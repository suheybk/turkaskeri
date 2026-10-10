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
      /* Girişte deneme kilidi vardı, KAYITTA hiçbir sınır yoktu: tek bir
         istemci binlerce hesap açıp Durable Object deposunu şişirebiliyordu.
         Cloudflare gerçek istemci adresini `cf-connecting-ip` ile veriyor ve
         Worker başlıkları DO'ya aynen aktarıyor. */
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
/* Oda (takım ölüm maçı, en çok 8 oyuncu)                              */
/* ------------------------------------------------------------------ */
const TARGET = 30, MATCH = 360, MAXP = 8, PERTEAM = 4;
const TEAMHP = { a: 100, o: 90 };
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);

export class Room {
  constructor() {
    this.inited = false; this.pw = ''; this.players = new Map(); this.nextId = 1;
    /* `/info` istenen şifrenin doğru olup olmadığını (`pwOk`) söylüyordu ve
       hiçbir sınır yoktu — oda şifresi sınırsız denenebiliyordu. */
    this.pwFail = { n: 0, until: 0 };
    this.phase = 'lobby'; this.score = { a: 0, o: 0 }; this.left = MATCH; this.host = null; this.timer = null;
  }
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
    /* Yanlış şifre sayılır; BOŞ şifre sayılmaz, çünkü istemci `needsPw`i
       öğrenmek için önce boş sorguyla geliyor. */
    if (this.pw && pwGiven) {
      if (this.pwFail.until > Date.now())
        return J({ err: 'cok_deneme', retry: Math.ceil((this.pwFail.until - Date.now()) / 1000) }, 429);
      if (pwGiven !== this.pw) {
        if (++this.pwFail.n >= 10) { this.pwFail.n = 0; this.pwFail.until = Date.now() + 60e3; }
      } else this.pwFail.n = 0;
    }
    if (u.pathname === '/info') {
      return J({ exists: true, needsPw: !!this.pw, pwOk: !this.pw || pwGiven === this.pw, count: this.players.size, max: MAXP, full: this.players.size >= MAXP, phase: this.phase });
    }
    if (u.pathname === '/ws') {
      if (this.pw && pwGiven !== this.pw) return J({ err: 'pw' }, 403);
      if (this.players.size >= MAXP) return J({ err: 'full' }, 409);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      let name = decodeURIComponent(req.headers.get('x-name') || 'Misafir') || 'Misafir';
      const taken = new Set([...this.players.values()].map((p) => p.name.toLocaleLowerCase('tr')));
      if (taken.has(name.toLocaleLowerCase('tr'))) { let i = 2; while (taken.has((name + ' ' + i).toLocaleLowerCase('tr'))) i++; name = name + ' ' + i; }
      this.addPlayer(server, name);
      return new Response(null, { status: 101, webSocket: client });
    }
    return J({}, 404);
  }
  send(p, o) { try { p.ws.send(JSON.stringify(o)); } catch (e) { } }
  bcast(o, except) { const s = JSON.stringify(o); for (const p of this.players.values()) if (p !== except) { try { p.ws.send(s); } catch (e) { } } }
  pub(p) { return { id: p.id, name: p.name, team: p.team, kills: p.kills, deaths: p.deaths, alive: p.alive }; }
  addPlayer(ws, name) {
    const cnt = { a: 0, o: 0 }; for (const p of this.players.values()) cnt[p.team]++;
    const team = cnt.a <= cnt.o ? 'a' : 'o';
    const p = { id: this.nextId++, name, ws, team, kills: 0, deaths: 0, alive: true, hp: TEAMHP[team], lastHit: 0, x: 0, z: 0, sn: 0, mc: 0 };
    this.players.set(p.id, p);
    if (!this.host || !this.players.has(this.host)) this.host = p.id;
    if (this.phase === 'play') { p.alive = true; p.hp = TEAMHP[team]; }
    this.send(p, { t: 'welcome', id: p.id, host: this.host, phase: this.phase, score: this.score, left: this.left, players: [...this.players.values()].map((q) => this.pub(q)), pwSet: !!this.pw });
    this.bcast({ t: 'join', p: this.pub(p) }, p);
    ws.addEventListener('message', (ev) => this.onMsg(p, ev.data));
    const gone = () => this.removePlayer(p);
    ws.addEventListener('close', gone); ws.addEventListener('error', gone);
  }
  removePlayer(p) {
    if (!this.players.has(p.id)) return;
    this.players.delete(p.id);
    if (this.host === p.id) this.host = this.players.size ? this.players.keys().next().value : null;
    this.bcast({ t: 'leave', id: p.id, host: this.host });
    if (!this.players.size) { this.stopTimer(); this.phase = 'lobby'; this.score = { a: 0, o: 0 }; }
  }
  stopTimer() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
  startMatch() {
    this.phase = 'play'; this.score = { a: 0, o: 0 }; this.left = MATCH;
    for (const p of this.players.values()) { p.kills = 0; p.deaths = 0; p.alive = true; p.hp = TEAMHP[p.team]; p.lastHit = 0; }
    this.bcast({ t: 'start', left: this.left, score: this.score, players: [...this.players.values()].map((q) => this.pub(q)) });
    this.stopTimer(); this.tick = 0;
    this.timer = setInterval(() => this.onTick(), 1000);
  }
  onTick() {
    if (this.phase !== 'play') return this.stopTimer();
    this.left--; this.tick++;
    const now = Date.now();
    for (const p of this.players.values()) {
      if (p.alive && p.hp < TEAMHP[p.team] && now - p.lastHit > 5000) { p.hp = Math.min(TEAMHP[p.team], p.hp + 18); this.send(p, { t: 'hp', hp: p.hp }); }
    }
    if (this.tick % 3 === 0) this.bcast({ t: 'time', left: this.left });
    if (this.left <= 0) this.endMatch();
  }
  endMatch() {
    if (this.phase !== 'play') return;
    this.phase = 'end'; this.stopTimer();
    const win = this.score.a === this.score.o ? null : (this.score.a > this.score.o ? 'a' : 'o');
    this.bcast({ t: 'end', win, score: this.score, players: [...this.players.values()].map((q) => this.pub(q)) });
  }
  onMsg(p, data) {
    if (typeof data !== 'string' || data.length > 2000) return;
    /* Hiz siniri: her paket odadaki herkese role ediliyor, yani tek istemci
       7 kat yayin carpani olarak kullanilabiliyordu. En hizli mesaj akisi
       konum guncellemesi (`st`); 120/sn fazlasiyla yeterli.
       NOT: bu bir hile onlemi DEGIL, DoS onlemi. Isabetin dogrulanmamasi
       (istemci `hit.d` bildiriyor) ayri bir konu, README'de yazili. */
    const sn = (Date.now() / 1000) | 0;
    if (sn !== p.sn) { p.sn = sn; p.mc = 0; }
    if (++p.mc > 120) return;
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    switch (m.t) {
      case 'team': {
        if (this.phase === 'play') return;
        const t = m.team === 'o' ? 'o' : 'a'; if (t === p.team) return;
        let c = 0; for (const q of this.players.values()) if (q.team === t) c++;
        if (c >= PERTEAM) return this.send(p, { t: 'err', msg: 'Bu takım dolu.' });
        p.team = t; p.hp = TEAMHP[t]; this.bcast({ t: 'team', id: p.id, team: t });
        break;
      }
      case 'start':
        if (p.id === this.host && this.phase !== 'play') this.startMatch();
        break;
      case 'st': {
        p.x = num(m.x); p.z = num(m.z);
        this.bcast({ t: 'st', id: p.id, x: num(m.x), y: num(m.y), z: num(m.z), yaw: num(m.yaw), w: String(m.w || '').slice(0, 20), s: num(m.s) }, p);
        break;
      }
      case 'sh':
        if (this.phase === 'play' && p.alive) this.bcast({ t: 'sh', id: p.id, ax: num(m.ax), ay: num(m.ay), az: num(m.az), bx: num(m.bx), by: num(m.by), bz: num(m.bz), w: String(m.w || '').slice(0, 20) }, p);
        break;
      case 'nade':
        if (this.phase === 'play' && p.alive) this.bcast({ t: 'nade', id: p.id, k: m.k === 'smoke' ? 'smoke' : 'frag', x: num(m.x), y: num(m.y), z: num(m.z), vx: num(m.vx), vy: num(m.vy), vz: num(m.vz) }, p);
        break;
      case 'hit': {
        if (this.phase !== 'play' || !p.alive) return;
        const v = this.players.get(num(m.to, -1)); if (!v || !v.alive) return;
        const self = v === p; if (!self && v.team === p.team) return;
        const d = Math.min(260, Math.max(0, num(m.d)));
        if (d <= 0) return;
        v.hp -= d; v.lastHit = Date.now();
        if (v.hp <= 0) {
          v.alive = false; v.deaths++;
          if (!self) { p.kills++; this.score[p.team]++; }
          this.bcast({ t: 'kill', k: p.id, v: v.id, head: m.h ? 1 : 0, score: this.score });
          setTimeout(() => { if (this.phase === 'play' && this.players.has(v.id)) { v.alive = true; v.hp = TEAMHP[v.team]; this.bcast({ t: 'resp', id: v.id, hp: v.hp }); } }, 3000);
          if (this.score.a >= TARGET || this.score.o >= TARGET) this.endMatch();
        } else this.send(v, { t: 'hp', hp: v.hp });
        break;
      }
    }
  }
}
