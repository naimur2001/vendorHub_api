# test-wishlist.ps1
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

# a second customer (auto-verified test domain)
$email2 = "wl-$([guid]::NewGuid().ToString('N').Substring(0, 8))@vendorshub.test"
$reg = Call 'POST' '/auth/register' $null @{ name = 'Wishlist Two'; email = $email2; password = 'Password123!' }
Need ($reg.status -eq 201) 'registering the second customer'
$cust2 = Login $email2

# a TechZone listing with a known price
$techId = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id
$rows = @((Call 'GET' "/shops/$techId/listings" $owner $null).json.data | Where-Object { $_.isActive -ne $false })
$lid = $rows[0].id
$lid2 = $rows[1].id
$start = 50000
Check 'price prepared' (Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ price = $start }).status 200

function Drops($token) {
    $n = @((Call 'GET' '/notifications?limit=50' $token $null).json.data)
    return @($n | Where-Object { $_.type -eq 'WISHLIST_PRICE_DROP' -and $_.data.listingId -eq $lid }).Count
}

# ---- 1. access ----
Check 'no token -> 401' (Call 'GET' '/wishlist' $null $null).status 401
Check 'shop owner -> 403' (Call 'GET' '/wishlist' $owner $null).status 403
Check 'bad listingId -> 400' (Call 'POST' '/wishlist' $cust @{ listingId = 'nope' }).status 400
Check 'unknown listing -> 404' (Call 'POST' '/wishlist' $cust @{ listingId = [guid]::NewGuid().ToString() }).status 404

# ---- 2. add, duplicate, list, ids ----
Call 'DELETE' "/wishlist/$lid" $cust $null | Out-Null
Call 'DELETE' "/wishlist/$lid2" $cust $null | Out-Null
$r = Call 'POST' '/wishlist' $cust @{ listingId = $lid }
Check 'add -> 201' $r.status 201
Check 'priceAtSave from the server' $r.json.data.priceAtSave $start
Check 'priceDropped false at first' $r.json.data.priceDropped $false
$r = Call 'POST' '/wishlist' $cust @{ listingId = $lid }
Check 'duplicate -> 200' $r.status 200
Check 'add second' (Call 'POST' '/wishlist' $cust @{ listingId = $lid2 }).status 201
$r = Call 'GET' '/wishlist?page=1&limit=10' $cust $null
Check 'list' $r.status 200
Check 'list has 2 items' @($r.json.data.items).Count 2
Check 'pagination total 2' $r.json.data.pagination.total 2
Check 'newest first' $r.json.data.items[0].listingId $lid2
Check 'card has product title' ($null -ne $r.json.data.items[0].product.title) $true
Check 'card has shop slug' $r.json.data.items[0].shop.slug 'techzone-electronics'
$ids = @((Call 'GET' '/wishlist/ids' $cust $null).json.data.listingIds)
Check 'ids has both' (($ids -contains $lid) -and ($ids -contains $lid2)) $true
Check 'bad limit -> 400' (Call 'GET' '/wishlist?limit=500' $cust $null).status 400

# ---- 3. another user cannot see or remove it ----
Check 'second customer list empty' @((Call 'GET' '/wishlist' $cust2 $null).json.data.items).Count 0
Check 'second customer ids empty' @((Call 'GET' '/wishlist/ids' $cust2 $null).json.data.listingIds).Count 0
Check 'second customer delete -> 204' (Call 'DELETE' "/wishlist/$lid2" $cust2 $null).status 204
Check 'item still saved for the owner' (@((Call 'GET' '/wishlist/ids' $cust $null).json.data.listingIds) -contains $lid2) $true

# ---- 4. delete ----
Check 'delete -> 204' (Call 'DELETE' "/wishlist/$lid2" $cust $null).status 204
Check 'delete again -> 204' (Call 'DELETE' "/wishlist/$lid2" $cust $null).status 204
Check 'delete bad id -> 404' (Call 'DELETE' '/wishlist/nope' $cust $null).status 404
Check 'gone from ids' (@((Call 'GET' '/wishlist/ids' $cust $null).json.data.listingIds) -contains $lid2) $false

# ---- 5. hidden listings are left out ----
Check 'add again' (Call 'POST' '/wishlist' $cust @{ listingId = $lid2 }).status 201
Check 'hide listing' (Call 'DELETE' "/shops/$techId/listings/$lid2" $owner $null).status 200
$ids = @((Call 'GET' '/wishlist/ids' $cust $null).json.data.listingIds)
Check 'hidden listing not in ids' ($ids -contains $lid2) $false
Check 'hidden listing not in list' (@((Call 'GET' '/wishlist' $cust $null).json.data.items | Where-Object { $_.listingId -eq $lid2 }).Count) 0
Check 'a hidden listing cannot be saved' (Call 'POST' '/wishlist' $cust2 @{ listingId = $lid2 }).status 404

# ---- 6. price drop ----
Check 'second customer saves it too' (Call 'POST' '/wishlist' $cust2 @{ listingId = $lid }).status 201
$n1 = Drops $cust; $n2 = Drops $cust2
Check 'price goes up' (Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ price = $start + 1000 }).status 200
Check 'a price rise sends nothing' (Drops $cust) $n1
Check 'price drops' (Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ price = $start - 2000 }).status 200
Check 'customer 1 notified once' (Drops $cust) ($n1 + 1)
Check 'customer 2 notified once' (Drops $cust2) ($n2 + 1)
$note = @((Call 'GET' '/notifications?limit=50' $cust $null).json.data | Where-Object { $_.type -eq 'WISHLIST_PRICE_DROP' -and $_.data.listingId -eq $lid })[0]
Check 'title says price dropped' ($note.title -like 'Price dropped on *') $true
Check 'drops again within 24 h' (Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ price = $start - 3000 }).status 200
Check 'no second notification in 24 h' (Drops $cust) ($n1 + 1)
$item = @((Call 'GET' '/wishlist' $cust $null).json.data.items | Where-Object { $_.listingId -eq $lid })[0]
Check 'current price shown' $item.price ($start - 3000)
Check 'priceAtSave kept' $item.priceAtSave $start
Check 'priceDropped true' $item.priceDropped $true

# ---- 7. the limit of 200 ----
node --env-file=.env scripts/fill-wishlist.mjs $email2 200 | Out-Null
$r = Call 'POST' '/wishlist' $cust2 @{ listingId = $lid }
Check '201st item -> 409' $r.status 409
Check 'code WISHLIST_LIMIT' $r.json.error.details.code 'WISHLIST_LIMIT'
Check 'hidden filler not listed' @((Call 'GET' '/wishlist' $cust2 $null).json.data.items).Count 0
node --env-file=.env scripts/fill-wishlist.mjs $email2 199 | Out-Null
Check 'below the limit it works again' (Call 'POST' '/wishlist' $cust2 @{ listingId = $lid }).status 201

# ---- cleanup ----
node --env-file=.env scripts/fill-wishlist.mjs --clean | Out-Null
Call 'POST' "/shops/$techId/listings" $owner @{ productId = $rows[1].product.id; price = $rows[1].price } | Out-Null
Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ price = $rows[0].price } | Out-Null
Call 'DELETE' "/wishlist/$lid" $cust $null | Out-Null

# ---- 8. product cards: bestListingId ----
# which owner token manages which shop
$tokenOf = @{}
foreach ($o in @($owner, (Login 'owner2@vendorshub.test'), (Login 'owner3@vendorshub.test'))) {
    foreach ($sh in @((Call 'GET' '/users/me/shops' $o $null).json.data)) { $tokenOf[$sh.id] = $o }
}
# a product sold by at least two of those shops
$target = $null
foreach ($card in @((Call 'GET' '/products?limit=50' $null $null).json.data | Where-Object { $_.shopCount -ge 2 })) {
    $d = (Call 'GET' "/products/$($card.slug)" $null $null).json.data
    $ls = @(@($d.selectedListing) + @($d.otherListings) | Where-Object { $_ -and $tokenOf.ContainsKey($_.shop.id) })
    if ($ls.Count -ge 2) { $target = @{ card = $card; listings = $ls }; break }
}
Need $target 'finding a product with two or more shops'
$prodId = $target.card.id
$ls = $target.listings
$orig = @($ls | ForEach-Object { @{ id = $_.id; shop = $_.shop.id; price = $_.price; availability = $_.availability } })
function SetL($l, $price, $avail) { return (Call 'PATCH' "/shops/$($l.shop.id)/listings/$($l.id)" $tokenOf[$l.shop.id] @{ price = $price; availability = $avail }).status }
function Best { return @((Call 'GET' "/products?q=$([uri]::EscapeDataString($target.card.title))&limit=50" $null $null).json.data | Where-Object { $_.id -eq $prodId })[0].bestListingId }

Check 'cards carry bestListingId' (@((Call 'GET' '/products?limit=1' $null $null).json.data)[0].PSObject.Properties.Name -contains 'bestListingId') $true
# cheapest is OUT of stock, the next one IN stock, the rest dearer and in stock
SetL $ls[0] 1000 'OUT_OF_STOCK' | Out-Null
SetL $ls[1] 2000 'IN_STOCK' | Out-Null
for ($i = 2; $i -lt $ls.Count; $i++) { SetL $ls[$i] (3000 + $i) 'IN_STOCK' | Out-Null }
Check 'bestListingId = cheapest IN_STOCK' (Best) $ls[1].id
Check 'lowestPrice is still the overall lowest' (@((Call 'GET' "/products?q=$([uri]::EscapeDataString($target.card.title))&limit=50" $null $null).json.data | Where-Object { $_.id -eq $prodId })[0].lowestPrice) 1000
# none in stock: the cheapest overall
for ($i = 1; $i -lt $ls.Count; $i++) { SetL $ls[$i] (2000 + $i) 'OUT_OF_STOCK' | Out-Null }
Check 'none in stock -> cheapest' (Best) $ls[0].id
# in stock but LIMITED/AVAILABLE do not count as IN_STOCK
SetL $ls[1] 2001 'LIMITED' | Out-Null
Check 'LIMITED is not IN_STOCK -> still cheapest' (Best) $ls[0].id
SetL $ls[1] 2001 'IN_STOCK' | Out-Null
Check 'back in stock -> that one' (Best) $ls[1].id

# ---- 9. productIds and delete by product ----
Check 'guest ids -> 401' (Call 'GET' '/wishlist/ids' $null $null).status 401
Check 'guest delete by product -> 401' (Call 'DELETE' "/wishlist/product/$prodId" $null $null).status 401
Check 'shop owner delete by product -> 403' (Call 'DELETE' "/wishlist/product/$prodId" $owner $null).status 403
Check 'invalid product uuid -> 400' (Call 'DELETE' '/wishlist/product/not-a-uuid' $cust $null).status 400
Call 'DELETE' "/wishlist/product/$prodId" $cust $null | Out-Null
Call 'DELETE' "/wishlist/product/$prodId" $cust2 $null | Out-Null

Check 'save one listing' (Call 'POST' '/wishlist' $cust @{ listingId = $ls[0].id }).status 201
$w = (Call 'GET' '/wishlist/ids' $cust $null).json.data
Check 'productIds includes the product' (@($w.productIds) -contains $prodId) $true
Check 'listingIds still returned' (@($w.listingIds) -contains $ls[0].id) $true
Check 'remove the listing' (Call 'DELETE' "/wishlist/$($ls[0].id)" $cust $null).status 204
Check 'productIds drops the product' (@((Call 'GET' '/wishlist/ids' $cust $null).json.data.productIds) -contains $prodId) $false

Call 'POST' '/wishlist' $cust @{ listingId = $ls[0].id } | Out-Null
Call 'POST' '/wishlist' $cust @{ listingId = $ls[1].id } | Out-Null
Check 'second customer saves it too' (Call 'POST' '/wishlist' $cust2 @{ listingId = $ls[0].id }).status 201
$w = (Call 'GET' '/wishlist/ids' $cust $null).json.data
Check 'two listings, one productId' @($w.productIds | Where-Object { $_ -eq $prodId }).Count 1
Check 'delete by product -> 204' (Call 'DELETE' "/wishlist/product/$prodId" $cust $null).status 204
$w = (Call 'GET' '/wishlist/ids' $cust $null).json.data
Check 'both listings gone for this user' (@($w.listingIds | Where-Object { $_ -eq $ls[0].id -or $_ -eq $ls[1].id }).Count) 0
Check 'productId gone for this user' (@($w.productIds) -contains $prodId) $false
Check 'other customer keeps theirs' (@((Call 'GET' '/wishlist/ids' $cust2 $null).json.data.listingIds) -contains $ls[0].id) $true
Check 'delete by product again -> 204' (Call 'DELETE' "/wishlist/product/$prodId" $cust $null).status 204
Check 'unknown product -> 204' (Call 'DELETE' "/wishlist/product/$([guid]::NewGuid())" $cust $null).status 204

# ---- cleanup 2: put the listings back ----
Call 'DELETE' "/wishlist/product/$prodId" $cust2 $null | Out-Null
foreach ($o in $orig) {
    Call 'PATCH' "/shops/$($o.shop)/listings/$($o.id)" $tokenOf[$o.shop] @{ price = $o.price; availability = $o.availability } | Out-Null
}

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
if ($script:fail -gt 0) { exit 1 }
