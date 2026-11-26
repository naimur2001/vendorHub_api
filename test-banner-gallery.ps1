# test-banner-gallery.ps1 (home page gallery: GALLERY placement, its own limit of 16, size rules, no phone version,
# public list, reorder, placement moves, audit). Run while the API runs. Deletes its banners at the end.
$base = 'http://localhost:4000/api/v1'
$script:pass = 0
$script:fail = 0
$script:lastMsg = ''
$script:lastCode = ''

function Call($method, $path, $token, $body) {
    $script:lastMsg = ''
    $script:lastCode = ''
    $params = @{ Method = $method; Uri = "$base$path"; UseBasicParsing = $true }
    if ($token) { $params.Headers = @{ Authorization = "Bearer $token" } }
    if ($null -ne $body) {
        $params.ContentType = 'application/json'
        $params.Body = ($body | ConvertTo-Json -Depth 6 -Compress)
    }
    try {
        $r = Invoke-WebRequest @params
        return @{ status = [int]$r.StatusCode; json = ($r.Content | ConvertFrom-Json); raw = $r.Content }
    } catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { return @{ status = 0; json = $null; raw = '' } }
        $text = $_.ErrorDetails.Message
        $json = $null
        try { $json = $text | ConvertFrom-Json } catch { }
        if ($null -ne $json -and $null -ne $json.error) {
            $script:lastMsg = $json.error.message
            if ($null -ne $json.error.details) { $script:lastCode = $json.error.details.code }
        }
        return @{ status = [int]$resp.StatusCode; json = $json; raw = $text }
    }
}

function Check($name, $actual, $expected) {
    if ($actual -eq $expected) {
        Write-Host "PASS  $name" -ForegroundColor Green
        $script:pass++
    } else {
        $extra = ''
        if ($script:lastMsg) { $extra = " | server said: $($script:lastMsg)" }
        Write-Host "FAIL  $name (got '$actual', expected '$expected')$extra" -ForegroundColor Red
        $script:fail++
    }
}

function Login($email) {
    $r = Call 'POST' '/auth/login' $null @{ email = $email; password = 'Password123!' }
    if ($r.status -ne 200) { Write-Host "Login failed for $email" -ForegroundColor Red; exit 1 }
    return $r.json.data.accessToken
}

function Helper() {
    $lines = @(node --env-file=.env scripts/delivery-test-helper.mjs @args)
    $line = @($lines | Where-Object { $_ -like '{*' -and $_ -notlike '*"level":*' }) | Select-Object -Last 1
    if (-not $line) { return $null }
    return ($line | ConvertFrom-Json)
}

try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch { Write-Host 'The API is not running.' -ForegroundColor Red; exit 1 }

function GHelper() {
    $lines = @(node --env-file=.env scripts/banner-gallery-test-helper.mjs @args)
    $line = @($lines | Where-Object { $_ -like '{*' -and $_ -notlike '*"level":*' }) | Select-Object -Last 1
    if (-not $line) { return $null }
    return ($line | ConvertFrom-Json)
}
$tmp = Join-Path $env:TEMP 'vh-gallery-test'
node scripts/make-banner-fixtures.mjs $tmp | Out-Null

# multipart with curl.exe (like test-banners.ps1)
function Send($method, $path, $token, $files, $fields) {
    $out = Join-Path $tmp 'resp.json'
    if (Test-Path $out) { Remove-Item $out }
    $cargs = @('-s', '-o', $out, '-w', '%{http_code}', '-X', $method)
    if ($token) { $cargs += @('-H', "Authorization: Bearer $token") }
    foreach ($f in @($files)) {
        if (-not $f) { continue }
        $parts = $f -split '=', 2
        $nameType = $parts[1] -split ';type=', 2
        $cargs += @('-F', "$($parts[0])=@$(Join-Path $tmp $nameType[0]);type=$($nameType[1])")
    }
    if ($fields) { foreach ($k in $fields.Keys) { $cargs += @('--form-string', "$k=$($fields[$k])") } }
    $code = & curl.exe @cargs "$base$path"
    $json = $null
    if (Test-Path $out) { try { $json = Get-Content $out -Raw | ConvertFrom-Json } catch { } }
    return @{ status = [int]$code; json = $json }
}
$script:made = @()
function NewBanner($fields, $file) {
    if (-not $file) { $file = 'media=gallery.png;type=image/png' }
    $r = Send 'POST' '/admin/banners' $admin @($file) $fields
    if ($r.status -eq 201) { $script:made += $r.json.data.id }
    return $r
}
function Meta($placement) { return (Call 'GET' "/admin/banners?placement=$placement" $admin $null).json.meta }
function PublicGallery { return @((Call 'GET' '/banners?placement=GALLERY' $null $null).json.data | ForEach-Object { $_.id }) }

$since = [DateTime]::UtcNow.AddSeconds(-2).ToString('o')
$admin = Login 'admin@vendorshub.test'
$cust = Login 'customer@vendorshub.test'
$tag = "Gallery$(Get-Date -Format 'HHmmss')"

function Cleanup {
    foreach ($id in $script:made) { Call 'DELETE' "/admin/banners/$id" $admin $null | Out-Null }
    return (GHelper cleanup $since)
}
function Need($value, $what) {
    if (-not $value) {
        Write-Host "Cannot continue: $what failed. Server said: $($script:lastMsg)" -ForegroundColor Red
        Cleanup | Out-Null
        exit 1
    }
}

$hero0 = Meta 'HERO'
$g0 = Meta 'GALLERY'
Check 'GALLERY meta: its own max 16' $g0.max 16
Check 'HERO meta: the shared max 12' $hero0.max 12
Need ($g0.total -le 14) 'a gallery with room for 2 test images'

# ---- 1. create ----
Check 'a customer cannot create -> 403' (Send 'POST' '/admin/banners' $cust @('media=gallery.png;type=image/png') @{ titleEn = 'x'; placement = 'GALLERY' }).status 403
Check 'no title -> 400' (NewBanner @{ placement = 'GALLERY' }).status 400
Check 'below 600 x 600 -> 422' (NewBanner @{ titleEn = 'x'; placement = 'GALLERY' } 'media=gallery-small.png;type=image/png').status 422
$r = Send 'POST' '/admin/banners' $admin @('media=gallery.png;type=image/png', 'mobileMedia=mobile.jpg;type=image/jpeg') @{ titleEn = 'x'; placement = 'GALLERY' }
Check 'a phone version -> 422 GALLERY_NO_MOBILE' "$($r.status)/$($r.json.error.details.code)" '422/GALLERY_NO_MOBILE'
Check 'a GIF -> refused (pictures only)' ((NewBanner @{ titleEn = 'x'; placement = 'GALLERY' } 'media=anim.gif;type=image/gif').status -ne 201) $true
Check 'a javascript: link -> 400' (NewBanner @{ titleEn = 'x'; placement = 'GALLERY'; linkUrl = 'javascript:alert(1)' }).status 400
$a = NewBanner @{ titleEn = "$tag one"; placement = 'GALLERY'; linkUrl = '/markets'; subtitleEn = 'ignored'; ctaLabelEn = 'ignored' }
Need ($a.status -eq 201) 'the first gallery image'
$d = $a.json.data
Check 'created: GALLERY, IMAGE, 1200 x 1200, thumb, link kept' "$($d.placement)/$($d.mediaType)/$($d.media.width)x$($d.media.height)/$([bool]$d.media.thumbUrl)/$($d.linkUrl)" 'GALLERY/IMAGE/1200x1200/True//markets'
Check 'subtitle and CTA are not kept' "$($null -eq $d.subtitleEn)/$($null -eq $d.ctaLabelEn)/$($null -eq $d.mobileMedia)" 'True/True/True'
$b = NewBanner @{ titleEn = "$tag two"; placement = 'GALLERY' } 'media=side.png;type=image/png'
Need ($b.status -eq 201) 'the second gallery image (600 x 900)'
Check 'any shape at 600 x 600 or more (600 x 900)' "$($b.json.data.media.width)x$($b.json.data.media.height)" '600x900'
Check 'GALLERY meta counts them' (Meta 'GALLERY').total ($g0.total + 2)
Check 'HERO + SIDE_AD total unchanged' (Meta 'HERO').total $hero0.total

# ---- 2. public list, reorder ----
$r = Invoke-WebRequest "$base/banners?placement=GALLERY" -UseBasicParsing
Check 'public gallery: cached 60 s' $r.Headers['Cache-Control'] 'public, max-age=60'
$ids = PublicGallery
Check 'public gallery: ours in sortOrder (one before two)' ([array]::IndexOf($ids, $a.json.data.id) -lt [array]::IndexOf($ids, $b.json.data.id) -and [array]::IndexOf($ids, $a.json.data.id) -ge 0) $true
Check 'not in the slider' (@((Call 'GET' '/banners' $null $null).json.data | Where-Object { $_.id -eq $a.json.data.id }).Count) 0
$ro = Call 'PATCH' '/admin/banners/reorder' $admin @{ ids = @($b.json.data.id, $a.json.data.id) }
Check 'reorder -> 200 with the gallery' "$($ro.status)/$(@($ro.json.data | Where-Object { $_.placement -ne 'GALLERY' }).Count)" '200/0'
$ids = PublicGallery
Check 'public gallery follows the new order' ([array]::IndexOf($ids, $b.json.data.id) -lt [array]::IndexOf($ids, $a.json.data.id)) $true
$heroId = @((Call 'GET' '/admin/banners?placement=HERO' $admin $null).json.data)[0].id
if ($heroId) { Check 'reorder mixing GALLERY and HERO -> 400' (Call 'PATCH' '/admin/banners/reorder' $admin @{ ids = @($a.json.data.id, $heroId) }).status 400 }
$later = NewBanner @{ titleEn = "$tag later"; placement = 'GALLERY'; startsAt = [DateTime]::UtcNow.AddDays(1).ToString('o') }
Check 'scheduled for tomorrow: not public yet' (@(PublicGallery) -contains $later.json.data.id) $false

# ---- 3. placement moves ----
$mv = Send 'PATCH' "/admin/banners/$($b.json.data.id)" $admin @() @{ placement = 'HERO' }
Check 'GALLERY 600 x 900 -> HERO: too small (900 x 300) -> 422' $mv.status 422
$mv = Send 'PATCH' "/admin/banners/$($a.json.data.id)" $admin @() @{ placement = 'HERO' }
Check 'GALLERY 1200 x 1200 -> HERO -> 200' "$($mv.status)/$($mv.json.data.placement)" '200/HERO'
Check 'HERO + SIDE_AD total +1, gallery -1' "$((Meta 'HERO').total - $hero0.total)/$((Meta 'GALLERY').total - $g0.total)" '1/2'
$mv = Send 'PATCH' "/admin/banners/$($a.json.data.id)" $admin @() @{ placement = 'GALLERY'; subtitleEn = 'dropped' }
Check 'back to GALLERY -> 200, subtitle not kept' "$($mv.status)/$($mv.json.data.placement)/$($null -eq $mv.json.data.subtitleEn)" '200/GALLERY/True'
Check 'audit: created, then updated twice (the moves)' (GHelper audit $since $a.json.data.id).actions 'banner.created,banner.updated,banner.updated'
Check 'audit: the reorder is logged' ((GHelper audit $since $b.json.data.id).actions -like '*banner.reordered*') $true

# ---- 4. the 17th gallery image ----
$hero = NewBanner @{ titleEn = "$tag hero" } 'media=banner.png;type=image/png'
$left = 16 - (Meta 'GALLERY').total
for ($i = 1; $i -le $left; $i++) { Need ((NewBanner @{ titleEn = "$tag fill $i"; placement = 'GALLERY'; isActive = 'false' }).status -eq 201) "gallery image $i" }
Check 'gallery full: 16 / 16' "$((Meta 'GALLERY').total)/$((Meta 'GALLERY').max)" '16/16'
$files0 = (GHelper files).files
$r = NewBanner @{ titleEn = "$tag 17"; placement = 'GALLERY' }
Check 'the 17th -> 409 GALLERY_LIMIT' "$($r.status)/$($r.json.error.details.code)" '409/GALLERY_LIMIT'
Check 'no file kept' (GHelper files).files $files0
Check 'HERO still works while the gallery is full' $hero.status 201
$mv = Send 'PATCH' "/admin/banners/$($hero.json.data.id)" $admin @() @{ placement = 'GALLERY' }
Check 'moving a HERO banner into a full gallery -> 409 GALLERY_LIMIT' "$($mv.status)/$($mv.json.error.details.code)" '409/GALLERY_LIMIT'
Check 'public gallery: at most 16 and only live ones' ((@(PublicGallery).Count -le 16) -and -not (@(PublicGallery) -contains $later.json.data.id)) $true

# ---- 5. cleanup ----
$out = Cleanup
Check 'cleanup: gallery back to the start' (Meta 'GALLERY').total $g0.total
Check 'cleanup: HERO back to the start' (Meta 'HERO').total $hero0.total

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
if ($script:fail -gt 0) { exit 1 }
