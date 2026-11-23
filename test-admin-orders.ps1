# test-admin-orders.ps1 (admin order monitor: list, late rules, detail, chat, cancel, notes, reminders)
# Run from the project root while "npm run dev" is running in another terminal (mock modes).
# Every order this suite makes is deleted again at the end (scripts/admin-orders-test-helper.mjs cleanup).
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
        return @{ status = [int]$r.StatusCode; json = ($r.Content | ConvertFrom-Json); raw = $r.Content }
    } catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { return @{ status = 0; json = $null; raw = '' } }
        $text = $_.ErrorDetails.Message
        $json = $null
        try { $json = $text | ConvertFrom-Json } catch { }
        if ($null -ne $json -and $null -ne $json.error) { $script:lastMsg = $json.error.message }
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

try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}

$since = [DateTime]::UtcNow.AddSeconds(-2).ToString('o')
$cust = Login 'customer@vendorshub.test'
$owner = Login 'owner1@vendorshub.test'
$admin = Login 'admin@vendorshub.test'
$adminName = (Call 'GET' '/auth/me' $admin $null).json.data.name
$techId = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id
$mine = @((Call 'GET' "/shops/$techId/listings" $owner $null).json.data | Where-Object { $_.isActive -ne $false })
$l = $mine[0]; $lid = $l.id
$origStock = $l.stockQty; $origAvail = $l.availability
$script:orders = @()

function Cleanup {
    foreach ($o in $script:orders) { Call 'POST' "/admin/orders/$o/cancel" $admin @{ reason = 'Test cleanup' } | Out-Null }
    Call 'DELETE' '/cart' $cust $null | Out-Null
    $restore = @{ stockQty = $origStock }
    if ($null -eq $origStock) { $restore.availability = $origAvail }
    Call 'PATCH' "/shops/$techId/listings/$lid" $owner $restore | Out-Null
    if ($script:orders.Count -gt 0) {
        $out = node --env-file=.env scripts/admin-orders-test-helper.mjs cleanup $since $lid @($script:orders) | Select-Object -Last 1 | ConvertFrom-Json
        Write-Host "INFO  cleanup: $($out.orders) orders, $($out.notifications) notifications, $($out.auditLogs) audit entries removed"
        return $out
    }
}
function Need($value, $what) {
    if (-not $value) {
        Write-Host "Cannot continue: $what failed. Server said: $($script:lastMsg)" -ForegroundColor Red
        Cleanup | Out-Null
        exit 1
    }
}
function Order($delivery, $payment) {
    Call 'DELETE' '/cart' $cust $null | Out-Null
    Need ((Call 'POST' '/cart/items' $cust @{ listingId = $lid; quantity = 1 }).status -eq 200) 'adding to the cart'
    $choice = @{ shopId = $techId; deliveryMethod = $delivery; paymentMethod = $payment }
    if ($delivery -eq 'VENDOR_DELIVERY') { $choice.deliveryAddress = 'House 12, Road 5, Dhanmondi, Dhaka' }
    $r = Call 'POST' '/checkout' $cust @{ shops = @($choice) }
    Need ($r.status -eq 201) 'the checkout'
    $o = $r.json.data.orders[0]
    $script:orders += $o.id
    return $o
}
function Backdate($id, $createdH, $statusH) { node --env-file=.env scripts/admin-orders-test-helper.mjs backdate $id $createdH $statusH | Out-Null }
function Step($id, $token, $status) { return Call 'POST' "/shops/$techId/orders/$id/status" $token @{ status = $status } }
function Rows($query) { return @((Call 'GET' "/admin/orders?$query" $admin $null).json.data) }
function Stock { return @((Call 'GET' "/shops/$techId/listings" $owner $null).json.data | Where-Object { $_.id -eq $lid })[0].stockQty }
function Notes($token, $type, $orderId) { return @((Call 'GET' '/notifications?limit=50' $token $null).json.data | Where-Object { $_.type -eq $type -and $_.data.orderId -eq $orderId }).Count }

Need ((Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ availability = 'IN_STOCK'; stockQty = 50 }).status -eq 200) 'preparing the listing'

# ---- 1. access ----
Check 'no login -> 401' (Call 'GET' '/admin/orders' $null $null).status 401
Check 'customer -> 403' (Call 'GET' '/admin/orders' $cust $null).status 403
Check 'shop owner -> 403' (Call 'GET' '/admin/orders' $owner $null).status 403
Check 'shop owner cannot read the chat -> 403' (Call 'GET' "/admin/orders/$([guid]::NewGuid())/messages" $owner $null).status 403

# ---- 2. orders to watch ----
$o1 = Order 'VENDOR_DELIVERY' 'CASH_ON_DELIVERY'   # stays PLACED -> unconfirmed when backdated
$o2 = Order 'STORE_PICKUP' 'PAY_AT_STORE'          # READY_FOR_PICKUP -> pickup late
$o3 = Order 'VENDOR_DELIVERY' 'CASH_ON_DELIVERY'   # OUT_FOR_DELIVERY -> delivery late
$o4 = Order 'STORE_PICKUP' 'PAY_AT_STORE'          # fresh, not late; cancelled by the admin

# ---- 3. the list ----
$r = Call 'GET' "/admin/orders?q=$($o1.orderNumber)" $admin $null
Check 'list -> 200' $r.status 200
$row = @($r.json.data)
Check 'search by order number finds it' "$($row.Count)/$($row[0].id)" "1/$($o1.id)"
Check 'row fields' ((@($row[0].PSObject.Properties.Name) | Sort-Object) -join ',') 'createdAt,customer,delivery,id,lastStatusAt,lateReason,messageCount,openReturn,orderNumber,payment,shop,status,total'
Check 'row shop' "$($row[0].shop.id)/$($row[0].shop.slug)" "$techId/techzone-electronics"
Check 'row customer has name and phone only' ((@($row[0].customer.PSObject.Properties.Name) | Sort-Object) -join ',') 'name,phone'
Check 'row delivery + payment' "$($row[0].delivery.method)/$($row[0].payment.method)/$($row[0].payment.status)" 'VENDOR_DELIVERY/CASH_ON_DELIVERY/PENDING'
Check 'fresh order: not late' $row[0].lateReason $null
Check 'no return, no chat yet' "$($row[0].openReturn)/$($row[0].messageCount)" 'False/0'
Check 'counts per status present' ((@($r.json.meta.counts.byStatus.PSObject.Properties.Name) | Sort-Object) -join ',') 'CANCELLED,COMPLETED,CONFIRMED,OUT_FOR_DELIVERY,PLACED,READY_FOR_PICKUP'
Check 'counts per late reason present' ((@($r.json.meta.counts.byLate.PSObject.Properties.Name) | Sort-Object) -join ',') 'any,delivery,pickup,unconfirmed'
Check 'counts follow the search (1 PLACED)' $r.json.meta.counts.byStatus.PLACED 1
$custEmail = (Call 'GET' '/auth/me' $cust $null).json.data.email
Check 'search by customer email' (@(Rows "q=$custEmail&limit=100" | Where-Object { $_.id -eq $o4.id }).Count) 1
Check 'filter shopId + deliveryMethod + paymentMethod' (@(Rows "shopId=$techId&deliveryMethod=STORE_PICKUP&paymentMethod=PAY_AT_STORE&limit=100" | Where-Object { $_.id -eq $o2.id -or $_.id -eq $o1.id }).Count) 1
$today = [DateTime]::UtcNow.AddHours(6).ToString('yyyy-MM-dd')
$tomorrow = [DateTime]::UtcNow.AddHours(30).ToString('yyyy-MM-dd')
Check 'from/to today includes it' (@(Rows "q=$($o4.orderNumber)&from=$today&to=$today").Count) 1
Check 'from tomorrow excludes it' (@(Rows "q=$($o4.orderNumber)&from=$tomorrow").Count) 0
Check 'from after to -> 400' (Call 'GET' "/admin/orders?from=$tomorrow&to=$today" $admin $null).status 400
Check 'bad late value -> 400' (Call 'GET' '/admin/orders?late=soon' $admin $null).status 400
Check 'bad date -> 400' (Call 'GET' '/admin/orders?from=23-11-2026' $admin $null).status 400
$p1 = Call 'GET' "/admin/orders?shopId=$techId&limit=2&page=1" $admin $null
Check 'paging: 2 per page' @($p1.json.data).Count 2
Check 'paging: total at least 4' ($p1.json.meta.pagination.total -ge 4) $true

# ---- 4. ADMIN actor on the shop endpoints (the fix) ----
Check 'owner confirms o2' (Step $o2.id $owner 'CONFIRMED').status 200
Check 'admin confirms o3 through the shop endpoint' (Step $o3.id $admin 'CONFIRMED').status 200
$t2 = @((Call 'GET' "/orders/$($o2.id)" $cust $null).json.data.statusEvents)
$t3 = @((Call 'GET' "/orders/$($o3.id)" $cust $null).json.data.statusEvents)
Check 'the shop change says SHOP' $t2[-1].actorRole 'SHOP'
Check 'the admin change says ADMIN' $t3[-1].actorRole 'ADMIN'
Check 'the customer timeline has no actor name or id' ((@($t3[-1].PSObject.Properties.Name) | Sort-Object) -join ',') 'actorRole,createdAt,note,status'
Check 'o2 ready for pickup' (Step $o2.id $owner 'READY_FOR_PICKUP').status 200
Check 'o3 out for delivery' (Step $o3.id $owner 'OUT_FOR_DELIVERY').status 200

# ---- 5. late rules ----
Backdate $o1.id 1 1
Check 'PLACED 1 h ago: not late' (@(Rows "late=unconfirmed&q=$($o1.orderNumber)").Count) 0
Backdate $o1.id 3 3
$lr = @(Rows "late=unconfirmed&q=$($o1.orderNumber)")
Check 'PLACED 3 h ago: late unconfirmed' "$($lr.Count)/$($lr[0].lateReason)" '1/unconfirmed'
Backdate $o2.id 100 70
Check 'ready for pickup 70 h: not late yet' (@(Rows "late=pickup&q=$($o2.orderNumber)").Count) 0
Backdate $o2.id 100 73
Check 'ready for pickup 73 h (over 3 days): late pickup' (@(Rows "late=pickup&q=$($o2.orderNumber)")[0].lateReason) 'pickup'
Backdate $o3.id 60 47
Check 'out for delivery 47 h: not late' (@(Rows "late=delivery&q=$($o3.orderNumber)").Count) 0
Backdate $o3.id 60 49
Check 'out for delivery 49 h: late delivery' (@(Rows "late=delivery&q=$($o3.orderNumber)")[0].lateReason) 'delivery'
Check 'old createdAt alone does not make a delivery late (o3 in unconfirmed: no)' (@(Rows "late=unconfirmed&q=$($o3.orderNumber)").Count) 0
$anyIds = @(Rows "late=any&shopId=$techId&limit=100" | ForEach-Object { $_.id })
Check 'late=any has all three' (@($o1.id, $o2.id, $o3.id) | Where-Object { $anyIds -contains $_ }).Count 3
Check 'late=any leaves the fresh one out' ($anyIds -contains $o4.id) $false
$cnt = (Call 'GET' "/admin/orders?shopId=$techId" $admin $null).json.meta.counts.byLate
Check 'late counts add up' $cnt.any ($cnt.unconfirmed + $cnt.delivery + $cnt.pickup)
Check 'late counts include ours' (($cnt.unconfirmed -ge 1) -and ($cnt.delivery -ge 1) -and ($cnt.pickup -ge 1)) $true

# ---- 6. dashboard ----
$dash = (Call 'GET' '/dashboard/admin' $admin $null).json.data
Check 'dashboard ordersLate at least 3' ($dash.ordersLate -ge 3) $true
Check 'dashboard ordersToday at least 1 (o4)' ($dash.ordersToday -ge 1) $true

# ---- 7. detail ----
$d = Call 'GET' "/admin/orders/$($o3.id)" $admin $null
Check 'detail -> 200' $d.status 200
$dd = $d.json.data
Check 'detail has items' @($dd.items).Count 1
Check 'detail has the delivery address' ($dd.delivery.address -like 'House 12*') $true
Check 'detail coupon / discount / credit' "$($dd.couponCode)/$($dd.discount)/$($dd.creditUsed)" '/0/0'
Check 'timeline: PLACED, CONFIRMED, OUT_FOR_DELIVERY' ((@($dd.statusEvents | ForEach-Object { $_.status })) -join ',') 'PLACED,CONFIRMED,OUT_FOR_DELIVERY'
Check 'timeline: the admin row carries the admin name' (@($dd.statusEvents)[1].actorName) $adminName
Check 'timeline: the shop row has no name' "$(@($dd.statusEvents)[2].actorRole)/$(@($dd.statusEvents)[2].actorName)" 'SHOP/'
Check 'timeline: the customer row has no name' (@($dd.statusEvents)[0].actorName) $null
Check 'customer contact' ($dd.customer.email -eq $custEmail) $true
Check 'shop contact' "$($dd.shop.slug)/$([bool]$dd.shop.owner.email)" 'techzone-electronics/True'
Check 'payments / returns / notes are lists' "$(@($dd.payments).Count)/$(@($dd.returns).Count)/$(@($dd.adminNotes).Count)" '0/0/0'
Check 'detail lateReason' $dd.lateReason 'delivery'
Check 'unknown order -> 404' (Call 'GET' "/admin/orders/$([guid]::NewGuid())" $admin $null).status 404
Check 'malformed id -> 404' (Call 'GET' '/admin/orders/not-an-id' $admin $null).status 404

# ---- 8. read-only chat ----
Check 'customer writes on o1' (Call 'POST' "/orders/$($o1.id)/messages" $cust @{ body = 'Is my order coming?' }).status 201
$c = Call 'GET' "/admin/orders/$($o1.id)/messages" $admin $null
Check 'admin reads the chat' "$($c.status)/$(@($c.json.data.messages).Count)/$($c.json.data.readOnly)" '200/1/True'
Check 'message body visible' (@($c.json.data.messages)[0].body) 'Is my order coming?'
$act = @((Call 'GET' '/dashboard/admin' $admin $null).json.data.recentActivity)
Check 'the read is audited as order.chat_viewed' (@($act | Where-Object { $_.action -eq 'order.chat_viewed' -and $_.entityId -eq $o1.id }).Count -ge 1) $true
Check 'messageCount on the row' (@(Rows "q=$($o1.orderNumber)")[0].messageCount) 1
Check 'admin cannot write through it (no POST)' (Call 'POST' "/admin/orders/$($o1.id)/messages" $admin @{ body = 'x' }).status 404
Check 'chat of an unknown order -> 404' (Call 'GET' "/admin/orders/$([guid]::NewGuid())/messages" $admin $null).status 404

# ---- 9. internal notes ----
$secret = "Internal check $(Get-Random)"
$n = Call 'POST' "/admin/orders/$($o3.id)/notes" $admin @{ body = $secret }
Check 'note -> 201' $n.status 201
Check 'note author is the admin' $n.json.data.author.name $adminName
Check 'empty note -> 400' (Call 'POST' "/admin/orders/$($o3.id)/notes" $admin @{ body = '  ' }).status 400
Check '501 characters -> 400' (Call 'POST' "/admin/orders/$($o3.id)/notes" $admin @{ body = ('x' * 501) }).status 400
Check '500 characters -> 201' (Call 'POST' "/admin/orders/$($o3.id)/notes" $admin @{ body = ('y' * 500) }).status 201
Check 'notes in the detail' @((Call 'GET' "/admin/orders/$($o3.id)" $admin $null).json.data.adminNotes).Count 2
Check 'the customer never sees the note' ((Call 'GET' "/orders/$($o3.id)" $cust $null).raw -like "*$secret*") $false
Check 'the shop never sees the note' ((Call 'GET' "/shops/$techId/orders/$($o3.id)" $owner $null).raw -like "*$secret*") $false
Check 'owner cannot add notes -> 403' (Call 'POST' "/admin/orders/$($o3.id)/notes" $owner @{ body = 'hi' }).status 403

# ---- 10. remind the shop ----
$rm = Call 'POST' "/admin/orders/$($o1.id)/remind-shop" $admin $null
Check 'remind a late order -> 200' "$($rm.status)/$($rm.json.data.lateReason)" '200/unconfirmed'
Check 'the shop got ORDER_LATE_REMINDER' (Notes $owner 'ORDER_LATE_REMINDER' $o1.id) 1
$again = Call 'POST' "/admin/orders/$($o1.id)/remind-shop" $admin $null
Check 'again within the hour -> 429' "$($again.status)/$($again.json.error.details.code)" '429/REMINDER_TOO_SOON'
Check 'it says when to retry' ([bool]$again.json.error.details.retryAt) $true
Check 'still one reminder' (Notes $owner 'ORDER_LATE_REMINDER' $o1.id) 1
$nl = Call 'POST' "/admin/orders/$($o4.id)/remind-shop" $admin $null
Check 'not late -> 409 ORDER_NOT_LATE' "$($nl.status)/$($nl.json.error.details.code)" '409/ORDER_NOT_LATE'

# ---- 11. admin cancel ----
$before = Stock
Check 'cancel without a reason -> 400' (Call 'POST' "/admin/orders/$($o4.id)/cancel" $admin @{}).status 400
$cx = Call 'POST' "/admin/orders/$($o4.id)/cancel" $admin @{ reason = 'Customer called support' }
Check 'admin cancel -> 200' "$($cx.status)/$($cx.json.data.status)" '200/CANCELLED'
Check 'cancel event: ADMIN with the admin name' "$(@($cx.json.data.statusEvents)[-1].actorRole)/$(@($cx.json.data.statusEvents)[-1].actorName)" "ADMIN/$adminName"
Check 'cancel note is the reason' (@($cx.json.data.statusEvents)[-1].note) 'Customer called support'
Check 'no refund needed for pay at store' $cx.json.data.refundNeeded $false
Check 'stock came back' ((Stock) - $before) 1
Check 'the customer was notified' (Notes $cust 'ORDER_STATUS' $o4.id) 1
Check 'the shop was notified' (Notes $owner 'ORDER_CANCELLED' $o4.id) 1
Check 'the customer sees ADMIN in the timeline' (@((Call 'GET' "/orders/$($o4.id)" $cust $null).json.data.statusEvents)[-1].actorRole) 'ADMIN'
$c2 = Call 'POST' "/admin/orders/$($o4.id)/cancel" $admin @{ reason = 'Again' }
Check 'cancel twice -> 409 ORDER_CLOSED' "$($c2.status)/$($c2.json.error.details.code)" '409/ORDER_CLOSED'
Check 'owner cannot use admin cancel -> 403' (Call 'POST' "/admin/orders/$($o1.id)/cancel" $owner @{ reason = 'Nope' }).status 403

# a paid ONLINE order: refunded through the payment adapter (mock)
$o5 = Order 'VENDOR_DELIVERY' 'ONLINE'
Check 'o5 paid (mock)' (Call 'POST' "/orders/$($o5.id)/pay-mock" $cust $null).status 200
$cx5 = Call 'POST' "/admin/orders/$($o5.id)/cancel" $admin @{ reason = 'Shop closed for repairs' }
Check 'paid online: refundNeeded' $cx5.json.data.refundNeeded $true
Check 'paid online: payment refunded' $cx5.json.data.payment.status 'REFUNDED'
Check 'paid online: payment record refunded' (@($cx5.json.data.payments | Where-Object { $_.status -eq 'REFUNDED' }).Count -ge 1) $true

# ---- 12. cleanup: no test data left ----
$out = Cleanup
Check 'cleanup removed every test order' $out.orders $script:orders.Count
Check 'stock is back to what it was' (Stock) $origStock

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
