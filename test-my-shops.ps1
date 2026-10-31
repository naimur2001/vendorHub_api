# test-my-shops.ps1 (GET /users/me/shops: the shops I own or work at)
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
        $text = $_.ErrorDetails.Message
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

function MyShops($token) { return @((Call 'GET' '/users/me/shops' $token $null).json.data) }

# exactly these fields, nothing more (the score, notes, documents and ownerId must never appear)
$shopKeys = 'createdAt,id,isActive,latestVerification,levelFloor,market,membership,name,shopNumber,slug,staffTitle,verificationLevel'
$verificationKeys = 'createdAt,id,status,targetLevel'
function Keys($obj) { return (@($obj.PSObject.Properties.Name) | Sort-Object) -join ',' }

# upload a private document with curl.exe (PowerShell 5.1 cannot send files itself)
$tmp = Join-Path $env:TEMP 'vh-myshops-test'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$pdf = Join-Path $tmp 'doc.pdf'
[IO.File]::WriteAllText($pdf, "%PDF-1.4`n1 0 obj << >> endobj`ntrailer << >>`n%%EOF")
function UploadDoc($token) {
    $out = Join-Path $tmp 'resp.json'
    if (Test-Path $out) { Remove-Item $out }
    $code = & curl.exe -s -o $out -w '%{http_code}' -X POST -H "Authorization: Bearer $token" -F "file=@$pdf;type=application/pdf" "$base/uploads?purpose=PRIVATE_DOCUMENT"
    $json = $null
    if (Test-Path $out) { try { $json = Get-Content $out -Raw | ConvertFrom-Json } catch { } }
    if ([int]$code -ne 201) { return $null }
    return $json.data.url
}

try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}

$cust = Login 'customer@vendorshub.test'
$owner1 = Login 'owner1@vendorshub.test'
$owner2 = Login 'owner2@vendorshub.test'
$admin = Login 'admin@vendorshub.test'

# ---- 1. access ----
$r = Call 'GET' '/users/me/shops' $null $null
Check 'a login is required' $r.status 401
$r = Call 'GET' '/users/me/shops' $cust $null
Check 'a customer gets 200' $r.status 200
Check 'a customer gets an empty list' @($r.json.data).Count 0

# ---- 2. seeded owners and staff ----
$s1 = @(MyShops $owner1)
Check 'owner1 has one shop' $s1.Count 1
Check 'it is TechZone' $s1[0].slug 'techzone-electronics'
Check 'owner1 is its OWNER' $s1[0].membership 'OWNER'
Check 'an owner has no staff title' ($null -eq $s1[0].staffTitle) $true
Check 'only the allowed shop fields are returned' (Keys $s1[0]) $shopKeys

$s2 = @(MyShops $owner2)
Check 'owner2 has two shops' $s2.Count 2
Check 'the owned shop comes first' $s2[0].slug 'dhaka-mobile-house'
Check 'owner2 owns Dhaka Mobile House' $s2[0].membership 'OWNER'
Check 'TechZone comes second' $s2[1].slug 'techzone-electronics'
Check 'owner2 is STAFF at TechZone' $s2[1].membership 'STAFF'
Check 'the staff title is filled in' ([bool]$s2[1].staffTitle) $true
Check 'the market is included' ([bool]$s2[0].market.slug) $true

# ---- 3. a new shop owner, step by step ----
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$reg = Call 'POST' '/auth/register' $null @{ name = 'New Owner'; email = "newowner$stamp@vendorshub.test"; password = 'Password123!'; role = 'SHOP_OWNER' }
Need ($reg.status -eq 201) 'registering a shop owner'
$new = $reg.json.data.accessToken
Check 'a new shop owner starts with no shops' (MyShops $new).Count 0

$c = Call 'POST' '/shops' $new @{ name = "My Shop Test $stamp"; addressLine = 'Level 1, Shop 5, Bashundhara City, Dhaka' }
Need ($c.status -eq 201) 'creating a shop'
$shopId = $c.json.data.id
$s = @(MyShops $new)
Check 'the new shop is listed' $s.Count 1
Check 'it is the created shop' $s[0].id $shopId
Check 'the new owner is OWNER' $s[0].membership 'OWNER'
Check 'the new shop starts UNVERIFIED' $s[0].verificationLevel 'UNVERIFIED'
Check 'there is no verification request yet' ($null -eq $s[0].latestVerification) $true

$tl = UploadDoc $new
$nid = UploadDoc $new
Need ($tl -and $nid) 'uploading the documents'
$docs = @(@{ type = 'TRADE_LICENSE'; fileUrl = $tl }, @{ type = 'NID'; fileUrl = $nid })
$v = Call 'POST' "/shops/$shopId/verifications" $new @{ targetLevel = 'DOCUMENTS_VERIFIED'; documents = $docs }
Need ($v.status -eq 201) 'submitting the verification request'
$s = @(MyShops $new)
$lv = $s[0].latestVerification
Check 'the latest verification request is shown' ([bool]$lv) $true
Check 'it is PENDING or AUTO_FLAGGED' (@('PENDING', 'AUTO_FLAGGED') -contains $lv.status) $true
Check 'it targets DOCUMENTS_VERIFIED' $lv.targetLevel 'DOCUMENTS_VERIFIED'
Check 'it has its submission time' ([bool]$lv.createdAt) $true
Check 'only the allowed verification fields are returned' (Keys $lv) $verificationKeys

# ---- 4. a shop deactivated by an admin stays visible to its owner ----
$d = Call 'PATCH' "/admin/shops/$shopId/status" $admin @{ isActive = $false; reason = 'Testing the my-shops list.' }
Check 'the admin deactivates the shop' $d.status 200
$s = @(MyShops $new)
Check 'the deactivated shop is still listed' $s.Count 1
Check 'it shows isActive false' $s[0].isActive $false

# ---- 5. nobody sees other people's shops ----
$other = @(MyShops $owner1 | Where-Object { $_.id -eq $shopId }).Count
Check 'another owner does not see the new shop' $other 0

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
Write-Host 'A test owner and a test shop were created. run-all-tests.ps1 reseeds the demo data first.'
