# test-product-deletion.ps1 (product deletion requests, the 12 hour job, admin approve / reject / permanent delete)
# Run from the project root while "npm run dev" is running in another terminal (mock modes).
# Creates its own products and removes everything again at the end.
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
    if ($r.status -ne 200) {
        Write-Host "Login failed for $email (status $($r.status))" -ForegroundColor Red
        exit 1
    }
    return $r.json.data.accessToken
}

# Runs the helper and returns its JSON line (pino log lines may come before or after it).
function Helper() {
    $lines = @(node --env-file=.env scripts/product-deletion-test-helper.mjs @args)
    $line = @($lines | Where-Object { $_ -like '{*' -and $_ -notlike '*"level":*' }) | Select-Object -Last 1
    if (-not $line) { return $null }
    return ($line | ConvertFrom-Json)
}

try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}

$since = [DateTime]::UtcNow.AddSeconds(-2).ToString('o')
$admin = Login 'admin@vendorshub.test'
$owner = Login 'owner1@vendorshub.test'   # owns TechZone
$staff = Login 'owner2@vendorshub.test'   # staff of TechZone, owner of Dhaka Mobile House
$cust = Login 'customer@vendorshub.test'
$techId = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id
$otherShopId = (Call 'GET' '/shops/dhaka-mobile-house' $null $null).json.data.id
$cat = @((Call 'GET' '/categories' $null $null).json.data)[0].id
$tag = "Delcheck$(Get-Date -Format 'yyyyMMddHHmmss')"
$script:productIds = @()

function Cleanup {
    Call 'DELETE' '/cart' $cust $null | Out-Null
    if ($script:productIds.Count -eq 0) { return $null }
    Helper cleanup @script:productIds | Out-Null
    $lines = @(node --env-file=.env scripts/product-sorts-test-helper.mjs cleanup $since @script:productIds)
    $line = @($lines | Where-Object { $_ -like '{*' -and $_ -notlike '*"level":*' }) | Select-Object -Last 1
    if ($line) { return ($line | ConvertFrom-Json) }
    return $null
}
function Need($value, $what) {
    if (-not $value) {
        Write-Host "Cannot continue: $what failed. Server said: $($script:lastMsg)" -ForegroundColor Red
        Cleanup | Out-Null
        exit 1
    }
}
function NewProduct($n) {
    $r = Call 'POST' "/shops/$techId/products" $owner @{ title = "$tag Item $n"; categoryId = $cat; listing = @{ price = 1500; stockQty = 10 } }
    Need ($r.status -eq 201) "creating product $n"
    $script:productIds += $r.json.data.product.id
    return @{ id = $r.json.data.product.id; slug = $r.json.data.product.slug; lid = $r.json.data.listing.id }
}
function Public($p) { return (Call 'GET' "/products/$($p.slug)" $null $null).status }
function RequestDel($p, $token, $body) {
    if ($null -eq $body) { $body = @{} }
    return Call 'POST' "/shops/$techId/products/$($p.id)/deletion-request" $token $body
}
function HasNote($token, $type, $productId) {
    $items = @((Call 'GET' '/notifications?limit=50' $token $null).json.data)
    return (@($items | Where-Object { $_.type -eq $type -and $_.data.productId -eq $productId }).Count -ge 1)
}

$p1 = NewProduct 'Auto'
$p2 = NewProduct 'Reject'
$p3 = NewProduct 'Cancel'
$p4 = NewProduct 'Ordered'
$p5 = NewProduct 'Shared'

# ---- 1. access and validation ----
Check 'staff (not owner) -> 403' (RequestDel $p1 $staff $null).status 403
Check 'customer -> 403' (RequestDel $p1 $cust $null).status 403
Check 'admin on the shop endpoint -> 403' (RequestDel $p1 $admin $null).status 403
Check 'no token -> 401' (RequestDel $p1 $null $null).status 401
Check 'malformed product id -> 400' (Call 'POST' "/shops/$techId/products/not-a-uuid/deletion-request" $owner @{}).status 400
Check 'malformed shop id -> 400' (Call 'POST' "/shops/nope/products/$($p1.id)/deletion-request" $owner @{}).status 400
Check 'reason over 500 characters -> 400' (RequestDel $p1 $owner @{ reason = ('x' * 501) }).status 400
Check 'unknown product -> 404' (Call 'POST' "/shops/$techId/products/00000000-0000-4000-8000-000000000000/deletion-request" $owner @{}).status 404
Check 'staff cannot list the requests -> 403' (Call 'GET' "/shops/$techId/deletion-requests" $staff $null).status 403
Check 'owner cannot use the admin list -> 403' (Call 'GET' '/admin/deletion-requests' $owner $null).status 403
Check 'owner cannot delete permanently -> 403' (Call 'DELETE' "/admin/products/$($p1.id)/permanent" $owner $null).status 403

# ---- 2. request -> hidden -> auto delete after 12 hours ----
Call 'DELETE' '/cart' $cust $null | Out-Null
Need ((Call 'POST' '/cart/items' $cust @{ listingId = $p1.lid; quantity = 1 }).status -eq 200) 'adding P1 to the cart'
Need ((Call 'POST' '/wishlist' $cust @{ listingId = $p1.lid }).status -in 200, 201) 'saving P1 to the wishlist'
Check 'P1 is public before' (Public $p1) 200
$r = RequestDel $p1 $owner @{ reason = 'We no longer sell this' }
Check 'request -> 201' $r.status 201
$req1 = $r.json.data
Check 'request is PENDING, outcome null, scope PRODUCT' "$($req1.status)/$($req1.outcome)/$($req1.scope)" 'PENDING//PRODUCT'
Check 'request keeps the reason' $req1.reason 'We no longer sell this'
$hours = ([DateTime]$req1.autoDeleteAt - [DateTime]$req1.createdAt).TotalHours
Check 'autoDeleteAt = createdAt + 12 hours' ([Math]::Round($hours, 3)) 12
Check 'P1 is hidden from public pages at once' (Public $p1) 404
Check 'P1 is left out of the product list' (@((Call 'GET' "/products?q=$tag&limit=50" $null $null).json.data | Where-Object { $_.id -eq $p1.id }).Count) 0
$r = RequestDel $p1 $owner $null
Check 'a second request -> 409' $r.status 409
Check 'a second request: code ALREADY_PENDING' $script:lastCode 'ALREADY_PENDING'
Check 'admins are notified (PRODUCT_DELETION_REQUESTED)' (HasNote $admin 'PRODUCT_DELETION_REQUESTED' $p1.id) $true

$adm = Call 'GET' '/admin/deletion-requests?status=PENDING&limit=100' $admin $null
Check 'admin list -> 200' $adm.status 200
$row = @($adm.json.data | Where-Object { $_.id -eq $req1.id })[0]
Check 'admin list: product title, shop name, reason' "$($row.product.title)|$($row.shop.name)|$($row.reason)" "$tag Item Auto|TechZone Electronics|We no longer sell this"
Check 'admin list: autoDeleteAt' ([DateTime]$row.autoDeleteAt -eq [DateTime]$req1.autoDeleteAt) $true
Check 'admin list: status filter' (@($adm.json.data | Where-Object { $_.status -ne 'PENDING' }).Count) 0
Check 'admin list: pagination meta' ($null -ne $adm.json.meta.pagination.total) $true
Check 'admin list: bad status -> 400' (Call 'GET' '/admin/deletion-requests?status=WAITING' $admin $null).status 400

$sh = Call 'GET' "/shops/$techId/deletion-requests" $owner $null
Check 'shop list -> 200' $sh.status 200
$srow = @($sh.json.data | Where-Object { $_.id -eq $req1.id })[0]
Check 'shop list: status and autoDeleteAt' "$($srow.status)/$($null -ne $srow.autoDeleteAt)" 'PENDING/True'

$s = Helper sweep '--hours-ahead=11'
$st = Helper status $req1.id
Check 'after 11 hours: still PENDING and the product row exists' "$($st.status)/$($st.productExists)" 'PENDING/True'
$s = Helper sweep '--hours-ahead=13'
Check 'after 13 hours: the job deleted at least one' ($s.deleted -ge 1) $true
$st = Helper status $req1.id
Check 'after 13 hours: DONE / DELETED, the product row is gone' "$($st.status)/$($st.outcome)/$($st.productExists)" 'DONE/DELETED/False'
$lr = Helper listing $p1.lid
Check 'the listing, cart item and wishlist item went with it' "$($lr.listing)/$($lr.cartItems)/$($lr.wishlistItems)" 'False/0/0'
Check 'the owner is notified (PRODUCT_DELETION_DONE)' (HasNote $owner 'PRODUCT_DELETION_DONE' $p1.id) $true
$s = Helper sweep '--hours-ahead=13'
$st = Helper status $req1.id
Check 'a second run changes nothing (idempotent)' "$($st.status)/$($st.outcome)" 'DONE/DELETED'
$adm = Call 'GET' '/admin/deletion-requests?status=DONE&limit=100' $admin $null
$row = @($adm.json.data | Where-Object { $_.id -eq $req1.id })[0]
Check 'admin list after delete: product null, title kept' "$($null -eq $row.product)|$($row.productTitle)" "True|$tag Item Auto"

# ---- 3. reject restores the product ----
$r = RequestDel $p2 $owner $null
Need ($r.status -eq 201) 'requesting P2'
$req2 = $r.json.data
Check 'P2 hidden while pending' (Public $p2) 404
Check 'reject without a note -> 400' (Call 'POST' "/admin/deletion-requests/$($req2.id)/reject" $admin @{}).status 400
$r = Call 'POST' "/admin/deletion-requests/$($req2.id)/reject" $admin @{ note = 'Customers still ask for it' }
Check 'reject -> 200' $r.status 200
Check 'reject: REJECTED with the note' "$($r.json.data.status)|$($r.json.data.rejectNote)" 'REJECTED|Customers still ask for it'
Check 'P2 is visible again' (Public $p2) 200
Check 'the owner is notified (PRODUCT_DELETION_REJECTED)' (HasNote $owner 'PRODUCT_DELETION_REJECTED' $p2.id) $true
Check 'reject again -> 409' (Call 'POST' "/admin/deletion-requests/$($req2.id)/reject" $admin @{ note = 'Again please' }).status 409
Check 'approve a rejected request -> 409' (Call 'POST' "/admin/deletion-requests/$($req2.id)/approve" $admin $null).status 409
Check 'unknown request -> 404' (Call 'POST' '/admin/deletion-requests/00000000-0000-4000-8000-000000000000/approve' $admin $null).status 404

# a new request after a rejection is allowed; the admin approves it at once
$r = RequestDel $p2 $owner $null
Check 'a new request after a rejection -> 201' $r.status 201
$req2b = $r.json.data
$r = Call 'POST' "/admin/deletion-requests/$($req2b.id)/approve" $admin $null
Check 'approve -> 200 DONE / DELETED' "$($r.status)/$($r.json.data.status)/$($r.json.data.outcome)" '200/DONE/DELETED'
Check 'P2 is gone' (Public $p2) 404
Check 'approve again -> 409' (Call 'POST' "/admin/deletion-requests/$($req2b.id)/approve" $admin $null).status 409

# ---- 4. cancel ----
$r = RequestDel $p3 $owner $null
Need ($r.status -eq 201) 'requesting P3'
$req3 = $r.json.data
Check 'P3 hidden while pending' (Public $p3) 404
Check 'staff cannot cancel -> 403' (Call 'DELETE' "/shops/$techId/deletion-requests/$($req3.id)" $staff $null).status 403
Check 'cancel through another shop -> 403' (Call 'DELETE' "/shops/$otherShopId/deletion-requests/$($req3.id)" $owner $null).status 403
$r = Call 'DELETE' "/shops/$techId/deletion-requests/$($req3.id)" $owner $null
Check 'cancel -> 200 CANCELLED' "$($r.status)/$($r.json.data.status)" '200/CANCELLED'
Check 'P3 is visible again' (Public $p3) 200
Check 'cancel again -> 409' (Call 'DELETE' "/shops/$techId/deletion-requests/$($req3.id)" $owner $null).status 409
Helper sweep '--hours-ahead=13' | Out-Null
Check 'the job leaves a cancelled request alone' (Public $p3) 200

# ---- 5. a product with orders is only deactivated ----
Call 'DELETE' '/cart' $cust $null | Out-Null
Need ((Call 'POST' '/cart/items' $cust @{ listingId = $p4.lid; quantity = 1 }).status -eq 200) 'adding P4 to the cart'
$o = Call 'POST' '/checkout' $cust @{ shops = @(@{ shopId = $techId; deliveryMethod = 'VENDOR_DELIVERY'; paymentMethod = 'CASH_ON_DELIVERY'; deliveryAddress = 'House 12, Road 5, Dhanmondi, Dhaka' }) }
Need ($o.status -eq 201) 'ordering P4'
$orderId = $o.json.data.orders[0].id
$r = RequestDel $p4 $owner $null
Need ($r.status -eq 201) 'requesting P4'
$req4 = $r.json.data
Helper sweep '--hours-ahead=13' | Out-Null
$st = Helper status $req4.id
Check 'P4: DONE / DEACTIVATED, the product row stays, inactive' "$($st.status)/$($st.outcome)/$($st.productExists)/$($st.productActive)" 'DONE/DEACTIVATED/True/False'
Check 'P4 is not public' (Public $p4) 404
$ord = Call 'GET' "/orders/$orderId" $cust $null
Check 'the order is still there' $ord.status 200
Check 'the order item keeps its title' (@($ord.json.data.items | Where-Object { $_.title -eq "$tag Item Ordered" }).Count) 1
$r = Call 'DELETE' "/admin/products/$($p4.id)/permanent" $admin $null
Check 'admin permanent delete of P4 -> 200 DEACTIVATED' "$($r.status)/$($r.json.data.outcome)" '200/DEACTIVATED'

# ---- 6. a shared product: only this shop's listing goes (LISTING scope) ----
function OtherList($p, $price) {
    $l = Call 'POST' "/shops/$otherShopId/listings" $staff @{ productId = $p.id; price = $price; stockQty = 2 }
    Need ($l.status -eq 201) "the other shop listing $($p.slug)"
    return $l.json.data.id
}
function PublicListingIds($p) { return @((Call 'GET' "/products/$($p.slug)/listings" $null $null).json.data | ForEach-Object { $_.id }) }
$p5other = OtherList $p5 1400
$r = RequestDel $p5 $owner $null
Check 'shared product -> 201 (no longer 409)' $r.status 201
Check 'shared product: scope LISTING' $r.json.data.scope 'LISTING'
$req5 = $r.json.data
Check 'shared product stays public' (Public $p5) 200
$ids = PublicListingIds $p5
Check 'only our listing is hidden at once' "$($ids -contains $p5.lid)/$($ids -contains $p5other)" 'False/True'
Check 'the shop list shows the scope' (@((Call 'GET' "/shops/$techId/deletion-requests" $owner $null).json.data | Where-Object { $_.id -eq $req5.id })[0].scope) 'LISTING'
Check 'the admin list shows the scope' (@((Call 'GET' '/admin/deletion-requests?status=PENDING&limit=100' $admin $null).json.data | Where-Object { $_.id -eq $req5.id })[0].scope) 'LISTING'
Helper sweep '--hours-ahead=13' | Out-Null
$st = Helper status $req5.id
Check 'after 12 hours: DONE / LISTING_DELETED, the product stays active' "$($st.status)/$($st.outcome)/$($st.productExists)/$($st.productActive)" 'DONE/LISTING_DELETED/True/True'
Check 'our listing row is gone' (Helper listing $p5.lid).listing $false
Check 'the other shop listing stays' ((PublicListingIds $p5) -contains $p5other) $true
Check 'DONE notification carries outcome and scope' (@((Call 'GET' '/notifications?limit=50' $owner $null).json.data | Where-Object { $_.type -eq 'PRODUCT_DELETION_DONE' -and $_.data.requestId -eq $req5.id -and $_.data.outcome -eq 'LISTING_DELETED' -and $_.data.scope -eq 'LISTING' }).Count) 1
$r = Call 'POST' "/shops/$otherShopId/products/$($p5.id)/deletion-request" $staff @{}
Check 'a shop that did not create it -> 201 LISTING' "$($r.status)/$($r.json.data.scope)" '201/LISTING'
Check 'a shop without a listing -> 404' (Call 'POST' "/shops/$techId/products/$($p5.id)/deletion-request" $owner @{}).status 404
Need ((Call 'DELETE' "/shops/$otherShopId/deletion-requests/$($r.json.data.id)" $staff $null).status -eq 200) 'cancelling the other shop request'
Check 'cancel shows the other shop listing again' ((PublicListingIds $p5) -contains $p5other) $true

# ---- 6b. the last shop leaving a product it created deletes the product ----
$p6 = NewProduct 'Lastshop'
$p6other = OtherList $p6 1450
$rOwn = RequestDel $p6 $owner $null
Check 'P6 shared: the creator gets LISTING' "$($rOwn.status)/$($rOwn.json.data.scope)" '201/LISTING'
$rOther = Call 'POST' "/shops/$otherShopId/products/$($p6.id)/deletion-request" $staff @{}
Need ($rOther.status -eq 201) 'the other shop asking to leave P6'
$a = Call 'POST' "/admin/deletion-requests/$($rOther.json.data.id)/approve" $admin $null
Check 'the other shop leaves first: LISTING_DELETED, the product stays' "$($a.json.data.outcome)/$((Helper status $rOther.json.data.id).productExists)" 'LISTING_DELETED/True'
$a = Call 'POST' "/admin/deletion-requests/$($rOwn.json.data.id)/approve" $admin $null
Check 'the creator leaves last: the product is deleted (DELETED, scope LISTING)' "$($a.json.data.outcome)/$($a.json.data.scope)" 'DELETED/LISTING'
Check 'P6 is gone' (Helper status $rOwn.json.data.id).productExists $false

# ---- 6c. a listing with orders is only deactivated ----
$p7 = NewProduct 'Listingorder'
$p7other = OtherList $p7 1400
Call 'DELETE' '/cart' $cust $null | Out-Null
Need ((Call 'POST' '/cart/items' $cust @{ listingId = $p7other; quantity = 1 }).status -eq 200) 'adding the other shop P7 listing to the cart'
$o7 = Call 'POST' '/checkout' $cust @{ shops = @(@{ shopId = $otherShopId; deliveryMethod = 'VENDOR_DELIVERY'; paymentMethod = 'CASH_ON_DELIVERY'; deliveryAddress = 'House 12, Road 5, Dhanmondi, Dhaka' }) }
Need ($o7.status -eq 201) 'ordering from the other shop'
$r = Call 'POST' "/shops/$otherShopId/products/$($p7.id)/deletion-request" $staff @{}
Need ($r.status -eq 201) 'the other shop asking to leave P7'
Helper sweep '--hours-ahead=13' | Out-Null
$st = Helper status $r.json.data.id
Check 'listing with orders: DONE / DEACTIVATED, product active' "$($st.status)/$($st.outcome)/$($st.productActive)" 'DONE/DEACTIVATED/True'
Check 'the listing row stays' (Helper listing $p7other).listing $true
Check 'the order is still there' (Call 'GET' "/orders/$($o7.json.data.orders[0].id)" $cust $null).status 200
Check 'P7 stays public with the creator listing' ((PublicListingIds $p7) -contains $p7.lid) $true

# ---- 6d. another shop lists it during the 12 hours: PRODUCT becomes LISTING ----
$p8 = NewProduct 'Latecomer'
$r = RequestDel $p8 $owner $null
Check 'P8 alone: scope PRODUCT' $r.json.data.scope 'PRODUCT'
$req8 = $r.json.data
Check 'P8 hidden' (Public $p8) 404
$late = (Helper add-listing $otherShopId $p8.id).listingId
Helper sweep '--hours-ahead=13' | Out-Null
$st = Helper status $req8.id
Check 'P8: DONE / LISTING_DELETED, scope now LISTING' "$($st.status)/$($st.outcome)/$($st.scope)" 'DONE/LISTING_DELETED/LISTING'
Check 'P8 stays and is visible again' "$($st.productExists)/$($st.productActive)/$(Public $p8)" 'True/True/200'
$ids = PublicListingIds $p8
Check 'only the late shop listing is left' "$($ids -contains $p8.lid)/$($ids -contains $late)" 'False/True'

# ---- 7. admin deletes at once ----
$r = Call 'DELETE' "/admin/products/$($p5.id)/permanent" $admin $null
Check 'admin permanent delete of P5 -> 200 DELETED' "$($r.status)/$($r.json.data.outcome)" '200/DELETED'
Check 'P5 is gone' (Public $p5) 404
Check 'again -> 404' (Call 'DELETE' "/admin/products/$($p5.id)/permanent" $admin $null).status 404
Check 'malformed id -> 400' (Call 'DELETE' '/admin/products/nope/permanent' $admin $null).status 400
$r = RequestDel $p3 $owner $null
Need ($r.status -eq 201) 'requesting P3 again'
$req3b = $r.json.data
$r = Call 'DELETE' "/admin/products/$($p3.id)/permanent" $admin $null
Check 'admin delete of a product with a pending request -> DELETED' "$($r.status)/$($r.json.data.outcome)" '200/DELETED'
$st = Helper status $req3b.id
Check 'its pending request is closed DONE / DELETED' "$($st.status)/$($st.outcome)" 'DONE/DELETED'

# ---- 8. cleanup ----
$out = Cleanup
Check 'cleanup removed the remaining test product' ($out.products -ge 1) $true
$left = @((Call 'GET' "/shops/$techId/deletion-requests?limit=100" $owner $null).json.data | Where-Object { $_.productTitle -like "$tag*" })
Check 'cleanup removed the deletion requests' $left.Count 0

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
if ($script:fail -gt 0) { exit 1 }
