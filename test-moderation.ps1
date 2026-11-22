# test-moderation.ps1
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
$email2 = "mod-$([guid]::NewGuid().ToString('N').Substring(0, 8))@vendorshub.test"
Need ((Call 'POST' '/auth/register' $null @{ name = 'Mod Two'; email = $email2; password = 'Password123!' }).status -eq 201) 'registering a second customer'
$cust2 = Login $email2
$stamp = Get-Date -Format 'yyyyMMddHHmmss'

$techId = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id
$mine = @((Call 'GET' "/shops/$techId/listings" $owner $null).json.data | Where-Object { $_.isActive -ne $false })
$lid = $mine[0].id
Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ availability = 'IN_STOCK'; stockQty = 50 } | Out-Null
$products = @((Call 'GET' '/products?limit=50' $null $null).json.data)

# ---- 1. featured ----
$made = @()
Check 'customer -> 403' (Call 'POST' '/admin/featured' $cust @{ kind = 'PRODUCT'; targetId = $products[0].id }).status 403
Check 'shop owner -> 403' (Call 'GET' '/admin/featured' $owner $null).status 403
# start empty for this test
foreach ($s in @((Call 'GET' '/admin/featured' $admin $null).json.data)) { Call 'DELETE' "/admin/featured/$($s.id)" $admin $null | Out-Null }
$r = Call 'POST' '/admin/featured' $admin @{ kind = 'PRODUCT'; targetId = $products[0].id }
Check 'feature a product -> 201' $r.status 201
$fp1 = $r.json.data
Check 'duplicate -> 409' (Call 'POST' '/admin/featured' $admin @{ kind = 'PRODUCT'; targetId = $products[0].id }).json.error.details.code 'FEATURED_DUPLICATE'
Check 'unknown product -> 404' (Call 'POST' '/admin/featured' $admin @{ kind = 'PRODUCT'; targetId = [guid]::NewGuid().ToString() }).status 404
Check 'a shop id as a PRODUCT -> 404' (Call 'POST' '/admin/featured' $admin @{ kind = 'PRODUCT'; targetId = $techId }).status 404
$fs = (Call 'POST' '/admin/featured' $admin @{ kind = 'SHOP'; targetId = $techId }).json.data
Check 'feature a shop' ($null -ne $fs.id) $true
$r = Call 'POST' '/admin/featured' $admin @{ kind = 'PRODUCT'; targetId = $products[1].id; startsAt = [DateTime]::UtcNow.AddDays(1).ToString('o') }
$future = $r.json.data
Check 'scheduled slot not live' $future.liveNow $false
$pub = @((Call 'GET' '/featured?kind=PRODUCT' $null $null).json.data)
Check 'public PRODUCT list: only the live one' (($pub | ForEach-Object { $_.product.id }) -join ',') $products[0].id
Check 'featured product has a price' ($pub[0].product.lowestPrice -gt 0) $true
Check 'public SHOP list' (@((Call 'GET' '/featured?kind=SHOP' $null $null).json.data)[0].shop.slug) 'techzone-electronics'
Check 'kind is required -> 400' (Call 'GET' '/featured' $null $null).status 400
Check 'mixed reorder -> 400' (Call 'PATCH' '/admin/featured/reorder' $admin @{ ids = @($fp1.id, $fs.id) }).status 400
$r = Call 'PATCH' '/admin/featured/reorder' $admin @{ ids = @($future.id, $fp1.id) }
Check 'reorder one kind' (($r.json.data | ForEach-Object { $_.id }) -join ',') "$($future.id),$($fp1.id)"
Check 'make the scheduled one live' (Call 'PATCH' "/admin/featured/$($future.id)" $admin @{ startsAt = $null }).json.data.liveNow $true
Check 'public order follows sortOrder' ((@((Call 'GET' '/featured?kind=PRODUCT' $null $null).json.data) | ForEach-Object { $_.product.id }) -join ',') "$($products[1].id),$($products[0].id)"
for ($i = 2; $i -lt 12; $i++) { Call 'POST' '/admin/featured' $admin @{ kind = 'PRODUCT'; targetId = $products[$i].id } | Out-Null }
Check '12 products featured' @((Call 'GET' '/admin/featured?kind=PRODUCT' $admin $null).json.data).Count 12
Check 'the 13th -> 409 FEATURED_LIMIT' (Call 'POST' '/admin/featured' $admin @{ kind = 'PRODUCT'; targetId = $products[12].id }).json.error.details.code 'FEATURED_LIMIT'
Check 'shops have their own 12' (Call 'POST' '/admin/featured' $admin @{ kind = 'SHOP'; targetId = (Call 'GET' '/shops/gadget-galaxy' $null $null).json.data.id }).status 201
Check 'delete a slot' (Call 'DELETE' "/admin/featured/$($fp1.id)" $admin $null).status 200
foreach ($s in @((Call 'GET' '/admin/featured' $admin $null).json.data)) { Call 'DELETE' "/admin/featured/$($s.id)" $admin $null | Out-Null }

# ---- 2. product moderation ----
$cat = @((Call 'GET' '/categories' $null $null).json.data)[0].id
$title = "Moderation Test Item $stamp"
$r = Call 'POST' "/shops/$techId/products" $owner @{ title = $title; categoryId = $cat; listing = @{ price = 1500; stockQty = 5 } }
Check 'shop creates a product' $r.status 201
$np = $r.json.data.product; $nl = $r.json.data.listing
Check 'it starts PENDING' $np.moderationStatus 'PENDING'
Check 'not in the public list' @((Call 'GET' "/products?q=$([uri]::EscapeDataString($title))" $null $null).json.data).Count 0
Check 'product page -> 404' (Call 'GET' "/products/$($np.slug)" $null $null).status 404
Check 'not in the storefront' (@((Call 'GET' '/shops/techzone-electronics/products?limit=50' $null $null).json.data | Where-Object { $_.listingId -eq $nl.id }).Count) 0
Check 'cannot be put in a cart' (Call 'POST' '/cart/items' $cust @{ listingId = $nl.id; quantity = 1 }).status 404
Check 'cannot be featured yet' (Call 'POST' '/admin/featured' $admin @{ kind = 'PRODUCT'; targetId = $np.id }).status 404
Check 'customer cannot see the queue' (Call 'GET' '/admin/moderation/products' $cust $null).status 403
$q = @((Call 'GET' '/admin/moderation/products?limit=50' $admin $null).json.data)
Check 'admin queue has it' (@($q | Where-Object { $_.id -eq $np.id }).Count) 1
Check 'the queue shows the shop' (@($q | Where-Object { $_.id -eq $np.id })[0].shop.slug) 'techzone-electronics'
Check 'reject needs a reason -> 400' (Call 'POST' "/admin/moderation/products/$($np.id)/reject" $admin @{ reason = '' }).status 400
$r = Call 'POST' "/admin/moderation/products/$($np.id)/reject" $admin @{ reason = 'Please add a clear title and the brand' }
Check 'rejected' $r.json.data.moderationStatus 'REJECTED'
$n = @((Call 'GET' '/notifications?limit=20' $owner $null).json.data | Where-Object { $_.type -eq 'PRODUCT_MODERATION' -and $_.data.productId -eq $np.id })
Check 'shop notified of the rejection' $n.Count 1
Check 'still hidden after rejection' (Call 'GET' "/products/$($np.slug)" $null $null).status 404
$r = Call 'PATCH' "/shops/$techId/products/$($np.id)" $owner @{ description = 'Now with a clear description.' }
Check 'editing a rejected product resubmits it' $r.json.data.moderationStatus 'PENDING'
Check 'the note is cleared' $r.json.data.moderationNote $null
$r = Call 'POST' "/admin/moderation/products/$($np.id)/approve" $admin $null
Check 'approved' $r.json.data.moderationStatus 'APPROVED'
Check 'approve twice -> 409' (Call 'POST' "/admin/moderation/products/$($np.id)/approve" $admin $null).status 409
Check 'now public' (Call 'GET' "/products/$($np.slug)" $null $null).status 200
Check 'now in the list' @((Call 'GET' "/products?q=$([uri]::EscapeDataString($title))" $null $null).json.data).Count 1
Check 'existing products stayed APPROVED' (Call 'GET' "/products/$($products[0].slug)" $null $null).status 200

# ---- 3. flags ----
# cust2 buys, the order is completed, and cust2 writes a review with a phone number in it
Call 'DELETE' '/cart' $cust2 $null | Out-Null
Need ((Call 'POST' '/cart/items' $cust2 @{ listingId = $lid; quantity = 1 }).status -eq 200) 'adding to the cart'
$o = (Call 'POST' '/checkout' $cust2 @{ shops = @(@{ shopId = $techId; deliveryMethod = 'VENDOR_DELIVERY'; paymentMethod = 'CASH_ON_DELIVERY'; deliveryAddress = 'House 12, Road 5, Dhanmondi, Dhaka' }) }).json.data.orders[0]
foreach ($st in 'CONFIRMED', 'OUT_FOR_DELIVERY', 'COMPLETED') { Call 'POST' "/shops/$techId/orders/$($o.id)/status" $owner @{ status = $st } | Out-Null }
$r = Call 'POST' '/reviews' $cust2 @{ orderId = $o.id; type = 'SHOP_TRUST'; rating = 4; comment = 'Good shop. Call me on 017-1234-5678 for a better deal' }
Check 'review created' $r.status 201
$rev = $r.json.data
$open = @((Call 'GET' '/admin/flags?limit=50' $admin $null).json.data | Where-Object { $_.targetId -eq $rev.id })
Check 'auto-flagged (phone number)' "$($open[0].auto)/$($open[0].reason)" 'True/PERSONAL_INFO'
Check 'the flag shows the content' ($open[0].target.comment -like 'Good shop*') $true
Check 'no reporter identity in the list' ($open[0].PSObject.Properties.Name -contains 'reporterId') $false
$r = Call 'POST' '/reviews' $cust2 @{ orderId = $o.id; type = 'PRODUCT'; productId = $mine[0].product.id; rating = 5; comment = 'Visit www.cheap-deals.example for more' }
Check 'auto-flagged (link)' (@((Call 'GET' '/admin/flags?limit=50' $admin $null).json.data | Where-Object { $_.targetId -eq $r.json.data.id })[0].reason) 'SPAM'
$plainReview = $r.json.data

Check 'report: no token -> 401' (Call 'POST' '/flags' $null @{ targetType = 'REVIEW'; targetId = $rev.id; reason = 'SPAM' }).status 401
Check 'report: bad reason -> 400' (Call 'POST' '/flags' $cust @{ targetType = 'REVIEW'; targetId = $rev.id; reason = 'BORING' }).status 400
Check 'report: unknown review -> 404' (Call 'POST' '/flags' $cust @{ targetType = 'REVIEW'; targetId = [guid]::NewGuid().ToString(); reason = 'SPAM' }).status 404
Check 'report your own review -> 400' (Call 'POST' '/flags' $cust2 @{ targetType = 'REVIEW'; targetId = $rev.id; reason = 'SPAM' }).status 400
Check 'a user reports it -> 201' (Call 'POST' '/flags' $cust @{ targetType = 'REVIEW'; targetId = $rev.id; reason = 'PERSONAL_INFO'; note = 'Phone number' }).status 201
Check 'reporting again -> 200 (once per user)' (Call 'POST' '/flags' $cust @{ targetType = 'REVIEW'; targetId = $rev.id; reason = 'SPAM' }).status 200

# chat messages
$msg = (Call 'POST' "/orders/$($o.id)/messages" $cust2 @{ body = 'Please send it fast' }).json.data
$msg2 = (Call 'POST' "/orders/$($o.id)/messages" $cust2 @{ body = 'You are useless' }).json.data
Check 'outsider reports a chat message -> 404' (Call 'POST' '/flags' $owner3 @{ targetType = 'ORDER_MESSAGE'; targetId = $msg.id; reason = 'ABUSE' }).status 404
Check 'the shop reports a message -> 201' (Call 'POST' '/flags' $owner @{ targetType = 'ORDER_MESSAGE'; targetId = $msg.id; reason = 'OTHER' }).status 201
Check 'the shop reports another -> 201' (Call 'POST' '/flags' $owner @{ targetType = 'ORDER_MESSAGE'; targetId = $msg2.id; reason = 'ABUSE' }).status 201
Check 'report your own message -> 400' (Call 'POST' '/flags' $cust2 @{ targetType = 'ORDER_MESSAGE'; targetId = $msg.id; reason = 'SPAM' }).status 400

# the daily limit (10 reports per user in 24 hours)
node --env-file=.env scripts/fill-flags.mjs 'customer@vendorshub.test' 10 | Out-Null
$r = Call 'POST' '/flags' $cust @{ targetType = 'REVIEW'; targetId = $plainReview.id; reason = 'SPAM' }
Check 'the 11th report today -> 429' $r.status 429
Check 'code FLAG_LIMIT' $r.json.error.details.code 'FLAG_LIMIT'
node --env-file=.env scripts/fill-flags.mjs --clean 'customer@vendorshub.test' | Out-Null

# ---- 4. resolving ----
Check 'customer cannot see flags' (Call 'GET' '/admin/flags' $cust $null).status 403
$before = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.stats.reviewCount
$f = @((Call 'GET' '/admin/flags?limit=50' $admin $null).json.data | Where-Object { $_.targetId -eq $rev.id })
Check 'two open flags on the review (auto + user)' $f[0].reportsOnTarget 2
$r = Call 'POST' "/admin/flags/$($f[0].id)/resolve" $admin @{ action = 'HIDE'; note = 'Phone number' }
Check 'hide -> HIDDEN' $r.json.data.status 'HIDDEN'
Check 'both flags resolved at once' $r.json.data.resolvedFlags 2
Check 'resolve again -> 409' (Call 'POST' "/admin/flags/$($f[0].id)/resolve" $admin @{ action = 'KEEP' }).status 409
Check 'hidden review left out of the rating count' ((Call 'GET' '/shops/techzone-electronics' $null $null).json.data.stats.reviewCount) ($before - 1)
Check 'hidden review left out of the list' (@((Call 'GET' '/shops/techzone-electronics/reviews?limit=50' $null $null).json.data | Where-Object { $_.id -eq $rev.id }).Count) 0
Check 'a hidden review cannot be reported' (Call 'POST' '/flags' $owner @{ targetType = 'REVIEW'; targetId = $rev.id; reason = 'SPAM' }).status 404
$fm = @((Call 'GET' '/admin/flags?targetType=ORDER_MESSAGE&limit=50' $admin $null).json.data | Where-Object { $_.targetId -eq $msg.id })[0]
Check 'keep -> KEPT' (Call 'POST' "/admin/flags/$($fm.id)/resolve" $admin @{ action = 'KEEP' }).json.data.status 'KEPT'
$fm2 = @((Call 'GET' '/admin/flags?targetType=ORDER_MESSAGE&limit=50' $admin $null).json.data | Where-Object { $_.targetId -eq $msg2.id })[0]
Check 'hide the abusive message' (Call 'POST' "/admin/flags/$($fm2.id)/resolve" $admin @{ action = 'HIDE' }).json.data.status 'HIDDEN'
$chat = @((Call 'GET' "/orders/$($o.id)/messages" $cust2 $null).json.data.messages)
Check 'kept message still shown' (@($chat | Where-Object { $_.id -eq $msg.id })[0].body) 'Please send it fast'
$h2 = @($chat | Where-Object { $_.id -eq $msg2.id })[0]
Check 'hidden message: body null' $h2.body $null
Check 'hidden message: hidden true' $h2.hidden $true
Check 'resolved flags listed as HIDDEN' (@((Call 'GET' '/admin/flags?status=HIDDEN&limit=50' $admin $null).json.data | Where-Object { $_.targetId -eq $rev.id }).Count) 2

# ---- cleanup ----
Call 'DELETE' '/cart' $cust $null | Out-Null
Call 'DELETE' '/cart' $cust2 $null | Out-Null

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
if ($script:fail -gt 0) { exit 1 }
