# test-order-tracking.ps1
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

# ---- setup: the TechZone A55 listing with stock ----
$techId = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id
$p = Call 'GET' '/products/galaxy-a55-5g-8-128gb' $null $null
$all = @($p.json.data.selectedListing) + @($p.json.data.otherListings)
$lid = (@($all | Where-Object { $_.shop.id -eq $techId }))[0].id
$prep = Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ availability = 'IN_STOCK'; stockQty = 50 }
Check 'listing prepared' $prep.status 200

function NewOrder {
    Call 'DELETE' '/cart' $cust $null | Out-Null
    $add = Call 'POST' '/cart/items' $cust @{ listingId = $lid; quantity = 1 }
    Need ($add.status -eq 200) 'adding the item to the cart'
    $choice = @{ shopId = $techId; deliveryMethod = 'VENDOR_DELIVERY'; paymentMethod = 'CASH_ON_DELIVERY'; deliveryAddress = 'House 12, Road 5, Dhanmondi, Dhaka' }
    $r = Call 'POST' '/checkout' $cust @{ shops = @($choice) }
    Need ($r.status -eq 201) 'the checkout'
    return $r.json.data.orders[0].id
}
function Events($orderId) { return @((Call 'GET' "/orders/$orderId" $cust $null).json.data.statusEvents) }
function SetStatus($orderId, $status, $reason) {
    $body = @{ status = $status }
    if ($reason) { $body.reason = $reason }
    return Call 'POST' "/shops/$techId/orders/$orderId/status" $owner $body
}

# ---- 1. placing an order gives one PLACED event ----
$o1 = NewOrder
$r = Call 'GET' "/orders/$o1" $cust $null
Check 'customer order detail' $r.status 200
$ev = @($r.json.data.statusEvents)
Check 'one event after placing' $ev.Count 1
Check 'first event is PLACED' $ev[0].status 'PLACED'
Check 'PLACED by CUSTOMER' $ev[0].actorRole 'CUSTOMER'
Check 'event has createdAt' ($null -ne $ev[0].createdAt) $true
$keys = @($ev[0].PSObject.Properties.Name | Sort-Object) -join ','
Check 'event exposes only status,note,actorRole,createdAt' $keys 'actorRole,createdAt,note,status'

# ---- 2. each status change adds one event, in order ----
Check 'confirm' (SetStatus $o1 'CONFIRMED' $null).status 200
Check 'out for delivery' (SetStatus $o1 'OUT_FOR_DELIVERY' $null).status 200
Check 'complete' (SetStatus $o1 'COMPLETED' $null).status 200
$ev = Events $o1
Check 'four events' $ev.Count 4
Check 'events in order' (($ev | ForEach-Object { $_.status }) -join ',') 'PLACED,CONFIRMED,OUT_FOR_DELIVERY,COMPLETED'
Check 'shop changes are SHOP' $ev[1].actorRole 'SHOP'
Check 'times ascend' ([datetime]$ev[3].createdAt -ge [datetime]$ev[0].createdAt) $true

# ---- 3. unchanged / invalid status adds no event ----
$r = SetStatus $o1 'COMPLETED' $null
Check 'same status again is 409' $r.status 409
Check 'still four events' (Events $o1).Count 4

# ---- 4. shop-side detail has the timeline ----
$r = Call 'GET' "/shops/$techId/orders/$o1" $owner $null
Check 'shop order detail' $r.status 200
Check 'shop sees four events' @($r.json.data.statusEvents).Count 4

# ---- 5. customer cancel adds CANCELLED with the note ----
$o2 = NewOrder
$r = Call 'POST' "/orders/$o2/cancel" $cust @{ reason = 'Changed my mind' }
Check 'customer cancel' $r.status 200
$ev = Events $o2
Check 'two events after cancel' $ev.Count 2
Check 'last is CANCELLED' $ev[1].status 'CANCELLED'
Check 'cancel note kept' $ev[1].note 'Changed my mind'
Check 'cancelled by CUSTOMER' $ev[1].actorRole 'CUSTOMER'
$r = Call 'POST' "/orders/$o2/cancel" $cust @{ reason = 'again' }
Check 'second cancel is 409' $r.status 409
Check 'still two events' (Events $o2).Count 2

# ---- 6. shop cancel ----
$o3 = NewOrder
Check 'shop cancels' (SetStatus $o3 'CANCELLED' 'Out of stock').status 200
$ev = Events $o3
Check 'shop cancel event' "$($ev[1].status)/$($ev[1].actorRole)/$($ev[1].note)" 'CANCELLED/SHOP/Out of stock'

# ---- 7. other users cannot read it ----
$r = Call 'GET' "/orders/$o1" $owner3 $null
Check 'another user gets 404' $r.status 404
$r = Call 'GET' "/shops/$techId/orders/$o1" $owner3 $null
Check 'another shop owner gets 403' $r.status 403

Call 'DELETE' '/cart' $cust $null | Out-Null
Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
if ($script:fail -gt 0) { exit 1 }
