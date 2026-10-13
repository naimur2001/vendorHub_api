# test-checkout.ps1
# Run from the project root while "npm run dev" is running in another terminal.
$base = 'http://localhost:4000/api/v1'
$script:pass = 0
$script:fail = 0

function Call($method, $path, $token, $body) {
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
        return @{ status = [int]$resp.StatusCode; json = $json }
    }
}

function Check($name, $actual, $expected) {
    if ($actual -eq $expected) {
        Write-Host "PASS  $name" -ForegroundColor Green
        $script:pass++
    } else {
        Write-Host "FAIL  $name (got '$actual', expected '$expected')" -ForegroundColor Red
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

try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}

$cust = Login 'customer@vendorshub.test'
$owner = Login 'owner1@vendorshub.test'
Write-Host "Logged in (token lengths: $($cust.Length), $($owner.Length))"

# ---- build a two-shop cart ----
Call 'DELETE' '/cart' $cust $null | Out-Null
$p = Call 'GET' '/products/galaxy-a55-5g-8-128gb' $null $null
$l1 = $p.json.data.selectedListing.id
$l2 = $p.json.data.otherListings[0].id
Call 'POST' '/cart/items' $cust @{ listingId = $l1; quantity = 1 } | Out-Null
Call 'POST' '/cart/items' $cust @{ listingId = $l2; quantity = 2 } | Out-Null
$cart = Call 'GET' '/cart' $cust $null
$groups = @($cart.json.data.shops)
Check 'cart has 2 shops' $groups.Count 2

$techId = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id

# one choice per shop: shops that deliver get delivery + cash on delivery, the others pickup + online
$choices = @()
foreach ($g in $groups) {
    if ($g.shop.supportsDelivery) {
        $choices += @{ shopId = $g.shop.id; deliveryMethod = 'VENDOR_DELIVERY'; paymentMethod = 'CASH_ON_DELIVERY'; deliveryAddress = 'House 12, Road 5, Dhanmondi, Dhaka' }
    } else {
        $choices += @{ shopId = $g.shop.id; deliveryMethod = 'STORE_PICKUP'; paymentMethod = 'ONLINE' }
    }
}
$deliveryChoice = @($choices | Where-Object { $_.deliveryMethod -eq 'VENDOR_DELIVERY' })[0]
$pickupChoice = @($choices | Where-Object { $_.deliveryMethod -eq 'STORE_PICKUP' })[0]
Check 'one shop delivers and one is pickup only' (($null -ne $deliveryChoice) -and ($null -ne $pickupChoice)) $true
Check 'the delivering shop is TechZone' ($deliveryChoice.shopId -eq $techId) $true

# ---- invalid choices ----
$r = Call 'POST' '/checkout' $cust @{ shops = @($deliveryChoice) }
Check 'a shop in the cart is missing from the request' $r.status 400

$pickupChoice.deliveryMethod = 'VENDOR_DELIVERY'
$pickupChoice.deliveryAddress = 'House 12, Road 5, Dhanmondi, Dhaka'
$r = Call 'POST' '/checkout' $cust @{ shops = $choices }
Check 'delivery requested from a shop that does not deliver' $r.status 400
$pickupChoice.deliveryMethod = 'STORE_PICKUP'
$pickupChoice.Remove('deliveryAddress')

$pickupChoice.paymentMethod = 'CASH_ON_DELIVERY'
$r = Call 'POST' '/checkout' $cust @{ shops = $choices }
Check 'cash on delivery with pickup' $r.status 400
$pickupChoice.paymentMethod = 'ONLINE'

$savedAddress = $deliveryChoice.deliveryAddress
$deliveryChoice.Remove('deliveryAddress')
$r = Call 'POST' '/checkout' $cust @{ shops = $choices }
Check 'delivery without an address' $r.status 400
$deliveryChoice.deliveryAddress = $savedAddress

# ---- stock before ----
$ownerListings = @((Call 'GET' "/shops/$techId/listings" $owner $null).json.data)
$before = ($ownerListings | Where-Object { $_.id -eq $l2 }).stockQty

# ---- the real checkout ----
$r = Call 'POST' '/checkout' $cust @{ shops = $choices }
Check 'checkout succeeds' $r.status 201
$checkoutId = $r.json.data.checkoutId
$orders = @($r.json.data.orders)
Check 'two independent orders' $orders.Count 2
Check 'order numbers are different' ($orders[0].orderNumber -ne $orders[1].orderNumber) $true
$sum = ($orders | Measure-Object -Property total -Sum).Sum
Check 'checkout total equals the sum of the orders' $r.json.data.totalAmount $sum
$deliv = @($orders | Where-Object { $_.deliveryMethod -eq 'VENDOR_DELIVERY' })[0]
$pick = @($orders | Where-Object { $_.deliveryMethod -eq 'STORE_PICKUP' })[0]
Check 'delivery fee on the delivery order' $deliv.deliveryFee 60
Check 'no delivery fee on the pickup order' $pick.deliveryFee 0
Check 'online order starts unpaid' $pick.paymentStatus 'PENDING'

$c = Call 'GET' '/cart' $cust $null
Check 'cart is empty after checkout' $c.json.data.totals.shopCount 0

if ($null -ne $before) {
    $ownerListings = @((Call 'GET' "/shops/$techId/listings" $owner $null).json.data)
    $after = ($ownerListings | Where-Object { $_.id -eq $l2 }).stockQty
    Check 'stock went down by 2' $after ($before - 2)
}

# ---- reading orders ----
$list = Call 'GET' '/orders' $cust $null
Check 'orders list contains both new orders' @($list.json.data | Where-Object { $_.checkoutId -eq $checkoutId }).Count 2
$one = Call 'GET' "/orders/$($pick.id)" $cust $null
Check 'order detail' $one.status 200
$s = Call 'GET' "/checkouts/$checkoutId" $cust $null
Check 'checkout summary' $s.status 200
$other = Call 'GET' "/orders/$($pick.id)" $owner $null
Check 'another user cannot see my order' $other.status 404

# ---- mock payment ----
$pay = Call 'POST' "/orders/$($pick.id)/pay-mock" $cust $null
Check 'mock payment' $pay.status 200
Check 'order is now paid' $pay.json.data.paymentStatus 'PAID'
$pay2 = Call 'POST' "/orders/$($pick.id)/pay-mock" $cust $null
Check 'paying twice is rejected' $pay2.status 409
$cod = Call 'POST' "/orders/$($deliv.id)/pay-mock" $cust $null
Check 'cash-on-delivery order cannot be paid online' $cod.status 400

# ---- empty cart and unavailable item ----
$r = Call 'POST' '/checkout' $cust @{ shops = $choices }
Check 'empty cart cannot check out' $r.status 400

Call 'POST' '/cart/items' $cust @{ listingId = $l2; quantity = 1 } | Out-Null
Call 'PATCH' "/shops/$techId/listings/$l2" $owner @{ availability = 'OUT_OF_STOCK' } | Out-Null
$r = Call 'POST' '/checkout' $cust @{ shops = @($deliveryChoice) }
Check 'an unavailable item blocks checkout' $r.status 409
Call 'PATCH' "/shops/$techId/listings/$l2" $owner @{ availability = 'IN_STOCK' } | Out-Null
Call 'DELETE' '/cart' $cust $null | Out-Null

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
Write-Host 'Run "npx prisma db seed" to reset stock and orders to the demo data.'