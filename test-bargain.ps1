# test-bargain.ps1
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
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $text = $reader.ReadToEnd()
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

# stop right away instead of producing a cascade of failures
function Need($value, $what) {
    if (-not $value) {
        Write-Host "Cannot continue: $what was not created. Server said: $($script:lastMsg)" -ForegroundColor Red
        exit 1
    }
}

# moves a negotiation's deadline into the past (developer tool)
function Expire($id) { & node --env-file=.env scripts/expire-bargain.mjs $id | Out-Null }

if (-not (Test-Path 'scripts/expire-bargain.mjs')) {
    Write-Host 'Missing scripts/expire-bargain.mjs - create it first (see the chat), then run this again.' -ForegroundColor Red
    exit 1
}
try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}

$cust = Login 'customer@vendorshub.test'
$owner = Login 'owner1@vendorshub.test'
$owner3 = Login 'owner3@vendorshub.test'
Write-Host "Logged in (token lengths: $($cust.Length), $($owner.Length), $($owner3.Length))"

# ---- setup: the TechZone A55 listing, bargaining on, shop minimum 92 percent ----
$techId = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id
$p = Call 'GET' '/products/galaxy-a55-5g-8-128gb' $null $null
$all = @($p.json.data.selectedListing) + @($p.json.data.otherListings)
$lid = (@($all | Where-Object { $_.shop.id -eq $techId }))[0].id
$prep = Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ bargainEnabled = $true; minOfferPercent = 92; availability = 'IN_STOCK'; stockQty = 50 }
Check 'listing prepared for bargaining' $prep.status 200
$P = [int]$prep.json.data.price

# start clean: empty cart, close EVERY open negotiation left over from the seed or earlier runs
Call 'DELETE' '/cart' $cust $null | Out-Null
$old = Call 'GET' '/bargains?limit=50' $cust $null
foreach ($b in @($old.json.data)) {
    if ($null -ne $b -and ($b.status -eq 'AWAITING_SHOP' -or $b.status -eq 'COUNTERED' -or $b.status -eq 'ACCEPTED')) { Expire $b.id }
}
$i0 = Call 'GET' "/listings/$lid/bargain-info" $cust $null
Check 'no active negotiation left from earlier runs' ($null -eq $i0.json.data.activeBargain) $true

$min70 = [int][math]::Ceiling($P * 0.70)
$floor = [int][math]::Ceiling($P * 0.92)
$o85 = [int][math]::Floor($P * 0.85)
$o90 = [int][math]::Floor($P * 0.90)
$c93 = [int][math]::Floor($P * 0.93)
$c95 = [int][math]::Floor($P * 0.95)

# ---- 1. info for the modal ----
$i = Call 'GET' "/listings/$lid/bargain-info" $cust $null
Check 'bargain info' $i.status 200
Check 'bargaining is enabled' $i.json.data.bargainEnabled $true
Check 'minimum offer is 70 percent' $i.json.data.minOffer $min70
Check 'maximum offer is price minus 1' $i.json.data.maxOffer ($P - 1)
Check 'info does not show the shop minimum' ($null -eq $i.json.data.minOfferPercent) $true

# ---- 2. invalid offers ----
$r = Call 'POST' '/bargains' $cust @{ listingId = $lid; offer = ($min70 - 1) }
Check 'offer below 70 percent is rejected' $r.status 400
$r = Call 'POST' '/bargains' $cust @{ listingId = $lid; offer = $P }
Check 'offer at the list price is rejected' $r.status 400

# ---- 3. an offer below the shop minimum waits for the shop ----
$r = Call 'POST' '/bargains' $cust @{ listingId = $lid; offer = $o85 }
Check 'offer is created' $r.status 201
$bid = $r.json.data.id
Need $bid 'the first offer'
Check 'status is AWAITING_SHOP' $r.json.data.status 'AWAITING_SHOP'
Check 'feed has one event' @($r.json.data.events).Count 1
Check 'customer is not on turn' $r.json.data.yourTurn $false
$r = Call 'POST' '/bargains' $cust @{ listingId = $lid; offer = $o90 }
Check 'a second active negotiation is rejected' $r.status 409

# ---- 4. turn rules and privacy ----
$r = Call 'POST' "/bargains/$bid/accept" $cust $null
Check 'customer cannot accept their own offer' $r.status 409
$r = Call 'GET' "/bargains/$bid" $owner3 $null
Check 'another shop owner cannot see it' $r.status 404
$r = Call 'POST' "/bargains/$bid/accept" $owner3 $null
Check 'another shop owner cannot act on it' $r.status 404

# ---- 5. shop inbox ----
$inbox = Call 'GET' "/shops/$techId/bargains" $owner $null
Check 'shop inbox shows the offer' @($inbox.json.data | Where-Object { $_.id -eq $bid }).Count 1
$r = Call 'GET' "/shops/$techId/bargains" $cust $null
Check 'customer cannot open the shop inbox' $r.status 403

# ---- 6. the shop counters ----
$r = Call 'POST' "/bargains/$bid/counter" $owner @{ amount = $o85 }
Check 'counter not above the current offer is rejected' $r.status 400
$r = Call 'POST' "/bargains/$bid/counter" $owner @{ amount = $c95 }
Check 'shop counter works' $r.status 200
Check 'status is COUNTERED' $r.json.data.status 'COUNTERED'
Check 'current offer is the counter' $r.json.data.currentOffer $c95
$r = Call 'POST' "/bargains/$bid/counter" $owner @{ amount = ($c95 + 1) }
Check 'shop cannot counter twice in a row' $r.status 409

# ---- 7. the customer counters back ----
$r = Call 'POST' "/bargains/$bid/counter" $cust @{ amount = $c95 }
Check 'customer counter must stay below the shop counter' $r.status 400
$r = Call 'POST' "/bargains/$bid/counter" $cust @{ amount = $o90 }
Check 'customer counter works' $r.status 200
Check 'status is AWAITING_SHOP again' $r.json.data.status 'AWAITING_SHOP'

# ---- 8. the shop counters again, the customer accepts ----
$r = Call 'POST' "/bargains/$bid/counter" $owner @{ amount = $c93 }
Check 'second shop counter' $r.status 200
$r = Call 'POST' "/bargains/$bid/accept" $cust $null
Check 'customer accepts' $r.status 200
Check 'status is ACCEPTED' $r.json.data.status 'ACCEPTED'
Check 'agreed price is the last counter' $r.json.data.agreedPrice $c93
Check 'feed has 5 events' @($r.json.data.events).Count 5

# ---- 9. the agreed price in the cart ----
$r = Call 'POST' "/bargains/$bid/add-to-cart" $cust $null
Check 'add to cart' $r.status 200
$item = $r.json.data.shops[0].items[0]
Check 'cart item uses the agreed price' $item.unitPrice $c93
Check 'cart item is flagged as bargained' $item.bargainApplied $true
$r = Call 'PATCH' "/cart/items/$($item.id)" $cust @{ quantity = 2 }
Check 'bargained item is limited to one unit' $r.status 400

# ---- 10. checkout uses the price once ----
$choice = @{ shopId = $techId; deliveryMethod = 'STORE_PICKUP'; paymentMethod = 'PAY_AT_STORE' }
$r = Call 'POST' '/checkout' $cust @{ shops = @($choice) }
Check 'checkout succeeds' $r.status 201
$oi = $r.json.data.orders[0].items[0]
Check 'order item has the bargained price' $oi.unitPrice $c93
Check 'order item is flagged as bargained' $oi.bargained $true
$r = Call 'GET' "/bargains/$bid" $cust $null
Check 'used bargain is closed' $r.json.data.status 'EXPIRED'
$r = Call 'POST' "/bargains/$bid/add-to-cart" $cust $null
Check 'a used bargain cannot go back into the cart' $r.status 409

# ---- 11. automatic acceptance at the shop minimum ----
$r = Call 'POST' '/bargains' $cust @{ listingId = $lid; offer = $floor }
Check 'offer at the shop minimum is created' $r.status 201
$auto = $r.json.data.id
Need $auto 'the automatic-acceptance offer'
Check 'it is accepted automatically' $r.json.data.status 'ACCEPTED'
Check 'agreed price equals the offer' $r.json.data.agreedPrice $floor
Expire $auto
$r = Call 'GET' "/bargains/$auto" $cust $null
Check 'an unused agreed price expires' $r.json.data.status 'EXPIRED'
Check 'the feed explains why' (@($r.json.data.events | Where-Object { $_.actor -eq 'SYSTEM' }).Count -ge 2) $true

# ---- 12. the shop declines ----
$r = Call 'POST' '/bargains' $cust @{ listingId = $lid; offer = $o85 }
$d1 = $r.json.data.id
Need $d1 'the offer for the decline test'
$r = Call 'POST' "/bargains/$d1/decline" $owner $null
Check 'shop declines' $r.status 200
Check 'status is DECLINED' $r.json.data.status 'DECLINED'
$r = Call 'POST' "/bargains/$d1/accept" $cust $null
Check 'a closed negotiation cannot be changed' $r.status 409

# ---- 13. the customer withdraws ----
$r = Call 'POST' '/bargains' $cust @{ listingId = $lid; offer = $o85 }
$d2 = $r.json.data.id
Need $d2 'the offer for the withdraw test'
$r = Call 'POST' "/bargains/$d2/decline" $cust $null
Check 'customer withdraws' $r.status 200
Check 'withdrawn offer is DECLINED' $r.json.data.status 'DECLINED'

# ---- 14. an unanswered offer expires ----
$r = Call 'POST' '/bargains' $cust @{ listingId = $lid; offer = $o85 }
$d3 = $r.json.data.id
Need $d3 'the offer for the expiry test'
Expire $d3
$r = Call 'GET' "/bargains/$d3" $cust $null
Check 'an unanswered offer expires' $r.json.data.status 'EXPIRED'
$r = Call 'POST' "/bargains/$d3/counter" $owner @{ amount = $c95 }
Check 'an expired offer cannot be countered' $r.status 409
$r = Call 'POST' '/bargains' $cust @{ listingId = $lid; offer = $o85 }
Check 'a new offer is allowed after expiry' $r.status 201
Call 'POST' "/bargains/$($r.json.data.id)/decline" $cust $null | Out-Null

# ---- 15. bargaining switched off ----
Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ bargainEnabled = $false } | Out-Null
$r = Call 'POST' '/bargains' $cust @{ listingId = $lid; offer = $o85 }
Check 'offers are refused when bargaining is off' $r.status 409
Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ bargainEnabled = $true } | Out-Null

Call 'DELETE' '/cart' $cust $null | Out-Null
Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
Write-Host 'Run "npx prisma db seed" to reset the demo data.'