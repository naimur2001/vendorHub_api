# test-try-on.ps1 (virtual try-on, MOCK mode: no AI calls, no cost)
# Run from the project root while "npm run dev" is running with TRYON_MODE=mock (the default).
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

$tmp = Join-Path $env:TEMP 'vh-tryon-test'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

# multipart helpers with curl.exe (PowerShell 5.1 cannot send files itself)
function CurlJson($cArgs) {
    $out = Join-Path $tmp 'resp.json'
    if (Test-Path $out) { Remove-Item $out }
    $code = & curl.exe @cArgs -s -o $out -w '%{http_code}'
    $json = $null
    if (Test-Path $out) { try { $json = Get-Content $out -Raw | ConvertFrom-Json } catch { } }
    $script:lastMsg = ''
    if ($null -ne $json -and $null -ne $json.error) { $script:lastMsg = $json.error.message }
    return @{ status = [int]$code; json = $json }
}
function UploadPublic($token, $file) {
    return CurlJson @('-X', 'POST', '-H', "Authorization: Bearer $token", '-F', "file=@$file;type=image/png", "$base/uploads?purpose=PUBLIC_IMAGE")
}
function TryOn($token, $productId, $view, $photo, $mime, $reference) {
    $cArgs = @('-X', 'POST')
    if ($token) { $cArgs += @('-H', "Authorization: Bearer $token") }
    if ($photo) { $cArgs += @('-F', "photo=@$photo;type=$mime") }
    if ($reference) { $cArgs += @('-F', "reference=@$reference;type=image/png") }
    $cArgs += "$base/try-on?productId=$productId&view=$view"
    return CurlJson $cArgs
}
function CountFiles {
    if (-not (Test-Path 'uploads')) { return 0 }
    return @(Get-ChildItem -Path 'uploads' -Recurse -File).Count
}

try { Invoke-WebRequest -Uri "$root/health" -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}

$admin = Login 'admin@vendorshub.test'
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$reg = Call 'POST' '/auth/register' $null @{ name = 'Try On Tester'; email = "tryon$stamp@vendorshub.test"; password = 'Password123!'; role = 'CUSTOMER' }
Need ($reg.status -eq 201) 'registering a customer'
$cust = $reg.json.data.accessToken

# test files: a "customer photo" (PNG) and a text file pretending to be a photo
$photo = Join-Path $tmp 'me.png'
[IO.File]::WriteAllBytes($photo, [Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='))
$fake = Join-Path $tmp 'fake.png'
[IO.File]::WriteAllText($fake, 'this is not an image')

# ---- setup: a clothing category and a shirt with a real (uploaded) photo ----
$cat = Call 'POST' '/admin/categories' $admin @{ name = "Clothing $stamp" }
Need ($cat.status -eq 201) 'creating a clothing category'
$catId = $cat.json.data.id
$img = UploadPublic $admin $photo
Need ($img.status -eq 201) 'uploading the product photo'
$prod = Call 'POST' '/admin/products' $admin @{ title = "Test Shirt $stamp"; categoryId = $catId; images = @($img.json.data.url) }
Need ($prod.status -eq 201) 'creating the shirt'
$shirtId = $prod.json.data.id
$shirtSlug = $prod.json.data.slug
$pd = (Call 'GET' '/products/galaxy-a55-5g-8-128gb' $null $null).json.data
$phoneId = if ($pd.product.id) { $pd.product.id } else { $pd.id }
Need $phoneId 'finding the phone product id'


# ---- 1. the admin switch ----
$r = Call 'GET' "/products/$shirtSlug/try-on" $null $null
Check 'try-on is off until the category is switched on' $r.json.data.available $false
$r = Call 'PATCH' "/admin/categories/$catId/try-on" $cust @{ enabled = $true }
Check 'a customer cannot switch it on' $r.status 403
$r = Call 'PATCH' "/admin/categories/$catId/try-on" $admin @{ enabled = $true }
Check 'an admin switches the category on' $r.status 200
$r = Call 'GET' "/products/$shirtSlug/try-on" $null $null
Check 'try-on is now available' $r.json.data.available $true
Check 'five views are offered' @($r.json.data.views).Count 5
Check 'the roll starts on the front' $r.json.data.startView 'FRONT'
if ($r.json.data.mock -ne $true) {
    Write-Host 'STOP: the server is not in mock mode (TRYON_MODE=gemini). This test would use your real AI quota.' -ForegroundColor Red
    Write-Host 'Set TRYON_MODE=mock in .env, stop the server (Ctrl+C), run "npm run dev" again, then run this test.' -ForegroundColor Red
    exit 1
}


# ---- 2. input checks ----
$r = TryOn $null $shirtId 'FRONT' $photo 'image/png' $null
Check 'try-on needs a login' $r.status 401
$r = TryOn $cust $shirtId 'TOP' $photo 'image/png' $null
Check 'an unknown view is rejected' $r.status 400
$r = TryOn $cust $shirtId 'FRONT' $null $null $null
Check 'a request without a photo is rejected' $r.status 400
$r = TryOn $cust $shirtId 'FRONT' $fake 'image/png' $null
Check 'a text file is not accepted as a photo' $r.status 400
$r = TryOn $cust $phoneId 'FRONT' $photo 'image/png' $null
Check 'a phone cannot be tried on' $r.status 409

# ---- 3. the five frames of the roll, nothing stored ----
$before = CountFiles
$r = TryOn $cust $shirtId 'FRONT' $photo 'image/png' $null
Check 'the front view is created' $r.status 200
Check 'it is the FRONT view' $r.json.data.view 'FRONT'
Check 'the picture comes back inline' ($r.json.data.image -like 'data:image/png;base64,*') $true
Check 'the AI-preview note is included' ($r.json.data.note -like '*AI preview*') $true
foreach ($v in @('LEFT_45', 'RIGHT_45', 'LEFT', 'RIGHT')) {
    $r = TryOn $cust $shirtId $v $photo 'image/png' $photo
    Check "the $v view is created (with the front as reference)" $r.status 200
}
$r = TryOn $cust $shirtId 'BACK' $photo 'image/png' $null
Check 'there is no back view' $r.status 400
Check 'no file was written to disk' (CountFiles) $before

# ---- 4. the daily limit (default 25 pictures; 5 used above) ----
for ($i = 1; $i -le 20; $i++) { TryOn $cust $shirtId 'FRONT' $photo 'image/png' $null | Out-Null }
$r = TryOn $cust $shirtId 'FRONT' $photo 'image/png' $null
Check 'the daily limit is enforced' $r.status 429

# ---- 5. switching it off again ----
Call 'PATCH' "/admin/categories/$catId/try-on" $admin @{ enabled = $false } | Out-Null
$r = Call 'GET' "/products/$shirtSlug/try-on" $null $null
Check 'try-on is off again' $r.json.data.available $false
$a = Call 'GET' "/admin/audit-logs?entityType=Category&entityId=$catId" $admin $null
Check 'the switches are audited' (@($a.json.data | Where-Object { $_.action -like 'catalog.try_on_*' }).Count -ge 2) $true

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"