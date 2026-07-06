# Türkiye–ABD RFID bölge yapılandırması

## Temel kural

EPC ürünün küresel kimliğidir; ürün Türkiye'den ABD'ye giderken değiştirilmez.
Değişen şey, etikete enerji veren okuyucu/yazıcının ülkeye uygun RF bölge
profilidir.

```text
Türkiye üretim tesisi
  EPC üret -> ETSI_TR ile yaz -> geri oku ve doğrula
            |
            v
      aynı etiket ve aynı EPC
            |
            v
ABD oteli
  FCC_US ile oku -> Gateway -> Globaltex envanteri
```

Etiketler pasif UHF RAIN RFID, EPC Class 1 Gen2 / ISO 18000-63 ve geniş bant
860–960 MHz uyumlu tekstil etiketi olmalıdır. Gerçek ürün yerleşimiyle hem
Türkiye yazma hattında hem de ABD pilot sahasında okuma testi yapılmalıdır.

## Uygulamadaki profiller

| Profil | Kullanım | Sistem davranışı |
| --- | --- | --- |
| `FCC_US` | ABD'deki otel, depo ve pilot okuyucuları | 902–928 MHz ABD modeli/üretici bölge ayarı beklenir |
| `ETSI_TR` | Türkiye'deki kodlama ve kalite kontrol istasyonu | Cihazın güncel BTK onayı ve üretici Türkiye/ETSI ayarı beklenir |

`ETSI_TR` adı bir uygulama profilidir; tek başına mevzuat uygunluğu belgesi
değildir. Kesin kanal, güç, anten kazancı ve kullanım koşulları satın alınan
cihazın onayı ve güncel BTK arayüz gereklilikleriyle doğrulanmalıdır.

Amerika kıtasındaki bütün ülkeler `FCC_US` kabul edilmez. Kanada, Meksika,
Karayipler ve Güney Amerika kurulumları için ilgili ülkenin düzenleyici profili
eklenmeden adaptör RF yayınına geçirilmemelidir.

## Gateway güvenlik kuralı

RF yayan bir donanım adaptörü:

1. manifest içinde desteklediği bölgeleri ilan eder,
2. `REGULATORY_REGION` veya adaptör ayarında açık bir bölge ister,
3. bilinmeyen ya da cihazın desteklemediği bölgede başlamayı reddeder,
4. üretici SDK'sında bölgeyi RF açılmadan önce uygular.

ABD kurulumu:

```powershell
$env:REGULATORY_REGION='FCC_US'
$env:ADAPTER_CONFIG='{"host":"192.168.1.50"}'
node src/gateway/cli.js .\adapters\vendor-reader.js
```

Türkiye kodlama istasyonu:

```powershell
$env:REGULATORY_REGION='ETSI_TR'
$env:ADAPTER_CONFIG='{"host":"192.168.1.60"}'
node src/gateway/cli.js .\adapters\vendor-writer.js
```

Üretici adaptörü `FCC_US` veya `ETSI_TR` değerini cihaz SDK'sındaki gerçek
bölge sabitine çevirmelidir. Bu eşleme yapılmadan RF açılmamalıdır.

## Satın alma ve pilot kabul listesi

- ABD okuyucusunun tam modelinde FCC yetkilendirmesi/FCC ID bulunmalı.
- Cihazın bölge kilidi ve seçilen modelin `FCC_US` desteği yazılı doğrulanmalı.
- Türkiye'deki yazıcının güncel BTK/ürün uygunluğu ve yerel bölge ayarı
  doğrulanmalı.
- Etiket veri sayfası global/geniş bant UHF aralığını belirtmeli.
- Etiket gerçek havlu, çarşaf ve bornoz yerleşimlerinde ayrı ayrı test edilmeli.
- Endüstriyel yıkama, kurutma, pres ve kimyasal dayanım raporu alınmalı.
- Yazılan EPC geri okunmalı; mümkünse TID ile EPC eşlemesi kaydedilmeli.
- ABD pilotunda okuma oranı, kaçak okumalar, anten yerleşimi ve güç seviyesi
  saha kabul testinden geçirilmelidir.

## Sorumluluk sınırı

Uygulama yanlış veya eksik bölge ayarıyla adaptörün başlamasını engeller.
Donanımın yasal uygunluğu, anten/güç kurulumu ve üretici SDK'sındaki bölge
eşlemesi ise cihaz modeli ve kurulum ülkesi seçildikten sonra saha
sertifikasyonunun parçasıdır.
