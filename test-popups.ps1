# test-popups.ps1 (welcome popup: create and validation, language, pages, audience, dates, priority, version,
# stop, the popupsEnabled switch, anonymous stats)
# Run from the project root while the API runs. Removes its popups and restores the setting at the end.
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

function PopHelper() {
    $lines = @(node --env-file=.env scripts/popups-test-helper.mjs @args)
    $line = @($lines | Where-Object { $_ -like '{*' -and $_ -notlike '*"level":*' }) | Select-Object -Last 1
    if (-not $line) { return $null }
    return ($line | ConvertFrom-Json)
}
$tmp = Join-Path $env:TEMP 'vh-popup-test'
node scripts/make-banner-fixtures.mjs $tmp | Out-Null

# multipart with curl.exe (like test-banners.ps1): $files = @("field=filename;type=mime"), $fields sent with --form-string
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
function NewPopup($fields, $file) {
    if (-not $file) { $file = 'media=banner.png;type=image/png' }
    $r = Send 'POST' '/admin/popups' $admin @($file) $fields
    if ($r.status -eq 201) { $script:made += $r.json.data.id }
    return $r
}
function Active($token, $query) { return (Call 'GET' "/popups/active$query" $token $null).json.data }

$since = [DateTime]::UtcNow.AddSeconds(-2).ToString('o')
$admin = Login 'admin@vendorshub.test'
$owner = Login 'owner1@vendorshub.test'
$cust = Login 'customer@vendorshub.test'
$tag = "Popcheck$(Get-Date -Format 'HHmmss')"
$settings0 = (Call 'GET' '/admin/popups/settings' $admin $null).json.data
Call 'PATCH' '/admin/popups/settings' $admin @{ popupsEnabled = $true } | Out-Null
if ((PopHelper live).live -gt 0) { Write-Host 'Stop the live popups first (this suite needs a known start).' -ForegroundColor Red; exit 1 }

function Cleanup {
    foreach ($id in $script:made) { Call 'DELETE' "/admin/popups/$id" $admin $null | Out-Null }
    Call 'PATCH' '/admin/popups/settings' $admin @{ popupsEnabled = [bool]$settings0.popupsEnabled } | Out-Null
    return (PopHelper cleanup $since)
}
function Need($value, $what) {
    if (-not $value) {
        Write-Host "Cannot continue: $what failed. Server said: $($script:lastMsg)" -ForegroundColor Red
        Cleanup | Out-Null
        exit 1
    }
}

# ---- 1. create and validation ----
Check 'nothing live: guest gets null' (Active $null '') $null
Check 'a customer cannot create -> 403' (Send 'POST' '/admin/popups' $cust @('media=banner.png;type=image/png') @{ titleEn = 'x' }).status 403
Check 'no image -> 400' (Send 'POST' '/admin/popups' $admin @() @{ titleEn = 'x' }).status 400
Check 'too small (280 x 420) -> 422' (NewPopup @{ titleEn = 'x' } 'media=side-small.png;type=image/png').status 422
Check 'a javascript: link -> 400' (NewPopup @{ titleEn = 'x'; linkUrl = 'javascript:alert(1)' }).status 400
Check 'delaySeconds 31 -> 400' (NewPopup @{ titleEn = 'x'; delaySeconds = '31' }).status 400
Check 'endsAt before startsAt -> 400' (NewPopup @{ titleEn = 'x'; startsAt = '2026-12-10T00:00:00Z'; endsAt = '2026-12-01T00:00:00Z' }).status 400
$p1 = NewPopup @{ titleEn = "$tag Eid sale"; titleBn = "$tag BN title"; bodyEn = 'Up to 30% off in every market'; linkUrl = '/deals'; ctaLabelEn = 'See deals'; priority = '10' }
Need ($p1.status -eq 201) 'creating the popup'
$d = $p1.json.data
Check 'created: version 1, live, defaults ALL / HOME_ONLY / ONCE_PER_DAY / 2 s, IMAGE' "$($d.version)/$($d.liveNow)/$($d.audience)/$($d.pages)/$($d.frequency)/$($d.delaySeconds)/$($d.mediaType)" '1/True/ALL/HOME_ONLY/ONCE_PER_DAY/2/IMAGE'
$id1 = $d.id

# ---- 2. public answer, language, pages, cache ----
$r = Invoke-WebRequest "$base/popups/active?page=home" -UseBasicParsing
$a = ($r.Content | ConvertFrom-Json).data
Check 'guest gets the popup' $a.id $id1
Check 'public fields only' (Keys $a) 'body,ctaLabel,delaySeconds,frequency,id,imageUrl,linkUrl,mediaType,mobileImageUrl,title,version'
Check 'cacheable 60 s for guests, varies by login and language' "$($r.Headers['Cache-Control'])|$($r.Headers['Vary'])" 'public, max-age=60|Authorization, Accept-Language'
Check 'English by default' "$($a.title)/$($a.ctaLabel)" "$tag Eid sale/See deals"
Check '?lang=bn: Bangla title, English body as fallback' "$((Active $null '?lang=bn').title)/$((Active $null '?lang=bn').body)" "$tag BN title/Up to 30% off in every market"
$r = Invoke-WebRequest "$base/popups/active" -Headers @{ 'Accept-Language' = 'bn-BD,bn;q=0.9' } -UseBasicParsing
Check 'Accept-Language bn: Bangla' (($r.Content | ConvertFrom-Json).data.title) "$tag BN title"
Check 'HOME_ONLY: not on another page' (Active $null '?page=product') $null
Need ((Send 'PATCH' "/admin/popups/$id1" $admin @() @{ pages = 'ALL_PAGES' }).status -eq 200) 'setting ALL_PAGES'
Check 'ALL_PAGES: on another page too' (Active $null '?page=product').id $id1
Check 'a bad page key -> 400' (Call 'GET' '/popups/active?page=../x' $null $null).status 400

# ---- 3. audience ----
$p2 = NewPopup @{ titleEn = "$tag customers"; audience = 'CUSTOMERS'; priority = '20' }
Need ($p2.status -eq 201) 'the customer popup'
$id2 = $p2.json.data.id
Check 'customer gets the CUSTOMERS popup' (Active $cust '').id $id2
Check 'guest does not (gets ALL)' (Active $null '').id $id1
Check 'shop owner does not (gets ALL)' (Active $owner '').id $id1
$r = Invoke-WebRequest "$base/popups/active" -Headers @{ Authorization = "Bearer $cust" } -UseBasicParsing
Check 'logged in: private cache' $r.Headers['Cache-Control'] 'private, max-age=60'
Need ((Send 'PATCH' "/admin/popups/$id2" $admin @() @{ audience = 'SHOP_TEAM' }).status -eq 200) 'switching to SHOP_TEAM'
Check 'SHOP_TEAM: the owner gets it, the customer gets ALL' "$((Active $owner '').id -eq $id2)/$((Active $cust '').id -eq $id1)" 'True/True'
Need ((Send 'PATCH' "/admin/popups/$id1" $admin @() @{ audience = 'GUESTS' }).status -eq 200) 'switching to GUESTS'
Check 'audience mismatch: GUESTS popup -> customer gets null' (Active $cust '') $null
Check 'guest still gets it' (Active $null '').id $id1

# ---- 4. dates and priority ----
$tomorrow = [DateTime]::UtcNow.AddDays(1).ToString('o')
$p3 = NewPopup @{ titleEn = "$tag later"; priority = '30'; startsAt = $tomorrow }
Need ($p3.status -eq 201) 'the scheduled popup'
$id3 = $p3.json.data.id
Check 'not started yet: liveNow false, guest still gets the first' "$($p3.json.data.liveNow)/$((Active $null '').id -eq $id1)" 'False/True'
$past = NewPopup @{ titleEn = "$tag over"; priority = '40'; startsAt = [DateTime]::UtcNow.AddDays(-3).ToString('o'); endsAt = [DateTime]::UtcNow.AddDays(-1).ToString('o') }
Check 'ended: not shown' "$($past.json.data.liveNow)/$((Active $null '').id -eq $id1)" 'False/True'
Need ((Send 'PATCH' "/admin/popups/$id3" $admin @() @{ startsAt = '' }).status -eq 200) 'starting it now'
Check 'priority: the highest live one wins (30 > 10)' (Active $null '').id $id3

# ---- 5. version ----
$v = Send 'PATCH' "/admin/popups/$id1" $admin @() @{ titleEn = "$tag Eid sale 2" }
Check 'a content change bumps the version' $v.json.data.version 2
Check 'priority only: same version' (Send 'PATCH' "/admin/popups/$id1" $admin @() @{ priority = '11' }).json.data.version 2
$m = NewPopup @{ titleEn = "$tag mobile"; isActive = 'false' } 'media=banner.png;type=image/png'
Need ($m.status -eq 201) 'the second image popup'
$mm = Send 'PATCH' "/admin/popups/$($m.json.data.id)" $admin @('mobileMedia=mobile.jpg;type=image/jpeg') @{}
Check 'a phone image: mobileMedia set, version 2' "$($null -ne $mm.json.data.mobileMedia)/$($mm.json.data.version)" 'True/2'
$rm = Send 'PATCH' "/admin/popups/$($m.json.data.id)" $admin @() @{ removeMobileMedia = 'true' }
Check 'remove the phone image: null, version 3' "$($null -eq $rm.json.data.mobileMedia)/$($rm.json.data.version)" 'True/3'
$g = NewPopup @{ titleEn = "$tag gif"; isActive = 'false' } 'media=anim.gif;type=image/gif'
Check 'a GIF stays animated (GIF)' "$($g.status)/$($g.json.data.mediaType)" '201/GIF'

# ---- 6. stop, settings ----
$st = Call 'POST' "/admin/popups/$id3/stop" $admin $null
Check 'stop -> isActive false at once' "$($st.status)/$($st.json.data.isActive)/$($st.json.data.liveNow)" '200/False/False'
Check 'stopped: the next one shows' (Active $null '').id $id1
Check 'stop an unknown popup -> 404' (Call 'POST' "/admin/popups/$([guid]::NewGuid())/stop" $admin $null).status 404
Check 'owner cannot use the settings -> 403' (Call 'PATCH' '/admin/popups/settings' $owner @{ popupsEnabled = $false }).status 403
Check 'settings off -> 200 false' (Call 'PATCH' '/admin/popups/settings' $admin @{ popupsEnabled = $false }).json.data.popupsEnabled $false
Check 'off: guest null, owner null' "$($null -eq (Active $null ''))/$($null -eq (Active $owner ''))" 'True/True'
Check 'on again: shows again' "$((Call 'PATCH' '/admin/popups/settings' $admin @{ popupsEnabled = $true }).json.data.popupsEnabled)/$((Active $null '').id -eq $id1)" 'True/True'

# ---- 7. stats ----
foreach ($t in @('VIEW', 'VIEW', 'VIEW', 'CLOSE', 'CLOSE', 'CLICK')) { Call 'POST' "/popups/$id1/events" $null @{ type = $t } | Out-Null }
$ev = Call 'POST' "/popups/$id1/events" $null @{ type = 'VIEW' }
Check 'an event -> 202, no login needed' "$($ev.status)/$($ev.json.data.recorded)" '202/VIEW'
Check 'a bad event type -> 400' (Call 'POST' "/popups/$id1/events" $null @{ type = 'HOVER' }).status 400
Check 'an unknown popup -> 404' (Call 'POST' "/popups/$([guid]::NewGuid())/events" $null @{ type = 'VIEW' }).status 404
$s = (Call 'GET' "/admin/popups/$id1/stats" $admin $null).json.data
Check 'stats totals: 4 views, 2 closes, 1 click, CTR 25%' "$($s.totals.views)/$($s.totals.closes)/$($s.totals.clicks)/$($s.totals.ctr)" '4/2/1/25'
Check 'stats: 30 days, today has the counts' "$(@($s.days).Count)/$((@($s.days)[-1]).views)" '30/4'
Check 'stats: a day without views has CTR null' $null (@($s.days)[0]).ctr
Check 'owner cannot see stats -> 403' (Call 'GET' "/admin/popups/$id1/stats" $owner $null).status 403

# ---- 8. admin list, delete ----
$list = @((Call 'GET' '/admin/popups' $admin $null).json.data | Where-Object { $_.titleEn -like "$tag*" })
Check 'admin list has our 6 popups' $list.Count 6
$del = Call 'DELETE' "/admin/popups/$id2" $admin $null
Check 'delete -> 200' $del.status 200
$script:made = @($script:made | Where-Object { $_ -ne $id2 })
Check 'deleted -> 404 on stop' (Call 'POST' "/admin/popups/$id2/stop" $admin $null).status 404

# ---- 9. cleanup ----
$out = Cleanup
Check 'cleanup: no test popups left' (@((Call 'GET' '/admin/popups' $admin $null).json.data | Where-Object { $_.titleEn -like "$tag*" }).Count) 0
Check 'settings restored' (Call 'GET' '/admin/popups/settings' $admin $null).json.data.popupsEnabled ([bool]$settings0.popupsEnabled)

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
if ($script:fail -gt 0) { exit 1 }
