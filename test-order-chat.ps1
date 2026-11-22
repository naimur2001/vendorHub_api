# test-order-chat.ps1
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
$email2 = "chat-$([guid]::NewGuid().ToString('N').Substring(0, 8))@vendorshub.test"
Need ((Call 'POST' '/auth/register' $null @{ name = 'Chat Two'; email = $email2; password = 'Password123!' }).status -eq 201) 'registering a second customer'
$cust2 = Login $email2

$techId = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id
$otherShopId = @((Call 'GET' '/users/me/shops' $owner3 $null).json.data)[0].id
$rows = @((Call 'GET' "/shops/$techId/listings" $owner $null).json.data | Where-Object { $_.isActive -ne $false })
$lid = $rows[0].id
Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ availability = 'IN_STOCK'; stockQty = 50 } | Out-Null
function NewOrder {
    Call 'DELETE' '/cart' $cust $null | Out-Null
    Need ((Call 'POST' '/cart/items' $cust @{ listingId = $lid; quantity = 1 }).status -eq 200) 'adding to the cart'
    $r = Call 'POST' '/checkout' $cust @{ shops = @(@{ shopId = $techId; deliveryMethod = 'VENDOR_DELIVERY'; paymentMethod = 'CASH_ON_DELIVERY'; deliveryAddress = 'House 12, Road 5, Dhanmondi, Dhaka' }) }
    Need ($r.status -eq 201) 'the checkout'
    return $r.json.data.orders[0].id
}
$o = NewOrder
$cPath = "/orders/$o/messages"
$sPath = "/shops/$techId/orders/$o/messages"
function Notes($token, $type) { return @((Call 'GET' '/notifications?limit=50' $token $null).json.data | Where-Object { $_.type -eq $type -and $_.data.orderId -eq $o }).Count }
function UnreadInList($token, $path) { return @((Call 'GET' $path $token $null).json.data | Where-Object { $_.id -eq $o })[0].unreadCount }

# ---- 1. access both ways ----
Check 'no token -> 401' (Call 'GET' $cPath $null $null).status 401
Check 'the buyer reads -> 200' (Call 'GET' $cPath $cust $null).status 200
Check 'another customer -> 404' (Call 'GET' $cPath $cust2 $null).status 404
Check 'another customer cannot write -> 404' (Call 'POST' $cPath $cust2 @{ body = 'hi' }).status 404
Check 'the shop team reads -> 200' (Call 'GET' $sPath $owner $null).status 200
Check 'another shop owner -> 403' (Call 'GET' $sPath $owner3 $null).status 403
Check 'a customer on the shop route -> 403' (Call 'GET' $sPath $cust $null).status 403
Check 'the order under the wrong shop -> 404' (Call 'GET' "/shops/$otherShopId/orders/$o/messages" $owner3 $null).status 404

# ---- 2. sending ----
$r = Call 'POST' $cPath $cust @{ body = '  Is it the black colour?  ' }
Check 'customer sends -> 201' $r.status 201
$m1 = $r.json.data
Check 'trimmed body' $m1.body 'Is it the black colour?'
Check 'senderRole CUSTOMER' $m1.senderRole 'CUSTOMER'
Check 'mine true for the sender' $m1.mine $true
Check 'no personal data in a message' (($m1.PSObject.Properties.Name | Sort-Object) -join ',') 'body,createdAt,id,mine,readAt,senderRole'
Check 'empty body -> 400' (Call 'POST' $cPath $cust @{ body = '' }).status 400
Check 'only spaces -> 400' (Call 'POST' $cPath $cust @{ body = '    ' }).status 400
Check '1001 characters -> 400' (Call 'POST' $cPath $cust @{ body = ('a' * 1001) }).status 400
Check '1000 characters -> 201' (Call 'POST' $cPath $cust @{ body = ('b' * 1000) }).status 201
$seen = (Call 'GET' $sPath $owner $null).json.data
Check 'shop sees 2 messages' @($seen.messages).Count 2
Check 'not mine for the shop' $seen.messages[0].mine $false
Check 'shop unreadCount 2' $seen.unreadCount 2

# ---- 3. notifications (at most one per 5 minutes per order) ----
Check 'shop notified once for two messages' (Notes $owner 'ORDER_MESSAGE') 1
$r = Call 'POST' $sPath $owner @{ body = 'Yes, black is in stock.' }
Check 'shop replies -> 201' $r.status 201
Check 'reply senderRole SHOP' $r.json.data.senderRole 'SHOP'
Check 'customer notified' (Notes $cust 'ORDER_MESSAGE') 1
Call 'POST' $sPath $owner @{ body = 'Anything else?' } | Out-Null
Check 'customer still notified once' (Notes $cust 'ORDER_MESSAGE') 1

# ---- 4. unread counts and read ----
Check 'shop order list unreadCount 2' (UnreadInList $owner "/shops/$techId/orders?limit=50") 2
Check 'customer order list unreadCount 2' (UnreadInList $cust '/orders?limit=50') 2
$r = Call 'POST' "$sPath/read" $owner $null
Check 'shop marks read' $r.json.data.marked 2
Check 'shop list unreadCount 0' (UnreadInList $owner "/shops/$techId/orders?limit=50") 0
Check 'customer messages now have readAt' ($null -ne (Call 'GET' $cPath $cust $null).json.data.messages[0].readAt) $true
Check 'customer unreadCount still 2' (Call 'GET' $cPath $cust $null).json.data.unreadCount 2
Check 'customer marks read' (Call 'POST' "$cPath/read" $cust $null).json.data.marked 2
Check 'customer list unreadCount 0' (UnreadInList $cust '/orders?limit=50') 0
Check 'read again marks 0' (Call 'POST' "$cPath/read" $cust $null).json.data.marked 0

# ---- 5. polling with after ----
$all = @((Call 'GET' $cPath $cust $null).json.data.messages)
Check 'four messages, oldest first' (($all.Count -eq 4) -and ([datetime]$all[0].createdAt -le [datetime]$all[3].createdAt)) $true
$after = @((Call 'GET' "${cPath}?after=$($all[1].id)" $cust $null).json.data.messages)
Check 'after returns only later ones' (($after | ForEach-Object { $_.id }) -join ',') (($all[2..3] | ForEach-Object { $_.id }) -join ',')
Check 'after the last -> empty' @((Call 'GET' "${cPath}?after=$($all[3].id)" $cust $null).json.data.messages).Count 0
Check 'bad after -> 400' (Call 'GET' "${cPath}?after=nope" $cust $null).status 400
Check 'unknown after -> 404' (Call 'GET' "${cPath}?after=$([guid]::NewGuid())" $cust $null).status 404

# ---- 6. the chat closes 7 days after COMPLETED ----
$o2 = NewOrder
foreach ($st in 'CONFIRMED', 'OUT_FOR_DELIVERY', 'COMPLETED') { Call 'POST' "/shops/$techId/orders/$o2/status" $owner @{ status = $st } | Out-Null }
Check 'just completed: still open' (Call 'POST' "/orders/$o2/messages" $cust @{ body = 'Thanks!' }).status 201
node --env-file=.env scripts/backdate-completion.mjs $o2 6 | Out-Null
Check '6 days after: still open' (Call 'POST' "/orders/$o2/messages" $cust @{ body = 'One more thing' }).status 201
node --env-file=.env scripts/backdate-completion.mjs $o2 8 | Out-Null
$r = Call 'POST' "/orders/$o2/messages" $cust @{ body = 'Hello?' }
Check '8 days after: 409' $r.status 409
Check 'code CHAT_CLOSED' $r.json.error.details.code 'CHAT_CLOSED'
Check 'the shop cannot write either' (Call 'POST' "/shops/$techId/orders/$o2/messages" $owner @{ body = 'Hi' }).status 409
$g = (Call 'GET' "/orders/$o2/messages" $cust $null).json.data
Check 'reading still works' @($g.messages).Count 2
Check 'closed flag true' $g.closed $true
Check 'open chat: closed false' (Call 'GET' $cPath $cust $null).json.data.closed $false

# ---- 7. rate limit: 20 messages per minute per user ----
# this customer already sent 4 accepted messages in this minute (first, 1000 chars, Thanks, One more thing);
# rejected ones (400, 409) do not count
$codes = @()
for ($i = 0; $i -lt 20; $i++) { $codes += (Call 'POST' $cPath $cust @{ body = "msg $i" }).status }
Check 'the 21st message in a minute -> 429' ($codes -contains 429) $true
Check '20 accepted in the minute in total' (@($codes | Where-Object { $_ -eq 201 }).Count + 4) 20
Check 'another user is not limited' (Call 'POST' $sPath $owner @{ body = 'Still here' }).status 201

# ---- cleanup ----
Call 'DELETE' '/cart' $cust $null | Out-Null

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
if ($script:fail -gt 0) { exit 1 }
