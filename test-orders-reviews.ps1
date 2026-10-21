# test-orders-reviews.ps1
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

# ---- setup: the TechZone A55 listing with plenty of stock ----
$techId = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id
$p = Call 'GET' '/products/galaxy-a55-5g-8-128gb' $null $null
$productId = $p.json.data.product.id
$all = @($p.json.data.selectedListing) + @($p.json.data.otherListings)
$lid = (@($all | Where-Object { $_.shop.id -eq $techId }))[0].id
$prep = Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ availability = 'IN_STOCK'; stockQty = 50 }
Check 'listing prepared' $prep.status 200

function Stock {
    $rows = @((Call 'GET' "/shops/$techId/listings" $owner $null).json.data)
    return @($rows | Where-Object { $_.id -eq $lid })[0].stockQty
}

function NewOrder($kind) {
    Call 'DELETE' '/cart' $cust $null | Out-Null
    $add = Call 'POST' '/cart/items' $cust @{ listingId = $lid; quantity = 1 }
    Need ($add.status -eq 200) 'adding the item to the cart'
    if ($kind -eq 'pickup-online') {
        $choice = @{ shopId = $techId; deliveryMethod = 'STORE_PICKUP'; paymentMethod = 'ONLINE' }
    } else {
        $choice = @{ shopId = $techId; deliveryMethod = 'VENDOR_DELIVERY'; paymentMethod = 'CASH_ON_DELIVERY'; deliveryAddress = 'House 12, Road 5, Dhanmondi, Dhaka' }
    }
    $r = Call 'POST' '/checkout' $cust @{ shops = @($choice) }
    Need ($r.status -eq 201) 'the checkout'
    return $r.json.data.orders[0]
}

function SetStatus($orderId, $status, $reason) {
    $body = @{ status = $status }
    if ($reason) { $body.reason = $reason }
    return Call 'POST' "/shops/$techId/orders/$orderId/status" $owner $body
}

# ---- 1. two orders and the seller's view ----
$s0 = Stock
$o1 = NewOrder 'pickup-online'
Check 'order 1 placed' ($null -ne $o1.id) $true
Check 'stock went down by 1' (Stock) ($s0 - 1)
$o2 = NewOrder 'delivery-cod'
Check 'order 2 placed' ($null -ne $o2.id) $true

$r = Call 'GET' "/shops/$techId/orders?limit=50" $owner $null
Check 'seller list works' $r.status 200
Check 'seller sees both orders' @($r.json.data | Where-Object { $_.id -eq $o1.id -or $_.id -eq $o2.id }).Count 2
$row1 = @($r.json.data | Where-Object { $_.id -eq $o1.id })[0]
Check 'seller sees the customer name' $row1.customer.name 'Test Customer'
Check 'unpaid online order cannot be confirmed yet' @($row1.nextStatuses | Where-Object { $_ -eq 'CONFIRMED' }).Count 0
$r = Call 'GET' "/shops/$techId/orders" $cust $null
Check 'a customer cannot open the seller list' $r.status 403
$r = Call 'GET' "/shops/$techId/orders" $owner3 $null
Check 'another shop owner cannot open it' $r.status 403
$r = Call 'GET' "/shops/$techId/orders/$($o1.id)" $owner $null
Check 'seller order detail' $r.status 200

# ---- 2. pickup + online path ----
$r = SetStatus $o1.id 'CONFIRMED' $null
Check 'an unpaid online order cannot be confirmed' $r.status 409
Call 'POST' "/orders/$($o1.id)/pay-mock" $cust $null | Out-Null
$r = SetStatus $o1.id 'CONFIRMED' $null
Check 'a paid online order can be confirmed' $r.status 200
Check 'status is CONFIRMED' $r.json.data.status 'CONFIRMED'
$r = SetStatus $o1.id 'COMPLETED' $null
Check 'steps cannot be skipped' $r.status 409
$r = SetStatus $o1.id 'OUT_FOR_DELIVERY' $null
Check 'a pickup order cannot go out for delivery' $r.status 409
$r = SetStatus $o1.id 'READY_FOR_PICKUP' $null
Check 'pickup order is ready' $r.status 200
$r = SetStatus $o1.id 'COMPLETED' $null
Check 'pickup order is completed' $r.status 200
Check 'status is COMPLETED' $r.json.data.status 'COMPLETED'
$r = SetStatus $o1.id 'CANCELLED' 'too late'
Check 'a finished order cannot be cancelled' $r.status 409

# ---- 3. delivery + cash path ----
$r = SetStatus $o2.id 'CONFIRMED' $null
Check 'cash order can be confirmed without payment' $r.status 200
$r = SetStatus $o2.id 'READY_FOR_PICKUP' $null
Check 'a delivery order cannot be ready for pickup' $r.status 409
$r = SetStatus $o2.id 'OUT_FOR_DELIVERY' $null
Check 'delivery order is out for delivery' $r.status 200
$r = SetStatus $o2.id 'COMPLETED' $null
Check 'delivery order is completed' $r.status 200
$mine = Call 'GET' "/orders/$($o2.id)" $cust $null
Check 'cash on delivery is marked paid when completed' $mine.json.data.paymentStatus 'PAID'

# ---- 4. cancellation ----
$s1 = Stock
$o3 = NewOrder 'delivery-cod'
Check 'stock decreased for order 3' (Stock) ($s1 - 1)
$r = Call 'POST' "/orders/$($o3.id)/cancel" $cust @{ reason = 'Changed my mind' }
Check 'customer cancels a placed order' $r.status 200
Check 'order is CANCELLED' $r.json.data.status 'CANCELLED'
Check 'stock is restored' (Stock) $s1
$r = Call 'POST' "/orders/$($o3.id)/cancel" $cust @{}
Check 'cancelling twice is rejected' $r.status 409

$o4 = NewOrder 'delivery-cod'
SetStatus $o4.id 'CONFIRMED' $null | Out-Null
$r = Call 'POST' "/orders/$($o4.id)/cancel" $cust @{}
Check 'the customer cannot cancel after confirmation' $r.status 409
$r = Call 'POST' "/orders/$($o4.id)/cancel" $owner3 @{}
Check 'someone else cannot cancel my order' $r.status 404

$o5 = NewOrder 'pickup-online'
Call 'POST' "/orders/$($o5.id)/pay-mock" $cust $null | Out-Null
$r = SetStatus $o5.id 'CANCELLED' $null
Check 'a shop cancel needs a reason' $r.status 400
$r = SetStatus $o5.id 'CANCELLED' 'Out of stock at the shop'
Check 'shop cancels with a reason' $r.status 200
$mine = Call 'GET' "/orders/$($o5.id)" $cust $null
Check 'a paid online order is refunded' $mine.json.data.paymentStatus 'REFUNDED'
$r = SetStatus $o5.id 'CONFIRMED' $null
Check 'a cancelled order cannot be reopened' $r.status 409

$a = Call 'GET' "/admin/audit-logs?entityType=SubOrder&entityId=$($o1.id)" $admin $null
Check 'order history is audited' (@($a.json.data).Count -ge 3) $true

# ---- 5. reviews ----
# remove the seeded reviews of the test customer first (this also tests deleting your own review)
$rv = Call 'GET' '/shops/techzone-electronics/reviews?limit=50' $null $null
foreach ($x in @($rv.json.data | Where-Object { $_.reviewer -eq 'Test Customer' })) {
    Call 'DELETE' "/reviews/$($x.id)" $cust $null | Out-Null
}
$st0 = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.stats.reviewCount

$r = Call 'POST' '/reviews' $cust @{ orderId = $o4.id; type = 'SHOP_TRUST'; rating = 5 }
Check 'an unfinished order cannot be reviewed' $r.status 409
$r = Call 'POST' '/reviews' $cust @{ orderId = $o1.id; type = 'SHOP_TRUST'; rating = 6 }
Check 'rating 6 is rejected' $r.status 400
$r = Call 'POST' '/reviews' $cust @{ orderId = $o1.id; type = 'PRODUCT'; rating = 5 }
Check 'a product review needs a product' $r.status 400
$r = Call 'POST' '/reviews' $cust @{ orderId = $o1.id; type = 'SHOP_TRUST'; productId = $productId; rating = 5 }
Check 'a shop review must not carry a product' $r.status 400
$r = Call 'POST' '/reviews' $owner3 @{ orderId = $o1.id; type = 'SHOP_TRUST'; rating = 5 }
Check 'someone else cannot review my order' $r.status 404
$list = Call 'GET' '/products?limit=5' $null $null
$otherProduct = @($list.json.data | Where-Object { $_.id -ne $productId })[0].id
$r = Call 'POST' '/reviews' $cust @{ orderId = $o1.id; type = 'PRODUCT'; productId = $otherProduct; rating = 5 }
Check 'a product that is not in the order is rejected' $r.status 400

$r = Call 'POST' '/reviews' $cust @{ orderId = $o1.id; type = 'SHOP_TRUST'; rating = 5; comment = 'Fast and honest.' }
Check 'shop review is created' $r.status 201
$rid1 = $r.json.data.id
Need $rid1 'the shop review'
$r = Call 'POST' '/reviews' $cust @{ orderId = $o1.id; type = 'SHOP_TRUST'; rating = 4 }
Check 'a second shop review is rejected' $r.status 409
$r = Call 'POST' '/reviews' $cust @{ orderId = $o1.id; type = 'PRODUCT'; productId = $productId; rating = 4; comment = 'Good phone.' }
Check 'product review is created' $r.status 201
$rid2 = $r.json.data.id
Need $rid2 'the product review'

$st1 = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.stats.reviewCount
Check 'the shop review count went up by one' $st1 ($st0 + 1)
$pr = Call 'GET' '/products/galaxy-a55-5g-8-128gb/reviews' $null $null
Check 'public product reviews' $pr.status 200
Check 'the new product review is listed' @($pr.json.data | Where-Object { $_.id -eq $rid2 }).Count 1
Check 'the summary has a count' ($pr.json.meta.summary.count -ge 1) $true

# ---- 6. edit and delete ----
$r = Call 'PATCH' "/reviews/$rid2" $cust @{ rating = 3 }
Check 'the author edits the review' $r.status 200
Check 'the rating changed' $r.json.data.rating 3
$r = Call 'PATCH' "/reviews/$rid2" $owner3 @{ rating = 1 }
Check 'someone else cannot edit it' $r.status 404
$r = Call 'DELETE' "/reviews/$rid2" $owner3 $null
Check 'someone else cannot delete it' $r.status 404
$r = Call 'DELETE' "/reviews/$rid2" $admin $null
Check 'an admin can delete it' $r.status 200
$r = Call 'DELETE' "/reviews/$rid1" $cust $null
Check 'the author can delete their review' $r.status 200

# ---- cleanup: put the stock of the confirmed order back ----
SetStatus $o4.id 'CANCELLED' 'Test cleanup' | Out-Null
Call 'DELETE' '/cart' $cust $null | Out-Null

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
Write-Host 'Run "npx prisma db seed" to reset the demo data.'
