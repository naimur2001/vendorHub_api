# test-cart.ps1
# Run from the project root while "npm run dev" is running in another terminal.
$base = 'http://localhost:4000/api/v1'
$script:pass = 0
$script:fail = 0

function Call($method, $path, $token, $body) {
    $params = @{ Method = $method; Uri = "$base$path"; UseBasicParsing = $true }
    if ($token) { $params.Headers = @{ Authorization = "Bearer $token" } }
    if ($null -ne $body) {
        $params.ContentType = 'application/json'
        $params.Body = ($body | ConvertTo-Json -Compress)
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

# 0. is the server up?
try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}

$cust = Login 'customer@vendorshub.test'
$owner = Login 'owner1@vendorshub.test'
Write-Host "Logged in (token lengths: $($cust.Length), $($owner.Length))"

# start from an empty cart
Call 'DELETE' '/cart' $cust $null | Out-Null

$p = Call 'GET' '/products/galaxy-a55-5g-8-128gb' $null $null
$l1 = $p.json.data.selectedListing.id
$l2 = $p.json.data.otherListings[0].id
Check 'product has two listings from different shops' ($l1 -ne $l2) $true

# add from two shops
$r = Call 'POST' '/cart/items' $cust @{ listingId = $l1; quantity = 1 }
Check 'add from shop 1' $r.status 200
Check 'cart has 1 shop' $r.json.data.totals.shopCount 1

$r = Call 'POST' '/cart/items' $cust @{ listingId = $l2; quantity = 2 }
Check 'add from shop 2' $r.status 200
Check 'cart has 2 shops' $r.json.data.totals.shopCount 2
Check 'item count is 3' $r.json.data.totals.itemCount 3
Check 'checkoutReady is true' $r.json.data.totals.checkoutReady $true

# same listing again -> quantity goes up
$r = Call 'POST' '/cart/items' $cust @{ listingId = $l1; quantity = 1 }
Check 'same listing again increases quantity (count 4)' $r.json.data.totals.itemCount 4

# change quantity
$itemId = $r.json.data.shops[0].items[0].id
$r = Call 'PATCH' "/cart/items/$itemId" $cust @{ quantity = 1 }
Check 'change quantity' $r.status 200
Check 'item count is 3 again' $r.json.data.totals.itemCount 3

# error cases
$r = Call 'POST' '/cart/items' $cust @{ listingId = $l1; quantity = 11 }
Check '11 of one item is rejected' $r.status 400
$r = Call 'POST' '/cart/items' $cust @{ listingId = '00000000-0000-4000-8000-000000000000'; quantity = 1 }
Check 'unknown listing' $r.status 404
$r = Call 'GET' '/cart' $null $null
Check 'cart without token' $r.status 401
$r = Call 'PATCH' "/cart/items/$itemId" $owner @{ quantity = 2 }
Check 'someone else cannot touch my cart item' $r.status 404

# remove one item
$r = Call 'DELETE' "/cart/items/$itemId" $cust $null
Check 'remove item' $r.status 200
Check 'one shop left' $r.json.data.totals.shopCount 1

# out-of-stock rule (restores the listing afterwards)
$shop = Call 'GET' '/shops/techzone-electronics' $null $null
$shopId = $shop.json.data.id
$mine = (Call 'GET' "/shops/$shopId/listings" $owner $null).json.data | Where-Object { $_.isActive } | Select-Object -First 1
Call 'PATCH' "/shops/$shopId/listings/$($mine.id)" $owner @{ availability = 'OUT_OF_STOCK' } | Out-Null
$r = Call 'POST' '/cart/items' $cust @{ listingId = $mine.id; quantity = 1 }
Check 'out-of-stock listing cannot be added' $r.status 409
Call 'PATCH' "/shops/$shopId/listings/$($mine.id)" $owner @{ availability = $mine.availability; stockQty = $mine.stockQty } | Out-Null

# clear
$r = Call 'DELETE' '/cart' $cust $null
Check 'clear cart' $r.status 200
Check 'cart is empty' $r.json.data.totals.shopCount 0

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"