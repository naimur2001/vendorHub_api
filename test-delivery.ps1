# test-delivery.ps1 (courier delivery: zones and fees, shop delivery mode, shipments, webhook, admin monitor)
# Run from the project root while the API runs with COURIER_MODE=mock (the default). Removes its data at the end.
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
function Keys($obj) { return ((@($obj.PSObject.Properties.Name) | Sort-Object) -join ',') }

try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch { Write-Host 'The API is not running.' -ForegroundColor Red; exit 1 }

$since = [DateTime]::UtcNow.AddSeconds(-2).ToString('o')
$admin = Login 'admin@vendorshub.test'
$owner = Login 'owner1@vendorshub.test'   # owns TechZone
$staff = Login 'owner2@vendorshub.test'   # staff of TechZone
$cust = Login 'customer@vendorshub.test'
$techId = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id
$cat = @((Call 'GET' '/categories' $null $null).json.data)[0].id
$tag = "Shipcheck$(Get-Date -Format 'yyyyMMddHHmmss')"
$script:productIds = @()
$script:addressIds = @()
$snapFile = Join-Path $env:TEMP "vh-delivery-$tag.json"
Helper snapshot $snapFile $techId | Out-Null   # TechZone starts on OWN without a store; restored at the end

function Cleanup {
    Call 'DELETE' '/cart' $cust $null | Out-Null
    foreach ($a in $script:addressIds) { Call 'DELETE' "/users/me/addresses/$a" $cust $null | Out-Null }
    Helper cleanup $since $snapFile $techId | Out-Null
    if ($script:productIds.Count -gt 0) {
        $lines = @(node --env-file=.env scripts/product-sorts-test-helper.mjs cleanup $since @script:productIds)
        $line = @($lines | Where-Object { $_ -like '{*' -and $_ -notlike '*"level":*' }) | Select-Object -Last 1
        if ($line) { return ($line | ConvertFrom-Json) }
    }
    return $null
}
function Need($value, $what) {
    if (-not $value) {
        Write-Host "Cannot continue: $what failed. Server said: $($script:lastMsg)" -ForegroundColor Red
        Cleanup | Out-Null
        exit 1
    }
}
$np = Call 'POST' "/shops/$techId/products" $owner @{ title = "$tag Item"; categoryId = $cat; listing = @{ price = 1000; stockQty = 30 } }
Need ($np.status -eq 201) 'creating the test product'
$script:productIds += $np.json.data.product.id
$lid = $np.json.data.listing.id

function Order($shopBody) {
    Call 'DELETE' '/cart' $cust $null | Out-Null
    Need ((Call 'POST' '/cart/items' $cust @{ listingId = $lid; quantity = 1 }).status -eq 200) 'adding to the cart'
    $shopBody.shopId = $techId
    $r = Call 'POST' '/checkout' $cust @{ shops = @($shopBody) }
    return $r
}
function SetStatus($orderId, $status) { return Call 'POST' "/shops/$techId/orders/$orderId/status" $owner @{ status = $status } }
function AdminShipment($orderNumber) {
    $row = @((Call 'GET' "/admin/shipments?q=$orderNumber" $admin $null).json.data)[0]
    return (Call 'GET' "/admin/shipments/$($row.id)" $admin $null).json.data
}
$t0 = [DateTime]::UtcNow
function At($minutes) { return $t0.AddMinutes($minutes).ToString('o') }

# ---- 1. an OWN-mode shop is unchanged ----
$o = Order @{ deliveryMethod = 'VENDOR_DELIVERY'; paymentMethod = 'CASH_ON_DELIVERY'; deliveryAddress = 'House 12, Road 5, Dhanmondi, Dhaka' }
Check 'OWN: checkout -> 201' $o.status 201
$own = $o.json.data.orders[0]
Check 'OWN: delivery fee is still 60' $own.deliveryFee 60
Check 'OWN: no shipment' $own.shipment $null
Need ((SetStatus $own.id 'CONFIRMED').status -eq 200) 'confirming the OWN order'
$so = Call 'GET' "/shops/$techId/orders/$($own.id)" $owner $null
Check 'OWN: the shop can go out for delivery' (@($so.json.data.nextStatuses) -contains 'OUT_FOR_DELIVERY') $true
Check 'OWN: OUT_FOR_DELIVERY -> 200' (SetStatus $own.id 'OUT_FOR_DELIVERY').status 200
Check 'OWN: COMPLETED -> 200' (SetStatus $own.id 'COMPLETED').status 200

# ---- 2. delivery mode, courier store, zones ----
Check 'staff cannot change the delivery mode -> 403' (Call 'PATCH' "/shops/$techId/delivery-mode" $staff @{ deliveryMode = 'PLATFORM_COURIER' }).status 403
$m = Call 'PATCH' "/shops/$techId/delivery-mode" $owner @{ deliveryMode = 'PLATFORM_COURIER' }
Check 'owner switches to PLATFORM_COURIER -> 200, not ready yet' "$($m.status)/$($m.json.data.deliveryMode)/$($m.json.data.courierReady)" '200/PLATFORM_COURIER/False'
Call 'DELETE' '/cart' $cust $null | Out-Null
Call 'POST' '/cart/items' $cust @{ listingId = $lid; quantity = 1 } | Out-Null
$cartShop = @((Call 'GET' '/cart' $cust $null).json.data.shops | Where-Object { $_.shop.id -eq $techId })[0].shop
Check 'cart: delivery hidden without a courier store' "$($cartShop.deliveryAvailable)/$($cartShop.courierDelivery)" 'False/True'
Check 'cart: the store id is never shown' ($cartShop.PSObject.Properties.Name -contains 'courierStoreId') $false
$r = Order @{ deliveryMethod = 'VENDOR_DELIVERY'; paymentMethod = 'CASH_ON_DELIVERY'; deliveryAddress = 'House 12, Road 5, Dhanmondi, Dhaka' }
Check 'checkout without a store -> 400 DELIVERY_UNAVAILABLE' "$($r.status)/$($script:lastCode)" '400/DELIVERY_UNAVAILABLE'
Check 'owner cannot create the courier store -> 403' (Call 'POST' "/admin/shops/$techId/courier-store" $owner @{}).status 403
$r = Call 'POST' "/admin/shops/$techId/courier-store" $admin @{}
Check 'courier store without a location -> 400 LOCATION_REQUIRED' "$($r.status)/$($script:lastCode)" '400/LOCATION_REQUIRED'
$r = Call 'POST' "/admin/shops/$techId/courier-store" $admin @{ courierCityId = 1; courierZoneId = 101; courierAreaId = 1011 }
Check 'admin creates the courier store -> READY' "$($r.status)/$($r.json.data.state)" '200/READY'

$cities = @((Call 'GET' '/delivery/locations/cities' $null $null).json.data)
Check 'locations: cities have only id and name' (Keys $cities[0]) 'id,name'
Check 'locations: zones of Dhaka' (@((Call 'GET' '/delivery/locations/cities/1/zones' $null $null).json.data).Count -ge 1) $true
Check 'locations: areas of a zone' (@((Call 'GET' '/delivery/locations/zones/101/areas' $null $null).json.data).Count -ge 1) $true
Check 'locations: a bad id -> 400' (Call 'GET' '/delivery/locations/cities/abc/zones' $null $null).status 400

$bad = Call 'POST' '/users/me/addresses' $cust @{ line1 = 'House 1, Road 2'; phone = '01712345678'; courierCityId = 1; courierZoneId = 101; courierAreaId = 9999 }
Check 'address with an unknown area -> 400 BAD_LOCATION' "$($bad.status)/$($script:lastCode)" '400/BAD_LOCATION'
Check 'address with only a city -> 400' (Call 'POST' '/users/me/addresses' $cust @{ line1 = 'House 1, Road 2'; phone = '01712345678'; courierCityId = 1 }).status 400
$addr = Call 'POST' '/users/me/addresses' $cust @{ label = "$tag"; line1 = 'House 7, Road 3'; phone = '01712345678'; courierCityId = 1; courierZoneId = 101; courierAreaId = 1011 }
Check 'address with a delivery area -> 201' $addr.status 201
$script:addressIds += $addr.json.data.id
Check 'the server fills in the names' "$($addr.json.data.courierCityName)/$($addr.json.data.courierZoneName)" 'Dhaka/Dhanmondi'

$zones = @((Call 'GET' '/admin/delivery-zones' $admin $null).json.data)
Check 'admin: 3 zones with fees 80 / 120 / 150' ((@($zones | ForEach-Object { $_.customerFee }) | Sort-Object) -join '/') '80/120/150'
$couriers = @((Call 'GET' '/admin/couriers' $admin $null).json.data)
Check 'admin: 5 couriers' $couriers.Count 5
Check 'admin: only Pathao is active and default' ((@($couriers | Where-Object { $_.isActive -or $_.isDefault } | ForEach-Object { "$($_.code):$($_.isActive):$($_.isDefault)" })) -join ',') 'PATHAO:True:True'
$pathao = @($couriers | Where-Object { $_.code -eq 'PATHAO' })[0]
Check 'the default cannot be switched off -> 409' (Call 'PATCH' "/admin/couriers/$($pathao.id)" $admin @{ isActive = $false }).status 409
Check 'owner cannot list couriers -> 403' (Call 'GET' '/admin/couriers' $owner $null).status 403

# ---- 3. a courier order: zone fee, shipment, booking ----
$r = Order @{ deliveryMethod = 'VENDOR_DELIVERY'; paymentMethod = 'CASH_ON_DELIVERY'; deliveryAddress = 'House 12, Road 5, Dhanmondi, Dhaka' }
Check 'courier order with a typed address -> 400 ADDRESS_NEEDS_AREA' "$($r.status)/$($script:lastCode)" '400/ADDRESS_NEEDS_AREA'
$r = Order @{ deliveryMethod = 'VENDOR_DELIVERY'; paymentMethod = 'CASH_ON_DELIVERY'; addressId = $addr.json.data.id }
Check 'courier order -> 201' $r.status 201
$co = $r.json.data.orders[0]
Check 'the fee comes from the zone (INSIDE_DHAKA 80)' "$($co.deliveryFee)/$($co.total)" '80/1080'
Check 'customer: shipment PENDING' $co.shipment.status 'PENDING'
Check 'customer: shipment fields only' (Keys $co.shipment) 'courier,status,timeline,trackingCode'
Need ((SetStatus $co.id 'CONFIRMED').status -eq 200) 'confirming the courier order'
$so = Call 'GET' "/shops/$techId/orders/$($co.id)" $owner $null
Check 'courier order: the shop marks it ready (not out for delivery)' ((@($so.json.data.nextStatuses) | Sort-Object) -join ',') 'CANCELLED,READY_FOR_PICKUP'
$ready = SetStatus $co.id 'READY_FOR_PICKUP'
Check 'ready -> 200' $ready.status 200
$shopView = $ready.json.data.shipment
Check 'ready books the courier automatically' $shopView.status 'BOOKED'
Check 'shop: tracking code and courier name' "$([bool]$shopView.trackingCode)/$($shopView.courier.name)" 'True/Pathao'
Check 'shop: COD amount = order total, not paid yet' "$($shopView.codAmount)/$($shopView.shopPaid)" '1080/False'
Check 'shop: no courier cost or margin' (($shopView.PSObject.Properties.Name -contains 'courierCost') -or ($shopView.PSObject.Properties.Name -contains 'margin')) $false

$s1 = Call 'POST' "/shops/$techId/orders/$($co.id)/ship" $owner $null
$s2 = Call 'POST' "/shops/$techId/orders/$($co.id)/ship" $staff $null
Check 'ship again -> 200 with the same tracking code (idempotent)' "$($s1.status)/$($s2.status)/$($s1.json.data.trackingCode -eq $shopView.trackingCode)/$($s2.json.data.trackingCode -eq $shopView.trackingCode)" '200/200/True/True'
$ad = AdminShipment $co.orderNumber
Check 'booked once (one BOOKED event)' (@($ad.events | Where-Object { $_.status -eq 'BOOKED' }).Count) 1
Check 'margin = customer fee - courier cost (80 - 60 = 20)' "$($ad.customerFee)/$($ad.courierCost)/$($ad.margin)" '80/60/20'
Check 'admin sees the consignment and the recipient' "$([bool]$ad.consignmentId)/$($ad.recipient.areaId)" 'True/1011'
Check 'customer before pickup: no courier, no tracking code' "$($null -eq (Call 'GET' "/orders/$($co.id)" $cust $null).json.data.shipment.courier)/$($null -eq (Call 'GET' "/orders/$($co.id)" $cust $null).json.data.shipment.trackingCode)" 'True/True'
$r = SetStatus $co.id 'OUT_FOR_DELIVERY'
Check 'the shop cannot set out for delivery -> 409 COURIER_MANAGED' "$($r.status)/$($script:lastCode)" '409/COURIER_MANAGED'
$r = Call 'POST' "/shops/$techId/orders/$($co.id)/status" $owner @{ status = 'CANCELLED'; reason = 'Changed my mind' }
Check 'the shop cannot cancel a booked order -> 409 SHIPMENT_BOOKED' "$($r.status)/$($script:lastCode)" '409/SHIPMENT_BOOKED'

# ---- 4. webhook: signature, mapping, duplicates, order ----
$cid = $ad.consignmentId
Check 'a bad signature -> 401' (Helper webhook $cid 'order.picked' (At 1) bad).status 401
$i = Helper integration
Check 'the integration check -> 202' "$($i.status)/$($i.body.data.integration)" '202/True'
$w = Helper webhook $cid 'order.assigned-for-pickup' (At 2)
Check 'assigned-for-pickup -> PICKUP_ASSIGNED' "$($w.status)/$((AdminShipment $co.orderNumber).status)" '202/PICKUP_ASSIGNED'
$cv = (Call 'GET' "/orders/$($co.id)" $cust $null).json.data.shipment
Check 'customer at PICKUP_ASSIGNED: still no courier' "$($cv.status)/$($null -eq $cv.courier)/$($null -eq $cv.trackingCode)" 'PICKUP_ASSIGNED/True/True'
Helper webhook $cid 'order.picked' (At 10) | Out-Null
$cOrder = (Call 'GET' "/orders/$($co.id)" $cust $null).json.data
Check 'picked -> PICKED_UP, the order is OUT_FOR_DELIVERY' "$($cOrder.shipment.status)/$($cOrder.status)" 'PICKED_UP/OUT_FOR_DELIVERY'
Check 'customer after pickup: courier name and tracking code' "$($cOrder.shipment.courier.name)/$([bool]$cOrder.shipment.trackingCode)" 'Pathao/True'
Check 'customer never sees cost, margin or raw data' (Keys $cOrder.shipment) 'courier,status,timeline,trackingCode'
$before = @((AdminShipment $co.orderNumber).events).Count
$dup = Helper webhook $cid 'order.picked' (At 10)
Check 'a duplicate event is ignored' "$($dup.body.data.ignored)/$(@((AdminShipment $co.orderNumber).events).Count)" "1/$before"
$old = Helper webhook $cid 'order.in-transit' (At 5)
Check 'an older event is ignored (out of order)' "$($old.body.data.ignored)/$((AdminShipment $co.orderNumber).status)" '1/PICKED_UP'
Helper webhook $cid 'order.in-transit' (At 15) | Out-Null
Check 'in-transit -> IN_TRANSIT' (AdminShipment $co.orderNumber).status 'IN_TRANSIT'
Helper webhook $cid 'order.delivered' (At 30) | Out-Null
$cOrder = (Call 'GET' "/orders/$($co.id)" $cust $null).json.data
Check 'delivered -> DELIVERED, the order is COMPLETED' "$($cOrder.shipment.status)/$($cOrder.status)" 'DELIVERED/COMPLETED'
Check 'COD is PAID on delivery' $cOrder.paymentStatus 'PAID'
Helper webhook $cid 'order.returned' (At 40) | Out-Null
Check 'nothing changes after DELIVERED' (AdminShipment $co.orderNumber).status 'DELIVERED'
$notes = @((Call 'GET' '/notifications?limit=50' $cust $null).json.data | Where-Object { $_.data.orderId -eq $co.id } | ForEach-Object { $_.type })
Check 'customer told: picked up and delivered' "$($notes -contains 'SHIPMENT_PICKED_UP')/$($notes -contains 'SHIPMENT_DELIVERED')" 'True/True'

# ---- 5. money ----
$sid = $ad.id
Check 'mark COD remitted -> 200' (Call 'POST' "/admin/shipments/$sid/mark-cod-remitted" $admin $null).status 200
Check 'again -> 409' (Call 'POST' "/admin/shipments/$sid/mark-cod-remitted" $admin $null).status 409
Check 'mark the shop paid -> 200' (Call 'POST' "/admin/shipments/$sid/mark-shop-paid" $admin $null).status 200
Check 'the shop sees it was paid' (Call 'GET' "/shops/$techId/orders/$($co.id)" $owner $null).json.data.shipment.shopPaid $true
Check 'owner cannot use admin shipment actions -> 403' (Call 'POST' "/admin/shipments/$sid/mark-shop-paid" $owner $null).status 403

# ---- 6. a returned shipment cancels the order ----
$r = Order @{ deliveryMethod = 'VENDOR_DELIVERY'; paymentMethod = 'CASH_ON_DELIVERY'; addressId = $addr.json.data.id }
Need ($r.status -eq 201) 'the second courier order'
$ro = $r.json.data.orders[0]
SetStatus $ro.id 'CONFIRMED' | Out-Null
SetStatus $ro.id 'READY_FOR_PICKUP' | Out-Null
$rcid = (AdminShipment $ro.orderNumber).consignmentId
Helper webhook $rcid 'order.picked' (At 50) | Out-Null
Helper webhook $rcid 'order.delivery-failed' (At 55) | Out-Null
Check 'delivery-failed -> FAILED with a reason' "$((AdminShipment $ro.orderNumber).status)/$([bool](AdminShipment $ro.orderNumber).failReason)" 'FAILED/True'
Helper webhook $rcid 'order.returned' (At 60) | Out-Null
$rr = (Call 'GET' "/orders/$($ro.id)" $cust $null).json.data
Check 'returned -> RETURNED, the order is CANCELLED' "$($rr.shipment.status)/$($rr.status)" 'RETURNED/CANCELLED'
$tn = @((Call 'GET' '/notifications?limit=50' $owner $null).json.data | Where-Object { $_.data.orderId -eq $ro.id } | ForEach-Object { $_.type })
Check 'shop told: failed and returned' "$($tn -contains 'SHIPMENT_FAILED')/$($tn -contains 'SHIPMENT_RETURNED')" 'True/True'

# ---- 7. booking failure: kept PENDING, retried, then everyone is told ----
$fa = Call 'POST' '/users/me/addresses' $cust @{ label = "$tag fail"; line1 = 'House 9 [mock-fail]'; phone = '01712345678'; courierCityId = 3; courierZoneId = 301; courierAreaId = 3011 }
Need ($fa.status -eq 201) 'the failing address'
$script:addressIds += $fa.json.data.id
$r = Order @{ deliveryMethod = 'VENDOR_DELIVERY'; paymentMethod = 'CASH_ON_DELIVERY'; addressId = $fa.json.data.id }
Need ($r.status -eq 201) 'the third courier order'
$fo = $r.json.data.orders[0]
Check 'outside Dhaka fee 150' $fo.deliveryFee 150
SetStatus $fo.id 'CONFIRMED' | Out-Null
$fr = SetStatus $fo.id 'READY_FOR_PICKUP'
Check 'a failed booking keeps the order ready and the shipment PENDING' "$($fr.status)/$($fr.json.data.shipment.status)" '200/PENDING'
$fs = AdminShipment $fo.orderNumber
Check 'first try counted, a retry is planned' "$($fs.bookingAttempts)/$([bool]$fs.nextAttemptAt)" '1/True'
Helper retry 2 | Out-Null
Helper retry 10 | Out-Null
$fs = AdminShipment $fo.orderNumber
Check 'after 3 tries: no more retries' "$($fs.bookingAttempts)/$($null -eq $fs.nextAttemptAt)" '3/True'
Check 'the shop sees bookingFailed' (Call 'GET' "/shops/$techId/orders/$($fo.id)" $owner $null).json.data.shipment.bookingFailed $true
Check 'admins are told (SHIPMENT_BOOKING_FAILED)' (@((Call 'GET' '/notifications?limit=50' $admin $null).json.data | Where-Object { $_.type -eq 'SHIPMENT_BOOKING_FAILED' -and $_.data.orderId -eq $fo.id }).Count) 1
$r = Call 'POST' "/shops/$techId/orders/$($fo.id)/ship" $owner $null
Check 'ship by hand still fails -> 502 BOOKING_FAILED' "$($r.status)/$($script:lastCode)" '502/BOOKING_FAILED'
Check 'admin cancels the shipment -> 200 CANCELLED' (Call 'POST' "/admin/shipments/$($fs.id)/cancel" $admin $null).json.data.status 'CANCELLED'

# ---- 8. monitor ----
$sum = Call 'GET' "/admin/delivery/summary?shopId=$techId" $admin $null
Check 'summary -> 200' $sum.status 200
Check 'summary: delivered, returned, success rate' "$($sum.json.data.delivered -ge 1)/$($sum.json.data.returned -ge 1)/$($null -ne $sum.json.data.successRate)" 'True/True/True'
Check 'summary: fees, cost and margin add up' ($sum.json.data.customerFees - $sum.json.data.courierCost) $sum.json.data.margin
Check 'summary: counts by status' ($sum.json.data.countsByStatus.DELIVERED -ge 1) $true
$ts = Call 'GET' '/admin/delivery/timeseries?interval=day' $admin $null
Check 'timeseries: 30 days' "$($ts.status)/$(@($ts.json.data.points).Count)" '200/30'
Check 'timeseries: today has our delivery' ((@($ts.json.data.points)[-1]).delivered -ge 1) $true
$bs = Call 'GET' '/admin/delivery/by-shop' $admin $null
Check 'by-shop includes TechZone' (@($bs.json.data.items | Where-Object { $_.shopId -eq $techId }).Count) 1
$bp = Call 'GET' '/admin/delivery/by-provider' $admin $null
Check 'by-provider: Pathao' (@($bp.json.data.items | Where-Object { $_.providerCode -eq 'PATHAO' }).Count) 1
Check 'bad range -> 400' (Call 'GET' '/admin/delivery/summary?from=2026-12-01&to=2026-11-01' $admin $null).status 400
$list = Call 'GET' "/admin/shipments?shopId=$techId&status=DELIVERED" $admin $null
Check 'shipments list filters by status' (@($list.json.data | Where-Object { $_.status -ne 'DELIVERED' }).Count) 0
Check 'shipments list row has stuck and age' "$($list.json.data[0].PSObject.Properties.Name -contains 'stuck')/$($list.json.data[0].PSObject.Properties.Name -contains 'ageHours')" 'True/True'
Check 'owner cannot see the monitor -> 403' (Call 'GET' '/admin/delivery/summary' $owner $null).status 403

# ---- 9. cleanup ----
Call 'POST' "/shops/$techId/orders/$($fo.id)/status" $owner @{ status = 'CANCELLED'; reason = 'Test finished' } | Out-Null
$out = Cleanup
Check 'cleanup removed the test orders' ($out.orders -ge 4) $true
Check 'the cart still works after cleanup' ((Call 'GET' '/cart' $cust $null).status) 200

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
if ($script:fail -gt 0) { exit 1 }
