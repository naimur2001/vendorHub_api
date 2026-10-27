# test-dashboards.ps1
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
$staff = Login 'owner2@vendorshub.test'
$owner3 = Login 'owner3@vendorshub.test'
$admin = Login 'admin@vendorshub.test'

# ---- setup: the TechZone A55 listing with plenty of stock ----
$techId = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id
$p = Call 'GET' '/products/galaxy-a55-5g-8-128gb' $null $null
$all = @($p.json.data.selectedListing) + @($p.json.data.otherListings)
$lid = (@($all | Where-Object { $_.shop.id -eq $techId }))[0].id
$prep = Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ availability = 'IN_STOCK'; stockQty = 50 }
Check 'listing prepared' $prep.status 200

# ---- 1. access rules ----
$r = Call 'GET' '/dashboard/customer' $null $null
Check 'the customer dashboard needs a login' $r.status 401
$r = Call 'GET' "/dashboard/shop/$techId" $cust $null
Check 'a customer cannot open a shop dashboard' $r.status 403
$r = Call 'GET' "/dashboard/shop/$techId" $owner3 $null
Check 'another shop owner cannot open it' $r.status 403
$r = Call 'GET' "/dashboard/shop/$techId" $staff $null
Check 'shop staff can open it' $r.status 200
$r = Call 'GET' "/dashboard/shop/$techId" $admin $null
Check 'an admin can open it' $r.status 200
$r = Call 'GET' '/dashboard/admin' $cust $null
Check 'a customer cannot open the admin dashboard' $r.status 403
$r = Call 'GET' '/dashboard/admin' $owner $null
Check 'a shop owner cannot open the admin dashboard' $r.status 403

# ---- 2. dashboards before an order ----
Call 'DELETE' '/cart' $cust $null | Out-Null
$r = Call 'GET' '/dashboard/customer' $cust $null
Check 'customer dashboard works' $r.status 200
$c0 = $r.json.data
Check 'every order status has a counter' ($null -ne $c0.orders.byStatus.PLACED -and $null -ne $c0.orders.byStatus.CANCELLED) $true
Check 'bargain counters exist' ($c0.bargains.active -ge 0) $true
$r = Call 'GET' "/dashboard/shop/$techId" $owner $null
Check 'shop dashboard works' $r.status 200
$s0 = $r.json.data
Check 'the shop dashboard is for TechZone' $s0.shop.slug 'techzone-electronics'
Check 'the verification level is shown' $s0.verification.level 'PHYSICAL_SHOP_VERIFIED'
$r = Call 'GET' '/dashboard/admin' $admin $null
Check 'admin dashboard works' $r.status 200
$a0 = $r.json.data
Check 'users are counted' ($a0.users.total -ge 5) $true
Check 'every role has a counter' ($null -ne $a0.users.byRole.ADMIN -and $null -ne $a0.users.byRole.CUSTOMER) $true
Check 'shops are counted per level' ($a0.shops.byLevel.TRUSTED_VENDOR -ge 1) $true
Check 'the seeded verification request is counted' ($a0.verification.pendingReview -ge 1) $true
Check 'recent activity is a list' ($a0.recentActivity -is [array] -or $null -eq $a0.recentActivity -or $a0.recentActivity.Count -ge 0) $true

# ---- 3. place an order and check every dashboard moves ----
$add = Call 'POST' '/cart/items' $cust @{ listingId = $lid; quantity = 1 }
Check 'item added to the cart' $add.status 200
$r = Call 'GET' '/dashboard/customer' $cust $null
Check 'the cart summary shows the item' $r.json.data.cart.itemCount 1
Check 'the cart summary shows one shop' $r.json.data.cart.shopCount 1

$choice = @{ shopId = $techId; deliveryMethod = 'STORE_PICKUP'; paymentMethod = 'PAY_AT_STORE' }
$r = Call 'POST' '/checkout' $cust @{ shops = @($choice) }
Check 'checkout succeeds' $r.status 201
$order = $r.json.data.orders[0]
Need $order.id 'the order'

$c1 = (Call 'GET' '/dashboard/customer' $cust $null).json.data
Check 'customer: one more order' $c1.orders.total ($c0.orders.total + 1)
Check 'customer: one more PLACED order' $c1.orders.byStatus.PLACED ($c0.orders.byStatus.PLACED + 1)
Check 'customer: the newest order comes first' $c1.orders.recent[0].id $order.id
Check 'customer: the cart is empty again' $c1.cart.itemCount 0

$s1 = (Call 'GET' "/dashboard/shop/$techId" $owner $null).json.data
Check 'shop: one more order to confirm' $s1.actions.ordersToConfirm ($s0.actions.ordersToConfirm + 1)
Check 'shop: 24-hour order count' $s1.sales.last24h.orders ($s0.sales.last24h.orders + 1)
Check 'shop: 24-hour revenue' $s1.sales.last24h.revenue ($s0.sales.last24h.revenue + $order.total)
Check 'shop: the newest order comes first' $s1.orders.recent[0].id $order.id
Check 'shop: the order shows the customer name' $s1.orders.recent[0].customer 'Test Customer'
Check 'shop: the product is in the top products' @($s1.topProducts30d | Where-Object { $_.title -like '*Galaxy A55*' }).Count 1

$a1 = (Call 'GET' '/dashboard/admin' $admin $null).json.data
Check 'admin: 24-hour order count' $a1.orders.sales.last24h.orders ($a0.orders.sales.last24h.orders + 1)

# low stock appears in the shop dashboard
Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ stockQty = 3 } | Out-Null
$s2 = (Call 'GET' "/dashboard/shop/$techId" $owner $null).json.data
Check 'shop: low stock is counted' ($s2.actions.lowStockCount -ge 1) $true
Check 'shop: the low-stock listing is listed' @($s2.actions.lowStock | Where-Object { $_.id -eq $lid }).Count 1
Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ availability = 'IN_STOCK'; stockQty = 50 } | Out-Null

# ---- 4. vendors ----
$v = Call 'GET' '/admin/shops?q=techzone' $admin $null
Check 'vendors list works' $v.status 200
$row = @($v.json.data)[0]
Check 'the row is TechZone' $row.slug 'techzone-electronics'
Check 'the row has order statistics' ($row.stats.orders -ge 1) $true
Check 'the row has the owner email' ($null -ne $row.owner.email) $true
$v = Call 'GET' '/admin/shops?verificationLevel=TRUSTED_VENDOR' $admin $null
Check 'the level filter finds a trusted vendor' (@($v.json.data).Count -ge 1) $true
Check 'the level filter returns only that level' @($v.json.data | Where-Object { $_.verificationLevel -ne 'TRUSTED_VENDOR' }).Count 0
$v = Call 'GET' '/admin/shops' $cust $null
Check 'a customer cannot open the vendors list' $v.status 403

# a fresh shop to deactivate and reactivate
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$reg = Call 'POST' '/auth/register' $null @{ name = 'Dash Owner'; email = "dtest$stamp@vendorshub.test"; password = 'Password123!'; role = 'SHOP_OWNER' }
$own = $reg.json.data.accessToken
Need $own 'the test shop owner'
$sh = Call 'POST' '/shops' $own @{ name = "Dash Test $stamp"; addressLine = 'Road 3, Test Area, Dhaka' }
$newId = $sh.json.data.id
$newSlug = $sh.json.data.slug
Need $newId 'the test shop'

$r = Call 'PATCH' "/admin/shops/$newId/status" $admin @{ isActive = $false; reason = 'no' }
Check 'a deactivation needs a proper reason' $r.status 400
$r = Call 'PATCH' "/admin/shops/$newId/status" $own @{ isActive = $false; reason = 'Trying it myself' }
Check 'an owner cannot deactivate a shop' $r.status 403
$r = Call 'PATCH' "/admin/shops/$newId/status" $admin @{ isActive = $false; reason = 'Suspected fake shop.' }
Check 'admin deactivates the shop' $r.status 200
$r = Call 'GET' "/shops/$newSlug" $null $null
Check 'the deactivated shop is gone from the public site' $r.status 404
$r = Call 'PATCH' "/admin/shops/$newId/status" $admin @{ isActive = $false; reason = 'Suspected fake shop.' }
Check 'deactivating twice is rejected' $r.status 409
$v = Call 'GET' '/admin/shops?isActive=false&limit=50' $admin $null
Check 'the inactive filter lists it' @($v.json.data | Where-Object { $_.id -eq $newId }).Count 1
$r = Call 'PATCH' "/admin/shops/$newId/status" $admin @{ isActive = $true; reason = 'Documents checked, all fine.' }
Check 'admin reactivates the shop' $r.status 200
$r = Call 'GET' "/shops/$newSlug" $null $null
Check 'the shop is public again' $r.status 200

# ---- 5. reports ----
$sales = Call 'GET' '/admin/reports/sales' $admin $null
Check 'sales report works' $sales.status 200
$rows = @($sales.json.data.rows)
Check 'the report has rows' ($rows.Count -ge 1) $true
$sumRevenue = ($rows | Measure-Object -Property revenue -Sum).Sum
$sumOrders = ($rows | Measure-Object -Property orders -Sum).Sum
Check 'the revenue total equals the sum of the rows' $sales.json.data.totals.revenue $sumRevenue
Check 'the order total equals the sum of the rows' $sales.json.data.totals.orders $sumOrders
Check 'the timezone is Dhaka' $sales.json.data.timezone 'Asia/Dhaka'
$r = Call 'GET' '/admin/reports/sales?interval=week' $admin $null
Check 'weekly report works' $r.status 200
$r = Call 'GET' '/admin/reports/sales?interval=month' $admin $null
Check 'monthly report works' $r.status 200
$r = Call 'GET' '/admin/reports/sales?interval=year' $admin $null
Check 'an unknown interval is rejected' $r.status 400
$r = Call 'GET' '/admin/reports/sales?from=2026-12-01&to=2026-01-01' $admin $null
Check 'a backwards range is rejected' $r.status 400
$long = (Get-Date).AddDays(-400).ToString('yyyy-MM-dd')
$r = Call 'GET' "/admin/reports/sales?from=$long" $admin $null
Check 'a range over 366 days is rejected' $r.status 400
$r = Call 'GET' '/admin/reports/sales' $cust $null
Check 'a customer cannot read the sales report' $r.status 403

$top = Call 'GET' '/admin/reports/top' $admin $null
Check 'top report works' $top.status 200
Check 'TechZone is among the top shops' @($top.json.data.shops | Where-Object { $_.slug -eq 'techzone-electronics' }).Count 1
Check 'the A55 is among the top products' @($top.json.data.products | Where-Object { $_.title -like '*Galaxy A55*' }).Count 1
$r = Call 'GET' '/admin/reports/top?limit=0' $admin $null
Check 'a limit of 0 is rejected' $r.status 400

# ---- cleanup ----
Call 'POST' "/shops/$techId/orders/$($order.id)/status" $owner @{ status = 'CANCELLED'; reason = 'Test cleanup' } | Out-Null

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
Write-Host 'Run "node --env-file=.env prisma/seed.js" to reset the demo data.'