# test-reservations.ps1
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

$techId = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id
$rows = @((Call 'GET' "/shops/$techId/listings" $owner $null).json.data | Where-Object { $_.isActive -ne $false })
$lid = $rows[0].id
Check 'listing prepared' (Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ availability = 'IN_STOCK'; stockQty = 50 }).status 200
function Stock { return @((Call 'GET' "/shops/$techId/listings" $owner $null).json.data | Where-Object { $_.id -eq $lid })[0].stockQty }
function Sweep($minutes) { return (node --env-file=.env scripts/run-reservation-sweep.mjs "--minutes-ahead=$minutes" | Select-Object -Last 1 | ConvertFrom-Json) }
function Reserve($payment) {
    Call 'DELETE' '/cart' $cust $null | Out-Null
    $add = Call 'POST' '/cart/items' $cust @{ listingId = $lid; quantity = 1 }
    Need ($add.status -eq 200) 'adding the item to the cart'
    if (-not $payment) { $payment = 'PAY_AT_STORE' }
    return Call 'POST' '/checkout' $cust @{ shops = @(@{ shopId = $techId; deliveryMethod = 'RESERVE_PICKUP'; paymentMethod = $payment }) }
}
function Order($id) { return (Call 'GET' "/orders/$id" $cust $null).json.data }
function SetStatus($id, $status) { return Call 'POST' "/shops/$techId/orders/$id/status" $owner @{ status = $status } }

# start clean: a sweep far in the future cancels any open reservation left from an earlier run
Sweep 100000 | Out-Null

# ---- 1. placing a reservation ----
Check 'reservation needs PAY_AT_STORE' (Reserve 'ONLINE').status 400
$s0 = Stock
$r = Reserve
Check 'reserve -> 201' $r.status 201
$o1 = $r.json.data.orders[0]
Check 'deliveryMethod RESERVE_PICKUP' $o1.deliveryMethod 'RESERVE_PICKUP'
Check 'nothing paid now' $o1.paymentStatus 'PENDING'
$created = [datetime]$o1.createdAt
Check 'reservedUntil = +2 h' ([math]::Round(([datetime]$o1.reservedUntil - $created).TotalMinutes)) 120
Check 'confirmBy = +30 min' ([math]::Round(([datetime]$o1.confirmBy - $created).TotalMinutes)) 30
Check 'stock held' (Stock) ($s0 - 1)
$so = (Call 'GET' "/shops/$techId/orders/$($o1.id)" $owner $null).json.data
Check 'shop sees reservedUntil' ($null -ne $so.reservedUntil) $true
Check 'shop can confirm or cancel only' (($so.nextStatuses | Sort-Object) -join ',') 'CANCELLED,CONFIRMED'
$other = @((Call 'GET' '/orders?limit=50' $cust $null).json.data.items | Where-Object { $_.deliveryMethod -ne 'RESERVE_PICKUP' })
if ($other.Count) { Check 'other orders have reservedUntil null' $other[0].reservedUntil $null }
$r = Reserve; $o2 = $r.json.data.orders[0]
$r = Reserve; $o3 = $r.json.data.orders[0]
Check 'three open reservations' (@($o1, $o2, $o3) | Where-Object { $_.id }).Count 3

# ---- 2. the limit ----
$r = Reserve
Check '4th open reservation -> 409' $r.status 409
Check 'code RESERVATION_LIMIT' $r.json.error.details.code 'RESERVATION_LIMIT'
Call 'DELETE' '/cart' $cust $null | Out-Null

# ---- 3. nothing happens before the deadlines ----
$res = Sweep 0
Check 'sweep now: nothing cancelled' "$($res.notConfirmed)/$($res.expired)" '0/0'
Check 'o1 still PLACED' (Order $o1.id).status 'PLACED'

# o2: confirmed by the shop; o3: confirmed, ready and completed
Check 'o2 confirmed' (SetStatus $o2.id 'CONFIRMED').status 200
Check 'o3 confirmed' (SetStatus $o3.id 'CONFIRMED').status 200
Check 'o3 ready for pickup' (SetStatus $o3.id 'READY_FOR_PICKUP').status 200
Check 'o3 completed' (SetStatus $o3.id 'COMPLETED').status 200
Check 'out for delivery is not allowed' (SetStatus $o2.id 'OUT_FOR_DELIVERY').status 409

# ---- 4. not confirmed in 30 minutes (fake clock +31 min) ----
$s1 = Stock
$res = Sweep 31
Check 'one auto-cancel: not confirmed' "$($res.notConfirmed)/$($res.expired)" '1/0'
$d = Order $o1.id
Check 'o1 CANCELLED' $d.status 'CANCELLED'
$ev = @($d.statusEvents)[-1]
Check 'event by SYSTEM' $ev.actorRole 'SYSTEM'
Check 'event reason' $ev.note 'Shop did not confirm'
Check 'stock released' (Stock) ($s1 + 1)
Check 'confirmed o2 not touched at +31 min' (Order $o2.id).status 'CONFIRMED'
$n = @((Call 'GET' '/notifications?limit=20' $cust $null).json.data | Where-Object { $_.data.orderId -eq $o1.id -and $_.title -like 'Reservation*cancelled*' })
Check 'customer notified' $n.Count 1
$n = @((Call 'GET' '/notifications?limit=20' $owner $null).json.data | Where-Object { $_.data.orderId -eq $o1.id -and $_.title -like '*cancelled automatically*' })
Check 'shop notified' $n.Count 1

# ---- 5. expired at reservedUntil (fake clock +121 min) ----
$s2 = Stock
$res = Sweep 121
Check 'one auto-cancel: expired' "$($res.notConfirmed)/$($res.expired)" '0/1'
$d = Order $o2.id
Check 'o2 CANCELLED' $d.status 'CANCELLED'
Check 'reason expired' (@($d.statusEvents)[-1].note) 'Reservation expired'
Check 'stock released again' (Stock) ($s2 + 1)
Check 'completed o3 stays COMPLETED' (Order $o3.id).status 'COMPLETED'

# ---- 6. safe to run twice ----
$res = Sweep 121
Check 'second sweep changes nothing' "$($res.notConfirmed)/$($res.expired)" '0/0'
Check 'only one CANCELLED event' (@((Order $o2.id).statusEvents | Where-Object { $_.status -eq 'CANCELLED' }).Count) 1
Check 'stock not released twice' (Stock) ($s2 + 1)

# ---- 7. the limit frees up ----
$r = Reserve
Check 'a new reservation after the cancels' $r.status 201
Check 'customer may cancel it' (Call 'POST' "/orders/$($r.json.data.orders[0].id)/cancel" $cust @{ reason = 'Test' }).status 200

# ---- cleanup ----
Call 'DELETE' '/cart' $cust $null | Out-Null

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
if ($script:fail -gt 0) { exit 1 }
