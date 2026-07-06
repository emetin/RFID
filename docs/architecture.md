# Globaltex RFID mimarisi

## Hedef

Tek bir Globaltex platformu; farklı ülkelerdeki otelleri, otel gruplarını, depoları ve çamaşırhaneleri birbirinden yalıtılmış kiracılar olarak yönetir. Sabit kapı okuyucusu, masaüstü okuyucu ve el terminali aynı olay modeline bağlanır.

```text
UHF etiketler
    |
RFID okuyucu (EPC Gen2 / ISO 18000-63)
    |
Edge Gateway
  - LLRP adapter
  - MQTT/HTTP adapter
  - Zebra/Impinj SDK adapter
  - çevrimdışı disk kuyruğu
    |
Globaltex Cloud API
  - cihaz kimliği ve imza
  - idempotency / filtreleme
  - kabul ve hareket motoru
    |
PostgreSQL + olay arşivi
    |
Web/Mobil panel + Hotel ERP/PMS API
```

## Kimlik modeli

Etiket EPC'si tekil fiziksel ürünü tanımlar. EPC hiçbir zaman otel adı, oda numarası veya ürün açıklaması taşımaz.

- `tenant`: otel grubu veya bağımsız müşteri
- `facility`: otel, depo ya da dış çamaşırhane
- `zone`: receiving, linen-room, laundry-out, laundry-in, floor-12 gibi okuma alanı
- `catalog_product`: Globaltex SKU, ürün tipi, ölçü, renk
- `asset`: EPC ile eşleşmiş tekil tekstil ürünü
- `container`: koli veya palet; kendi EPC'si bulunabilir
- `shipment`: Globaltex'ten otele sevkiyat
- `read_event`: okuyucunun ham gözlemi
- `movement_event`: filtrelenmiş iş hareketi
- `inventory_session`: el terminaliyle yapılan sayım

Koli/palet ilişkisi fiziksel olarak etiketin içinde değil, sunucuda `container_membership` olarak tutulur. Böylece koli açıldığında ürünler kendi yaşam döngülerine devam eder.

## Okuma ile iş hareketi aynı şey değildir

Bir kapıdaki etiket saniyede onlarca kez okunabilir. Her okuma “stok hareketi” yapılırsa veri bozulur. Üretim hareket motoru:

1. `eventId` ile tekrar gönderimleri eler.
2. EPC + okuyucu + anten + zaman penceresinde okumaları toplar.
3. RSSI, anten ve mümkünse beam/direction verisiyle geçiş yönünü belirler.
4. Belirli süre ve güven eşiği oluşunca tek bir `RECEIVED`, `MOVED`, `LAUNDRY_OUT` veya `LAUNDRY_IN` olayı üretir.
5. Belirsiz okumayı otomatik hareket yerine operatör incelemesine bırakır.

Bu nedenle pilotta anten yerleşimi ve saha kalibrasyonu yazılım kadar önemlidir.

## Global kullanım için zorunlu ilkeler

- UHF frekans/bölge ayarı ülkeye göre okuyucuda yapılandırılır.
- Her otel verisi `tenant_id` ile ayrılır; kullanıcı ve cihaz yetkileri ayrıca sınırlandırılır.
- Edge Gateway internet kesildiğinde şifreli yerel kuyruğa yazar ve aynı `eventId` ile tekrar yollar.
- Cihaz sırrı düz metin dosyada değil OS secret store veya güvenli donanımda tutulur.
- Bulut bağlantısı TLS, tercihen cihaz başına mTLS kullanır.
- Ham okumalar sınırlı süre; iş hareketleri denetim ihtiyacına göre daha uzun saklanır.
- EPC kişisel veri taşımaz; çalışan/konuk takibi ürün kapsamı dışındadır.

## Üretim teknoloji yönü

- Web ve yönetim: Next.js/TypeScript
- API ve hareket işleyicileri: TypeScript servisleri
- Ana veri: PostgreSQL
- yüksek hacimli giriş: yönetilen kuyruk veya Kafka sınıfı event bus
- Edge Gateway: Node.js servis veya kurumsal kurulumlarda container
- gözlemleme: reader heartbeat, kuyruk derinliği, okuma oranı, hata ve anten sağlığı

MVP bilinçli olarak harici bağımlılık olmadan çalışır. PostgreSQL ve event bus geçişi, cihaz protokolü doğrulandıktan sonra yapılmalıdır.

