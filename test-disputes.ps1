# test-disputes.ps1 (returns and disputes, part B, with return notifications)
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

function Latest($token) { return @((Call 'GET' '/notifications?limit=5' $token $null).json.data)[0] }

try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}

$cust = Login 'customer@vendorshub.test'
$owner = Login 'owner1@vendorshub.test'    # TechZone owner
$staff = Login 'owner2@vendorshub.test'    # staff at TechZone
$owner3 = Login 'owner3@vendorshub.test'   # another shop
$admin = Login 'admin@vendorshub.test'

# ---- setup: TechZone A55 in stock, 7-day return window ----
$techId = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id
$p = Call 'GET' '/products/galaxy-a55-5g-8-128gb' $null $null
$all = @($p.json.data.selectedListing) + @($p.json.data.otherListings)
$lid = (@($all | Where-Object { $_.shop.id -eq $techId }))[0].id
$prep = Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ availability = 'IN_STOCK'; stockQty = 50 }
Need ($prep.status -eq 200) 'preparing the listing'
Call 'PATCH' "/shops/$techId" $owner @{ returnWindowDays = 7 } | Out-Null

function Stock {
    $rows = @((Call 'GET' "/shops/$techId/listings" $owner $null).json.data)
    return @($rows | Where-Object { $_.id -eq $lid })[0].stockQty
}

# a delivered and completed cash order
function CompletedOrder {
    Call 'DELETE' '/cart' $cust $null | Out-Null
    $add = Call 'POST' '/cart/items' $cust @{ listingId = $lid; quantity = 1 }
    Need ($add.status -eq 200) 'adding the item to the cart'
    $choice = @{ shopId = $techId; deliveryMethod = 'VENDOR_DELIVERY'; paymentMethod = 'CASH_ON_DELIVERY'; deliveryAddress = 'House 12, Road 5, Dhanmondi, Dhaka' }
    $r = Call 'POST' '/checkout' $cust @{ shops = @($choice) }
    Need ($r.status -eq 201) 'the checkout'
    $id = $r.json.data.orders[0].id
    foreach ($s in @('CONFIRMED', 'OUT_FOR_DELIVERY', 'COMPLETED')) {
        $st = Call 'POST' "/shops/$techId/orders/$id/status" $owner @{ status = $s }
        Need ($st.status -eq 200) "moving the order to $s"
    }
    return $id
}

function AskReturn($orderId, $description) {
    return Call 'POST' "/orders/$orderId/returns" $cust @{ reason = 'NOT_AS_DESCRIBED'; description = $description }
}

# ---- 1. the request and the conversation ----
$o1 = CompletedOrder
$r = AskReturn $o1 'The battery lasts only two hours, not a full day.'
$ret1 = $r.json.data.id
Need $ret1 'the return request'
Check 'the shop owner is told about the request' (Latest $owner).type 'RETURN_REQUESTED'
Check 'TechZone staff are told too' (Latest $staff).type 'RETURN_REQUESTED'

$r = Call 'POST' "/returns/$ret1/messages" $cust @{ body = 'Can I bring it in on Saturday?' }
Check 'the customer writes a message' $r.status 201
Check 'the message is in the thread' @($r.json.data.messages).Count 1
Check 'the shop is told about the message' (Latest $owner).type 'RETURN_MESSAGE'
$r = Call 'POST' "/returns/$ret1/messages" $staff @{ body = 'Yes, Saturday works. Bring the charger too.' }
Check 'shop staff reply' $r.status 201
Check 'the reply is marked as from the shop' @($r.json.data.messages)[-1].authorRole 'SHOP'
Check 'the customer is told about the reply' (Latest $cust).type 'RETURN_MESSAGE'
$r = Call 'POST' "/returns/$ret1/messages" $owner3 @{ body = 'Hello from another shop.' }
Check 'another shop cannot write' $r.status 404
$r = Call 'POST' "/returns/$ret1/messages" $cust @{ body = '' }
Check 'an empty message is rejected' $r.status 400
$r = Call 'POST' "/returns/$ret1/escalate" $cust @{ reason = 'The shop has not decided anything yet.' }
Check 'escalation needs a rejection first' $r.status 409

# ---- 2. rejection and escalation ----
$shopNote = 'Battery life depends on usage; the phone tested fine.'
$r = Call 'POST' "/returns/$ret1/respond" $owner @{ decision = 'REJECT'; note = $shopNote }
Check 'the shop rejects' $r.status 200
Check 'the rejection note joins the thread' @($r.json.data.messages)[-1].body $shopNote
Check 'the customer is told about the rejection' (Latest $cust).type 'RETURN_REJECTED'
$c = Call 'GET' "/returns/$ret1" $cust $null
Check 'the customer may now escalate' $c.json.data.actions.escalate $true
$r = Call 'POST' "/returns/$ret1/escalate" $owner @{ reason = 'The shop tries to escalate its own case.' }
Check 'only the customer can escalate' $r.status 404
$r = Call 'POST' "/returns/$ret1/escalate" $cust @{ reason = 'short' }
Check 'an escalation needs a real reason' $r.status 400
$r = Call 'POST' "/returns/$ret1/escalate" $cust @{ reason = 'The battery is clearly faulty; I have the battery health report.' }
Check 'the customer escalates' $r.status 200
Check 'the return is ESCALATED' $r.json.data.status 'ESCALATED'
Check 'the admin is told' (Latest $admin).type 'RETURN_ESCALATED'
Check 'the shop is told too' (Latest $owner).type 'RETURN_ESCALATED'
$r = Call 'POST' "/returns/$ret1/escalate" $cust @{ reason = 'Escalating a second time for no reason.' }
Check 'escalating twice is rejected' $r.status 409

# ---- 3. the admin's queue ----
$r = Call 'GET' '/admin/disputes' $admin $null
Check 'the dispute is in the admin queue' @($r.json.data | Where-Object { $_.id -eq $ret1 }).Count 1
$r = Call 'GET' "/returns/$ret1" $admin $null
Check 'the admin may resolve it' $r.json.data.actions.resolve $true
$r = Call 'GET' '/admin/disputes' $cust $null
Check 'a customer cannot open the queue' $r.status 403
$r = Call 'GET' '/admin/disputes' $owner $null
Check 'a shop owner cannot open the queue' $r.status 403
$r = Call 'GET' '/admin/disputes?status=ALL' $admin $null
Check 'the queue can show every return' $r.status 200

# ---- 4. the admin decides: refund ----
$s0 = Stock
$r = Call 'POST' "/admin/returns/$ret1/resolve" $owner @{ decision = 'APPROVE'; note = 'Shop tries to decide.' }
Check 'only an admin can resolve' $r.status 403
$r = Call 'POST' "/admin/returns/$ret1/resolve" $admin @{ decision = 'APPROVE' }
Check 'a decision needs a note' $r.status 400
$adminNote = 'The battery report confirms a fault. Refund approved.'
$r = Call 'POST' "/admin/returns/$ret1/resolve" $admin @{ decision = 'APPROVE'; note = $adminNote }
Check 'the admin approves a refund' $r.status 200
Check 'the return is REFUNDED' $r.json.data.status 'REFUNDED'
Check 'the admin note is the final note' $r.json.data.resolutionNote $adminNote
Check 'the thread keeps the shop note too' @($r.json.data.messages | Where-Object { $_.body -eq $shopNote }).Count 1
$mine = Call 'GET' "/orders/$o1" $cust $null
Check 'the payment is refunded' $mine.json.data.paymentStatus 'REFUNDED'
Check 'the stock did not change (restock was not asked)' (Stock) $s0
Check 'the customer is told about the decision' (Latest $cust).type 'RETURN_RESOLVED'
Check 'the shop is told about the decision' (Latest $owner).type 'RETURN_RESOLVED'
$r = Call 'POST' "/admin/returns/$ret1/resolve" $admin @{ decision = 'REJECT'; note = 'Changing my mind.' }
Check 'a decision is final' $r.status 409
$r = Call 'POST' "/returns/$ret1/messages" $cust @{ body = 'Thank you!' }
Check 'a decided return is closed for messages' $r.status 409
$r = Call 'GET' '/admin/disputes' $admin $null
Check 'it leaves the waiting queue' @($r.json.data | Where-Object { $_.id -eq $ret1 }).Count 0

# ---- 5. the admin decides: close without refund ----
$o2 = CompletedOrder
$r = AskReturn $o2 'The colour looks different from the photos.'
$ret2 = $r.json.data.id
Need $ret2 'the second return request'
Call 'POST' "/returns/$ret2/respond" $owner @{ decision = 'REJECT'; note = 'The colour matches the product page.' } | Out-Null
Call 'POST' "/returns/$ret2/escalate" $cust @{ reason = 'The photos show a much lighter colour than I received.' } | Out-Null
$r = Call 'POST' "/admin/returns/$ret2/resolve" $admin @{ decision = 'REJECT'; note = 'The colour matches the photos under normal light.' }
Check 'the admin closes the dispute' $r.status 200
Check 'the return is CLOSED' $r.json.data.status 'CLOSED'
$mine = Call 'GET' "/orders/$o2" $cust $null
Check 'a closed dispute refunds nothing' $mine.json.data.paymentStatus 'PAID'

# ---- 6. audit ----
$a = Call 'GET' "/admin/audit-logs?entityType=ReturnRequest&entityId=$ret1" $admin $null
Check 'request, rejection, escalation and decision are audited' (@($a.json.data).Count -ge 4) $true

Call 'DELETE' '/cart' $cust $null | Out-Null

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"