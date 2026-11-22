# test-promotions.ps1
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

$cust = Login 'customer@vendorshub.test'
$owner = Login 'owner1@vendorshub.test'
$owner3 = Login 'owner3@vendorshub.test'
$admin = Login 'admin@vendorshub.test'
$email2 = "promo-$([guid]::NewGuid().ToString('N').Substring(0, 8))@vendorshub.test"
Need ((Call 'POST' '/auth/register' $null @{ name = 'Promo Two'; email = $email2; password = 'Password123!' }).status -eq 201) 'registering a second customer'
$cust2 = Login $email2
$rnd = [guid]::NewGuid().ToString('N').Substring(0, 6).ToUpper()

$techId = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id
$otherShopId = @((Call 'GET' '/users/me/shops' $owner3 $null).json.data)[0].id
$mine = @((Call 'GET' "/shops/$techId/listings" $owner $null).json.data | Where-Object { $_.isActive -ne $false })
$l = $mine[0]; $lid = $l.id; $slug = $l.product.slug; $p0 = $l.price
$l2 = $mine[1]; $lid2 = $l2.id; $p2 = $l2.price
Check 'listing 1 at 10000' (Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ price = 10000; availability = 'IN_STOCK'; stockQty = 50 }).status 200
Check 'listing 2 at 9999' (Call 'PATCH' "/shops/$techId/listings/$lid2" $owner @{ price = 9999; availability = 'IN_STOCK'; stockQty = 50 }).status 200
function Iso($minutes) { return [DateTime]::UtcNow.AddMinutes($minutes).ToString('o') }
function ListingPrice { return @((@((Call 'GET' "/products/${slug}?listingId=$lid" $null $null).json.data) | ForEach-Object { @($_.selectedListing) + @($_.otherListings) }) | Where-Object { $_.id -eq $lid })[0] }
function Fill($token, $listing, $qty) {
    Call 'DELETE' '/cart' $token $null | Out-Null
    Need ((Call 'POST' '/cart/items' $token @{ listingId = $listing; quantity = $qty }).status -eq 200) 'adding to the cart'
}
function Checkout($token, $code) {
    $choice = @{ shopId = $techId; deliveryMethod = 'VENDOR_DELIVERY'; paymentMethod = 'CASH_ON_DELIVERY'; deliveryAddress = 'House 12, Road 5, Dhanmondi, Dhaka' }
    if ($code) { $choice.couponCode = $code }
    return Call 'POST' '/checkout' $token @{ shops = @($choice) }
}
function Deal($body) { return Call 'POST' "/shops/$techId/deals" $owner $body }
$cancel = @()

# ---- 1. deal validation and access ----
Check 'deal price not lower -> 400' (Deal @{ listingId = $lid; dealPrice = 10000; endsAt = (Iso 60) }).status 400
Check 'ends before it starts -> 400' (Deal @{ listingId = $lid; dealPrice = 8000; startsAt = (Iso 60); endsAt = (Iso 30) }).status 400
Check 'longer than 30 days -> 400' (Deal @{ listingId = $lid; dealPrice = 8000; endsAt = (Iso (31 * 24 * 60)) }).status 400
Check 'other shop owner -> 403' (Call 'POST' "/shops/$techId/deals" $owner3 @{ listingId = $lid; dealPrice = 8000; endsAt = (Iso 60) }).status 403
Check 'customer -> 403' (Call 'POST' "/shops/$techId/deals" $cust @{ listingId = $lid; dealPrice = 8000; endsAt = (Iso 60) }).status 403
Check 'admin -> 403' (Call 'POST' "/shops/$techId/deals" $admin @{ listingId = $lid; dealPrice = 8000; endsAt = (Iso 60) }).status 403

# ---- 2. the price applies only inside the time window ----
$r = Deal @{ listingId = $lid; dealPrice = 8000; startsAt = (Iso 60); endsAt = (Iso 120) }
Check 'scheduled deal -> 201' $r.status 201
$sched = $r.json.data
Check 'status SCHEDULED' $sched.status 'SCHEDULED'
$lp = ListingPrice
Check 'before the window: normal price' $lp.price 10000
Check 'before the window: no deal' $lp.deal $null
Check 'overlapping deal -> 409' (Deal @{ listingId = $lid; dealPrice = 7000; endsAt = (Iso 90) }).json.error.details.code 'DEAL_OVERLAP'
Check 'delete a scheduled deal' (Call 'DELETE' "/shops/$techId/deals/$($sched.id)" $owner $null).status 200
Check 'it is gone' (@((Call 'GET' "/shops/$techId/deals" $owner $null).json.data | Where-Object { $_.id -eq $sched.id }).Count) 0

$r = Deal @{ listingId = $lid; dealPrice = 8000; endsAt = (Iso 60); maxQty = 2 }
Check 'active deal -> 201' $r.status 201
$deal = $r.json.data
Check 'status ACTIVE' $deal.status 'ACTIVE'
$lp = ListingPrice
Check 'product page: deal price' $lp.price 8000
Check 'product page: original price' $lp.deal.originalPrice 10000
Check 'product page: 2 left' $lp.deal.remaining 2
$card = @((Call 'GET' "/products?q=$([uri]::EscapeDataString($l.product.title))&limit=50" $null $null).json.data | Where-Object { $_.slug -eq $slug })[0]
Check 'card lowestPrice uses the deal' ($card.lowestPrice -le 8000) $true
Check 'card shows a deal' ($null -ne $card.deal) $true
Check 'price filter uses the deal' (@((Call 'GET' "/products?q=$([uri]::EscapeDataString($l.product.title))&maxPrice=8000&limit=50" $null $null).json.data | Where-Object { $_.slug -eq $slug }).Count) 1
$pub = @((Call 'GET' '/deals' $null $null).json.data | Where-Object { $_.dealId -eq $deal.id })[0]
Check 'public deals list has it' "$($pub.price)/$($pub.originalPrice)/$($pub.percentOff)" '8000/10000/20'
Check 'storefront grid uses the deal' (@((Call 'GET' '/shops/techzone-electronics/products?limit=50' $null $null).json.data | Where-Object { $_.listingId -eq $lid })[0].price) 8000
Fill $cust $lid 1
$cart = (Call 'GET' '/cart' $cust $null).json.data
Check 'cart unit price uses the deal' $cart.shops[0].items[0].unitPrice 8000

# ---- 3. checkout, units and sold out ----
$r = Checkout $cust $null
Check 'checkout at the deal price' $r.status 201
$o1 = $r.json.data.orders[0]; $cancel += $o1.id
Check 'order item at 8000' $o1.items[0].unitPrice 8000
Check 'total = 8000 + delivery 60' $o1.total 8060
Fill $cust2 $lid 2
$r = Checkout $cust2 $null
Check 'more units than left -> 409' $r.status 409
Check 'code DEAL_SOLD_OUT' $r.json.error.details.code 'DEAL_SOLD_OUT'
Fill $cust2 $lid 1
$r = Checkout $cust2 $null
Check 'the last unit' $r.status 201
$o2 = $r.json.data.orders[0]
Check 'sold out -> normal price again' (ListingPrice).price 10000
Check 'status SOLD_OUT' (@((Call 'GET' "/shops/$techId/deals" $owner $null).json.data | Where-Object { $_.id -eq $deal.id })[0].status) 'SOLD_OUT'
Check 'cancel gives a unit back' (Call 'POST' "/orders/$($o2.id)/cancel" $cust2 @{ reason = 'Test' }).status 200
Check 'deal active again' (ListingPrice).price 8000

# ---- 4. an ended deal reverts ----
Check 'end the deal now' (Call 'DELETE' "/shops/$techId/deals/$($deal.id)" $owner $null).status 200
Check 'normal price after the end' (ListingPrice).price 10000
Check 'no deal after the end' (ListingPrice).deal $null
Check 'not in the public list' (@((Call 'GET' '/deals' $null $null).json.data | Where-Object { $_.dealId -eq $deal.id }).Count) 0
Check 'status ENDED' (@((Call 'GET' "/shops/$techId/deals" $owner $null).json.data | Where-Object { $_.id -eq $deal.id })[0].status) 'ENDED'
Check 'the earlier order keeps its deal price' ((Call 'GET' "/orders/$($o1.id)" $cust $null).json.data.items[0].unitPrice) 8000

# ---- 5. coupons: creation ----
function Coupon($token, $shop, $body) { return Call 'POST' "/shops/$shop/coupons" $token $body }
$c10 = "TEN$rnd"
$r = Coupon $owner $techId @{ code = $c10.ToLower(); percentOff = 10; minOrder = 5000; endsAt = (Iso 600) }
Check 'percent coupon -> 201' $r.status 201
Check 'code stored upper case' $r.json.data.code $c10
$c10id = $r.json.data.id
Check 'same code again -> 409' (Coupon $owner $techId @{ code = $c10; amountOff = 100; endsAt = (Iso 600) }).json.error.details.code 'COUPON_CODE_TAKEN'
Check 'both percent and amount -> 400' (Coupon $owner $techId @{ code = "BOTH$rnd"; percentOff = 5; amountOff = 100; endsAt = (Iso 600) }).status 400
Check 'neither -> 400' (Coupon $owner $techId @{ code = "NONE$rnd"; endsAt = (Iso 600) }).status 400
Check 'bad characters -> 400' (Coupon $owner $techId @{ code = 'AB-12'; percentOff = 5; endsAt = (Iso 600) }).status 400
Check 'percent over 90 -> 400' (Coupon $owner $techId @{ code = "BIG$rnd"; percentOff = 95; endsAt = (Iso 600) }).status 400
Check 'customer cannot create -> 403' (Coupon $cust $techId @{ code = "CUST$rnd"; percentOff = 5; endsAt = (Iso 600) }).status 403

# ---- 6. coupons at checkout: the math ----
Fill $cust $lid 1
$r = Checkout $cust $c10
Check 'checkout with 10% -> 201' $r.status 201
$oc = $r.json.data.orders[0]; $cancel += $oc.id
Check 'discount 10% of 10000' $oc.discount 1000
Check 'delivery fee not discounted: 10000 - 1000 + 60' $oc.total 9060
Check 'couponCode on the order' $oc.couponCode $c10
Check 'shop sees the discount' ((Call 'GET' "/shops/$techId/orders/$($oc.id)" $owner $null).json.data.discount) 1000
Check 'used once' (@((Call 'GET' "/shops/$techId/coupons" $owner $null).json.data | Where-Object { $_.id -eq $c10id })[0].usedCount) 1
Fill $cust $lid 1
Check 'same customer again -> COUPON_ALREADY_USED' (Checkout $cust $c10).json.error.details.code 'COUPON_ALREADY_USED'
Check 'a failed coupon saves nothing (cart kept)' ((Call 'GET' '/cart' $cust $null).json.data.totals.itemCount) 1

$c15 = "FIFTEEN$rnd"
Coupon $owner $techId @{ code = $c15; percentOff = 15; endsAt = (Iso 600) } | Out-Null
Fill $cust $lid2 1
$r = Checkout $cust $c15
Check 'rounding: 15% of 9999 = 1499 (rounded down)' $r.json.data.orders[0].discount 1499
$cancel += $r.json.data.orders[0].id

$cBig = "BIG$rnd"
Coupon $owner $techId @{ code = $cBig; amountOff = 50000; endsAt = (Iso 600) } | Out-Null
Fill $cust $lid2 1
$r = Checkout $cust $cBig
Check 'amount larger than the items: capped at the subtotal' $r.json.data.orders[0].discount 9999
Check 'only the delivery fee left' $r.json.data.orders[0].total 60
$cancel += $r.json.data.orders[0].id

# ---- 7. coupons: the limits ----
$cMin = "MIN$rnd"
Coupon $owner $techId @{ code = $cMin; amountOff = 500; minOrder = 20000; endsAt = (Iso 600) } | Out-Null
Fill $cust $lid 1
Check 'below minOrder -> COUPON_MIN_ORDER' (Checkout $cust $cMin).json.error.details.code 'COUPON_MIN_ORDER'
$cOther = "OTHER$rnd"
Check 'another shop creates its own coupon' (Coupon $owner3 $otherShopId @{ code = $cOther; percentOff = 5; endsAt = (Iso 600) }).status 201
Check 'another shop''s coupon -> COUPON_INVALID' (Checkout $cust $cOther).json.error.details.code 'COUPON_INVALID'
Check 'unknown code -> COUPON_INVALID' (Checkout $cust "NOPE$rnd").json.error.details.code 'COUPON_INVALID'
$cOld = "OLD$rnd"
Coupon $owner $techId @{ code = $cOld; percentOff = 5; startsAt = (Iso -120); endsAt = (Iso -60) } | Out-Null
Check 'expired -> COUPON_EXPIRED' (Checkout $cust $cOld).json.error.details.code 'COUPON_EXPIRED'
$cNext = "NEXT$rnd"
Coupon $owner $techId @{ code = $cNext; percentOff = 5; startsAt = (Iso 60); endsAt = (Iso 120) } | Out-Null
Check 'not started -> COUPON_NOT_STARTED' (Checkout $cust $cNext).json.error.details.code 'COUPON_NOT_STARTED'
$cOne = "ONE$rnd"
$one = (Coupon $owner $techId @{ code = $cOne; percentOff = 5; maxUses = 1; endsAt = (Iso 600) }).json.data
Fill $cust $lid 1
$r = Checkout $cust $cOne
Check 'the single use' $r.status 201
$oOne = $r.json.data.orders[0]
Fill $cust2 $lid 1
Check 'maxUses reached -> COUPON_USED_UP' (Checkout $cust2 $cOne).json.error.details.code 'COUPON_USED_UP'
Check 'cancel gives the use back' (Call 'POST' "/orders/$($oOne.id)/cancel" $cust @{ reason = 'Test' }).status 200
Check 'usedCount back to 0' (@((Call 'GET' "/shops/$techId/coupons" $owner $null).json.data | Where-Object { $_.id -eq $one.id })[0].usedCount) 0
$r = Checkout $cust2 $cOne
Check 'now the other customer may use it' $r.status 201
$cancel += $r.json.data.orders[0].id
Check 'switch a coupon off' (Call 'PATCH' "/shops/$techId/coupons/$c10id" $owner @{ isActive = $false }).status 200
Fill $cust2 $lid 1
Check 'switched off -> COUPON_INVALID' (Checkout $cust2 $c10).json.error.details.code 'COUPON_INVALID'
Check 'lower-case code accepted at checkout' (Checkout $cust2 $c15.ToLower()).status 201

# ---- cleanup ----
foreach ($id in $cancel) { Call 'POST' "/shops/$techId/orders/$id/status" $owner @{ status = 'CANCELLED'; reason = 'Test cleanup' } | Out-Null }
$last = @((Call 'GET' '/orders?limit=5' $cust2 $null).json.data)[0]
if ($last) { Call 'POST' "/orders/$($last.id)/cancel" $cust2 @{ reason = 'Test' } | Out-Null }
Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ price = $p0 } | Out-Null
Call 'PATCH' "/shops/$techId/listings/$lid2" $owner @{ price = $p2 } | Out-Null
Call 'DELETE' '/cart' $cust $null | Out-Null
Call 'DELETE' '/cart' $cust2 $null | Out-Null

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
if ($script:fail -gt 0) { exit 1 }
