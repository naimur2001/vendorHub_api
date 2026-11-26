# test-listing-options.ps1: product variations (size / colour) on listings, cart, checkout and orders
# Run from the project root while "npm run dev" is running in another terminal.
$base = 'http://localhost:4000/api/v1'
$script:pass = 0
$script:fail = 0

function Call($method, $path, $token, $body) {
    $params = @{ Method = $method; Uri = "$base$path"; UseBasicParsing = $true }
    if ($token) { $params.Headers = @{ Authorization = "Bearer $token" } }
    if ($null -ne $body) {
        $params.ContentType = 'application/json'
        $params.Body = ($body | ConvertTo-Json -Compress -Depth 10)
    }
    try {
        $r = Invoke-WebRequest @params
        return @{ status = [int]$r.StatusCode; json = ($r.Content | ConvertFrom-Json) }
    } catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { return @{ status = 0; json = $null } }
        $text = $_.ErrorDetails.Message  # PowerShell 5.1 has already read the response stream
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
Call 'DELETE' '/cart' $cust $null | Out-Null

$shopId = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id
$listing = @((Call 'GET' "/shops/$shopId/listings" $owner $null).json.data | Where-Object { $_.isActive -and $_.availability -ne 'OUT_OF_STOCK' -and -not $_.bargainEnabled }) | Select-Object -First 1
$lid = $listing.id
$slug = $listing.product.slug
Write-Host "Listing $lid ($slug)"

$size = @{ name = 'Size'; values = @(@{ value = 'S' }, @{ value = 'M' }, @{ value = 'L'; inStock = $false }) }
$colour = @{ name = 'Colour'; values = @(@{ value = 'Black' }, @{ value = 'White' }) }

# 1. Owner saves variations; bad ones are refused
$r = Call 'PATCH' "/shops/$shopId/listings/$lid" $owner @{ options = @($size, $colour) }
Check 'owner saves Size + Colour' $r.status 200
Check 'two groups stored' @($r.json.data.options).Count 2
Check 'L stored as sold out' (@($r.json.data.options[0].values) | Where-Object { $_.value -eq 'L' }).inStock $false
$r = Call 'PATCH' "/shops/$shopId/listings/$lid" $owner @{ options = @(@{ name = 'Size'; values = @(@{ value = 'M' }, @{ value = 'm' }) }) }
Check 'duplicate value refused' $r.status 400
$r = Call 'PATCH' "/shops/$shopId/listings/$lid" $owner @{ options = @(@{ name = 'Size'; values = @(@{ value = 'M=L' }) }) }
Check 'value with = refused' $r.status 400
$four = @(1..4 | ForEach-Object { @{ name = "G$_"; values = @(@{ value = 'x' }) } })
$r = Call 'PATCH' "/shops/$shopId/listings/$lid" $owner @{ options = $four }
Check 'more than 3 groups refused' $r.status 400
$r = Call 'PATCH' "/shops/$shopId/listings/$lid" $null @{ options = @($size) }
Check 'no token cannot change variations' $r.status 401

# 2. Product page shows them
$r = Call 'GET' "/products/$($slug)?listingId=$lid" $null $null
Check 'product page lists the groups' @($r.json.data.selectedListing.options).Count 2

# 3. Cart: a choice is required and checked
$r = Call 'POST' '/cart/items' $cust @{ listingId = $lid; quantity = 1 }
Check 'no choice -> 422' $r.status 422
Check 'code OPTIONS_REQUIRED' $r.json.error.details.code 'OPTIONS_REQUIRED'
$r = Call 'POST' '/cart/items' $cust @{ listingId = $lid; quantity = 1; options = @{ Size = 'L'; Colour = 'Black' } }
Check 'sold-out value -> OPTION_OUT_OF_STOCK' $r.json.error.details.code 'OPTION_OUT_OF_STOCK'
$r = Call 'POST' '/cart/items' $cust @{ listingId = $lid; quantity = 1; options = @{ Size = 'XXL'; Colour = 'Black' } }
Check 'unknown value -> OPTION_INVALID' $r.json.error.details.code 'OPTION_INVALID'
$r = Call 'POST' '/cart/items' $cust @{ listingId = $lid; quantity = 1; options = @{ Size = 'M'; Colour = 'Black'; Fit = 'Slim' } }
Check 'extra group -> OPTION_INVALID' $r.json.error.details.code 'OPTION_INVALID'

$r = Call 'POST' '/cart/items' $cust @{ listingId = $lid; quantity = 1; options = @{ Size = 'M'; Colour = 'Black' } }
Check 'M + Black added' $r.status 200
$r = Call 'POST' '/cart/items' $cust @{ listingId = $lid; quantity = 1; options = @{ size = 'm'; colour = 'black' } }
$r = Call 'POST' '/cart/items' $cust @{ listingId = $lid; quantity = 1; options = @{ Size = 'S'; Colour = 'White' } }
$lines = @($r.json.data.shops | ForEach-Object { $_.items } | Where-Object { $_.listingId -eq $lid })
Check 'two cart lines (one per choice)' $lines.Count 2
$m = $lines | Where-Object { $_.options.Size -eq 'M' }
Check 'same choice (any case) adds up' $m.quantity 2
Check 'stored with the shop spelling' $m.options.Colour 'Black'

# 4. The shop sells out M: that line gets a problem, then comes back
Call 'PATCH' "/shops/$shopId/listings/$lid" $owner @{ options = @(@{ name = 'Size'; values = @(@{ value = 'S' }, @{ value = 'M'; inStock = $false }) }, $colour) } | Out-Null
$r = Call 'GET' '/cart' $cust $null
$m = @($r.json.data.shops | ForEach-Object { $_.items } | Where-Object { $_.listingId -eq $lid -and $_.options.Size -eq 'M' })[0]
Check 'sold-out choice -> OPTION_UNAVAILABLE' $m.problem 'OPTION_UNAVAILABLE'
Check 'cart not ready' $r.json.data.totals.checkoutReady $false
Call 'PATCH' "/shops/$shopId/listings/$lid" $owner @{ options = @($size, $colour) } | Out-Null

# 5. Checkout keeps the choice on the order (customer and shop views), then the order is cancelled
$r = Call 'POST' '/checkout' $cust @{ shops = @(@{ shopId = $shopId; deliveryMethod = 'RESERVE_PICKUP'; paymentMethod = 'PAY_AT_STORE' }) }
Check 'checkout' $r.status 201
$orderId = $r.json.data.orders[0].id
$r = Call 'GET' "/orders/$orderId" $cust $null
$item = @($r.json.data.items | Where-Object { $_.options.Size -eq 'M' })[0]
Check 'customer order shows Size M' $item.options.Size 'M'
Check 'customer order shows Colour Black' $item.options.Colour 'Black'
$r = Call 'GET' "/shops/$shopId/orders/$orderId" $owner $null
Check 'shop order shows the choice' (@($r.json.data.items | Where-Object { $_.options.Size -eq 'S' })[0]).options.Colour 'White'
$r = Call 'POST' "/orders/$orderId/cancel" $cust @{ reason = 'Listing options test' }
Check 'test order cancelled' $r.status 200

# 6. Without variations the old behaviour stays
Call 'PATCH' "/shops/$shopId/listings/$lid" $owner @{ options = $null } | Out-Null
$r = Call 'POST' '/cart/items' $cust @{ listingId = $lid; quantity = 1 }
Check 'no variations: added without a choice' $r.status 200
$r = Call 'POST' '/cart/items' $cust @{ listingId = $lid; quantity = 1; options = @{ Size = 'M' } }
Check 'no variations: a choice is refused' $r.status 422
$r = Call 'GET' "/products/$($slug)?listingId=$lid" $null $null
Check 'product page: no groups' @($r.json.data.selectedListing.options).Count 0

# clean up
Call 'DELETE' '/cart' $cust $null | Out-Null
Call 'PATCH' "/shops/$shopId/listings/$lid" $owner @{ availability = $listing.availability; stockQty = $listing.stockQty } | Out-Null

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
if ($script:fail -gt 0) { exit 1 }
