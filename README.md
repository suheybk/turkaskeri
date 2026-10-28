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

## Botlar, kurucu ayarları ve oylama
- Oda: en çok 8 insan oyuncu. İki mod: takım savaşı (4'e 4) ve Battle Royale (en çok 16 kişi, bot dahil).
- Botlar her modda var. Botları kurucunun tarayıcısı yönetir (kurucu çıkarsa yeni kurucu devralır); can ve ölüm kararlarını sunucu verir.
- Kurucu lobide modu seçer, bot ekler/çıkarır, oyuncu ve botların takımını değiştirir. "Oyunu başlat"a basınca diğer oyunculara teklif gider, 5 saniye içinde oy verirler (oy vermeyen kabul sayılır). Ret sayısı kabulden az değilse teklif düşer; yalnız oyuncu varsa oylama yapılmaz.
- Ölüm maçı (tek kişilik de var: ana menüden botlarla) (Battle Royale haritasında herkes herkese): ölenler 3 sn sonra rastgele bir noktada yeniden doğar, ilk 40 öldürmeyi yapan kazanır (10 dakikada kimse ulaşamazsa en çok öldüren). Eşya, araç ve çember yok; oyuncunun kendi teçhizatı kullanılır.
- Battle Royale: dünya, eşyalar ve çember odanın tohumundan türetilir (herkeste aynı). Eşya alma ve araca binme sunucuda hakemlenir.

## Battle Royale haritası ve araçlar
- Harita ~6 kat büyütüldü (750 × 750 m); nehir (köprülü), iki derin göl (ortası 3-4 m, suya batılır, yavaşlanır, su altında ateş edilemez; araçlar zor geçer) ve basamaklı tepeler var: yeni kasabalar, yollar, daha çok ağaç/kaya/konteyner; çember ve paraşüt irtifası buna göre ölçeklendi.
- **Tank:** top (patlayıcı mermi, alan hasarı), çarptığını ezer, fareyle namlu yönü.
- **Makineli jip:** 2 kişilik. Çok oyunculuda ikinci oyuncu yolcu/nişancı olarak binip makineli tüfeği kullanır; sürücü inerse yolcu direksiyona geçer.
- Helikopter ve uçak da ateş eder.
- 4 sığ dere (bele kadar, yürünerek girilir) göllere ve nehre bağlanır.
- Terk edilmiş yüksek kuleler (içeriden spiral merdivenli (kapıdan girilir), çatıda korkuluk ve keskin nişancı tüfeği) ve çok sık ormanlar var.

### Uçaktan atlama ve büyük harita
- Battle Royale artık taşıma uçağıyla başlar: uçak haritayı boydan boya geçer, **Space / E** (mobilde zıpla) ile atlanır; botlar hedef kapılarına yaklaşınca atlar, uçak çıkışa varınca herkes düşer.
- Harita 960 m x 960 m (BRS=3.2, yarı boyut 480); çember evreleri ve radar buna göre ölçeklendi.

### Takım savaşı haritaları
- 5 harita: Üs (orijinal), Depo, Köy, Rafineri, Geçit. Menüden seçilir ya da "Rastgele"; çok oyunculuda harita oda tohumundan (seed) belirlenir, herkeste aynıdır.
- Yeni haritaların bot yol noktaları otomatik üretilir (ızgara + görüş hattı).

### Sınıflar, yıkım ve bayrak modu
- 5 sınıf (menüden seçilir, **Q** tuşu / mobilde YETENEK): Asalt (zırh plakası), Sağlıkçı (yakındaki takıma +45 can), Destek (cephane ikmali), Nişancı (düşman keşfi), Mühendis (2 C4, +2 bomba). Sağlık/zırh/ikmal çok oyunculuda sunucu üzerinden (`heal`, `gad`) çalışır.
- Yıkılabilir siper: bomba sandık ve alçak siperleri, C4 konteyner ve tankları da yıkar (yalnızca takım savaşı haritaları).
- Bayrak ele geçirme (A-B-C): tek oyunculu ve çok oyunculu (lobide "Bayrak"). Kurucu bayrak durumunu hesaplayıp yayınlar (`dfl`), sunucu puanı tutar (`dscore`/`dsc`); 100 puana ilk ulaşan kazanır, botlar bayrak hedefler.

### Büyük savaş (Conquest, 32v32)
- 220 m x 220 m iki harita (Kuşatma, Liman; sabit tohumla üretilir), 7 bayrak, her takım 500 bilet. Ölüm 1 bilet, bayrak çoğunluğu rakibin biletini eritir; biletleri biten kaybeder (süre 10 dk).
- Solo: 31 + 32 bot. Çok oyunculu: kurucu botları yönetir, sunucu bilet tutar (`dscore`, `dsc`), lobide "Büyük savaş 32v32".
- Botlar 2 m'lik gezinme ızgarası (A*) ile yürür; ölenler sahip olunan bayraklarda veya üste doğar.

### Sınıf silah kısıtı ve aksesuarlar
- Takım savaşı / bayrak / büyük savaşta silahlar sınıfa göre gelir (Asalt: tüfekler, Sağlıkçı: karabina/SMG, Destek: ağır makineli + tüfek, Nişancı: nişancı tüfekleri, Mühendis: SMG/av tüfeği); sınıfın ilk silahı seviyeden bağımsız açıktır. Yanında her zaman tabanca.
- Silah başına öldürmeyle aksesuar açılır: 15 öldürme dikey kabza, 40 uzun şarjör, 80 susturucu; sonraki maçta otomatik takılır. Sayaçlar profile (`wk`) kaydedilir.

### Takım (squad) sistemi
- Her takım 4'lü squad'lara bölünür (çok oyunculuda oyuncu kimliğine göre, hepsinde aynı). Sol altta radar altında squad listesi (can çubuklarıyla). Lider (★) **T** ile toplanma noktası kurar (25 sn bekleme, 90 sn / 6 doğuş); squad üyeleri orada doğar. Botlar liderini izler.

### Maç sonu oylaması ve harita rotasyonu
- Maç bitince sunucu 3 rastgele seçenek (mod + harita) sunar, 13 sn oylanır, kazanan 3 sn sonra otomatik başlar. Kurucu manuel başlatırsa oylama iptal olur.

## Yıkılabilir binalar, aksesuar seçimi, sağlık/ikmal kutuları
- C4 ve patlamalar binaları (bld 2, hangar 3 vuruş) kademeli yıkar.
- Menüde aksesuar (kabza/şarjör/susturucu) aç-kapa; tercih localStorage'da.
- Sağlıkçı Q: 20 sn can kutusu, Destek Q: 25 sn cephane kutusu (takım yakınında kullanır; çok oyunculuda yayılır).

## Bayrak kapma (CTF)
- Tek oyunculu menüde "Bayrak kapma (CTF)", çok oyunculuda lobide "Bayrak kapma" (dom=3). İlk 5 yakalamaya ulaşan kazanır.
- Düşmanın bayrağına dokun → taşı → kendi bayrağın üstteyken kendi üssüne getir. Taşıyan ölürse bayrak düşer; takım arkadaşı dokunursa üsse döner, 25 sn dokunulmazsa kendiliğinden döner.
- Çok oyunculu: bayrak durumunu host hesaplar (`cfl` yayını), skor `dscore` ile sunucuya gider.

## Rush (M-COM)
- Lobi/menüde "Rush": Alfa saldırır (80 bilet), Özel Harekât savunur. Büyük harita, 2 aşama × 2 M-COM.
- M-COM'un 3.5 m yakınında E'yi basılı tut: saldırgan 5 sn'de kurar, 30 sn fitil yanar; savunma 4 sn basılı tutarak etkisizleştirir. Aşamadaki tüm M-COM'lar imha olursa sonraki aşama; son aşama biterse Alfa kazanır. Bilet biterse veya süre dolarsa savunma kazanır.
- Çok oyunculu: host durumu hesaplar (`rst`), oyuncular tutma bilgisini `rarm` ile yollar, bitiş `fin`.

## Büyük savaş ve Rush araçları
- Büyük savaş (32v32) ve Rush haritalarında her takımın üssünde tank, 2 makineli jip, cip ve motosiklet; ortada 2 cip bulunur. E ile bin/in; jip ve tankta ikinci koltuk (yolcu/nişancı) vardır.
- Araç sistemi Battle Royale ile aynıdır (aynı sürüş, silah ve çok oyunculu `venter/vleave/vst` mesajları); araçlar maç başında yeniden kurulur.
- Sınırlar: araçların canı yoktur (patlatılamaz), botlar araç kullanmaz, helikopter/uçak bu modlarda yok.

## Botlar araç kullanır, helikopter, geniş Rush haritaları
- Büyük savaş ve Rush'ta botlar yakındaki boş araca biner (Rush'ta yalnız saldırganlar), hedefe sürer, tank/jip/helikopterden ateş eder, ezer; 45 sn sonra iner, ölünce araçtan düşer. Çok oyunculuda host sürer, araç durumu `bs` mesajıyla yayılır.
- Her üste helikopter var (W/S ileri-geri, Boşluk/Shift yükseklik); harita sınırı içinde kalır.
- Rush için iki yeni 340×340 harita: "Geniş Vadi" ve "Büyük Liman"; Rush süresi 15 dk, bu haritalarda ekstra tank/jip var.

## UH-60 Kara Şahin helikopteri
- Helikopter modeli koyu renkli UH-60 (Kara Şahin) olarak yenilendi: dört kanatlı ana rotor, eğik kuyruk dikmesi ve kırmızı-beyaz yuvarlak işaret, kayar kapı panelleri, kısa kanatçık ve silah kapsülleri. Battle Royale ve Rush/Büyük savaştaki tüm helikopterlerde aynı model kullanılır.
