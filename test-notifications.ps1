# test-notifications.ps1 (part 1: orders)
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

function Unread($token) { return (Call 'GET' '/notifications/unread-count' $token $null).json.data.unread }
function Latest($token) { return @((Call 'GET' '/notifications?limit=5' $token $null).json.data)[0] }

try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}

$cust = Login 'customer@vendorshub.test'
$ownerA = Login 'owner1@vendorshub.test'   # TechZone owner
$staffA = Login 'owner2@vendorshub.test'   # staff at TechZone
$ownerB = Login 'owner3@vendorshub.test'   # Gadget Galaxy owner
$admin = Login 'admin@vendorshub.test'

# ---- setup: A55 at TechZone and at Gadget Galaxy ----
$p = Call 'GET' '/products/galaxy-a55-5g-8-128gb' $null $null
$all = @($p.json.data.selectedListing) + @($p.json.data.otherListings)
$listA = @($all | Where-Object { $_.shop.slug -eq 'techzone-electronics' })[0]
$listB = @($all | Where-Object { $_.shop.slug -eq 'gadget-galaxy' })[0]
Need ($listA -and $listB) 'finding the A55 at both shops'
$shopA = $listA.shop.id
$shopB = $listB.shop.id
Call 'PATCH' "/shops/$shopA/listings/$($listA.id)" $ownerA @{ availability = 'IN_STOCK'; stockQty = 20 } | Out-Null
Call 'PATCH' "/shops/$shopB/listings/$($listB.id)" $ownerB @{ availability = 'IN_STOCK'; stockQty = 20 } | Out-Null

# start everyone at zero unread
foreach ($t in @($cust, $ownerA, $staffA, $ownerB, $admin)) { Call 'POST' '/notifications/read-all' $t $null | Out-Null }

# ---- 1. access ----
$r = Call 'GET' '/notifications' $null $null
Check 'notifications need a login' $r.status 401
Check 'the customer starts with no unread notifications' (Unread $cust) 0

# ---- 2. a split checkout alerts each shop about its own order ----
Call 'DELETE' '/cart' $cust $null | Out-Null
Call 'POST' '/cart/items' $cust @{ listingId = $listA.id; quantity = 1 } | Out-Null
Call 'POST' '/cart/items' $cust @{ listingId = $listB.id; quantity = 1 } | Out-Null
$choices = @(
    @{ shopId = $shopA; deliveryMethod = 'STORE_PICKUP'; paymentMethod = 'PAY_AT_STORE' },
    @{ shopId = $shopB; deliveryMethod = 'STORE_PICKUP'; paymentMethod = 'PAY_AT_STORE' }
)
$r = Call 'POST' '/checkout' $cust @{ shops = $choices }
Check 'the split checkout succeeds' $r.status 201
Need ($r.status -eq 201) 'the checkout'
$listForA = @((Call 'GET' "/shops/$shopA/orders?limit=50" $ownerA $null).json.data)
$orderA = @($r.json.data.orders | Where-Object { $id = $_.id; @($listForA | Where-Object { $_.id -eq $id }).Count -eq 1 })[0]
$orderB = @($r.json.data.orders | Where-Object { $_.id -ne $orderA.id })[0]
Need ($orderA -and $orderB) 'finding each shop''s order'

Check 'the TechZone owner has 1 unread' (Unread $ownerA) 1
$nA = Latest $ownerA
Check 'it is a new-order alert' $nA.type 'ORDER_NEW'
Check 'it points to the TechZone order' $nA.data.orderId $orderA.id
Check 'the title names the order number' ($nA.title -eq "New order $($orderA.orderNumber)") $true
Check 'TechZone staff are alerted too' (Unread $staffA) 1
Check 'the Gadget Galaxy owner has 1 unread' (Unread $ownerB) 1
$nB = Latest $ownerB
Check 'Gadget Galaxy is told about ITS order only' $nB.data.orderId $orderB.id
Check 'the customer gets one note per order' (Unread $cust) 2
Check 'the admin is not alerted' (Unread $admin) 0

# ---- 3. status changes and cancellations ----
$r = Call 'POST' "/shops/$shopA/orders/$($orderA.id)/status" $ownerA @{ status = 'CONFIRMED' }
Check 'TechZone confirms its order' $r.status 200
Check 'the customer is told' (Unread $cust) 3
$nC = Latest $cust
Check 'the alert is a status change' $nC.type 'ORDER_STATUS'
Check 'it says CONFIRMED' $nC.data.status 'CONFIRMED'

$r = Call 'POST' "/orders/$($orderB.id)/cancel" $cust @{ reason = 'Found it cheaper elsewhere' }
Check 'the customer cancels the Gadget Galaxy order' $r.status 200
Check 'Gadget Galaxy is told' (Unread $ownerB) 2
$nX = Latest $ownerB
Check 'the alert is a cancellation' $nX.type 'ORDER_CANCELLED'
Check 'the reason is included' ($nX.body -like '*cheaper elsewhere*') $true
Check 'TechZone is not told about it' (Unread $ownerA) 1

# ---- 4. reading ----
$r = Call 'POST' "/notifications/$($nA.id)/read" $ownerB $null
Check 'someone else cannot mark my notification' $r.status 404
$r = Call 'POST' "/notifications/$($nA.id)/read" $ownerA $null
Check 'the owner marks it read' $r.status 200
Check 'it is now read' $r.json.data.read $true
Check 'the unread count drops' (Unread $ownerA) 0
$r = Call 'GET' '/notifications?unreadOnly=true' $cust $null
Check 'the unread filter matches the count' @($r.json.data).Count (Unread $cust)
$r = Call 'POST' '/notifications/read-all' $cust $null
Check 'read-all marks everything' $r.json.data.marked 3
Check 'nothing unread is left' (Unread $cust) 0

# ---- cleanup: put the stock back ----
Call 'POST' "/shops/$shopA/orders/$($orderA.id)/status" $ownerA @{ status = 'CANCELLED'; reason = 'Test cleanup' } | Out-Null

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"