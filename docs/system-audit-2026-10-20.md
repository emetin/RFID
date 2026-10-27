# RFID sistem kontrolü ve geliştirme planı

Tarih: 20 Ekim 2026. Kapsam: mevcut çalışma ağacı, 8081 portundaki yerel SQLite uygulaması, Windows cihazları, otomatik testler ve kod incelemesi.

## Sonuç

Yazılım çekirdeği yerel ortamda çalışıyor. Gerçek RFID okuma hattı şu anda faal değil: atanmış okuyucunun COM4 bağlantısı yok ve gateway çalışmıyor. Bu sonuç cihazın arızalı olduğunu kanıtlamaz; USB bağlantısı, güç, sürücü veya port değişikliği ayrı ayrı kontrol edilmeli.

## Doğrulananlar

- `npm test`: 78 test, 74 başarılı, 0 başarısız, 4 atlanan canlı PostgreSQL testi. İlk kısıtlı çalıştırmadaki EACCES bağlantı hataları, yerel ağ izniyle tekrar çalıştırıldığında kalktı. Log: `data/runtime/system-audit-tests.log`.
- `/health`: 200, ok. `/ready`: 200, SQLite ready.
- Yerel yönetici kimliği ve yetkili dashboard erişimi: 200.
- Dashboard'un yüklediği özet, hareketler, okuyucu sağlığı, denetim, outbox, uyarılar, istisnalar, sevkiyatlar, Zoho katalog raporu, varlıklar, tesisler, bölgeler, katalog, kabul partileri, kodlama partileri, standart profili, donanım durumu, tekstil operasyonları, zincir özeti ve kullanıcı uçları yanıt verdi.
- İki logo dosyası: 200. Login ve dashboard gömülü JavaScript sözdizimi geçerli.
- Atama: `local-reader`, RRU9809USB-L, `hotel-local-1 / receiving`, aktif kayıt.
- Donanım durumu: COM4 bulunamadı; Windows ve SerialPort yalnızca standart COM1 gösteriyor. CP210/Silicon Labs USB seri aygıtı görünmüyor.
- Atanmış okuyucu son heartbeat: 23 Temmuz 2026 10:35:28 UTC (Türkiye saati 13:35:28); sağlık durumu offline. Eski `readerConnected: true` alanı bugünkü bağlantının kanıtı değildir.
- Çalışan Node süreçlerinde RFID gateway komutu yok.
- Mevcut envanter gözlemleri: 11 benzersiz EPC; 9 kayıtlı, 2 kayıtsız. Bunlar geçmiş kayıtlar; bugünkü fiziksel stok sayımı değildir.
- Outbox: 7 pending olay, attempts=0. İncelenen bu olaylar teslim edilmemiş. Harici hedefin yapılandırılıp yapılandırılmadığı doğrulanmadı; bu tek başına konektör arızası kanıtı değildir.
- Tekstil operasyonlarında 11 gözlem `other` aşamasında; clean/inRoom/soiled/inWash sıfır. Operasyonel aşamalar için bölge eşlemesi ve saha verisi gerekiyor.

## Bulunan sorunlar ve riskler

1. **P1 — Gerçek okuyucu bağlantısı yok.** Canlı etiket okuma/yazma ve fiziksel doğruluk doğrulanamadı. COM4 kaydı atamadır, fiziksel bağlantı değildir.
2. **P1 — Donanım ekranı heartbeat'i yanlış eşleştiriyor.** `src/api/app.js` durum uç noktası `adapter === "rru9809usb"` arıyor; `src/gateway/runner.js` ise `rru9809usb@1.0.0` gönderiyor. Canlı sonuçta okuyucu sağlığı offline iken donanım durumu standby ve lastHeartbeatAt=null. Atanmış readerId üzerinden, sürümden bağımsız ve en güncel kayıtla eşleştirme yapılmalı.
3. **P1 — Gateway sürekli hizmet değil.** Runner sınırlı okumayı bitirip kuyruğu gönderiyor, tek heartbeat bildiriyor ve kapanıyor. Sürekli izleme için servis döngüsü, periyodik heartbeat, yeniden bağlanma ve yeniden başlatma gerekiyor. Hata öncesi kapanışlarda da sağlık bildirimini ele almak gerekli.
4. **P1 — Entegrasyon teslimatı bekliyor.** 7 pending olay için hedef ve worker durumu belirlenmeli. Hedef yoksa panel bunu yapılandırılmamış olarak göstermeli; varsa retry/teslim kanıtı sağlanmalı.
5. **P2 — Otomatik port tespiti yanlış pozitif üretebilir.** Detect uç noktası uygun USB eşleşmesi yoksa `ports[0]` değerine düşüyor. Bu bilgisayarda standart COM1'i RFID cihazı sanabilir. Port açılabilirliği ve okuyucu kimlik yanıtı doğrulanmadan detected denmemeli. Port ayarı yalnızca process.env içinde değişiyor, yeniden başlatmada kayboluyor.
6. **P2 — Dashboard yüklemesi tek noktadan kırılıyor.** Ortak `Promise.all` içindeki tek modül hatası bütün ilk yüklemeyi durduruyor. Modüller bağımsız hata durumu ve tekrar deneme sunmalı.
7. **P2 — Zoho bağlantı etiketi canlı bağlantıyı kanıtlamıyor.** Uç nokta yerel JSON raporunu okuyup connected=true döndürüyor. Son senkronizasyon zamanı, rapor yaşı ve canlı API bağlantısı ayrı durumlar olmalı.
8. **P2 — API ve gateway adresi tutarsızlaşabilir.** Önizleme 8081'de, gateway varsayılanı 8080. Gateway açıkça doğru API_URL ile çalıştırılmalı; ortak kalıcı yapılandırma kullanılmalı.
9. **P2 — Prototip ortamı.** Yerel varsayılan yönetici hesabı, SQLite ve geliştirme kimlikleri kullanılıyor. Üretim koşulları ve canlı PostgreSQL testleri bu kontrolde doğrulanmadı.

## Önerilen uygulama sırası

### 1. Bağlantıyı doğrulama ve doğru durum göstergesi

- Okuyucunun USB/güç/CP210x sürücüsü ve gerçek COM portunu kontrol et; COM1'i otomatik olarak atama.
- Port üzerinden model/firmware kimliğini doğrula; tesis/bölge/readerId atamasını kontrol et.
- Sürümlü adapter eşleştirmesini düzelt; bağlantı, heartbeat ve son etiket okumasını ayrı göster.
- API_URL ve portu ortak kalıcı yerel yapılandırmada birleştir.
- Kabul: doğrulanmış cihaz kimliği, güncel heartbeat, bilinen test etiketinin EPC'si ve dashboard'da aynı EPC; kablo çıkarıldığında doğru offline durumu.

### 2. Kesintisiz gateway ve dayanıklılık

- Windows arka plan servisi, periyodik heartbeat, otomatik yeniden bağlanma ve kontrollü kapatma.
- Disk kuyruğunun yeniden başlatma, ağ kesintisi ve tekrar gönderim senaryoları.
- Dashboard modüllerini bağımsız yükle; cihaz algılamasını kimlik doğrulamayla güçlendir.
- Kabul: 24 saat gözlemde kararlı çalışma; kontrollü ağ kesintisinde veri kaybı ve mükerrer stok yok; tek modül hatası diğer ekranları durdurmuyor.

### 3. Gerçek saha pilotu ve operasyon akışı

- Bilinen EPC listesiyle kuru/ıslak/katlı tekstil ve dolu araba testleri; en az 10 kontrollü geçiş.
- Mal kabul → depo → kullanım → kirli → yıkama → temiz dönüş bölgelerini tanımla.
- İki kayıtsız EPC'yi incele; geçmiş/demo verisini pilot verisinden ayır.
- Kabul: mevcut saha runbook hedefleri olan en az %99 okuma ve en çok %0,5 yanlış hareket; eksik/fazla ürün mutabakatı ve kesinti sonrası kayıpsız aktarım için kayıtlı kanıt.

### 4. Entegrasyon ve üretime hazırlık

- Zoho rapor yaşı/canlı bağlantı ayrımı; outbox worker ve teslimat takibi.
- PostgreSQL üzerinde atlanan 4 canlı testi çalıştır; tenant izolasyonu, migration ve yedekten geri dönüşü doğrula.
- Üretim kimlikleri, HTTPS, rol denetimi, izleme ve yük testleri.
- Kabul: bekleyen olaylar için teslim veya açıklanmış işlem durumu, başarılı geri yükleme denemesi, tüm gerekli canlı testler ve işletim prosedürleri.

## Kontrolün sınırları

Tarayıcıda tüm butonlar görsel olarak tıklanmadı; API yanıtı ve sözdizimi kontrolü tam kullanıcı arayüzü kabul testi değildir. Fiziksel cihaz bulunmadığı için gerçek RF taraması, EPC yazma, anten performansı ve yıkama/saha dayanımı denenmedi. Harici Zoho/webhook çağrıları yapılmadı. Mevcut envantere simülasyon verisi eklenmedi, etiket yazılmadı. Önceden mevcut çalışma ağacı değişikliklerine dokunulmadı; bu kontrol kapsamında uygulama kodu değiştirilmedi.
