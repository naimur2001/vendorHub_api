# test-banners.ps1
# Run from the project root while "npm run dev" is running in another terminal.
$base = 'http://localhost:4000/api/v1'
$script:pass = 0
$script:fail = 0
$script:lastMsg = ''

function Call($method, $path, $token, $body) {
    $script:lastMsg = ''
    $params = @{ Method = $method; Uri = "$base$path"; UseBasicParsing = $true }
    if ($token) { $params.Headers = @{ Authorization = "Bearer $token" } }
    if ($null -ne $body) {
        $params.ContentType = 'application/json'
        $params.Body = ($body | ConvertTo-Json -Depth 6 -Compress)
    }
    try {
        $r = Invoke-WebRequest @params
        return @{ status = [int]$r.StatusCode; json = ($r.Content | ConvertFrom-Json) }
    } catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { return @{ status = 0; json = $null } }
        # Windows PowerShell 5.1 has already read the response stream; the body is in ErrorDetails
        $text = $_.ErrorDetails.Message
        if (-not $text) {
            try { $text = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd() } catch { $text = '' }
        }
        $json = $null
        try { $json = $text | ConvertFrom-Json } catch { }
        if ($null -ne $json -and $null -ne $json.error) { $script:lastMsg = $json.error.message }
        return @{ status = [int]$resp.StatusCode; json = $json }
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
    if ($r.status -ne 200) {
        Write-Host "Login failed for $email (status $($r.status))" -ForegroundColor Red
        exit 1
    }
    return $r.json.data.accessToken
}

function Need($value, $what) {
    if (-not $value) {
        Write-Host "Cannot continue: $what failed. Server said: $($script:lastMsg)" -ForegroundColor Red
        exit 1
    }
}

try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}

$tmp = Join-Path $env:TEMP 'vh-banner-test'
node scripts/make-banner-fixtures.mjs $tmp | Out-Null

# multipart with curl.exe: $files = @("field=filename;type=mime"), $fields = @{ name = value } (sent with --form-string)
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
function NewBanner($fields, $file) {
    if (-not $file) { $file = 'media=banner.png;type=image/png' }
    return Send 'POST' '/admin/banners' $admin @($file) $fields
}
function FileOf($url) { return Join-Path 'uploads\media' ($url -split '/media/')[1] }
function PublicIds { return @((Call 'GET' '/banners' $null $null).json.data | ForEach-Object { $_.id }) }

$admin = Login 'admin@vendorshub.test'
$cust = Login 'customer@vendorshub.test'
$made = @()

# ---- 1. public list ----
$r = Invoke-WebRequest "$base/banners" -UseBasicParsing
Check 'public list is open' ([int]$r.StatusCode) 200
Check 'public list is cached 60s' $r.Headers['Cache-Control'] 'public, max-age=60'
$seedList = @(($r.Content | ConvertFrom-Json).data)
Check 'two seed banners' $seedList.Count 2
Check 'no admin fields in public list' ($null -eq $seedList[0].PSObject.Properties['isActive']) $true

# ---- 2. access ----
Check 'no token -> 401' (Call 'GET' '/admin/banners' $null $null).status 401
Check 'customer list -> 403' (Call 'GET' '/admin/banners' $cust $null).status 403
Check 'customer create -> 403' (Send 'POST' '/admin/banners' $cust @('media=banner.png;type=image/png') @{ titleEn = 'x' }).status 403
Check 'customer reorder -> 403' (Call 'PATCH' '/admin/banners/reorder' $cust @{ ids = @($seedList[0].id) }).status 403
Check 'customer edit -> 403' (Call 'PATCH' "/admin/banners/$($seedList[0].id)" $cust @{ titleEn = 'x' }).status 403
Check 'customer delete -> 403' (Call 'DELETE' "/admin/banners/$($seedList[0].id)" $cust $null).status 403

# ---- 3. create ----
$r = NewBanner @{ titleEn = 'Test live'; titleBn = 'Test BN'; linkUrl = '/markets/jamuna-future-park'; ctaLabelEn = 'Go' } $null
Check 'create banner' $r.status 201
$live = $r.json.data; $made += $live.id
Check 'mediaType IMAGE' $live.mediaType 'IMAGE'
Check 'width returned' $live.media.width 1800
Check 'height returned' $live.media.height 600
Check 'liveNow true' $live.liveNow $true
Check 'new banner goes last' $live.sortOrder 2
Check 'file published' (Test-Path (FileOf $live.media.url)) $true

$r = NewBanner @{ titleEn = 'Test gif' } 'media=anim.gif;type=image/gif'
Check 'create GIF banner' $r.status 201
$gif = $r.json.data; $made += $gif.id
Check 'mediaType GIF' $gif.mediaType 'GIF'
Check 'GIF stored as .webp' ($gif.media.url -like '*.webp') $true
$bytes = [System.IO.File]::ReadAllBytes((FileOf $gif.media.url))
Check 'stored WebP is animated' ([System.Text.Encoding]::ASCII.GetString($bytes).Contains('ANIM')) $true

$r = Send 'POST' '/admin/banners' $admin @('media=banner.png;type=image/png', 'mobileMedia=mobile.jpg;type=image/jpeg') @{ titleEn = 'Test mobile' }
Check 'create with phone version' $r.status 201
$mob = $r.json.data; $made += $mob.id
Check 'mobileMedia returned' ($null -ne $mob.mobileMedia.url) $true

# ---- 4. schedule and active flag ----
$future = (Get-Date).ToUniversalTime().AddDays(3).ToString('o')
$past1 = (Get-Date).ToUniversalTime().AddDays(-3).ToString('o')
$past2 = (Get-Date).ToUniversalTime().AddDays(-1).ToString('o')
$r = NewBanner @{ titleEn = 'Test inactive'; isActive = 'false' } $null; $inactive = $r.json.data; $made += $inactive.id
Check 'inactive created' $r.status 201
$r = NewBanner @{ titleEn = 'Test future'; startsAt = $future } $null; $fut = $r.json.data; $made += $fut.id
Check 'future created' $r.status 201
$r = NewBanner @{ titleEn = 'Test expired'; startsAt = $past1; endsAt = $past2 } $null; $exp = $r.json.data; $made += $exp.id
Check 'expired created' $r.status 201
$ids = PublicIds
Check 'public hides inactive' ($ids -contains $inactive.id) $false
Check 'public hides future' ($ids -contains $fut.id) $false
Check 'public hides expired' ($ids -contains $exp.id) $false
Check 'public shows live' ($ids -contains $live.id) $true
$all = @((Call 'GET' '/admin/banners' $admin $null).json.data)
Check 'admin sees all' @($all | Where-Object { $made -contains $_.id }).Count $made.Count
Check 'admin: future not liveNow' (@($all | Where-Object { $_.id -eq $fut.id })[0].liveNow) $false
Check 'admin: expired not liveNow' (@($all | Where-Object { $_.id -eq $exp.id })[0].liveNow) $false
Check 'endsAt before startsAt -> 400' (NewBanner @{ titleEn = 'x'; startsAt = $past2; endsAt = $past1 } $null).status 400

# ---- 5. validation ----
Check 'javascript: link -> 400' (NewBanner @{ titleEn = 'x'; linkUrl = 'javascript:alert(1)' } $null).status 400
Check '//host link -> 400' (NewBanner @{ titleEn = 'x'; linkUrl = '//evil.example' } $null).status 400
Check 'http link -> 400' (NewBanner @{ titleEn = 'x'; linkUrl = 'http://example.com' } $null).status 400
Check 'no title -> 400' (NewBanner @{ subtitleEn = 'x' } $null).status 400
Check 'title over 120 -> 400' (NewBanner @{ titleEn = ('a' * 121) } $null).status 400
Check 'cta over 40 -> 400' (NewBanner @{ titleEn = 'x'; ctaLabelEn = ('a' * 41) } $null).status 400
Check 'no media -> 400' (Send 'POST' '/admin/banners' $admin @() @{ titleEn = 'x' }).status 400
Check 'SVG rejected' (NewBanner @{ titleEn = 'x' } 'media=evil.svg;type=image/svg+xml').status 400
Check 'renamed text file rejected' (NewBanner @{ titleEn = 'x' } 'media=fake.png;type=image/png').status 400
Check 'over 5 MB rejected' (NewBanner @{ titleEn = 'x' } 'media=big.png;type=image/png').status 413
Check 'too small rejected' (NewBanner @{ titleEn = 'x' } 'media=small.png;type=image/png').status 422
$r = NewBanner @{ titleEn = 'Test https'; linkUrl = 'https://example.com/sale' } $null
Check 'https link accepted' $r.status 201
$made += $r.json.data.id

# ---- 6. ordering and reorder ----
$before = PublicIds
Check 'public order follows sortOrder' ($before[0]) $seedList[0].id
$rev = @($before); [array]::Reverse($rev)
$r = Call 'PATCH' '/admin/banners/reorder' $admin @{ ids = $rev }
Check 'reorder' $r.status 200
Check 'public order reversed' ((PublicIds) -join ',') ($rev -join ',')
Check 'reorder unknown id -> 404' (Call 'PATCH' '/admin/banners/reorder' $admin @{ ids = @([guid]::NewGuid().ToString()) }).status 404
Check 'reorder duplicate -> 400' (Call 'PATCH' '/admin/banners/reorder' $admin @{ ids = @($live.id, $live.id) }).status 400
Check 'reorder bad uuid -> 400' (Call 'PATCH' '/admin/banners/reorder' $admin @{ ids = @('nope') }).status 400

# ---- 7. update ----
$r = Call 'PATCH' "/admin/banners/$($live.id)" $admin @{ titleEn = 'Test live renamed'; linkUrl = '' }
Check 'update fields (JSON)' $r.status 200
Check 'title changed' $r.json.data.titleEn 'Test live renamed'
Check 'empty linkUrl clears it' $r.json.data.linkUrl $null
Check 'javascript: on update -> 400' (Call 'PATCH' "/admin/banners/$($live.id)" $admin @{ linkUrl = 'javascript:x' }).status 400
Check 'nothing to update -> 400' (Call 'PATCH' "/admin/banners/$($live.id)" $admin @{}).status 400
Check 'bad uuid -> 404' (Call 'PATCH' '/admin/banners/not-a-uuid' $admin @{ titleEn = 'x' }).status 404
Check 'endsAt before stored startsAt -> 400' (Call 'PATCH' "/admin/banners/$($exp.id)" $admin @{ endsAt = $past1 }).status 400
$oldFile = FileOf $live.media.url
$r = Send 'PATCH' "/admin/banners/$($live.id)" $admin @('media=anim.gif;type=image/gif') $null
Check 'replace media' $r.status 200
Check 'replaced media is GIF' $r.json.data.mediaType 'GIF'
Check 'old file deleted' (Test-Path $oldFile) $false
Check 'new file published' (Test-Path (FileOf $r.json.data.media.url)) $true
$r = Call 'PATCH' "/admin/banners/$($mob.id)" $admin @{ removeMobileMedia = $true }
Check 'remove phone version' $r.json.data.mobileMedia $null
Check 'phone file deleted' (Test-Path (FileOf $mob.mobileMedia.url)) $false

# ---- 7b. fit ----
Check 'fit defaults to COVER' $live.fit 'COVER'
Check 'public list has fit' (@((Call 'GET' '/banners' $null $null).json.data)[0].fit -in @('COVER', 'CONTAIN')) $true
$r = NewBanner @{ titleEn = 'Test contain'; fit = 'CONTAIN' } $null
Check 'create with fit CONTAIN' $r.json.data.fit 'CONTAIN'
$contain = $r.json.data.id
if ($contain) { $made += $contain }
$r = Call 'PATCH' "/admin/banners/$($live.id)" $admin @{ fit = 'CONTAIN' }
Check 'update fit (JSON)' $r.json.data.fit 'CONTAIN'
$r = Send 'PATCH' "/admin/banners/$($live.id)" $admin @() @{ fit = 'COVER' }
Check 'update fit (multipart)' $r.json.data.fit 'COVER'
Check 'bad fit -> 400' (Call 'PATCH' "/admin/banners/$($live.id)" $admin @{ fit = 'STRETCH' }).status 400
Check 'admin list has fit' (@((Call 'GET' '/admin/banners' $admin $null).json.data | Where-Object { $_.id -eq $live.id })[0].fit) 'COVER'

# ---- 7c. placement: the side advertisement ----
Check 'placement defaults to HERO' $live.placement 'HERO'
Check 'too small for SIDE_AD -> 422' (NewBanner @{ titleEn = 'x'; placement = 'SIDE_AD' } 'media=side-small.png;type=image/png').status 422
$r = NewBanner @{ titleEn = 'Test side'; placement = 'SIDE_AD' } 'media=side.png;type=image/png'
Check 'create SIDE_AD' $r.status 201
$side = $r.json.data; if ($side.id) { $made += $side.id }
Check 'SIDE_AD placement returned' $side.placement 'SIDE_AD'
Check 'SIDE_AD keeps the tall size' "$($side.media.width)x$($side.media.height)" '600x900'
Check 'SIDE_AD goes after the seeded side ad' $side.sortOrder 1
Check 'bad placement -> 400' (NewBanner @{ titleEn = 'x'; placement = 'POPUP' } $null).status 400

$heroIds = PublicIds
Check 'default public list is HERO only' ($heroIds -contains $side.id) $false
$r = Invoke-WebRequest "$base/banners?placement=SIDE_AD" -UseBasicParsing
$sideList = @(($r.Content | ConvertFrom-Json).data)
Check 'SIDE_AD list has the side ad' (@($sideList | Where-Object { $_.id -eq $side.id }).Count) 1
Check 'SIDE_AD list has no HERO banner' (@($sideList | Where-Object { $_.placement -ne 'SIDE_AD' }).Count) 0
Check 'SIDE_AD list is cached too' $r.Headers['Cache-Control'] 'public, max-age=60'
Check 'placement=HERO same as default' ((@((Call 'GET' '/banners?placement=HERO' $null $null).json.data | ForEach-Object { $_.id })) -join ',') ($heroIds -join ',')
Check 'bad public placement -> 400' (Call 'GET' '/banners?placement=POPUP' $null $null).status 400

$all = (Call 'GET' '/admin/banners' $admin $null).json
$onlySide = (Call 'GET' '/admin/banners?placement=SIDE_AD' $admin $null).json
Check 'admin filter SIDE_AD' (@($onlySide.data | Where-Object { $_.placement -ne 'SIDE_AD' }).Count) 0
Check 'admin filter keeps the shared total' $onlySide.meta.total $all.meta.total

Check 'mixed reorder -> 400' (Call 'PATCH' '/admin/banners/reorder' $admin @{ ids = @($side.id, $live.id) }).status 400
$r = Call 'PATCH' '/admin/banners/reorder' $admin @{ ids = @($side.id) }
Check 'reorder one placement' $r.status 200
Check 'reorder answers that placement only' (@($r.json.data | Where-Object { $_.placement -ne 'SIDE_AD' }).Count) 0
Check 'tall image too narrow for HERO -> 422' (Call 'PATCH' "/admin/banners/$($side.id)" $admin @{ placement = 'HERO' }).status 422
$r = Call 'PATCH' "/admin/banners/$($contain)" $admin @{ placement = 'SIDE_AD' }
Check 'a big enough HERO image may move to SIDE_AD' $r.json.data.placement 'SIDE_AD'
Check 'moved banner goes to the end of SIDE_AD' $r.json.data.sortOrder 1   # the reorder above set the new side ad to 0

# ---- 8. delete ----
$gifFile = FileOf $gif.media.url
$r = Call 'DELETE' "/admin/banners/$($gif.id)" $admin $null
Check 'delete banner' $r.status 200
Check 'file removed' (Test-Path $gifFile) $false
Check 'thumbnail removed' (Test-Path ($gifFile -replace '\.webp$', '-thumb.webp')) $false
Check 'gone from public list' ((PublicIds) -contains $gif.id) $false
Check 'second delete -> 404' (Call 'DELETE' "/admin/banners/$($gif.id)" $admin $null).status 404

# ---- 9. the limit of 12 banners ----
function MediaCount { return @(Get-ChildItem 'uploads\media' -Filter *.webp -ErrorAction SilentlyContinue).Count }
function StagingCount { return @(Get-ChildItem 'uploads\staging' -File -ErrorAction SilentlyContinue).Count }
function AdminList { return (Call 'GET' '/admin/banners' $admin $null).json }
$l = AdminList
Check 'meta.max is 12' $l.meta.max 12
Check 'meta.total matches the list' $l.meta.total @($l.data).Count
for ($i = $l.meta.total; $i -lt 12; $i++) {
    $r = NewBanner @{ titleEn = "Test fill $i" } $null
    if ($r.status -eq 201) { $made += $r.json.data.id }
}
Check 'filled up to 12' (AdminList).meta.total 12
Check 'the 12 include SIDE_AD banners' (@((AdminList).data | Where-Object { $_.placement -eq 'SIDE_AD' }).Count -ge 1) $true
Check 'SIDE_AD create at the limit -> 409' (NewBanner @{ titleEn = 'Test side 13th'; placement = 'SIDE_AD' } 'media=side.png;type=image/png').status 409
$m0 = MediaCount
$r = Send 'POST' '/admin/banners' $admin @('media=banner.png;type=image/png', 'mobileMedia=mobile.jpg;type=image/jpeg') @{ titleEn = 'Test 13th' }
Check '13th banner -> 409' $r.status 409
Check 'code BANNER_LIMIT' $r.json.error.details.code 'BANNER_LIMIT'
Check 'no new file after 409' (MediaCount) $m0
Check 'staging empty after 409' (StagingCount) 0
Check 'still 12' (AdminList).meta.total 12
Check 'public list shows up to 12' (@((Call 'GET' '/banners' $null $null).json.data).Count -le 12) $true

$drop = $made[-1]
Check 'delete one at the limit' (Call 'DELETE' "/admin/banners/$drop" $admin $null).status 200
$made = @($made | Where-Object { $_ -ne $drop })
$r = NewBanner @{ titleEn = 'Test after delete' } $null
Check 'create again after a delete' $r.status 201
$made += $r.json.data.id

# two creates at the same time with 11 banners: one wins, the total stays 12
$drop = $made[-1]
Call 'DELETE' "/admin/banners/$drop" $admin $null | Out-Null
$made = @($made | Where-Object { $_ -ne $drop })
Check 'down to 11' (AdminList).meta.total 11
$m0 = MediaCount
$procs = foreach ($n in 'A', 'B') {
    $resp = Join-Path $tmp "race-$n.json"; $code = Join-Path $tmp "race-$n.code"
    $cargs = "-s -o `"$resp`" -w %{http_code} -X POST -H `"Authorization: Bearer $admin`" -F `"media=@$(Join-Path $tmp 'banner.png');type=image/png`" --form-string `"titleEn=Test race $n`" $base/admin/banners"
    Start-Process curl.exe -ArgumentList $cargs -NoNewWindow -PassThru -RedirectStandardOutput $code
}
$procs | Wait-Process
$codes = @('A', 'B' | ForEach-Object { (Get-Content (Join-Path $tmp "race-$_.code") -Raw).Trim() }) | Sort-Object
Check 'parallel: one 201 and one 409' ($codes -join ',') '201,409'
Check 'parallel: total is 12, not 13' (AdminList).meta.total 12
Check 'parallel: only the winner kept files' (MediaCount) ($m0 + 2)
Check 'parallel: staging empty' (StagingCount) 0
foreach ($n in 'A', 'B') {
    try { $j = Get-Content (Join-Path $tmp "race-$n.json") -Raw | ConvertFrom-Json; if ($j.data.id) { $made += $j.data.id } } catch { }
}

# ---- cleanup ----
foreach ($id in $made) { Call 'DELETE' "/admin/banners/$id" $admin $null | Out-Null }
Call 'PATCH' '/admin/banners/reorder' $admin @{ ids = @($seedList | ForEach-Object { $_.id }) } | Out-Null
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
if ($script:fail -gt 0) { exit 1 }
