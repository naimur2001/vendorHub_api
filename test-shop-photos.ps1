# test-shop-photos.ps1
# Run from the project root while "npm run dev" is running in another terminal.
$root = 'http://localhost:4000'
$base = "$root/api/v1"
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

# multipart upload with curl.exe (PowerShell 5.1 cannot send files itself)
$tmp = Join-Path $env:TEMP 'vh-photo-test'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
function Upload($token, $purpose, $file, $mime) {
    $out = Join-Path $tmp 'resp.json'
    if (Test-Path $out) { Remove-Item $out }
    $cArgs = @('-s', '-o', $out, '-w', '%{http_code}', '-X', 'POST', '-H', "Authorization: Bearer $token",
        '-F', "file=@$file;type=$mime", "$base/uploads?purpose=$purpose")
    $code = & curl.exe @cArgs
    $json = $null
    if (Test-Path $out) { try { $json = Get-Content $out -Raw | ConvertFrom-Json } catch { } }
    return @{ status = [int]$code; json = $json }
}

try { Invoke-WebRequest -Uri "$root/health" -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}

$cust = Login 'customer@vendorshub.test'
$owner = Login 'owner1@vendorshub.test'    # TechZone owner
$staff = Login 'owner2@vendorshub.test'    # staff at TechZone
$owner3 = Login 'owner3@vendorshub.test'   # another shop
$admin = Login 'admin@vendorshub.test'
$techId = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id

# test images: three different tiny PNGs (one changed byte at the end makes each file unique)
$b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
$pngs = @()
for ($i = 1; $i -le 3; $i++) {
    $path = Join-Path $tmp "shop$i.png"
    $bytes = [Convert]::FromBase64String($b64) + [byte[]]@($i)
    [IO.File]::WriteAllBytes($path, $bytes)
    $pngs += $path
}
$pdf = Join-Path $tmp 'doc.pdf'
[IO.File]::WriteAllText($pdf, "%PDF-1.4`n1 0 obj << >> endobj`ntrailer << >>`n%%EOF")

# the owner uploads three photos and one private document; the customer uploads one image
$up = @()
foreach ($f in $pngs) {
    $u = Upload $owner 'PUBLIC_IMAGE' $f 'image/png'
    Need ($u.status -eq 201) 'uploading a shop photo'
    $up += $u.json.data.id
}
$privDoc = (Upload $owner 'PRIVATE_DOCUMENT' $pdf 'application/pdf').json.data.id
$custImg = (Upload $cust 'PUBLIC_IMAGE' $pngs[0] 'image/png').json.data.id
Need ($privDoc -and $custImg) 'the other uploads'

# ---- 1. who may add photos, and which uploads ----
$r = Call 'POST' "/shops/$techId/photos" $cust @{ uploadId = $up[0]; kind = 'EXTERIOR' }
Check 'a customer cannot add shop photos' $r.status 403
$r = Call 'POST' "/shops/$techId/photos" $staff @{ uploadId = $up[0]; kind = 'EXTERIOR' }
Check 'staff cannot add shop photos' $r.status 403
$r = Call 'POST' "/shops/$techId/photos" $owner3 @{ uploadId = $up[0]; kind = 'EXTERIOR' }
Check 'another shop owner cannot add photos' $r.status 403
$r = Call 'POST' "/shops/$techId/photos" $owner @{ uploadId = $up[0]; kind = 'ROOFTOP' }
Check 'an unknown kind is rejected' $r.status 400
$r = Call 'POST' "/shops/$techId/photos" $owner @{ uploadId = $privDoc; kind = 'EXTERIOR' }
Check 'a private document cannot be a shop photo' $r.status 400
$r = Call 'POST' "/shops/$techId/photos" $owner @{ uploadId = $custImg; kind = 'EXTERIOR' }
Check 'someone else''s upload cannot be used' $r.status 400

# ---- 2. building the gallery ----
$r = Call 'POST' "/shops/$techId/photos" $owner @{ uploadId = $up[0]; kind = 'EXTERIOR'; caption = 'Shop front, Level 3' }
Check 'the owner adds a photo' $r.status 201
$p1 = $r.json.data.id
Need $p1 'the first photo'
Check 'the first photo becomes the cover' $r.json.data.isCover $true
Check 'a new photo is not verified' $r.json.data.verified $false
$r = Call 'POST' "/shops/$techId/photos" $owner @{ uploadId = $up[1]; kind = 'SIGNBOARD'; caption = 'Our signboard' }
Check 'a second photo is added' $r.status 201
$p2 = $r.json.data.id
Check 'the second photo is not the cover' $r.json.data.isCover $false
$r = Call 'POST' "/shops/$techId/photos" $owner @{ uploadId = $up[1]; kind = 'SIGNBOARD' }
Check 'the same upload cannot be added twice' $r.status 409
$r = Call 'POST' "/shops/$techId/photos" $owner @{ uploadId = $up[2]; kind = 'PANORAMA_360'; caption = 'Walk around inside'; isCover = $true }
Check 'a 360 panorama is added as the new cover' $r.status 201
$p3 = $r.json.data.id
Check 'it is the cover' $r.json.data.isCover $true

$r = Call 'GET' '/shops/techzone-electronics/photos' $null $null
Check 'anyone can see the gallery' $r.status 200
Check 'the gallery has three photos' @($r.json.data).Count 3
Check 'the cover comes first' @($r.json.data)[0].id $p3
Check 'there is exactly one cover' @($r.json.data | Where-Object { $_.isCover }).Count 1
$f = Invoke-WebRequest -Uri @($r.json.data)[0].url -UseBasicParsing
Check 'the photo file can be opened' ([int]$f.StatusCode) 200

# ---- 3. the shop card ----
$s = Call 'GET' '/shops/techzone-electronics' $null $null
Check 'the storefront shows the cover photo' ($null -ne $s.json.data.coverPhoto) $true
Check 'the cover on the storefront is the panorama' $s.json.data.coverPhoto.kind 'PANORAMA_360'
Check 'the storefront shows the photo count' $s.json.data.photoCount 3
$m = Call 'GET' '/markets/jamuna-future-park' $null $null
$card = @($m.json.data.shops | Where-Object { $_.id -eq $techId })[0]
Check 'the market shop card shows the cover photo' ($null -ne $card.coverPhoto) $true

# ---- 4. editing ----
$r = Call 'PATCH' "/shops/$techId/photos/$p2" $owner @{ caption = 'The name board above the door'; sortOrder = 1 }
Check 'the owner edits a caption' $r.status 200
$r = Call 'PATCH' "/shops/$techId/photos/$p2" $owner @{ isCover = $false }
Check 'the cover cannot simply be unset' $r.status 400
$r = Call 'PATCH' "/shops/$techId/photos/$p2" $staff @{ caption = 'Staff edit' }
Check 'staff cannot edit photos' $r.status 403
$r = Call 'PATCH' "/shops/$techId/photos/$p1" $owner @{ isCover = $true }
Check 'another photo becomes the cover' $r.status 200
$r = Call 'GET' '/shops/techzone-electronics/photos' $null $null
Check 'still exactly one cover' @($r.json.data | Where-Object { $_.isCover }).Count 1
Check 'and it is the shop front' @($r.json.data)[0].id $p1

# ---- 5. admin verification ----
$r = Call 'PATCH' "/admin/shops/$techId/photos/$p1/verify" $owner @{ verified = $true }
Check 'an owner cannot verify their own photo' $r.status 403
$r = Call 'PATCH' "/admin/shops/$techId/photos/$p1/verify" $admin @{ verified = $true }
Check 'an admin verifies the photo' $r.status 200
Check 'the photo is verified' $r.json.data.verified $true
$s = Call 'GET' '/shops/techzone-electronics' $null $null
Check 'the shop card shows the verified cover' $s.json.data.coverPhoto.verified $true
$a = Call 'GET' "/admin/audit-logs?entityType=Shop&entityId=$techId" $admin $null
Check 'the verification is audited' (@($a.json.data | Where-Object { $_.action -eq 'shop.photo_verified' }).Count -ge 1) $true

# ---- 6. removing ----
$r = Call 'DELETE' "/shops/$techId/photos/$p1" $owner $null
Check 'the owner removes the cover photo' $r.status 200
$r = Call 'GET' '/shops/techzone-electronics/photos' $null $null
Check 'two photos are left' @($r.json.data).Count 2
Check 'another photo took over as the cover' @($r.json.data | Where-Object { $_.isCover }).Count 1
$r = Call 'DELETE' "/shops/$techId/photos/$p1" $owner $null
Check 'removing twice returns 404' $r.status 404

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"