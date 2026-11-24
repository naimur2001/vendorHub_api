# test-product-sorts.ps1 (GET /products: sort oldest / trending / popular, filter bargain=true)
# Run from the project root while "npm run dev" is running in another terminal (mock modes).
# Makes 4 fresh products with one search tag, so the order of exactly these 4 can be checked.
# Everything it makes is deleted again at the end (scripts/product-sorts-test-helper.mjs cleanup).
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
        $ids = @($p.Values | ForEach-Object { $_.id })
        if ($ids.Count -gt 0) { node --env-file=.env scripts/product-sorts-test-helper.mjs cleanup $since @ids | Out-Null }
        exit 1
    }
}

try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}

$since = [DateTime]::UtcNow.AddSeconds(-2).ToString('o')
$cust = Login 'customer@vendorshub.test'
$owner = Login 'owner1@vendorshub.test'
$admin = Login 'admin@vendorshub.test'
$techId = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id
$cat = @((Call 'GET' '/categories' $null $null).json.data)[0].id
$tag = "Sortcheck$(Get-Date -Format 'yyyyMMddHHmmss')"
$cardKeys = 'availability,bargainAvailable,bestListingId,brand,category,createdAt,deal,highestPrice,id,image,lowestPrice,msrp,shopCount,slug,thumbnail,title'

# A, B, C, D are made in this order (A oldest, D newest), approved, bargaining off
$p = @{}
foreach ($n in 'A', 'B', 'C', 'D') {
    $r = Call 'POST' "/shops/$techId/products" $owner @{ title = "$tag Item $n"; categoryId = $cat; listing = @{ price = 2000; stockQty = 10 } }
    Need ($r.status -eq 201) "creating product $n"
    Need ((Call 'POST' "/admin/moderation/products/$($r.json.data.product.id)/approve" $admin $null).status -in 200, 409) "approving product $n"
    $p[$n] = @{ id = $r.json.data.product.id; lid = $r.json.data.listing.id }
    Start-Sleep -Milliseconds 50
}
$names = @{}
foreach ($n in $p.Keys) { $names[$p[$n].id] = $n }
function Names($query) {
    $r = Call 'GET' "/products?q=$tag&limit=50&$query" $null $null
    return (@($r.json.data | ForEach-Object { $names[$_.id] }) -join ',')
}
function Order($n, $qty) {
    Call 'DELETE' '/cart' $cust $null | Out-Null
    Need ((Call 'POST' '/cart/items' $cust @{ listingId = $p[$n].lid; quantity = $qty }).status -eq 200) "adding $n to the cart"
    $r = Call 'POST' '/checkout' $cust @{ shops = @(@{ shopId = $techId; deliveryMethod = 'VENDOR_DELIVERY'; paymentMethod = 'CASH_ON_DELIVERY'; deliveryAddress = 'House 12, Road 5, Dhanmondi, Dhaka' }) }
    Need ($r.status -eq 201) "the checkout of $n"
    return $r.json.data.orders[0]
}

# ---- 1. validation ----
Check 'unknown sort -> 400' (Call 'GET' '/products?sort=bestselling' $null $null).status 400
Check 'bargain=yes -> 400' (Call 'GET' '/products?bargain=yes' $null $null).status 400
foreach ($s in 'oldest', 'trending', 'popular') {
    $r = Call 'GET' "/products?sort=$s&limit=50" $null $null
    Check "sort=$s works on the whole catalog" $r.status 200
    Check "sort=$s returns the normal card fields" ((@($r.json.data[0].PSObject.Properties.Name) | Sort-Object) -join ',') $cardKeys
}

# ---- 2. newest / oldest ----
Check 'newest: D,C,B,A' (Names 'sort=newest') 'D,C,B,A'
Check 'oldest: A,B,C,D' (Names 'sort=oldest') 'A,B,C,D'
$old = @((Call 'GET' '/products?sort=oldest&limit=50' $null $null).json.data | ForEach-Object { [datetime]$_.createdAt })
$okOrder = $true
for ($i = 1; $i -lt $old.Count; $i++) { if ($old[$i] -lt $old[$i - 1]) { $okOrder = $false } }
Check 'oldest: createdAt ascending over the whole catalog' $okOrder $true
Check 'no sales yet: trending ties go newest first' (Names 'sort=trending') 'D,C,B,A'
Check 'no sales yet: popular ties go newest first' (Names 'sort=popular') 'D,C,B,A'

# ---- 3. sales and add-to-carts ----
# A: 3 units now (+1 add-to-cart)        -> popular 3, trending 4
# B: 5 units, moved to 8 days ago         -> popular 5, trending 0
# C: 4 units CANCELLED, +9 add-to-carts   -> popular 0, trending 10 (add-to-carts stay counted)
# D: nothing                              -> 0 and 0
Order 'A' 3 | Out-Null
Order 'B' 5 | Out-Null
$oc = Order 'C' 4
Need ((Call 'POST' "/orders/$($oc.id)/cancel" $cust @{ reason = 'Test' }).status -eq 200) 'cancelling the C order'
Call 'DELETE' '/cart' $cust $null | Out-Null
1..9 | ForEach-Object { Call 'POST' '/cart/items' $cust @{ listingId = $p['C'].lid; quantity = 1 } | Out-Null }
Call 'DELETE' '/cart' $cust $null | Out-Null
Start-Sleep -Milliseconds 500 # add-to-carts are recorded in the background
$moved = node --env-file=.env scripts/backdate-sales.mjs $p['B'].lid 8 | Select-Object -Last 1 | ConvertFrom-Json
Check 'the B order was moved 8 days back' $moved.orders 1

Check 'popular: B(5), A(3), then D and C (0, newest first)' (Names 'sort=popular') 'B,A,D,C'
Check 'trending: C(10), A(4), then D and B (0, newest first)' (Names 'sort=trending') 'C,A,D,B'
Check 'a cancelled order is not a sale (C last in popular)' ((Names 'sort=popular').Split(',')[-1]) 'C'
Check 'sales older than 7 days leave trending (B last)' ((Names 'sort=trending').Split(',')[-1]) 'B'

# ---- 4. paging ----
$pg1 = Call 'GET' "/products?q=$tag&sort=trending&limit=2&page=1" $null $null
$pg2 = Call 'GET' "/products?q=$tag&sort=trending&limit=2&page=2" $null $null
Check 'trending page 1: C,A' ((@($pg1.json.data | ForEach-Object { $names[$_.id] })) -join ',') 'C,A'
Check 'trending page 2: D,B' ((@($pg2.json.data | ForEach-Object { $names[$_.id] })) -join ',') 'D,B'
Check 'trending total 4' $pg1.json.meta.pagination.total 4
Check 'trending 2 pages' $pg1.json.meta.pagination.totalPages 2
$pg3 = Call 'GET' "/products?q=$tag&sort=popular&limit=3&page=2" $null $null
Check 'popular page 2 of 3-per-page: C' ((@($pg3.json.data | ForEach-Object { $names[$_.id] })) -join ',') 'C'
$pg5 = Call 'GET' "/products?q=$tag&sort=popular&limit=3&page=5" $null $null
Check 'past the end: empty page' @($pg5.json.data).Count 0
Check 'past the end: total still 4' $pg5.json.meta.pagination.total 4

# ---- 5. availableOnly ----
Need ((Call 'PATCH' "/shops/$techId/listings/$($p['D'].lid)" $owner @{ availability = 'OUT_OF_STOCK'; stockQty = 0 }).status -eq 200) 'D out of stock'
Check 'availableOnly + trending: D left out' (Names 'sort=trending&availableOnly=true') 'C,A,B'
Check 'availableOnly + popular: D left out' (Names 'sort=popular&availableOnly=true') 'B,A,C'
Check 'availableOnly + oldest: D left out' (Names 'sort=oldest&availableOnly=true') 'A,B,C'
Check 'without availableOnly D is still listed' (Names 'sort=oldest') 'A,B,C,D'

# ---- 6. bargain=true ----
Check 'nobody bargains yet: bargain=true finds none of them' (Names 'bargain=true') ''
foreach ($n in 'A', 'C', 'D') {
    Need ((Call 'PATCH' "/shops/$techId/listings/$($p[$n].lid)" $owner @{ bargainEnabled = $true; minOfferPercent = 90 }).status -eq 200) "bargaining on for $n"
}
Check 'bargain=true: only A, C, D (oldest)' (Names 'bargain=true&sort=oldest') 'A,C,D'
Check 'bargain=false is no filter' (Names 'bargain=false&sort=oldest') 'A,B,C,D'
$bg = @((Call 'GET' "/products?q=$tag&bargain=true&limit=50" $null $null).json.data)
Check 'every bargain card says bargainAvailable' (@($bg | Where-Object { $_.bargainAvailable -ne $true }).Count) 0
Check 'bargain=true + popular' (Names 'bargain=true&sort=popular') 'A,D,C'
Check 'bargain=true + trending' (Names 'bargain=true&sort=trending') 'C,A,D'
Check 'bargain=true + availableOnly + trending: D left out' (Names 'bargain=true&availableOnly=true&sort=trending') 'C,A'
$bp = Call 'GET' "/products?q=$tag&bargain=true&availableOnly=true&sort=trending&limit=1&page=2" $null $null
Check 'bargain + availableOnly + paging: page 2 is A' ((@($bp.json.data | ForEach-Object { $names[$_.id] })) -join ',') 'A'
Check 'bargain + availableOnly + paging: total 2' $bp.json.meta.pagination.total 2

# a product with one bargaining shop and one not: the filter uses only the bargaining listing
$owner2 = Login 'owner2@vendorshub.test'
$shop2 = @((Call 'GET' '/users/me/shops' $owner2 $null).json.data | Where-Object { $_.membership -eq 'OWNER' -and $_.isActive })[0].id
Need $shop2 'finding owner2''s shop'
$l2 = Call 'POST' "/shops/$shop2/listings" $owner2 @{ productId = $p['B'].id; price = 1500; stockQty = 5; bargainEnabled = $true }
Need ($l2.status -eq 201) 'a second shop listing B with bargaining'
$bB = @((Call 'GET' "/products?q=$tag&bargain=true&limit=50" $null $null).json.data | Where-Object { $_.id -eq $p['B'].id })
Check 'B now appears with bargain=true' $bB.Count 1
Check 'its card counts only the bargaining shop' "$($bB[0].shopCount)/$($bB[0].lowestPrice)" '1/1500'
$all2 = @((Call 'GET' "/products?q=$tag&limit=50" $null $null).json.data | Where-Object { $_.id -eq $p['B'].id })
Check 'without the filter B has both shops' $all2[0].shopCount 2

# ---- 7. trending / popular count the matching listings only ----
# B's 5 units were sold at TechZone, so in the other shop B has 0; there it ties with nobody
Check 'shopId of the other shop + popular lists B' (Names "shopId=$shop2&sort=popular") 'B'
Check 'bargain=true + popular: B counts 0 there (its 5 units were at TechZone), so it is last' (Names 'bargain=true&sort=popular') 'A,D,C,B'
Call 'DELETE' "/shops/$shop2/listings/$($l2.json.data.id)" $owner2 $null | Out-Null
Check 'after removing that listing, bargain=true + popular is back to A,D,C' (Names 'bargain=true&sort=popular') 'A,D,C'

# ---- 8. cleanup: no test data left ----
Call 'DELETE' '/cart' $cust $null | Out-Null
$ids = @($p.Values | ForEach-Object { $_.id })
$out = node --env-file=.env scripts/product-sorts-test-helper.mjs cleanup $since @ids | Select-Object -Last 1 | ConvertFrom-Json
Write-Host "INFO  cleanup: $($out.products) products, $($out.listings) listings, $($out.orders) orders, $($out.notifications) notifications removed"
Check 'cleanup removed the 4 test products' $out.products 4
Check 'cleanup removed the 3 test orders' $out.orders 3
Check 'nothing with the tag is left' (Names 'sort=oldest') ''

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
