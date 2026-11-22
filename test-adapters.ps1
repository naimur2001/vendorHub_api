# test-adapters.ps1
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

$admin = Login 'admin@vendorshub.test'
$owner = Login 'owner1@vendorshub.test'
$cust = Login 'customer@vendorshub.test'

# ---- mock mode only ----
$log = Call 'GET' '/admin/message-log?limit=1' $admin $null
if ($log.json.meta.messagingMode -ne 'mock' -or $log.json.meta.paymentMode -ne 'mock') {
    Write-Host "STOP: MESSAGING_MODE / PAYMENT_MODE must be mock (now $($log.json.meta.messagingMode) / $($log.json.meta.paymentMode))." -ForegroundColor Red
    exit 1
}
Check 'adapters in mock mode' "$($log.json.meta.messagingMode)/$($log.json.meta.paymentMode)" 'mock/mock'
Check 'customer cannot read the message log' (Call 'GET' '/admin/message-log' $cust $null).status 403

$rnd = [guid]::NewGuid().ToString('N').Substring(0, 8)
$phone = '019' + (Get-Random -Minimum 10000000 -Maximum 99999999)
$email = "sms-$rnd@vendorshub.test"
Need ((Call 'POST' '/auth/register' $null @{ name = 'Sms Test'; email = $email; phone = $phone; password = 'Password123!' }).status -eq 201) 'registering a customer with a phone'
$buyer = Login $email
$techId = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id
$lid = @((Call 'GET' "/shops/$techId/listings" $owner $null).json.data | Where-Object { $_.isActive -ne $false })[0].id
Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ availability = 'IN_STOCK'; stockQty = 50 } | Out-Null
function Order($token, $delivery, $payment) {
    Call 'DELETE' '/cart' $token $null | Out-Null
    Need ((Call 'POST' '/cart/items' $token @{ listingId = $lid; quantity = 1 }).status -eq 200) 'adding to the cart'
    $choice = @{ shopId = $techId; deliveryMethod = $delivery; paymentMethod = $payment }
    if ($delivery -eq 'VENDOR_DELIVERY') { $choice.deliveryAddress = 'House 12, Road 5, Dhanmondi, Dhaka' }
    $r = Call 'POST' '/checkout' $token @{ shops = @($choice) }
    Need ($r.status -eq 201) 'the checkout'
    return $r.json.data.orders[0]
}
function SetStatus($orderId, $st) { $b = @{ status = $st }; if ($st -eq 'CANCELLED') { $b.reason = 'Test' }; return (Call 'POST' "/shops/$techId/orders/$orderId/status" $owner $b).status }
function Messages($orderId) { return @((Call 'GET' "/admin/message-log?limit=100&orderId=$orderId" $admin $null).json.data) }

# ---- 1. order status SMS ----
$o = Order $buyer 'VENDOR_DELIVERY' 'CASH_ON_DELIVERY'
Check 'placing an order sends no SMS' @(Messages $o.id).Count 0
SetStatus $o.id 'CONFIRMED' | Out-Null
$m = @(Messages $o.id)
Check 'CONFIRMED -> one SMS' $m.Count 1
Check 'template ORDER_CONFIRMED' $m[0].template 'ORDER_CONFIRMED'
Check 'mock provider, SENT' "$($m[0].provider)/$($m[0].status)" 'mock/SENT'
Check 'the phone is masked' $m[0].toMasked ($phone.Substring(0, 3) + '******' + $phone.Substring(9, 2))
Check 'the full phone is nowhere in the log' (($m | ConvertTo-Json -Depth 4) -like "*$phone*") $false
Check 'the text names the order' ($m[0].body -like "*$($o.orderNumber)*") $true
SetStatus $o.id 'OUT_FOR_DELIVERY' | Out-Null
SetStatus $o.id 'COMPLETED' | Out-Null
Check 'three status SMS in order' ((@(Messages $o.id) | Sort-Object createdAt | ForEach-Object { $_.template }) -join ',') 'ORDER_CONFIRMED,ORDER_OUT_FOR_DELIVERY,ORDER_COMPLETED'
$p = Order $buyer 'STORE_PICKUP' 'PAY_AT_STORE'
SetStatus $p.id 'CONFIRMED' | Out-Null
SetStatus $p.id 'READY_FOR_PICKUP' | Out-Null
Check 'pickup: READY_FOR_PICKUP SMS' (@(Messages $p.id | Where-Object { $_.template -eq 'ORDER_READY_FOR_PICKUP' }).Count) 1
SetStatus $p.id 'CANCELLED' | Out-Null
Check 'a cancel sends no status SMS' @(Messages $p.id).Count 2

# ---- 2. opt-out, and customers without a phone ----
$r = Call 'PATCH' '/users/me' $buyer @{ smsOptOut = $true }
Check 'opt out' $r.json.data.smsOptOut $true
$o2 = Order $buyer 'VENDOR_DELIVERY' 'CASH_ON_DELIVERY'
SetStatus $o2.id 'CONFIRMED' | Out-Null
Check 'opted out: no SMS' @(Messages $o2.id).Count 0
Call 'PATCH' '/users/me' $buyer @{ smsOptOut = $false } | Out-Null
SetStatus $o2.id 'OUT_FOR_DELIVERY' | Out-Null
Check 'opted in again: SMS again' @(Messages $o2.id).Count 1
$nophone = "nophone-$rnd@vendorshub.test"
Need ((Call 'POST' '/auth/register' $null @{ name = 'No Phone'; email = $nophone; password = 'Password123!' }).status -eq 201) 'registering a customer without a phone'
$np = Login $nophone
$o3 = Order $np 'VENDOR_DELIVERY' 'CASH_ON_DELIVERY'
SetStatus $o3.id 'CONFIRMED' | Out-Null
Check 'no phone: no SMS' @(Messages $o3.id).Count 0

# ---- 3. payments: create, signed callback, idempotency ----
function Callback($provider, $body, $sig) {
    $hdr = @{}
    if ($sig) { $hdr['X-Mock-Signature'] = $sig }
    try {
        $r = Invoke-WebRequest -Method POST -Uri "$base/payments/callback/$provider" -ContentType 'application/json' -Body ($body | ConvertTo-Json) -Headers $hdr -UseBasicParsing
        return @{ status = [int]$r.StatusCode; json = ($r.Content | ConvertFrom-Json) }
    } catch {
        return @{ status = [int]$_.Exception.Response.StatusCode; json = $null }
    }
}
function Sign($b) { return (node --env-file=.env scripts/sign-mock-callback.mjs $b.paymentId $b.providerRef $b.status $b.amount | Select-Object -Last 1) }

$on = Order $buyer 'STORE_PICKUP' 'ONLINE'
$r = Call 'POST' "/orders/$($on.id)/payments" $buyer $null
Check 'create payment -> 201' $r.status 201
$pay = $r.json.data
Check 'mock provider' $pay.provider 'mock'
Check 'amount = the order total' $pay.amount $on.total
Check 'a mock reference' ($pay.providerRef -like 'MOCK-*') $true
$again = (Call 'POST' "/orders/$($on.id)/payments" $buyer $null).json.data
Check 'idempotent while pending' "$($again.paymentId)/$($again.providerRef)" "$($pay.paymentId)/$($pay.providerRef)"
Check 'not my order -> 404' (Call 'POST' "/orders/$($on.id)/payments" $cust $null).status 404
Check 'a cash order -> 400' (Call 'POST' "/orders/$($o2.id)/payments" $buyer $null).status 400

$cb = @{ paymentId = $pay.paymentId; providerRef = $pay.providerRef; status = 'PAID'; amount = $pay.amount }
Check 'no signature -> 401' (Callback 'mock' $cb $null).status 401
Check 'a wrong signature -> 401' (Callback 'mock' $cb ('0' * 64)).status 401
$tampered = @{ paymentId = $pay.paymentId; providerRef = $pay.providerRef; status = 'PAID'; amount = $pay.amount - 1 }
Check 'signed, but the wrong amount -> 400' (Callback 'mock' $tampered (Sign $tampered)).status 400
Check 'another provider than the active one -> 404' (Callback 'bkash' $cb (Sign $cb)).status 404
$r = Callback 'mock' $cb (Sign $cb)
Check 'signed callback -> 200' $r.status 200
Check 'payment PAID' $r.json.data.status 'PAID'
Check 'first time: not a duplicate' $r.json.data.duplicate $false
Check 'the order is paid' ((Call 'GET' "/orders/$($on.id)" $buyer $null).json.data.paymentStatus) 'PAID'
$r = Callback 'mock' $cb (Sign $cb)
Check 'the same callback again -> 200' $r.status 200
Check 'marked as a duplicate' $r.json.data.duplicate $true
Check 'after paying, create -> 409' (Call 'POST' "/orders/$($on.id)/payments" $buyer $null).status 409

# a failed attempt, then a new one
$on2 = Order $buyer 'STORE_PICKUP' 'ONLINE'
$p1 = (Call 'POST' "/orders/$($on2.id)/payments" $buyer $null).json.data
$failCb = @{ paymentId = $p1.paymentId; providerRef = $p1.providerRef; status = 'FAILED'; amount = $p1.amount }
Check 'a FAILED callback' (Callback 'mock' $failCb (Sign $failCb)).json.data.status 'FAILED'
Check 'the order is still unpaid' ((Call 'GET' "/orders/$($on2.id)" $buyer $null).json.data.paymentStatus) 'PENDING'
$p2 = (Call 'POST' "/orders/$($on2.id)/payments" $buyer $null).json.data
Check 'a new attempt gets a new payment' ($p2.paymentId -ne $p1.paymentId) $true
$ok = @{ paymentId = $p2.paymentId; providerRef = $p2.providerRef; status = 'PAID'; amount = $p2.amount }
Check 'the new attempt is paid' (Callback 'mock' $ok (Sign $ok)).json.data.status 'PAID'

# pay-mock keeps working, and refunds go through the adapter
$on3 = Order $buyer 'STORE_PICKUP' 'ONLINE'
Check 'pay-mock still works' ((Call 'POST' "/orders/$($on3.id)/pay-mock" $buyer $null).json.data.paymentStatus) 'PAID'
Check 'the shop cancels a paid order' (SetStatus $on3.id 'CANCELLED') 200
Check 'refunded' ((Call 'GET' "/orders/$($on3.id)" $buyer $null).json.data.paymentStatus) 'REFUNDED'

# ---- cleanup ----
foreach ($x in $o2, $o3, $on, $on2) { SetStatus $x.id 'CANCELLED' | Out-Null }
Call 'DELETE' '/cart' $buyer $null | Out-Null

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
if ($script:fail -gt 0) { exit 1 }
