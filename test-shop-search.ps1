# test-shop-search.ps1 (GET /shops: public shop search by name)
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
        $json = $null
        try { $json = $_.ErrorDetails.Message | ConvertFrom-Json } catch { }
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

function Shops($query) { return @((Call 'GET' "/shops$query" $null $null).json.data) }

$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$script:n = 0
# a new shop owner with one shop (a separate owner for each test shop)
function NewShop($name) {
    $script:n++
    $reg = Call 'POST' '/auth/register' $null @{ name = "Search Owner $($script:n)"; email = "search$($script:n)x$stamp@vendorshub.test"; password = 'Password123!'; role = 'SHOP_OWNER' }
    Need ($reg.status -eq 201) 'registering a shop owner'
    $s = Call 'POST' '/shops' $reg.json.data.accessToken @{ name = $name; addressLine = 'Level 1, Shop 9, Test Plaza, Dhaka' }
    Need ($s.status -eq 201) "creating the shop $name"
    return $s.json.data.id
}

try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}

$admin = Login 'admin@vendorshub.test'
$cardKeys = 'coverPhoto,id,levelFloor,logoUrl,market,name,productCount,ratingAverage,reviewCount,shopNumber,slug,verificationLevel'

# ---- 1. the list without q ----
$r = Call 'GET' '/shops' $null $null
Check 'the shop list is public' $r.status 200
Check 'pagination is included' ([bool]$r.json.meta.pagination) $true
Check 'the default page size is 10' $r.json.meta.pagination.limit 10
$all = @($r.json.data)
Check 'only the card fields are returned (no ownerId, phone, email)' ((@($all[0].PSObject.Properties.Name) | Sort-Object) -join ',') $cardKeys
$levels = @{ UNVERIFIED = 0; DOCUMENTS_VERIFIED = 1; BUSINESS_VERIFIED = 2; PHYSICAL_SHOP_VERIFIED = 3; TRUSTED_VENDOR = 4 }
$ok = $true
for ($i = 1; $i -lt $all.Count; $i++) { if ($levels[$all[$i].verificationLevel] -gt $levels[$all[$i - 1].verificationLevel]) { $ok = $false } }
Check 'without q the most trusted shops come first' $ok $true

# ---- 2. search by name ----
$t = Shops '?q=tech'
Check 'q=tech finds TechZone' (@($t | Where-Object { $_.slug -eq 'techzone-electronics' }).Count) 1
$T = Shops '?q=TECH'
Check 'q=TECH finds the same (case-insensitive)' (($T | ForEach-Object { $_.id }) -join ',') (($t | ForEach-Object { $_.id }) -join ',')
$tz = @($t | Where-Object { $_.slug -eq 'techzone-electronics' })[0]
Check 'TechZone shows its market' $tz.market.slug 'jamuna-future-park'
Check 'TechZone counts its active listings' ($tz.productCount -ge 1) $true

$everything = (Call 'GET' '/shops' $null $null).json.meta.pagination.total
$pct = (Call 'GET' '/shops?q=%25' $null $null).json.meta.pagination.total
Check 'q % is a normal character (no match-everything)' ($pct -lt $everything) $true
Check 'q % finds no shop' $pct 0
Check 'q _ finds no shop' (Call 'GET' '/shops?q=_' $null $null).json.meta.pagination.total 0

# ---- 3. "starts with" comes before "contains" ----
$word = "Srch$stamp"
$containsId = NewShop "Contains $word"
$startsId = NewShop "$word Starts"
$closedId = NewShop "$word Closed"
$found = Shops "?q=$word"
Check 'all three test shops are found' $found.Count 3
Check 'the names that start with q come first' ((@($found[0].id, $found[1].id) -contains $startsId) -and (@($found[0].id, $found[1].id) -contains $closedId)) $true
Check 'inside that group the names are A-Z (Closed before Starts)' $found[0].id $closedId
Check 'the name that only contains q comes later' $found[2].id $containsId

# ---- 4. deactivated shops never appear ----
$d = Call 'PATCH' "/admin/shops/$closedId/status" $admin @{ isActive = $false; reason = 'Testing the shop search.' }
Check 'the admin deactivates one test shop' $d.status 200
$found = Shops "?q=$word"
Check 'the deactivated shop is gone from the search' (@($found | Where-Object { $_.id -eq $closedId }).Count) 0
Check 'the other two are still found' $found.Count 2

# ---- 5. filters ----
$jamuna = @((Call 'GET' '/markets' $null $null).json.data | Where-Object { $_.slug -eq 'jamuna-future-park' })[0].id
Need $jamuna 'finding Jamuna Future Park'
$inMarket = Shops "?marketId=$jamuna&limit=20"
Check 'the market filter returns shops' ($inMarket.Count -ge 1) $true
Check 'the market filter keeps only that market' (@($inMarket | Where-Object { $_.market.slug -ne 'jamuna-future-park' }).Count) 0
$verified = Shops '?verifiedOnly=true&limit=20'
Check 'verifiedOnly returns shops' ($verified.Count -ge 1) $true
Check 'verifiedOnly leaves out UNVERIFIED shops' (@($verified | Where-Object { $_.verificationLevel -eq 'UNVERIFIED' }).Count) 0

# ---- 6. paging ----
$p1 = Shops "?q=$word&limit=1&page=1"
$p2 = Shops "?q=$word&limit=1&page=2"
Check 'page 1 and page 2 are different shops' ($p1[0].id -ne $p2[0].id) $true
$past = Call 'GET' "/shops?q=$word&limit=1&page=3" $null $null
Check 'a page past the end is empty' @($past.json.data).Count 0
Check 'and still reports the total' $past.json.meta.pagination.total 2

# ---- 7. input rules ----
Check 'limit 21 is rejected' (Call 'GET' '/shops?limit=21' $null $null).status 400
$long = 'a' * 101
Check 'q longer than 100 characters is rejected' (Call 'GET' "/shops?q=$long" $null $null).status 400
Check 'a marketId that is not a uuid is rejected' (Call 'GET' '/shops?marketId=abc' $null $null).status 400

# ---- cleanup: the test shops leave the public list ----
foreach ($id in @($containsId, $startsId)) {
    Call 'PATCH' "/admin/shops/$id/status" $admin @{ isActive = $false; reason = 'Shop search test cleanup.' } | Out-Null
}
Check 'after cleanup no test shop is listed' (Shops "?q=$word").Count 0

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"