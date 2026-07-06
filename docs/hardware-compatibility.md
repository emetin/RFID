# Okuyucu ve etiket uyumluluğu

## Satın alma şartnamesi

Globaltex tekstil etiketi:

- pasif UHF RAIN RFID,
- EPC Class 1 Gen2 / ISO 18000-63,
- her fiziksel üründe benzersiz EPC,
- endüstriyel yıkama, kurutma, pres ve kimyasallara dayanım,
- tekstil içindeki yerleşim için doğrulanmış anten performansı.

Okuyucu:

- kullanılacağı ülkenin UHF bandı için onaylı bölgesel model,
- EPC Gen2 desteği,
- sabit cihazda en az LLRP veya MQTT/HTTPS veri çıkışı,
- NTP saat senkronizasyonu,
- TLS ve cihaz başına kimlik bilgisi,
- anten portu ve GPIO ihtiyacına uygunluk,
- çevrimdışı tampon veya yerel Gateway ile çalışma.

## Entegrasyon sınıfları

| Cihaz tipi | Globaltex bağlantısı | Not |
|---|---|---|
| MQTT/HTTP yayınlayan sabit okuyucu | Edge Gateway adapter | En kolay bulut kurulumu |
| LLRP destekleyen sabit okuyucu | LLRP adapter | Marka bağımsızlığı için güçlü ortak payda |
| Android el terminali | Üretici SDK'sı kullanan mobil uygulama | Sayım, arama ve istisna çözümü |
| USB/seri masaüstü okuyucu | Yerel adapter | Etiketleme ve ürün-EPC eşleme |
| Sadece üretici protokolü olan cihaz | Özel adapter | Satın almadan önce PoC zorunlu |

“Gen2 etiketi okuyabiliyor” olması yalnızca hava arayüzü uyumluluğunu kanıtlar. Yazılım entegrasyonu için cihazın host protokolü de şartnamede açıkça yer almalıdır.

## Türkiye üretiminden ABD kullanımına

- Ürüne yazılan EPC ülke değiştirirken değişmez.
- Global/geniş bant 860–960 MHz tekstil etiketi tercih edilir.
- Türkiye'deki kodlama cihazı `ETSI_TR`, ABD'deki okuyucu `FCC_US` profiliyle
  çalıştırılır.
- ABD cihazının tam modelinde FCC yetkilendirmesi ve 902–928 MHz desteği
  doğrulanır.
- “Amerika” tek bölge sayılmaz; ABD dışındaki her ülke için yerel düzenleme
  ayrıca doğrulanır.
- Adaptör, üretici SDK'sında doğru bölge ayarını RF açılmadan önce uygular.

Ayrıntılı akış ve satın alma listesi:
[Türkiye–ABD bölge yapılandırması](regional-rf-deployment.md).
