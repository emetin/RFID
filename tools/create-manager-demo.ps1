$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot '..\data\runtime\manager-demo'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$W = 1920; $H = 1080
$green = [System.Drawing.Color]::FromArgb(14,74,58)
$mint = [System.Drawing.Color]::FromArgb(225,244,236)
$ink = [System.Drawing.Color]::FromArgb(10,34,36)
$muted = [System.Drawing.Color]::FromArgb(90,111,110)
$paper = [System.Drawing.Color]::FromArgb(246,249,247)
$white = [System.Drawing.Color]::White
$amber = [System.Drawing.Color]::FromArgb(245,166,35)

function Font($size, $bold=$false) {
  $style = if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
  New-Object System.Drawing.Font('Segoe UI', $size, $style)
}
function RoundRect($g,$x,$y,$w,$h,$r,$brush) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r*2
  $p.AddArc($x,$y,$d,$d,180,90); $p.AddArc($x+$w-$d,$y,$d,$d,270,90)
  $p.AddArc($x+$w-$d,$y+$h-$d,$d,$d,0,90); $p.AddArc($x,$y+$h-$d,$d,$d,90,90)
  $p.CloseFigure(); $g.FillPath($brush,$p); $p.Dispose()
}
function Text($g,$s,$x,$y,$size,$color,$bold=$false) {
  $f=Font $size $bold; $b=New-Object System.Drawing.SolidBrush($color)
  $g.DrawString($s,$f,$b,$x,$y); $b.Dispose(); $f.Dispose()
}
function Card($g,$x,$y,$w,$h,$title,$value,$note,$accent=$green) {
  RoundRect $g $x $y $w $h 22 (New-Object System.Drawing.SolidBrush($white))
  $ab=New-Object System.Drawing.SolidBrush($accent); $g.FillRectangle($ab,$x,$y,8,$h); $ab.Dispose()
  Text $g $title ($x+32) ($y+24) 18 $muted $true
  Text $g $value ($x+32) ($y+65) 42 $ink $true
  Text $g $note ($x+32) ($y+127) 16 $muted
}
function New-Slide($n,$section,$title,$subtitle,[scriptblock]$body) {
  $bmp=New-Object System.Drawing.Bitmap($W,$H)
  $g=[System.Drawing.Graphics]::FromImage($bmp); $g.SmoothingMode='AntiAlias'; $g.TextRenderingHint='AntiAliasGridFit'
  $g.Clear($paper)
  $sb=New-Object System.Drawing.SolidBrush($green); $g.FillRectangle($sb,0,0,290,$H); $sb.Dispose()
  Text $g 'G' 62 54 56 $white $true; Text $g 'GLOBALTEX' 120 65 26 $white $true; Text $g 'RFID Control Center' 120 105 15 ([System.Drawing.Color]::FromArgb(180,225,210))
  Text $g $section 60 250 17 ([System.Drawing.Color]::FromArgb(180,225,210)) $true
  Text $g ('0'+$n) 60 292 80 $white $true
  Text $g $title 350 80 50 $ink $true; Text $g $subtitle 352 150 21 $muted
  & $body $g
  Text $g 'GLOBALTEX RFID TEXTILE CONTROL' 350 1020 15 $muted $true
  Text $g "$n / 6" 1780 1020 15 $muted $true
  $path=Join-Path $outDir ("slide-{0:00}.png" -f $n); $bmp.Save($path,[System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

New-Slide 1 'YONETICI OZETI' 'Tekstil operasyonlarında fiziksel doğruluk' 'RFID ile tekil ürün, stok ve teslimat kontrolü' {
  param($g)
  RoundRect $g 350 280 1450 570 30 (New-Object System.Drawing.SolidBrush($green))
  Text $g 'Her tekstil ürünü benzersiz EPC kimliğiyle izlenir.' 430 370 42 $white $true
  Text $g 'Okuma  •  Stok  •  Sevkiyat  •  Teslim kabulü' 430 465 30 ([System.Drawing.Color]::FromArgb(188,232,216))
  Text $g 'Amaç: Doğru ürünün, doğru lokasyonda, doğrulanmış şekilde yönetilmesi.' 430 585 27 $white
  Text $g 'CANLI PILOT' 430 700 18 ([System.Drawing.Color]::FromArgb(188,232,216)) $true
  Text $g 'Globaltex → Patak Hotel' 430 738 32 $white $true
}
New-Slide 2 'OPERASYON PANELI' 'Anlık operasyon görünürlüğü' 'Yönetici ekranında temel stok ve risk göstergeleri' {
  param($g)
  Card $g 350 270 330 210 'PHYSICAL UNITS' '8' 'Gözlemlenen EPC adedi'
  Card $g 710 270 330 210 'AVAILABLE' '6' 'Aktif kullanılabilir stok'
  Card $g 1070 270 330 210 'OPEN EXCEPTIONS' '1' 'İnceleme bekleyen kayıt' $amber
  Card $g 1430 270 330 210 'ACTIVE ALERTS' '2' 'Operasyonel uyarı' ([System.Drawing.Color]::FromArgb(205,70,70))
  RoundRect $g 350 530 920 340 24 (New-Object System.Drawing.SolidBrush($white))
  Text $g 'Varlık durumu' 390 565 24 $ink $true
  Text $g 'Aktif' 390 640 19 $muted; Text $g '6' 1165 640 22 $ink $true
  $bg=New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(230,235,232)); $g.FillRectangle($bg,520,645,610,15); $bg.Dispose()
  $fg=New-Object System.Drawing.SolidBrush($green); $g.FillRectangle($fg,520,645,520,15); $fg.Dispose()
  Text $g 'Kayıtsız' 390 725 19 $muted; Text $g '2' 1165 725 22 $ink $true
  RoundRect $g 1310 530 450 340 24 (New-Object System.Drawing.SolidBrush($mint))
  Text $g 'Zincir geneli' 1350 575 22 $green $true; Text $g '9' 1350 645 52 $ink $true
  Text $g '2 otel • 7 kullanılabilir birim' 1350 720 21 $green
}
New-Slide 3 'CANLI RFID' 'Cihaz bağlantısı ve gerçek etiket okuması' 'RRU9809USB-L, COM4 üzerinden doğrulandı' {
  param($g)
  RoundRect $g 350 270 1410 165 25 (New-Object System.Drawing.SolidBrush($mint))
  Text $g '●  CIHAZ BAGLI' 410 310 24 $green $true; Text $g 'COM4  •  57600 baud  •  ETSI_TR' 410 360 22 $muted
  Card $g 350 490 430 230 'GERCEK OKUMA' '3' 'Aynı etiketten doğrulama okuması'
  Card $g 825 490 430 230 'GONDERILEN PAKET' '1' 'Merkeze başarıyla aktarıldı'
  Card $g 1300 490 460 230 'BEKLEYEN VERI' '0' 'Kuyruk temiz • synchronized'
  Text $g 'Okuma işlemi etiketi değiştirmez; yalnızca mevcut EPC kimliğini gösterir.' 350 800 24 $ink $true
}
New-Slide 4 'URUN VE STOK' 'EPC tekil ürünü, SKU ürün grubunu temsil eder' 'Zoho kataloğu ile RFID fiziksel görünümü karşılaştırılır' {
  param($g)
  RoundRect $g 350 260 1410 610 24 (New-Object System.Drawing.SolidBrush($white))
  Text $g 'SKU' 400 300 17 $muted $true; Text $g 'URUN' 650 300 17 $muted $true; Text $g 'ZOHO' 1260 300 17 $muted $true; Text $g 'RFID' 1480 300 17 $muted $true
  $rows=@(
    @('BEACH-JPT4060','Acqualina Estates / Custom Jacquard Towels','0','1'),
    @('BT-WHT-2754','Bath Towel','—','5'),
    @('SOFYA-BT2754','Sofya White Bath Towel','—','15')
  )
  $y=365
  foreach($r in $rows){
    $pen=New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(225,232,228)); $g.DrawLine($pen,400,$y+65,1700,$y+65); $pen.Dispose()
    Text $g ($r[0]) 400 $y 19 $ink $true; Text $g ($r[1]) 650 $y 19 $ink; Text $g ($r[2]) 1270 $y 22 $ink $true; Text $g ($r[3]) 1490 $y 22 $green $true; $y+=120
  }
  RoundRect $g 400 735 1300 80 18 (New-Object System.Drawing.SolidBrush($mint))
  Text $g 'Farklar görünür hale gelir; ekip fiziksel stok sapmasına odaklanır.' 445 758 22 $green $true
}
New-Slide 5 'KONTROLLU ISLEM' 'Okuma ve etiket yazma birbirinden ayrıdır' 'Yanlışlıkla EPC değiştirme riskini azaltan güvenli operatör akışı' {
  param($g)
  RoundRect $g 350 275 680 520 28 (New-Object System.Drawing.SolidBrush($mint))
  Text $g '1  READ EXISTING TAG' 410 330 24 $green $true
  Text $g 'Salt okunur' 410 405 38 $ink $true
  Text $g '• Mevcut EPC görüntülenir' 410 505 23 $ink
  Text $g '• Etiket değişmez' 410 560 23 $ink
  Text $g '• Güvenli kontrol adımı' 410 615 23 $ink
  RoundRect $g 1080 275 680 520 28 (New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255,246,225)))
  Text $g '2  ENCODE NEW TAGS' 1140 330 24 $amber $true
  Text $g 'Kontrollü yazma' 1140 405 38 $ink $true
  Text $g '• Ürün seçilir' 1140 505 23 $ink
  Text $g '• Yeni EPC üretilir' 1140 560 23 $ink
  Text $g '• Yazma sonrası tekrar okunur' 1140 615 23 $ink
  Text $g '• Operatör onayı gerekir' 1140 670 23 $ink
}
New-Slide 6 'SEVKIYAT VE TESLIM' 'Globaltex gonderir, Patak tarar ve kabul eder' 'Stok yalnizca mutabakat sonrasi Accept delivery ile devredilir' {
  param($g)
  RoundRect $g 380 330 380 360 24 (New-Object System.Drawing.SolidBrush($white))
  Text $g '1  SEVKIYATI HAZIRLA' 410 370 21 $green $true
  Text $g 'EPC manifesti ve referans' 410 460 19 $ink
  Text $g 'olusturulur.' 410 500 19 $ink
  Text $g '>' 780 455 46 $green $true
  RoundRect $g 820 330 380 360 24 (New-Object System.Drawing.SolidBrush($white))
  Text $g '2  OTELDE TARA' 850 370 21 $green $true
  Text $g 'Eksik ve beklenmeyen urunler' 850 460 19 $ink
  Text $g 'karsilastirilir.' 850 500 19 $ink
  Text $g '>' 1220 455 46 $green $true
  RoundRect $g 1260 330 380 360 24 (New-Object System.Drawing.SolidBrush($white))
  Text $g '3  TESLIMI KABUL ET' 1290 370 21 $green $true
  Text $g 'Mutabakat tamamlaninca' 1290 460 19 $ink
  Text $g 'stok devredilir.' 1290 500 19 $ink
  RoundRect $g 460 770 1220 100 20 (New-Object System.Drawing.SolidBrush($green))
  Text $g 'SONUC: Izlenebilir, dogrulanmis ve denetlenebilir tekstil hareketi' 545 798 27 $white $true
}

Write-Output $outDir
