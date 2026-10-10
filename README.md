# turkaskeri

Türk Askeri – tarayıcıda çok oyunculu FPS (Three.js + Cloudflare Worker).


Tek bir Cloudflare Worker hem oyunu (public/index.html) hem de çok oyunculu sunucuyu (hesaplar, odalar, WebSocket) sunar.

## Yayına alma
1. `npm install`
2. `npx wrangler login`
3. `wrangler.toml` içindeki en alttaki 3 satırın başındaki `#` işaretlerini kaldır (alt alan adı bağlama).
   shanidargame.com'un DNS'i Cloudflare'deyse `ta` kaydını kendisi açar.
4. `npx wrangler deploy`

Alan adı Cloudflare'de değilse: önce `npx wrangler deploy` ile `*.workers.dev` adresini al, sonra DNS'te
`ta` için bu adrese CNAME ver ve Workers > Settings > Domains kısmından `ta.shanidargame.com` ekle.

## Yerelde deneme
`npm run dev` -> http://localhost:8787

## Nasıl çalışır
- Giriş ekranı: Devam et (kayıtlı/misafir) ya da hesap aç, sonra oyun kodu yaz. Oyunu kuran kişi isteğe bağlı şifre koyabilir.
- Hesap: kullanıcı adı + şifre (en az 4 karakter). Şifreler PBKDF2 ile özetlenir. Seviye ve teçhizat hesapla saklanır.
- Oda: 5 haneli kod, en çok 8 oyuncu (4'e 4), takım ölüm maçı, ilk 30 öldürme veya 6 dakika.
- Odalar bellekte yaşar; herkes çıkınca oda kapanır.
