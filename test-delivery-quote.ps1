# test-delivery-quote.ps1 (courier fee before ordering: address quotes, GET /delivery/quote, cart fees, checkout = quote;
# my shops deliveryMode/courierReady; admin shops courier store state and PENDING_APPROVAL; the default mode)
# Run from the project root while the API runs with COURIER_MODE=mock. Removes its data and restores the shops at the end.
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
$owner = Login 'owner1@vendorshub.test'   # owns TechZone
$owner2 = Login 'owner2@vendorshub.test'  # owns Dhaka Mobile House, staff of TechZone
$cust = Login 'customer@vendorshub.test'
$techId = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id
$mobileId = (Call 'GET' '/shops/dhaka-mobile-house' $null $null).json.data.id
$cat = @((Call 'GET' '/categories' $null $null).json.data)[0].id
$tag = "Quotecheck$(Get-Date -Format 'yyyyMMddHHmmss')"
$script:productIds = @()
$script:addressIds = @()
$script:orderIds = @()
$snapFile = Join-Path $env:TEMP "vh-quote-$tag.json"
Helper snapshot $snapFile $techId $mobileId | Out-Null   # both start on OWN without a store; restored at the end
$zones = @((Call 'GET' '/admin/delivery-zones' $admin $null).json.data)
$suburb = @($zones | Where-Object { $_.code -eq 'DHAKA_SUBURB' })[0]
$outside = @($zones | Where-Object { $_.code -eq 'OUTSIDE_DHAKA' })[0]

function Cleanup {
    Call 'PATCH' "/admin/delivery-zones/$($suburb.id)" $admin @{ courierZoneIds = @($suburb.courierZoneIds) } | Out-Null
    Call 'PATCH' "/admin/delivery-zones/$($outside.id)" $admin @{ isActive = [bool]$outside.isActive } | Out-Null
    foreach ($o in $script:orderIds) { Call 'POST' "/shops/$techId/orders/$o/status" $owner @{ status = 'CANCELLED'; reason = 'Test finished' } | Out-Null }
    Call 'DELETE' '/cart' $cust $null | Out-Null
    foreach ($a in $script:addressIds) { Call 'DELETE' "/users/me/addresses/$a" $cust $null | Out-Null }
    $h = Helper cleanup $since $snapFile $techId $mobileId
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

# ---- 1. new shops default to PLATFORM_COURIER ----
$dm = Helper default-mode
Check 'a new shop defaults to PLATFORM_COURIER with no store' "$($dm.deliveryMode)/$($dm.courierStoreState)" 'PLATFORM_COURIER/NONE'

# ---- 2. the owner's shops: deliveryMode and courierReady ----
Need ((Call 'PATCH' "/shops/$techId/delivery-mode" $owner @{ deliveryMode = 'PLATFORM_COURIER' }).status -eq 200) 'switching TechZone to the courier'
$mine = @((Call 'GET' '/users/me/shops' $owner $null).json.data | Where-Object { $_.id -eq $techId })[0]
Check 'my shops: courier mode, not ready yet' "$($mine.deliveryMode)/$($mine.courierReady)" 'PLATFORM_COURIER/False'
Check 'my shops: no store id' ($mine.PSObject.Properties.Name -contains 'courierStoreId') $false
$st = Call 'POST' "/admin/shops/$techId/courier-store" $admin @{ courierCityId = 1; courierZoneId = 101; courierAreaId = 1011 }
Check 'admin creates the TechZone store -> READY' "$($st.status)/$($st.json.data.state)/$($st.json.data.location.areaName)" '200/READY/Road 1 area'
$storeId = $st.json.data.courierStoreId
$mine = @((Call 'GET' '/users/me/shops' $owner $null).json.data | Where-Object { $_.id -eq $techId })[0]
Check 'my shops: courierReady after the store' $mine.courierReady $true
$asStaff = @((Call 'GET' '/users/me/shops' $owner2 $null).json.data | Where-Object { $_.id -eq $techId })[0]
Check 'staff see the same delivery fields' "$($asStaff.membership)/$($asStaff.deliveryMode)/$($asStaff.courierReady)" 'STAFF/PLATFORM_COURIER/True'
$again = Call 'POST' "/admin/shops/$techId/courier-store" $admin @{}
Check 'a READY store is kept when called again without a location' "$($again.status)/$($again.json.data.state)/$($again.json.data.courierStoreId -eq $storeId)" '200/READY/True'

# ---- 3. admin shops: courier store state, pending approval ----
$p1 = Call 'POST' "/admin/shops/$mobileId/courier-store" $admin @{ courierCityId = 1; courierZoneId = 101; courierAreaId = 1012 }
Check 'a store waiting for approval -> PENDING_APPROVAL, no id' "$($p1.status)/$($p1.json.data.state)/$($null -eq $p1.json.data.courierStoreId)" '200/PENDING_APPROVAL/True'
$p2 = Call 'POST' "/admin/shops/$mobileId/courier-store" $admin @{}
Check 'called again without a location -> still PENDING_APPROVAL (not LOCATION_REQUIRED)' "$($p2.status)/$($p2.json.data.state)/$($p2.json.data.location.areaId)" '200/PENDING_APPROVAL/1012'
$p3 = Call 'POST' "/admin/shops/$mobileId/courier-store" $admin @{ courierCityId = 3; courierZoneId = 301; courierAreaId = 3011 }
Check 'a new location while pending is ignored' "$($p3.json.data.state)/$($p3.json.data.location.areaId)" 'PENDING_APPROVAL/1012'
Check 'no second store was created' (Helper store-steps $since $mobileId).steps 'created,checked,checked'
$pend = Call 'GET' '/admin/shops?courierStoreState=PENDING_APPROVAL&limit=50' $admin $null
$row = @($pend.json.data | Where-Object { $_.id -eq $mobileId })[0]
Check 'filter PENDING_APPROVAL lists the shop' "$($pend.status)/$($null -ne $row)" '200/True'
Check 'only pending shops in that filter' (@($pend.json.data | Where-Object { $_.courierStoreState -ne 'PENDING_APPROVAL' }).Count) 0
Check 'admin row: state, mode, location, no id' "$($row.courierStoreState)/$($row.deliveryMode)/$($row.courierStoreLocation.zoneName)/$($null -eq $row.courierStoreId)" 'PENDING_APPROVAL/OWN/Dhanmondi/True'
$ready = @((Call 'GET' '/admin/shops?courierStoreState=READY&deliveryMode=PLATFORM_COURIER&limit=50' $admin $null).json.data)
Check 'filter READY + PLATFORM_COURIER lists TechZone with its store id' ((@($ready | Where-Object { $_.id -eq $techId })[0]).courierStoreId -eq $storeId) $true
Check 'filter deliveryMode=OWN leaves out TechZone' (@((Call 'GET' '/admin/shops?deliveryMode=OWN&limit=50' $admin $null).json.data | Where-Object { $_.id -eq $techId }).Count) 0
Check 'a bad courierStoreState -> 400' (Call 'GET' '/admin/shops?courierStoreState=MAYBE' $admin $null).status 400
Check 'the owner cannot list admin shops -> 403' (Call 'GET' '/admin/shops' $owner $null).status 403

# ---- 4. addresses carry deliveryQuote ----
Need ((Call 'PATCH' "/admin/delivery-zones/$($suburb.id)" $admin @{ courierZoneIds = @(103) }).status -eq 200) 'mapping Savar to the suburb zone'
function NewAddress($body) {
    $body.phone = '01712345678'
    $r = Call 'POST' '/users/me/addresses' $cust $body
    Need ($r.status -eq 201) "saving the address $($body.label)"
    $script:addressIds += $r.json.data.id
    return $r.json.data
}
$aIn = NewAddress @{ label = "$tag in"; line1 = 'House 7, Road 3'; courierCityId = 1; courierZoneId = 101; courierAreaId = 1011 }
$aSub = NewAddress @{ label = "$tag suburb"; line1 = 'House 2, Bank Colony'; courierCityId = 1; courierZoneId = 103; courierAreaId = 1031 }
$aOut = NewAddress @{ label = "$tag out"; line1 = 'House 5, Station Road'; courierCityId = 3; courierZoneId = 301; courierAreaId = 3011 }
$aNone = NewAddress @{ label = "$tag none"; line1 = 'House 9, Road 1, Mirpur' }
Check 'a new address answers with its quote' "$($aIn.deliveryQuote.zoneCode)/$($aIn.deliveryQuote.fee)" 'INSIDE_DHAKA/80'
$list = @((Call 'GET' '/users/me/addresses' $cust $null).json.data)
function InList($a) { return @($list | Where-Object { $_.id -eq $a.id })[0] }
Check 'list: Inside Dhaka 80' "$((InList $aIn).deliveryQuote.zoneCode)/$((InList $aIn).deliveryQuote.fee)/$((InList $aIn).deliveryQuote.etaText)" 'INSIDE_DHAKA/80/1-2 days'
Check 'list: the zone id beats the city (Savar -> suburb 120)' "$((InList $aSub).deliveryQuote.zoneCode)/$((InList $aSub).deliveryQuote.fee)" 'DHAKA_SUBURB/120'
Check 'list: another city falls back to Outside Dhaka 150' "$((InList $aOut).deliveryQuote.zoneCode)/$((InList $aOut).deliveryQuote.fee)" 'OUTSIDE_DHAKA/150'
Check 'list: no courier area -> deliveryQuote null' "$((InList $aNone).PSObject.Properties.Name -contains 'deliveryQuote')/$($null -eq (InList $aNone).deliveryQuote)" 'True/True'
Check 'quote fields' (Keys (InList $aIn).deliveryQuote) 'etaText,fee,zoneCode,zoneName'

# ---- 5. GET /delivery/quote ----
$q = Call 'GET' "/delivery/quote?addressId=$($aIn.id)" $cust $null
Check 'quote Inside Dhaka' "$($q.status)/$($q.json.data.zoneCode)/$($q.json.data.fee)" '200/INSIDE_DHAKA/80'
Check 'quote Dhaka suburb' (Call 'GET' "/delivery/quote?addressId=$($aSub.id)" $cust $null).json.data.fee 120
Check 'quote Outside Dhaka' (Call 'GET' "/delivery/quote?addressId=$($aOut.id)" $cust $null).json.data.fee 150
$r = Call 'GET' "/delivery/quote?addressId=$($aNone.id)" $cust $null
Check 'quote without a courier area -> 400 ADDRESS_NEEDS_AREA' "$($r.status)/$($script:lastCode)" '400/ADDRESS_NEEDS_AREA'
Check "another user's address -> 404" (Call 'GET' "/delivery/quote?addressId=$($aIn.id)" $owner $null).status 404
Check 'not logged in -> 401' (Call 'GET' "/delivery/quote?addressId=$($aIn.id)" $null $null).status 401
Check 'a bad addressId -> 400' (Call 'GET' '/delivery/quote?addressId=abc' $cust $null).status 400
Check 'no addressId -> 400' (Call 'GET' '/delivery/quote' $cust $null).status 400
Need ((Call 'PATCH' "/admin/delivery-zones/$($outside.id)" $admin @{ isActive = $false }).status -eq 200) 'switching Outside Dhaka off'
$r = Call 'GET' "/delivery/quote?addressId=$($aOut.id)" $cust $null
Check 'a switched-off zone -> 400 AREA_UNAVAILABLE' "$($r.status)/$($script:lastCode)" '400/AREA_UNAVAILABLE'
$off = @((Call 'GET' '/users/me/addresses' $cust $null).json.data | Where-Object { $_.id -eq $aOut.id })[0]
Check 'list: a switched-off zone -> deliveryQuote null' $off.deliveryQuote $null
Call 'PATCH' "/admin/delivery-zones/$($outside.id)" $admin @{ isActive = $true } | Out-Null

# ---- 6. cart fees ----
$np = Call 'POST' "/shops/$techId/products" $owner @{ title = "$tag Item"; categoryId = $cat; listing = @{ price = 1000; stockQty = 30 } }
Need ($np.status -eq 201) 'creating the test product'
$script:productIds += $np.json.data.product.id
$lid = $np.json.data.listing.id
Call 'DELETE' '/cart' $cust $null | Out-Null
Need ((Call 'POST' '/cart/items' $cust @{ listingId = $lid; quantity = 1 }).status -eq 200) 'adding to the cart'
$c0 = (Call 'GET' '/cart' $cust $null).json.data
$g0 = @($c0.shops | Where-Object { $_.shop.id -eq $techId })[0]
Check 'cart without an address: courier fee null (not 0)' "$($g0.PSObject.Properties.Name -contains 'deliveryFee')/$($null -eq $g0.deliveryFee)/$($null -eq $c0.deliveryQuote)" 'True/True/True'
Check 'cart: courierDelivery and deliveryAvailable' "$($g0.shop.courierDelivery)/$($g0.shop.deliveryAvailable)" 'True/True'
$c1 = (Call 'GET' "/cart?addressId=$($aSub.id)" $cust $null).json.data
$g1 = @($c1.shops | Where-Object { $_.shop.id -eq $techId })[0]
Check 'cart with the suburb address: fee 120, quote and address id' "$($g1.deliveryFee)/$($c1.deliveryQuote.fee)/$($c1.deliveryAddressId -eq $aSub.id)" '120/120/True'
$c2 = (Call 'GET' "/cart?addressId=$($aNone.id)" $cust $null).json.data
Check 'cart with an address without area: fee null' "$($null -eq (@($c2.shops)[0]).deliveryFee)/$($null -eq $c2.deliveryQuote)" 'True/True'
Check "cart with another user's address -> 404" (Call 'GET' "/cart?addressId=$($aIn.id)" $owner $null).status 404
Check 'cart with a bad addressId -> 400' (Call 'GET' '/cart?addressId=abc' $cust $null).status 400

# ---- 7. checkout charges the quoted fee (a fee sent by the client is ignored) ----
$quote = (Call 'GET' "/delivery/quote?addressId=$($aSub.id)" $cust $null).json.data
$co = Call 'POST' '/checkout' $cust @{ shops = @(@{ shopId = $techId; deliveryMethod = 'VENDOR_DELIVERY'; paymentMethod = 'CASH_ON_DELIVERY'; addressId = $aSub.id; deliveryFee = 1 }) }
Check 'checkout -> 201' $co.status 201
$order = $co.json.data.orders[0]
if ($order) { $script:orderIds += $order.id }
Check 'order deliveryFee = quote fee (client fee ignored)' "$($order.deliveryFee)/$($order.deliveryFee -eq $quote.fee)/$($order.total)" '120/True/1120'
$sh = @((Call 'GET' "/admin/shipments?q=$($order.orderNumber)" $admin $null).json.data)[0]
Check 'the shipment has the same zone and fee' "$($sh.zoneCode)/$($sh.customerFee)" 'DHAKA_SUBURB/120'

# ---- 8. cleanup ----
$out = Cleanup
Check 'cleanup restored both shops and removed the test orders' "$($out.helper.restored)/$($out.products.orders -ge 1)" '2/True'
$after = @((Call 'GET' '/users/me/addresses' $cust $null).json.data | Where-Object { $_.label -like "$tag*" }).Count
Check 'cleanup removed the test addresses' $after 0

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
if ($script:fail -gt 0) { exit 1 }
