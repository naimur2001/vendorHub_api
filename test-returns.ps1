# test-returns.ps1 (returns and disputes, part A)
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

try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path 'scripts/backdate-completion.mjs')) {
    Write-Host 'Missing scripts/backdate-completion.mjs - create it first, then run this again.' -ForegroundColor Red
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
Need ($prep.status -eq 200) 'preparing the listing'

function Stock {
    $rows = @((Call 'GET' "/shops/$techId/listings" $owner $null).json.data)
    return @($rows | Where-Object { $_.id -eq $lid })[0].stockQty
}

function SetStatus($orderId, $status) {
    return Call 'POST' "/shops/$techId/orders/$orderId/status" $owner @{ status = $status }
}

# kind: 'placed' (not completed), 'cash' (delivery, completed) or 'online' (pickup, paid, completed)
function NewOrder($kind) {
    Call 'DELETE' '/cart' $cust $null | Out-Null
    $add = Call 'POST' '/cart/items' $cust @{ listingId = $lid; quantity = 1 }
    Need ($add.status -eq 200) 'adding the item to the cart'
    if ($kind -eq 'online') {
        $choice = @{ shopId = $techId; deliveryMethod = 'STORE_PICKUP'; paymentMethod = 'ONLINE' }
    } else {
        $choice = @{ shopId = $techId; deliveryMethod = 'VENDOR_DELIVERY'; paymentMethod = 'CASH_ON_DELIVERY'; deliveryAddress = 'House 12, Road 5, Dhanmondi, Dhaka' }
    }
    $r = Call 'POST' '/checkout' $cust @{ shops = @($choice) }
    Need ($r.status -eq 201) 'the checkout'
    $id = $r.json.data.orders[0].id
    if ($kind -eq 'online') {
        Call 'POST' "/orders/$id/pay-mock" $cust $null | Out-Null
        $steps = @('CONFIRMED', 'READY_FOR_PICKUP', 'COMPLETED')
    } elseif ($kind -eq 'cash') {
        $steps = @('CONFIRMED', 'OUT_FOR_DELIVERY', 'COMPLETED')
    } else {
        $steps = @()
    }
    foreach ($s in $steps) {
        $st = SetStatus $id $s
        Need ($st.status -eq 200) "moving the order to $s"
    }
    return $id
}

function AskReturn($orderId, $token, $reason, $description) {
    return Call 'POST' "/orders/$orderId/returns" $token @{ reason = $reason; description = $description }
}

# ---- 1. the shop's return policy ----
$policy = 'Defective or wrong items can be returned within 7 days of delivery.'
$r = Call 'PATCH' "/shops/$techId" $owner @{ returnPolicy = $policy; returnWindowDays = 7 }
Check 'the owner sets a return policy' $r.status 200
Check 'the window is saved' $r.json.data.returnWindowDays 7
$r = Call 'PATCH' "/shops/$techId" $owner @{ returnWindowDays = 99 }
Check 'a window over 60 days is rejected' $r.status 400
$r = Call 'PATCH' "/shops/$techId" $staff @{ returnWindowDays = 3 }
Check 'staff cannot change the policy' $r.status 403
$r = Call 'GET' '/shops/techzone-electronics' $null $null
Check 'the storefront shows the window' $r.json.data.returnPolicy.windowDays 7
Check 'the storefront shows the policy text' $r.json.data.returnPolicy.text $policy

# ---- 2. asking for a return ----
$placed = NewOrder 'placed'
$r = AskReturn $placed $cust 'DEFECTIVE' 'The screen flickers after one day.'
Check 'an unfinished order cannot be returned' $r.status 409
Call 'POST' "/orders/$placed/cancel" $cust @{} | Out-Null

$o1 = NewOrder 'cash'
$r = AskReturn $o1 $owner3 'DEFECTIVE' 'The screen flickers after one day.'
Check 'someone else cannot return my order' $r.status 404
$r = AskReturn $o1 $cust 'BROKEN' 'The screen flickers after one day.'
Check 'an unknown reason is rejected' $r.status 400
$r = AskReturn $o1 $cust 'DEFECTIVE' 'bad'
Check 'a too-short description is rejected' $r.status 400
$r = AskReturn $o1 $cust 'DEFECTIVE' 'The screen flickers after one day.'
Check 'the customer asks for a return' $r.status 201
$ret1 = $r.json.data.id
Need $ret1 'the first return request'
Check 'the return starts as REQUESTED' $r.json.data.status 'REQUESTED'
Check 'the completion time is known' ($null -ne $r.json.data.order.completedAt) $true
$r = AskReturn $o1 $cust 'OTHER' 'Asking a second time for the same order.'
Check 'only one return per order' $r.status 409

# ---- 3. the return window ----
Call 'PATCH' "/shops/$techId" $owner @{ returnWindowDays = 0 } | Out-Null
$o0 = NewOrder 'cash'
$r = AskReturn $o0 $cust 'CHANGED_MIND' 'I do not need it any more.'
Check 'a shop with window 0 accepts no returns' $r.status 409
Call 'PATCH' "/shops/$techId" $owner @{ returnWindowDays = 7 } | Out-Null
$old = NewOrder 'cash'
& node --env-file=.env scripts/backdate-completion.mjs $old 8 | Out-Null
$r = AskReturn $old $cust 'CHANGED_MIND' 'I do not need it any more.'
Check 'a return after the window is rejected' $r.status 409

# ---- 4. who can see it ----
$r = Call 'GET' '/returns' $cust $null
Check 'the customer lists their returns' @($r.json.data | Where-Object { $_.id -eq $ret1 }).Count 1
$r = Call 'GET' "/returns?orderId=$o1" $cust $null
Check 'the order filter works' @($r.json.data).Count 1
$r = Call 'GET' "/returns/$ret1" $cust $null
Check 'the customer opens the return' $r.status 200
Check 'the customer cannot answer it' $r.json.data.actions.respond $false
$r = Call 'GET' "/returns/$ret1" $owner $null
Check 'the shop owner opens the return' $r.status 200
Check 'the shop can answer it' $r.json.data.actions.respond $true
Check 'the shop sees the customer name' $r.json.data.customer.name 'Test Customer'
$r = Call 'GET' "/returns/$ret1" $staff $null
Check 'shop staff can open it' $r.status 200
$r = Call 'GET' "/returns/$ret1" $admin $null
Check 'an admin can open it' $r.status 200
$r = Call 'GET' "/returns/$ret1" $owner3 $null
Check 'another shop gets 404' $r.status 404
$r = Call 'GET' "/shops/$techId/returns" $owner $null
Check 'the shop lists its returns' @($r.json.data | Where-Object { $_.id -eq $ret1 }).Count 1
$r = Call 'GET' "/shops/$techId/returns" $cust $null
Check 'a customer cannot open the shop list' $r.status 403
$r = Call 'GET' "/shops/$techId/returns" $owner3 $null
Check 'another shop cannot open the shop list' $r.status 403

# ---- 5. the shop answers ----
$reject = @{ decision = 'REJECT'; note = 'Our test shows the screen works; please bring it to the shop.' }
$r = Call 'POST' "/returns/$ret1/respond" $cust $reject
Check 'a customer cannot answer' $r.status 403
$r = Call 'POST' "/returns/$ret1/respond" $owner3 $reject
Check 'another shop cannot answer' $r.status 404
$r = Call 'POST' "/returns/$ret1/respond" $owner @{ decision = 'REJECT' }
Check 'a rejection needs a note' $r.status 400
$r = Call 'POST' "/returns/$ret1/respond" $owner $reject
Check 'the shop rejects with a note' $r.status 200
Check 'the return is REJECTED' $r.json.data.status 'REJECTED'
Check 'the note is shown' $r.json.data.resolutionNote $reject.note
$r = Call 'POST' "/returns/$ret1/respond" $owner $reject
Check 'answering twice is rejected' $r.status 409

# approve a paid online order and put the unit back in stock
$o2 = NewOrder 'online'
$r = AskReturn $o2 $cust 'WRONG_ITEM' 'I received the wrong colour.'
$ret2 = $r.json.data.id
Need $ret2 'the second return request'
$s0 = Stock
$r = Call 'POST' "/returns/$ret2/respond" $staff @{ decision = 'APPROVE'; note = 'Sorry about that.'; restock = $true }
Check 'shop staff approve the return' $r.status 200
Check 'the return is REFUNDED' $r.json.data.status 'REFUNDED'
$mine = Call 'GET' "/orders/$o2" $cust $null
Check 'the online payment is refunded' $mine.json.data.paymentStatus 'REFUNDED'
Check 'the returned unit is back in stock' (Stock) ($s0 + 1)

# approve a cash order without restocking (for example a damaged item)
$o3 = NewOrder 'cash'
$r = AskReturn $o3 $cust 'DEFECTIVE' 'The charger port is broken.'
$ret3 = $r.json.data.id
Need $ret3 'the third return request'
$s1 = Stock
$r = Call 'POST' "/returns/$ret3/respond" $owner @{ decision = 'APPROVE' }
Check 'the owner approves without restocking' $r.status 200
$mine = Call 'GET' "/orders/$o3" $cust $null
Check 'the cash payment is marked refunded' $mine.json.data.paymentStatus 'REFUNDED'
Check 'the stock did not change' (Stock) $s1

# ---- 6. audit ----
$a = Call 'GET' "/admin/audit-logs?entityType=ReturnRequest&entityId=$ret1" $admin $null
Check 'requests and answers are audited' (@($a.json.data).Count -ge 2) $true

Call 'DELETE' '/cart' $cust $null | Out-Null

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
Write-Host 'Orders and returns were created. run-all-tests.ps1 reseeds the demo data first.'