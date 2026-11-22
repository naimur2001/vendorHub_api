# test-referrals.ps1
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

$owner = Login 'owner1@vendorshub.test'
$cust = Login 'customer@vendorshub.test'
$admin = Login 'admin@vendorshub.test'
$tmp = Join-Path $env:TEMP 'vh-referrals'
node scripts/make-banner-fixtures.mjs $tmp | Out-Null   # banner.png (big enough), small.png (too small), fake.png (text)
$rnd = [guid]::NewGuid().ToString('N').Substring(0, 8)

# register / log in with an X-Device-Id header (the shared Call helper sends no extra headers)
function Register($name, $code, $device) {
    $email = "$name-$rnd@vendorshub.test"
    $b = @{ name = "Test $name"; email = $email; password = 'Password123!' }
    if ($code) { $b.referralCode = $code }
    $hdr = @{}
    if ($device) { $hdr['X-Device-Id'] = $device }
    $r = Invoke-WebRequest -Method POST -Uri "$base/auth/register" -ContentType 'application/json' -Body ($b | ConvertTo-Json) -Headers $hdr -UseBasicParsing
    Need ([int]$r.StatusCode -eq 201) "registering $name"
    return @{ email = $email; token = ($r.Content | ConvertFrom-Json).data.accessToken }
}
function LoginWith($email, $device) {
    $r = Invoke-WebRequest -Method POST -Uri "$base/auth/login" -ContentType 'application/json' -Body (@{ email = $email; password = 'Password123!' } | ConvertTo-Json) -Headers @{ 'X-Device-Id' = $device } -UseBasicParsing
    return ($r.Content | ConvertFrom-Json).data.accessToken
}
function UploadPhoto($token, $reviewId, $file, $type) {
    $out = Join-Path $tmp 'resp.json'
    if (Test-Path $out) { Remove-Item $out }
    $code = & curl.exe -s -o $out -w '%{http_code}' -X POST -H "Authorization: Bearer $token" -F "image=@$(Join-Path $tmp $file);type=$type" "$base/reviews/$reviewId/photos"
    $json = $null
    if (Test-Path $out) { try { $json = Get-Content $out -Raw | ConvertFrom-Json } catch { } }
    return @{ status = [int]$code; json = $json }
}

$techId = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id
$mine = @((Call 'GET' "/shops/$techId/listings" $owner $null).json.data | Where-Object { $_.isActive -ne $false })
$lid = $mine[0].id; $p0 = $mine[0].price
Check 'listing at 400 taka' (Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ price = 400; availability = 'IN_STOCK'; stockQty = 50 }).status 200
function Order($token, $useCredit) {
    Call 'DELETE' '/cart' $token $null | Out-Null
    Need ((Call 'POST' '/cart/items' $token @{ listingId = $lid; quantity = 1 }).status -eq 200) 'adding to the cart'
    $r = Call 'POST' '/checkout' $token @{ useCredit = [bool]$useCredit; shops = @(@{ shopId = $techId; deliveryMethod = 'VENDOR_DELIVERY'; paymentMethod = 'CASH_ON_DELIVERY'; deliveryAddress = 'House 12, Road 5, Dhanmondi, Dhaka' }) }
    Need ($r.status -eq 201) 'the checkout'
    return $r.json.data.orders[0]
}
function Set-OrderStatuses($orderId, $statuses) { foreach ($st in $statuses) { Call 'POST' "/shops/$techId/orders/$orderId/status" $owner @{ status = $st } | Out-Null } }
function Credit($token) { return (Call 'GET' '/me/credit' $token $null).json.data }

# ---- 1. review photos (verified buyers) ----
$ref = Register 'referrer' $null "dev-referrer-$rnd"
$o = Order $ref.token $false
Set-OrderStatuses $o.id @('CONFIRMED', 'OUT_FOR_DELIVERY', 'COMPLETED')
$rev = (Call 'POST' '/reviews' $ref.token @{ orderId = $o.id; type = 'SHOP_TRUST'; rating = 5; comment = 'Great service and a fair price' }).json.data
Check 'review written after a completed order' ($null -ne $rev.id) $true
$ids = @()
foreach ($i in 1..3) { $r = UploadPhoto $ref.token $rev.id 'banner.png' 'image/png'; Check "photo $i -> 201" $r.status 201; $ids += $r.json.data.id }
Check 'photo is WebP' ($r.json.data.url -like '*.webp') $true
$r = UploadPhoto $ref.token $rev.id 'banner.png' 'image/png'
Check 'a 4th photo -> 409' $r.status 409
Check 'code REVIEW_PHOTO_LIMIT' $r.json.error.details.code 'REVIEW_PHOTO_LIMIT'
Check 'not the author -> 404' (UploadPhoto $cust $rev.id 'banner.png' 'image/png').status 404
Check 'a shop owner -> 404' (UploadPhoto $owner $rev.id 'banner.png' 'image/png').status 404
Check 'remove one' (Call 'DELETE' "/reviews/$($rev.id)/photos/$($ids[0])" $ref.token $null).status 200
Check 'too small -> 422' (UploadPhoto $ref.token $rev.id 'small.png' 'image/png').status 422
Check 'not an image -> 400' (UploadPhoto $ref.token $rev.id 'fake.png' 'image/png').status 400
function ReviewPhotos { return @(@((Call 'GET' '/shops/techzone-electronics/reviews?limit=50' $null $null).json.data | Where-Object { $_.id -eq $rev.id })[0].photos) }
Check 'the review shows 2 photos' @(ReviewPhotos).Count 2
Check 'someone reports a photo' (Call 'POST' '/flags' $cust @{ targetType = 'REVIEW_PHOTO'; targetId = $ids[1]; reason = 'OFF_TOPIC' }).status 201
Check 'the author cannot report their own photo' (Call 'POST' '/flags' $ref.token @{ targetType = 'REVIEW_PHOTO'; targetId = $ids[1]; reason = 'SPAM' }).status 400
$f = @((Call 'GET' '/admin/flags?targetType=REVIEW_PHOTO&limit=50' $admin $null).json.data | Where-Object { $_.targetId -eq $ids[1] })[0]
Check 'admin sees the photo url' ($f.target.url -like '*.webp') $true
Check 'admin hides it' (Call 'POST' "/admin/flags/$($f.id)/resolve" $admin @{ action = 'HIDE' }).json.data.status 'HIDDEN'
Check 'a hidden photo is left out' @(ReviewPhotos).Count 1

# ---- 2. referral codes ----
$c = Credit $ref.token
Check 'a customer has a referral code' ($c.referralCode -match '^[A-Z0-9]{8}$') $true
Check 'balance starts at 0' $c.balance 0
Check 'shop owner -> 403' (Call 'GET' '/me/credit' $owner $null).status 403
$code = $c.referralCode
Check 'an unknown code does not block the signup' ((Register 'nocode' 'ZZZZZZZZ' $null).token.Length -gt 10) $true

# ---- 3. the credit comes only after the FIRST COMPLETED order ----
$a = Register 'friend' $code "dev-friend-$rnd"
Check 'the referral is recorded' (Credit $ref.token).referrals.invited 1
$oa = Order $a.token $false
Set-OrderStatuses $oa.id @('CONFIRMED', 'OUT_FOR_DELIVERY')
Check 'not completed yet: no credit for the friend' (Credit $a.token).balance 0
Check 'not completed yet: no credit for the referrer' (Credit $ref.token).balance 0
Set-OrderStatuses $oa.id @('COMPLETED')
Check 'completed: the friend gets 100' (Credit $a.token).balance 100
Check 'completed: the referrer gets 100' (Credit $ref.token).balance 100
Check 'rewarded count' (Credit $ref.token).referrals.rewarded 1
Check 'reward notification' (@((Call 'GET' '/notifications?limit=20' $a.token $null).json.data | Where-Object { $_.type -eq 'CREDIT_REWARD' }).Count) 1
$ob = Order $a.token $false
Set-OrderStatuses $ob.id @('CONFIRMED', 'OUT_FOR_DELIVERY', 'COMPLETED')
Check 'a second completed order pays nothing more' (Credit $a.token).balance 100
Check 'the history shows the reward' ((Credit $a.token).history[0].kind) 'REFERRAL_REWARD'

# ---- 4. abuse: the same device ----
$shared = "dev-shared-$rnd"
LoginWith $ref.email $shared | Out-Null   # the referrer used this device
$b = Register 'samedevice' $code $shared  # ... and the "friend" signs up on it
$obb = Order $b.token $false
Set-OrderStatuses $obb.id @('CONFIRMED', 'OUT_FOR_DELIVERY', 'COMPLETED')
Check 'same device: no credit for the new account' (Credit $b.token).balance 0
Check 'same device: no credit for the referrer' (Credit $ref.token).balance 100
Check 'invited 2, rewarded 1' "$((Credit $ref.token).referrals.invited)/$((Credit $ref.token).referrals.rewarded)" '2/1'
$late = Register 'latedevice' $code "dev-late-$rnd"
LoginWith $ref.email "dev-late-$rnd" | Out-Null  # the referrer logs in on the friend's device later
$ol = Order $late.token $false
Set-OrderStatuses $ol.id @('CONFIRMED', 'OUT_FOR_DELIVERY', 'COMPLETED')
Check 'a device shared later is caught at reward time' (Credit $late.token).balance 0

# ---- 5. spending: at most 20% of an order ----
$s1 = Order $a.token $true
Check 'cap: 20% of 400 = 80' $s1.creditUsed 80
Check 'total = 400 - 80 + 60 delivery' $s1.total 380
Check 'balance 20 left' (Credit $a.token).balance 20
Check 'listing at 10000' (Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ price = 10000 }).status 200
$s2 = Order $a.token $true
Check 'only what is left: 20' $s2.creditUsed 20
Check 'balance 0' (Credit $a.token).balance 0
$s3 = Order $a.token $true
Check 'no credit left: 0 used' $s3.creditUsed 0
$s4 = Order $ref.token $false
Check 'useCredit false: 0 used' $s4.creditUsed 0
Check 'cancel gives the credit back' (Call 'POST' "/orders/$($s1.id)/cancel" $a.token @{ reason = 'Test' }).status 200
Check 'balance 80 again' (Credit $a.token).balance 80
Check 'refund in the history' ((Credit $a.token).history[0].kind) 'CHECKOUT_REFUND'
Check 'the shop sees creditUsed' ((Call 'GET' "/shops/$techId/orders/$($s2.id)" $owner $null).json.data.creditUsed) 20

# ---- cleanup ----
foreach ($x in $s2, $s3, $s4) { Call 'POST' "/shops/$techId/orders/$($x.id)/status" $owner @{ status = 'CANCELLED'; reason = 'Test cleanup' } | Out-Null }
Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ price = $p0 } | Out-Null
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
if ($script:fail -gt 0) { exit 1 }
