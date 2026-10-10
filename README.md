# turkaskeri

Türk Askeri – tarayıcıda çok oyunculu FPS (Three.js + Cloudflare Worker).

**Yayında:** https://ta.shanidargame.com

Tek bir Cloudflare Worker hem oyunu (`public/index.html`) hem de çok oyunculu
sunucuyu (hesaplar, odalar, WebSocket) sunar.

## Yayına alma

```bash
npx wrangler login     # ilk sefer
npx wrangler deploy
```

Alt alan adı `wrangler.toml` içinde `routes` ile bağlı (`custom_domain = true`).
`shanidargame.com` zone'u Cloudflare hesabında olduğu için wrangler `ta` DNS
kaydını kendisi açıyor. `workers_dev = true` yedek adresi açık tutuyor —
`routes` tanımlanınca wrangler onu kendiliğinden kapatıyor.

> **TOML tuzağı:** `routes` ve `workers_dev` üst seviye anahtarlar ve
> **tüm tablo başlıklarından önce** durmalı. `[[migrations]]`'dan sonraya
> yazılırsa TOML onları migrations'ın alanı sayar ve wrangler
> "Unexpected fields found in migrations field" uyarısı verir.

## Yerelde deneme

`npx wrangler dev` → http://localhost:8787

## Nasıl çalışır

- Giriş ekranı: Devam et (kayıtlı/misafir) ya da hesap aç, sonra oyun kodu yaz.
  Oyunu kuran kişi isteğe bağlı şifre koyabilir.
- Hesap: kullanıcı adı + şifre (en az 4 karakter). Şifreler PBKDF2-SHA256,
  100.000 tur ile özetlenir, tuz hesaba özel. Seviye ve teçhizat hesapla saklanır.
- Oda: 5 haneli kod, en çok 8 oyuncu (4'e 4), takım ölüm maçı, ilk 30 öldürme
  veya 6 dakika.
- Odalar **bellekte** yaşar; herkes çıkınca oda kapanır. (Oda kurulduktan sonra
  ilk oyuncu bağlanana kadarki kısa aralıkta Durable Object tahliye edilirse oda
  kaybolur — olasılık düşük, tasarım bilinçli.)

## Güvenlik

`public/_headers` güvenlik başlıklarını veriyor: CSP, `nosniff`,
`no-referrer`, `frame-ancestors 'none'`, COOP, Permissions-Policy, HSTS.

CSP'de `script-src` **`'unsafe-inline'` istiyor**, çünkü oyunun tamamı
`index.html` içinde tek bir satır içi `<script>`. Dosyada hiç satır içi `on*`
niteliği ve `eval` yok — yani o blok `public/game.js`'e taşınırsa
`'unsafe-inline'` düşürülüp CSP sıkılaştırılabilir. `three.js` cdnjs'ten,
yazı tipleri Google Fonts'tan geldiği için ikisine açıkça izin verildi.

Hız sınırları:

| Yer | Sınır |
|---|---|
| `/api/register` | IP başına saatte 5 hesap |
| `/api/login` | 8 başarısız denemeden sonra 5 dk kilit |
| `/api/room/KOD?pw=` | 10 yanlış şifreden sonra 60 sn kilit (boş şifre sayılmaz) |
| WebSocket mesajı | Oyuncu başına saniyede 120 |

### Bilinen sınır: isabet istemci tarafında

**İsabet ve hasar istemci tarafından bildiriliyor** (`{t:'hit', to, d}`).
Sunucu `d`'yi 0–260 arasına kırpıyor — 260 meşru üst sınır, çünkü en güçlü
silah 130 hasar veriyor ve kafa vuruşu ikiye katlıyor. Ama sunucu atışın
gerçekten isabet ettiğini, nişanın hedefi gördüğünü ya da mesafenin uygun
olduğunu **doğrulamıyor**: devtools açan bir oyuncu istediği rakibe tek
pakette ölümcül hasar gönderebilir.

Bunu kapatmak sunucu-otoriter isabet testi gerektiriyor (silah tablosu +
harita geometrisi + ışın testi sunucuda). Ayrı bir iş; WebSocket hız sınırı
yalnızca DoS'u kesiyor, hileyi kesmiyor.
