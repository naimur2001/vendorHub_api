# test-split-orders.ps1
# Proves that a multi-shop checkout is split into one order per shop, and that each shop
# receives only its own order. Run while "npm run dev" is running in another terminal.
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
$ownerA = Login 'owner1@vendorshub.test'   # TechZone

# ---- setup: the same product from two different shops ----
$owners = @{ 'techzone-electronics' = 'owner1@vendorshub.test'; 'dhaka-mobile-house' = 'owner2@vendorshub.test'; 'gadget-galaxy' = 'owner3@vendorshub.test' }
$p = Call 'GET' '/products/galaxy-a55-5g-8-128gb' $null $null
$all = @($p.json.data.selectedListing) + @($p.json.data.otherListings)
$listA = @($all | Where-Object { $_.shop.slug -eq 'techzone-electronics' })[0]
$listB = @($all | Where-Object { $_.shop.slug -ne 'techzone-electronics' -and $owners.ContainsKey($_.shop.slug) })[0]
Need $listA 'finding the TechZone listing'
Need $listB 'finding a listing from a second shop'
$shopA = $listA.shop.id
$shopB = $listB.shop.id
$ownerB = Login $owners[$listB.shop.slug]
Write-Host "INFO  shop A = techzone-electronics, shop B = $($listB.shop.slug)"

$prepA = Call 'PATCH' "/shops/$shopA/listings/$($listA.id)" $ownerA @{ availability = 'IN_STOCK'; stockQty = 20 }
$prepB = Call 'PATCH' "/shops/$shopB/listings/$($listB.id)" $ownerB @{ availability = 'IN_STOCK'; stockQty = 20 }
Need ($prepA.status -eq 200 -and $prepB.status -eq 200) 'preparing both listings'

function ToConfirm($token, $shopId) {
    return (Call 'GET' "/dashboard/shop/$shopId" $token $null).json.data.actions.ordersToConfirm
}
$beforeA = ToConfirm $ownerA $shopA
$beforeB = ToConfirm $ownerB $shopB

# ---- 1. one cart, two shops, one checkout ----
Call 'DELETE' '/cart' $cust $null | Out-Null
Call 'POST' '/cart/items' $cust @{ listingId = $listA.id; quantity = 1 } | Out-Null
Call 'POST' '/cart/items' $cust @{ listingId = $listB.id; quantity = 1 } | Out-Null
$cart = Call 'GET' '/cart' $cust $null
Check 'the cart holds items from two shops' $cart.json.data.totals.shopCount 2

$choices = @(
    @{ shopId = $shopA; deliveryMethod = 'STORE_PICKUP'; paymentMethod = 'PAY_AT_STORE' },
    @{ shopId = $shopB; deliveryMethod = 'STORE_PICKUP'; paymentMethod = 'PAY_AT_STORE' }
)
$r = Call 'POST' '/checkout' $cust @{ shops = $choices }
Check 'one checkout succeeds' $r.status 201
$orders = @($r.json.data.orders)
Check 'it is split into two orders' $orders.Count 2
Need ($orders.Count -eq 2) 'the split checkout'
# $checkoutId = $r.json.data.id
$checkoutId = $r.json.data.checkoutId

# find which order went to which shop (by asking each shop)
$listForA = @((Call 'GET' "/shops/$shopA/orders?limit=50" $ownerA $null).json.data)
$listForB = @((Call 'GET' "/shops/$shopB/orders?limit=50" $ownerB $null).json.data)
$orderA = @($orders | Where-Object { $id = $_.id; @($listForA | Where-Object { $_.id -eq $id }).Count -eq 1 })[0]
$orderB = @($orders | Where-Object { $id = $_.id; @($listForB | Where-Object { $_.id -eq $id }).Count -eq 1 })[0]
Need ($orderA -and $orderB) 'finding each shop''s order'
Check 'each shop got a different order' ($orderA.id -ne $orderB.id) $true

# ---- 2. each shop receives only its own order ----
Check 'shop A does not see shop B''s order' @($listForA | Where-Object { $_.id -eq $orderB.id }).Count 0
Check 'shop B does not see shop A''s order' @($listForB | Where-Object { $_.id -eq $orderA.id }).Count 0
$r = Call 'GET' "/shops/$shopA/orders/$($orderB.id)" $ownerA $null
Check 'shop A cannot open shop B''s order' $r.status 404
$r = Call 'GET' "/shops/$shopB/orders/$($orderA.id)" $ownerB $null
Check 'shop B cannot open shop A''s order' $r.status 404
$rowA = @($listForA | Where-Object { $_.id -eq $orderA.id })[0]
Check 'shop A''s order holds only shop A''s item' @($rowA.items).Count 1
Check 'shop A sees the customer name' $rowA.customer.name 'Test Customer'
Check 'shop A has one more order to confirm' (ToConfirm $ownerA $shopA) ($beforeA + 1)
Check 'shop B has one more order to confirm' (ToConfirm $ownerB $shopB) ($beforeB + 1)

# ---- 3. each shop works on its own order independently ----
$r = Call 'POST' "/shops/$shopA/orders/$($orderA.id)/status" $ownerA @{ status = 'CONFIRMED' }
Check 'shop A confirms its order' $r.status 200
$r = Call 'POST' "/shops/$shopB/orders/$($orderA.id)/status" $ownerB @{ status = 'CANCELLED'; reason = 'Not my order' }
Check 'shop B cannot change shop A''s order' $r.status 404
$b = Call 'GET' "/orders/$($orderB.id)" $cust $null
Check 'shop B''s order is still PLACED' $b.json.data.status 'PLACED'

# ---- 4. the customer still sees one checkout ----
$s = Call 'GET' "/checkouts/$checkoutId" $cust $null
Check 'the checkout shows both orders' @($s.json.data.orders).Count 2

# ---- cleanup: cancel both, which puts the stock back ----
Call 'POST' "/shops/$shopA/orders/$($orderA.id)/status" $ownerA @{ status = 'CANCELLED'; reason = 'Test cleanup' } | Out-Null
Call 'POST' "/shops/$shopB/orders/$($orderB.id)/status" $ownerB @{ status = 'CANCELLED'; reason = 'Test cleanup' } | Out-Null

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"