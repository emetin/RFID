# Globaltex ve otel kullanıcıları

## Ekranlar

Girişten sonra `/dashboard`, Globaltex için mevcut tam operasyon panelini açar: EPC okuma/yazma, ürün girişi, envanter ve sevkiyat ekranları korunur. Globaltex menüsündeki **Oteller, hesaplar ve stok talepleri** bağlantısı `/dashboard/control` adresindeki ek yönetim alanını açar. Otel hesapları `/dashboard/receiving` gibi gelişmiş adresleri açsa bile sade otel portalını görür. Her iki alanda mevcut koyu ve altın renkli Globaltex paleti kullanılır; logonun arkasında kutu bulunmaz.

Otel portalı genel bakış, ürün listesi, konumlar ve stok taleplerinden oluşur. Ürün ve etiket koduyla arama, konum/durum filtreleri ve son görülme zamanı bulunur. Eski okumalar güncel fiziksel sayım gibi sunulmaz. Stok güncelliği uyarısı son okuma 24 saatten eski olduğunda gösterilir.

## Otel ve hesap açma

1. Globaltex yönetiminde **Oteller ve hesaplar → Otel ekle** ile oteli oluşturun. Otelin veri alanı, ana tesisi ve mal kabul bölgesi açılır.
2. **Kullanıcı oluştur** ile ad, kullanıcı adı, en az 12 karakterli parola ve rol girin; oteli seçin.
3. Hesap bilgilerini otel yetkilisiyle güvenli şekilde paylaşın. Bu sürüm e-posta daveti veya otomatik parola sıfırlama bağlantısı göndermez.
4. Aynı ekrandan otel hesabının rolünü/otel atamasını düzenleyebilir, parolasını değiştirebilir veya erişimini kapatabilirsiniz. Mevcut oturumlarda hesap ve atama bilgisi her istekte yeniden doğrulanır.

Globaltex merkez alanına otel hesabı atanamaz. Otel yöneticisi stok kurallarını yönetebilir. Operasyon kullanıcısı stok/talepleri takip edebilir ve bekleyen talebi iptal edebilir. Görüntüleyici yalnızca okuyabilir. Otel hesaplarının etiket yazma, ürün kaydı, kullanıcı oluşturma, cihaz/teknik yapılandırma ve sevkiyat oluşturma mutasyonları API'de engellenir.

Globaltex chain_admin kimliğinin ilk tenant ataması merkez alanı kabul edilir. Globaltex'in oluşturduğu oteller bu merkezin kalıcı dizinine kaydedilir ve yönetim kapsamına eklenir. Mevcut harici kimlik yapılandırmalarında merkez tenant'ı ilk sıraya yerleştirin.

## Minimum stok ve otomatik talep

- Kurallar otel ve SKU bazında kaydedilir: minimum, hedef ve otomatik talep tercihi.
- Kullanılabilir stok, doğrulanmış konumu olan kayıtlı ve `active` durumundaki ürün sayısıdır. Karantina, hasarlı, kayıp, kullanım dışı ve kayıtsız etiketler dahil edilmez. Bu toplam kullanılabilir ürün kuralıdır; temiz tekstil aşamasına özel bir PAR kuralı değildir.
- Sayı minimumun **altına** düşünce `hedef − kullanılabilir` kadar talep oluşturulur. Minimuma eşit stok tetiklemez.
- Aynı otel/SKU için submitted, approved veya shipped talep varken ikinci otomatik talep açılmaz. İşlemler bellekte, SQLite transaction'ında veya PostgreSQL advisory lock ile seri hale getirilir.
- İptal veya ret sonrası stok düşük kalıyorsa yeniden talep yağmuru oluşmaz. Stok minimuma ulaştığında kural yeniden kurulur; sonraki düşüş yeni talep açabilir.
- Sunucu çalışırken 30 saniyede bir arka plan kontrolü yapılır. Kural kaydı ve stok ekranı okuması da değerlendirme yapar. Sunucu kapalıyken arka plan görevleri çalışmaz.
- Akış: **Globaltex onayı bekliyor → Onaylandı → Sevk edildi → Tamamlandı**. Başlangıç durumunda ret veya iptal; sevkiyata bağlanmadan önce onaylı talepte iptal mümkündür. Otel yalnızca başlangıç durumundaki talebi iptal edebilir.
- Globaltex bütün yetkili otellerin taleplerini tek listeden görür. Her durum geçişi aktör ve zamanla talep geçmişinde saklanır.
- **Prepare shipment** bağlantısı hedef oteli, SKU'yu, miktarı ve talep referansını sevkiyat ekranına taşır. Talep miktarı kadar aktif, doğru SKU'lu ve Globaltex'e ait EPC okutulmalıdır. Paket oluşturulunca talep otomatik olarak **Shipped** olur.
- **Receive delivery** bağlantısı otelin mal kabul ekranına geçer. Kısmi teslimat talebi açık tutar ve teslim edilen adedi gösterir. Paketin tamamı kabul edildiğinde stok/mülkiyet aktarımını takiben talep otomatik **Completed** olur. Bu iki durum elle atanamaz.
- Aynı EPC iki açık pakette rezerve edilemez. Aynı talebin aynı paketle tekrarı ikinci sevkiyat oluşturmaz. Kesinti sonrası kalıcı talep bağlantısı, sevkiyat kaydıyla tekrar eşleştirilerek devam eder.
- Talep Globaltex paneline düşer; bu sürüm harici ticari sipariş API'si veya e-posta göndermez.

## Kalıcılık ve çalıştırma

SQLite `hotel_operations` tablosu var olan veritabanı açılırken otomatik oluşturulur. PostgreSQL için `014_hotel_operations.sql` migration'ı gerekir. PostgreSQL uygulama rolü için tenant slug bağlamıyla RLS uygulanır. Yeni özellikler mevcut envanter kayıtlarını veya etiketleri değiştirmez.

Yerel önizleme bu bilgisayarda 8081 portundadır. Gateway kullanılırken `API_URL=http://127.0.0.1:8081` ayarlanmalıdır. Fiziksel RRU9809 bu geliştirme sırasında bağlı değildi; RF okuma/yazma doğrulaması yapılmadı.

## Doğrulama

Otomatik kontroller otel oluşturma, kullanıcı oturumu, tenant izolasyonu, merkez alana hatalı atamanın engellenmesi, teknik işlemlerin engellenmesi, görüntüleyici yetkisi, minimum stok talebi, mükerrer talep önleme, iptal sonrası bastırma, hasarlı stok hariç tutma ve SQLite yeniden açılışından sonra kalıcılığı kapsar. Canlı PostgreSQL testleri DATABASE_URL olmadan atlanır.

## Admin için günlük kullanım

1. Eski ana panelde **What needs action?** alanından bekleyen talepleri ve teslimatları kontrol edin.
2. **Hotels, accounts and stock requests → Stock requests** içinde talebi **Approve** ile onaylayın.
3. **Prepare shipment** ile ürünleri okutun ve paketi gönderin. Yetersiz kaynak stok varsa etiketli ürün hazırlığını tamamlayın.
4. **Receive delivery** ile doğru oteldeki mal kabul oturumunu başlatın; okutulanları karşılaştırıp kabul edin.
5. Otel kendi ekranında konum, durum, talep ve teslimat ilerlemesini görür. Tam teslimat talebi otomatik kapatır.

Güncelleme öncesinden kalan ve yönetici atamalarınızda olmayan bir otele ait sevkiyatlar salt okunur gösterilir. Alıcı otelin erişimi yetkili olarak tanımlanmadan **Receive delivery** bağlantısı sunulmaz.
