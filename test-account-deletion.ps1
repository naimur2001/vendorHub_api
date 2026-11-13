# test-account-deletion.ps1 (request, blockers, pending block, cancel, anonymisation job)
$base = 'http://localhost:4000/api/v1'
$script:pass = 0
$script:fail = 0
$script:det = $null
function Check($name, $actual, $expected) {
    if ($actual -eq $expected) { Write-Host "PASS  $name" -ForegroundColor Green; $script:pass++ }
    else { Write-Host "FAIL  $name (got '$actual', expected '$expected')" -ForegroundColor Red; $script:fail++ }
}
function Call($method, $path, $token, $body) {
    $script:det = $null
    $p = @{ Method = $method; Uri = "$base$path"; UseBasicParsing = $true }
    if ($token) { $p.Headers = @{ Authorization = "Bearer $token" } }
    if ($null -ne $body) { $p.ContentType = 'application/json'; $p.Body = ($body | ConvertTo-Json -Depth 6 -Compress) }
    try { $r = Invoke-WebRequest @p; return @{ status = [int]$r.StatusCode; json = ($r.Content | ConvertFrom-Json) } }
    catch {
        if (-not $_.Exception.Response) { return @{ status = 0 } }
        $j = $null; try { $j = $_.ErrorDetails.Message | ConvertFrom-Json } catch { }
        if ($j -and $j.error) { $script:det = $j.error.details; $script:msg = $j.error.message }
        return @{ status = [int]$_.Exception.Response.StatusCode; json = $j }
    }
}
function Sql($q) { return (($q | docker exec -i vendors-hub-db psql -U vendors -d vendors_hub -t -A) -join '').Trim() }
try { Invoke-WebRequest 'http://localhost:4000/health' -UseBasicParsing | Out-Null } catch { Write-Host 'The API is not running.' -ForegroundColor Red; exit 1 }

$stamp = Get-Date -Format 'yyyyMMddHHmmss'
function Register($n, $role) {
    $email = "acdel$n$stamp@vendorshub.test"
    $r = Call 'POST' '/auth/register' $null @{ name = "Account $n"; email = $email; password = 'Password123!'; role = $role }
    return @{ email = $email; id = $r.json.data.user.id; token = $r.json.data.accessToken }
}
function Login($email) { return (Call 'POST' '/auth/login' $null @{ email = $email; password = 'Password123!' }) }

# ---- 1. a customer with a cancelled delivery order (kept later, without the phone) ----
$u = Register 'c' 'CUSTOMER'
$addr = (Call 'POST' '/users/me/addresses' $u.token @{ label = 'Home'; line1 = 'House 12, Road 7'; area = 'Banani'; city = 'Dhaka'; phone = '01712345678' }).json.data
# a shop that delivers, and has the A55 in stock
$sel = @((Call 'GET' '/products/galaxy-a55-5g-8-128gb/listings' $null $null).json.data | Where-Object { $_.shop.supportsDelivery -and $_.availability -ne 'OUT_OF_STOCK' })[0]
Call 'POST' '/cart/items' $u.token @{ listingId = $sel.id; quantity = 1 } | Out-Null
$co = Call 'POST' '/checkout' $u.token @{ shops = @(@{ shopId = $sel.shop.id; deliveryMethod = 'VENDOR_DELIVERY'; paymentMethod = 'CASH_ON_DELIVERY'; addressId = $addr.id }) }
if ($co.status -ne 201) { Write-Host "Cannot continue: checkout said: $($script:msg)" -ForegroundColor Red; exit 1 }
$orderId = $co.json.data.orders[0].id

# ---- 2. rules before the request ----
Check 'a wrong password: 400' (Call 'POST' '/users/me/deletion' $u.token @{ password = 'wrong-password' }).status 400
Check 'an open order blocks the deletion: 409' (Call 'POST' '/users/me/deletion' $u.token @{ password = 'Password123!' }).status 409
Check 'the blocker is named' (@($script:det.blockers | ForEach-Object { $_.code }) -contains 'OPEN_ORDERS') $true
Check 'the customer cancels the order' (Call 'POST' "/orders/$orderId/cancel" $u.token @{ reason = 'Changed my mind' }).status 200
$admin = (Login 'admin@vendorshub.test').json.data.accessToken
Check 'an admin cannot delete themselves this way: 403' (Call 'POST' '/users/me/deletion' $admin @{ password = 'Password123!' }).status 403

# ---- 3. the request ----
$deviceB = (Login $u.email).json.data
$req = Call 'POST' '/users/me/deletion' $u.token @{ password = 'Password123!'; reason = 'Test' }
Check 'the deletion is scheduled' $req.status 200
Check 'with a date' ([bool]$req.json.data.deletionScheduledFor) $true
Check 'the other device is logged out (refresh fails)' (Call 'POST' '/auth/refresh' $null @{ refreshToken = $deviceB.refreshToken }).status 401

# ---- 4. while pending ----
Check 'the cart is blocked: 403' (Call 'GET' '/cart' $u.token $null).status 403
Check 'with the code ACCOUNT_DELETION_PENDING' $script:det.code 'ACCOUNT_DELETION_PENDING'
Check 'and the date' ([bool]$script:det.deletionScheduledFor) $true
Check 'orders are blocked too: 403' (Call 'GET' '/orders' $u.token $null).status 403
$me = Call 'GET' '/auth/me' $u.token $null
Check 'GET /auth/me still works' $me.status 200
Check 'it shows the deletion date' ([bool]$me.json.data.deletionScheduledFor) $true
$again = Login $u.email
Check 'login still works (to cancel)' $again.status 200
Check 'the login answer shows the date' ([bool]$again.json.data.user.deletionScheduledFor) $true

# ---- 5. cancel restores, also a shop that was active ----
Check 'the customer cancels the deletion' (Call 'DELETE' '/users/me/deletion' $again.json.data.accessToken $null).status 200
Check 'the cart works again' (Call 'GET' '/cart' $again.json.data.accessToken $null).status 200
$o = Register 'o' 'SHOP_OWNER'
$shop = (Call 'POST' '/shops' $o.token @{ name = "Deletion Test Shop $stamp"; addressLine = 'Level 1, Shop 2, Test Plaza, Dhaka' }).json.data
Check 'the owner requests deletion' (Call 'POST' '/users/me/deletion' $o.token @{ password = 'Password123!' }).status 200
Check 'the owned shop is hidden' (Call 'GET' "/shops/$($shop.slug)" $null $null).status 404
Check 'the owner cancels' (Call 'DELETE' '/users/me/deletion' $o.token $null).status 200
Check 'the shop is visible again' (Call 'GET' "/shops/$($shop.slug)" $null $null).status 200

# ---- 6. the job anonymises when the date has passed ----
$t2 = (Login $u.email).json.data.accessToken
Check 'the customer requests deletion again' (Call 'POST' '/users/me/deletion' $t2 @{ password = 'Password123!' }).status 200
Sql "UPDATE `"User`" SET `"deletionScheduledFor`" = now() - interval '1 minute' WHERE id = '$($u.id)';" | Out-Null
node --env-file=.env scripts/run-account-deletions.mjs | Out-Null
Check 'the old login no longer works' (Login $u.email).status 401
Check 'the email is replaced' (Sql "SELECT email FROM `"User`" WHERE id = '$($u.id)';") "deleted-$($u.id)@deleted.invalid"
Check 'the name is replaced' (Sql "SELECT name FROM `"User`" WHERE id = '$($u.id)';") 'Deleted user'
Check 'the saved addresses are gone' (Sql "SELECT count(*) FROM `"Address`" WHERE `"userId`" = '$($u.id)';") '0'
Check 'the order is still there' (Sql "SELECT count(*) FROM `"SubOrder`" WHERE id = '$orderId';") '1'
Check 'its address keeps only area and city (no phone)' (Sql "SELECT `"deliveryAddress`" FROM `"SubOrder`" WHERE id = '$orderId';") 'Banani, Dhaka'

# ---- 7. audit ----
$acts = @((Call 'GET' "/admin/audit-logs?entityType=User&entityId=$($u.id)&limit=50" $admin $null).json.data | ForEach-Object { $_.action })
foreach ($a in @('user.deletion_requested', 'user.deletion_cancelled', 'user.deleted')) { Check "audit log has $a" ($acts -contains $a) $true }

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"