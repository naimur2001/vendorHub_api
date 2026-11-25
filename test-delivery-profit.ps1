# test-delivery-profit.ps1 (delivery profit rules: admin CRUD, one active rule per scope, most specific wins,
# targetProfit / profitGap on shipments and in the reports, recalculated with the current rules)
# Run from the project root while the API runs with COURIER_MODE=mock. Removes its data and restores the shop at the end.
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

$since = [DateTime]::UtcNow.AddSeconds(-2).ToString('o')
$admin = Login 'admin@vendorshub.test'
$owner2 = Login 'owner2@vendorshub.test'  # owns Dhaka Mobile House
$cust = Login 'customer@vendorshub.test'
$mobileId = (Call 'GET' '/shops/dhaka-mobile-house' $null $null).json.data.id
$cat = @((Call 'GET' '/categories' $null $null).json.data)[0].id
$tag = "Profitcheck$(Get-Date -Format 'yyyyMMddHHmmss')"
$script:productIds = @()
$script:addressIds = @()
$script:ruleIds = @()
$snapFile = Join-Path $env:TEMP "vh-profit-$tag.json"

function Cleanup {
    foreach ($id in $script:ruleIds) { Call 'DELETE' "/admin/delivery/profit-rules/$id" $admin $null | Out-Null }
    Call 'DELETE' '/cart' $cust $null | Out-Null
    foreach ($a in $script:addressIds) { Call 'DELETE' "/users/me/addresses/$a" $cust $null | Out-Null }
    $h = Helper cleanup $since $snapFile $mobileId
    $p = $null
    if ($script:productIds.Count -gt 0) {
        $lines = @(node --env-file=.env scripts/product-sorts-test-helper.mjs cleanup $since @script:productIds)
        $line = @($lines | Where-Object { $_ -like '{*' -and $_ -notlike '*"level":*' }) | Select-Object -Last 1
        if ($line) { $p = ($line | ConvertFrom-Json) }
    }
    return @{ helper = $h; products = $p }
}
function Need($value, $what) {
    if (-not $value) {
        Write-Host "Cannot continue: $what failed. Server said: $($script:lastMsg)" -ForegroundColor Red
        Cleanup | Out-Null
        exit 1
    }
}
function NewRule($body) {
    $r = Call 'POST' '/admin/delivery/profit-rules' $admin $body
    if ($r.status -eq 201) { $script:ruleIds += $r.json.data.id }
    return $r
}
function DropRule($id) {
    $r = Call 'DELETE' "/admin/delivery/profit-rules/$id" $admin $null
    if ($r.status -eq 200) { $script:ruleIds = @($script:ruleIds | Where-Object { $_ -ne $id }) }
    return $r
}

$existing = @((Call 'GET' '/admin/delivery/profit-rules' $admin $null).json.data | Where-Object { $_.isActive })
if ($existing.Count -gt 0) { Write-Host 'Switch off the existing active profit rules first (this suite needs a known start).' -ForegroundColor Red; exit 1 }
Helper snapshot $snapFile $mobileId | Out-Null
$zones = @((Call 'GET' '/admin/delivery-zones' $admin $null).json.data)
$inside = @($zones | Where-Object { $_.code -eq 'INSIDE_DHAKA' })[0]
$pathao = @((Call 'GET' '/admin/couriers' $admin $null).json.data | Where-Object { $_.code -eq 'PATHAO' })[0]

# ---- 1. courier shipments to measure (Mobile House: Inside Dhaka 80 - 60 = 20, Outside 150 - 110 = 40) ----
Need ((Call 'PATCH' "/shops/$mobileId/delivery-mode" $owner2 @{ deliveryMode = 'PLATFORM_COURIER' }).status -eq 200) 'switching to the courier'
Need ((Call 'POST' "/admin/shops/$mobileId/courier-store" $admin @{ courierCityId = 1; courierZoneId = 101; courierAreaId = 1011 }).json.data.state -eq 'READY') 'the courier store'
$np = Call 'POST' "/shops/$mobileId/products" $owner2 @{ title = "$tag Item"; categoryId = $cat; listing = @{ price = 1000; stockQty = 30 } }
Need ($np.status -eq 201) 'creating the test product'
$script:productIds += $np.json.data.product.id
$lid = $np.json.data.listing.id
function Ship($addr) {
    $a = Call 'POST' '/users/me/addresses' $cust (@{ label = "$tag"; phone = '01712345678' } + $addr)
    Need ($a.status -eq 201) 'saving an address'
    $script:addressIds += $a.json.data.id
    Call 'DELETE' '/cart' $cust $null | Out-Null
    Need ((Call 'POST' '/cart/items' $cust @{ listingId = $lid; quantity = 1 }).status -eq 200) 'adding to the cart'
    $co = Call 'POST' '/checkout' $cust @{ shops = @(@{ shopId = $mobileId; deliveryMethod = 'VENDOR_DELIVERY'; paymentMethod = 'CASH_ON_DELIVERY'; addressId = $a.json.data.id }) }
    Need ($co.status -eq 201) 'the checkout'
    $o = $co.json.data.orders[0]
    Need ((Call 'POST' "/shops/$mobileId/orders/$($o.id)/status" $owner2 @{ status = 'CONFIRMED' }).status -eq 200) 'confirming'
    Need ((Call 'POST' "/shops/$mobileId/orders/$($o.id)/status" $owner2 @{ status = 'READY_FOR_PICKUP' }).json.data.shipment.status -eq 'BOOKED') 'booking the courier'
    return $o.orderNumber
}
$inOrder = Ship @{ line1 = 'House 7, Road 3'; courierCityId = 1; courierZoneId = 101; courierAreaId = 1011 }
$outOrder = Ship @{ line1 = 'House 5, Station Road'; courierCityId = 3; courierZoneId = 301; courierAreaId = 3011 }
function Row($orderNumber) { return @((Call 'GET' "/admin/shipments?q=$orderNumber" $admin $null).json.data)[0] }
function Sum() { return (Call 'GET' "/admin/delivery/summary?shopId=$mobileId" $admin $null).json.data }

$r0 = Row $inOrder
Check 'no rule: target and gap null' "$($r0.margin)/$($null -eq $r0.targetProfit)/$($null -eq $r0.profitGap)/$($null -eq $r0.ruleName)" '20/True/True/True'
$s0 = Sum
Check 'summary without rules: targetProfit and profitGap null, belowTarget 0' "$($null -eq $s0.targetProfit)/$($null -eq $s0.profitGap)/$($s0.belowTarget)" 'True/True/0'

# ---- 2. validation and access ----
Check 'owner cannot list rules -> 403' (Call 'GET' '/admin/delivery/profit-rules' $owner2 $null).status 403
$r = NewRule @{ name = 'Half taka'; type = 'FIXED'; value = 25.5 }
Check 'FIXED with decimals -> 400 BAD_RULE' "$($r.status)/$($script:lastCode)" '400/BAD_RULE'
Check 'FIXED over 5000 -> 400' (NewRule @{ name = 'Too much'; type = 'FIXED'; value = 5001 }).status 400
Check 'FIXED with percentOf -> 400' (NewRule @{ name = 'Mixed'; type = 'FIXED'; value = 10; percentOf = 'COURIER_COST' }).status 400
Check 'PERCENT without percentOf -> 400' (NewRule @{ name = 'No base'; type = 'PERCENT'; value = 30 }).status 400
Check 'PERCENT over 100 -> 400' (NewRule @{ name = 'Over'; type = 'PERCENT'; value = 101; percentOf = 'CUSTOMER_FEE' }).status 400
Check 'PERCENT with 3 decimals -> 400' (NewRule @{ name = 'Fine'; type = 'PERCENT'; value = 12.345; percentOf = 'CUSTOMER_FEE' }).status 400
Check 'a 1-letter name -> 400' (NewRule @{ name = 'X'; type = 'FIXED'; value = 1 }).status 400
$r = NewRule @{ name = 'Ghost zone'; type = 'FIXED'; value = 1; zoneId = [guid]::NewGuid().ToString() }
Check 'an unknown zone -> 400 ZONE_NOT_FOUND' "$($r.status)/$($script:lastCode)" '400/ZONE_NOT_FOUND'

# ---- 3. create rules; one active rule per scope ----
$all = NewRule @{ name = "$tag all"; type = 'FIXED'; value = 25 }
Check 'FIXED 25 for all zones -> 201, no zone or courier' "$($all.status)/$($all.json.data.value)/$($null -eq $all.json.data.zoneName)/$($null -eq $all.json.data.providerName)" '201/25/True/True'
$r = NewRule @{ name = "$tag all again"; type = 'FIXED'; value = 30 }
Check 'a second active rule in the same scope -> 409 RULE_SCOPE_TAKEN' "$($r.status)/$($script:lastCode)" '409/RULE_SCOPE_TAKEN'
$off = NewRule @{ name = "$tag all off"; type = 'FIXED'; value = 30; isActive = $false }
Check 'an inactive rule in the same scope is allowed' $off.status 201
$r = Call 'PATCH' "/admin/delivery/profit-rules/$($off.json.data.id)" $admin @{ isActive = $true }
Check 'switching it on -> 409 RULE_SCOPE_TAKEN' "$($r.status)/$($script:lastCode)" '409/RULE_SCOPE_TAKEN'
Check 'delete the inactive one -> 200' (DropRule $off.json.data.id).status 200
$pct = NewRule @{ name = "$tag inside"; type = 'PERCENT'; value = 30; percentOf = 'COURIER_COST'; zoneId = $inside.id }
Check 'PERCENT 30% of COURIER_COST for Inside Dhaka -> 201 with the zone name' "$($pct.status)/$($pct.json.data.zoneName)/$($pct.json.data.percentOf)" '201/Inside Dhaka/COURIER_COST'
$list = @((Call 'GET' '/admin/delivery/profit-rules' $admin $null).json.data | Where-Object { $_.name -like "$tag*" })
Check 'list has both rules' $list.Count 2

# ---- 4. target profit per shipment: most specific rule wins ----
$ri = Row $inOrder
Check 'Inside Dhaka: 30% of 60 = 18, gap +2, zone rule' "$($ri.targetProfit)/$($ri.profitGap)/$($ri.ruleName)" "18/2/$tag inside"
$ro = Row $outOrder
Check 'Outside Dhaka: the all-zones rule 25, gap 40 - 25 = 15' "$($ro.margin)/$($ro.targetProfit)/$($ro.profitGap)/$($ro.ruleName)" "40/25/15/$tag all"
$zc = NewRule @{ name = "$tag inside pathao"; type = 'FIXED'; value = 5; zoneId = $inside.id; providerId = $pathao.id }
Check 'zone + courier rule -> 201 with the courier name' "$($zc.status)/$($zc.json.data.providerName)" '201/Pathao'
Check 'zone + courier beats zone' "$((Row $inOrder).targetProfit)/$((Row $inOrder).ruleName)" "5/$tag inside pathao"
$cr = NewRule @{ name = "$tag pathao"; type = 'FIXED'; value = 7; providerId = $pathao.id }
Check 'courier beats all zones (outside)' (Row $outOrder).targetProfit 7
DropRule $cr.json.data.id | Out-Null
DropRule $zc.json.data.id | Out-Null
$det = Call 'GET' "/admin/shipments/$((Row $inOrder).id)" $admin $null
Check 'detail has the same target' "$($det.json.data.targetProfit)/$($det.json.data.profitGap)/$($det.json.data.ruleId -eq $pct.json.data.id)" '18/2/True'

# ---- 5. reports ----
$s1 = Sum
Check 'summary: targetProfit 18 + 25, gap 2 + 15, none below target' "$($s1.targetProfit)/$($s1.profitGap)/$($s1.belowTarget)" '43/17/0'
Check 'summary: pricedMargin 20 + 40 over 2 priced shipments, gap = pricedMargin - target' "$($s1.pricedMargin)/$($s1.pricedShipments)/$($s1.pricedMargin - $s1.targetProfit -eq $s1.profitGap)" '60/2/True'
Check 'summary without rules counted priced shipments too' "$($s0.pricedMargin)/$($s0.pricedShipments)" '60/2'
Check 'summary: the real margin is unchanged (money counts on DELIVERED)' "$($s1.customerFees)/$($s1.margin)" '0/0'
$bs = @((Call 'GET' "/admin/delivery/by-shop?shopId=$mobileId" $admin $null).json.data.items)[0]
Check 'by-shop: the same sums' "$($bs.pricedMargin)/$($bs.pricedShipments)/$($bs.targetProfit)/$($bs.profitGap)" '60/2/43/17'
$bp = @((Call 'GET' "/admin/delivery/by-provider?shopId=$mobileId" $admin $null).json.data.items)[0]
Check 'by-provider: the same sums' "$($bp.providerCode)/$($bp.pricedMargin)/$($bp.targetProfit)/$($bp.profitGap)" 'PATHAO/60/43/17'
$pt = @((Call 'GET' "/admin/delivery/timeseries?shopId=$mobileId" $admin $null).json.data.points)[-1]
Check 'timeseries: today (booked) has the sums' "$($pt.booked)/$($pt.pricedShipments)/$($pt.pricedMargin)/$($pt.targetProfit)/$($pt.profitGap)" '2/2/60/43/17'
$first = @((Call 'GET' "/admin/delivery/timeseries?shopId=$mobileId" $admin $null).json.data.points)[0]
Check 'timeseries: a day without shipments has null' "$($null -eq $first.targetProfit)/$($null -eq $first.profitGap)" 'True/True'

# ---- 6. edit, switch off, delete (current rules are used for old shipments too) ----
$e = Call 'PATCH' "/admin/delivery/profit-rules/$($pct.json.data.id)" $admin @{ value = 50 }
Check 'edit Inside Dhaka to 50% -> 200' "$($e.status)/$($e.json.data.value)" '200/50'
$s2 = Sum
Check 'recalculated: 30 + 25, gap -10 + 15, one below target' "$($s2.targetProfit)/$($s2.profitGap)/$($s2.belowTarget)" '55/5/1'
Check 'PATCH PERCENT -> FIXED without dropping percentOf by hand works' (Call 'PATCH' "/admin/delivery/profit-rules/$($pct.json.data.id)" $admin @{ type = 'FIXED'; value = 10 }).json.data.percentOf $null
Check 'PATCH FIXED -> PERCENT without percentOf -> 400' (Call 'PATCH' "/admin/delivery/profit-rules/$($pct.json.data.id)" $admin @{ type = 'PERCENT'; value = 10 }).status 400
Call 'PATCH' "/admin/delivery/profit-rules/$($pct.json.data.id)" $admin @{ type = 'PERCENT'; value = 30; percentOf = 'COURIER_COST' } | Out-Null
$z = Call 'DELETE' "/admin/delivery-zones/$($inside.id)" $admin $null
Check 'a zone with rules cannot be deleted -> 409 ZONE_HAS_RULES' "$($z.status)/$($script:lastCode)" '409/ZONE_HAS_RULES'
$o = Call 'PATCH' "/admin/delivery/profit-rules/$($all.json.data.id)" $admin @{ isActive = $false }
Check 'switch the all-zones rule off -> 200' "$($o.status)/$($o.json.data.isActive)" '200/False'
Check 'outside shipment: no rule now' "$($null -eq (Row $outOrder).targetProfit)/$($null -eq (Row $outOrder).ruleName)" 'True/True'
$s3 = Sum
Check 'a priced shipment without a rule counts with target 0 in the gap (60 - 18)' "$($s3.pricedMargin)/$($s3.targetProfit)/$($s3.profitGap)" '60/18/42'
Check 'delete -> 200' (DropRule $all.json.data.id).status 200
Check 'delete again -> 404' (Call 'DELETE' "/admin/delivery/profit-rules/$($all.json.data.id)" $admin $null).status 404
Check 'a bad id -> 400' (Call 'PATCH' '/admin/delivery/profit-rules/abc' $admin @{ isActive = $false }).status 400
Check 'empty PATCH -> 400' (Call 'PATCH' "/admin/delivery/profit-rules/$($pct.json.data.id)" $admin @{}).status 400
$aud = (Call 'GET' '/admin/delivery/profit-rules' $owner2 $null).status
Check 'staff/owner still 403' $aud 403

# ---- 7. cleanup ----
$out = Cleanup
Check 'cleanup: rules gone' (@((Call 'GET' '/admin/delivery/profit-rules' $admin $null).json.data | Where-Object { $_.name -like "$tag*" }).Count) 0
Check 'cleanup: shop restored, orders removed' "$($out.helper.restored)/$($out.products.orders)" '1/2'

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
if ($script:fail -gt 0) { exit 1 }
