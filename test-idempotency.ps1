# test-idempotency.ps1 (POST /checkout with the Idempotency-Key header)
# Run from the project root on fresh seed data while "npm run dev" is running. Uses curl.exe.
$base = 'http://localhost:4000/api/v1'
$script:pass = 0
$script:fail = 0

function Check($name, $actual, $expected) {
    if ($actual -eq $expected) { Write-Host "PASS  $name" -ForegroundColor Green; $script:pass++ }
    else { Write-Host "FAIL  $name (got '$actual', expected '$expected')" -ForegroundColor Red; $script:fail++ }
}
function Call($method, $path, $token, $body, $key) {
    $h = @{}
    if ($token) { $h.Authorization = "Bearer $token" }
    if ($null -ne $key) { $h['Idempotency-Key'] = $key }
    $p = @{ Method = $method; Uri = "$base$path"; Headers = $h; UseBasicParsing = $true }
    if ($null -ne $body) { $p.ContentType = 'application/json'; $p.Body = ($body | ConvertTo-Json -Depth 6 -Compress) }
    try {
        $r = Invoke-WebRequest @p
        return @{ status = [int]$r.StatusCode; json = ($r.Content | ConvertFrom-Json); raw = $r.Content; replayed = [string]$r.Headers['Idempotent-Replayed'] }
    } catch {
        if (-not $_.Exception.Response) { return @{ status = 0 } }
        $j = $null; try { $j = $_.ErrorDetails.Message | ConvertFrom-Json } catch { }
        return @{ status = [int]$_.Exception.Response.StatusCode; json = $j; replayed = '' }
    }
}
try { Invoke-WebRequest 'http://localhost:4000/health' -UseBasicParsing | Out-Null } catch { Write-Host 'The API is not running.' -ForegroundColor Red; exit 1 }

$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$script:n = 0
function NewCustomer {
    $script:n++
    $r = Call 'POST' '/auth/register' $null @{ name = "Idem $($script:n)"; email = "idem$($script:n)x$stamp@vendorshub.test"; password = 'Password123!' } $null
    return $r.json.data.accessToken
}
$sel = (Call 'GET' '/products/galaxy-a55-5g-8-128gb' $null $null $null).json.data.selectedListing
$listingId = $sel.id
$body = @{ shops = @(@{ shopId = $sel.shop.id; deliveryMethod = 'STORE_PICKUP'; paymentMethod = 'PAY_AT_STORE' }) }
$other = @{ shops = @(@{ shopId = $sel.shop.id; deliveryMethod = 'STORE_PICKUP'; paymentMethod = 'ONLINE' }) }
function AddToCart($token) { return (Call 'POST' '/cart/items' $token @{ listingId = $listingId; quantity = 1 } $null).status }
function OrderCount($token) { return (Call 'GET' '/orders?limit=1' $token $null $null).json.meta.pagination.total }

# ---- 1. invalid keys ----
$u1 = NewCustomer
Check 'cart prepared' (AddToCart $u1) 200
Check 'a key that is not a UUID: 400' (Call 'POST' '/checkout' $u1 $body 'abc').status 400
Check 'a UUID that is not version 4: 400' (Call 'POST' '/checkout' $u1 $body '00000000-0000-1000-8000-000000000000').status 400
Check 'no order was created' (OrderCount $u1) 0

# ---- 2. same key twice: one set of orders, identical answer ----
$k = [guid]::NewGuid().ToString()
$a = Call 'POST' '/checkout' $u1 $body $k
Check 'the first request places the order' $a.status 201
Check 'it is not a replay' $a.replayed ''
$b = Call 'POST' '/checkout' $u1 $body $k
Check 'the repeat gets the same status' $b.status 201
Check 'it is marked as a replay' $b.replayed 'true'
Check 'the repeat returns the same checkout' $b.json.data.checkoutId $a.json.data.checkoutId
Check 'the whole answer is identical' (($b.json | ConvertTo-Json -Depth 10 -Compress) -eq ($a.json | ConvertTo-Json -Depth 10 -Compress)) $true
Check 'only one order exists' (OrderCount $u1) 1
$item = $a.json.data.orders[0].items[0]
Check 'an order item has the productSlug' $item.productSlug 'galaxy-a55-5g-8-128gb'
Check 'an order item has the productId' $item.productId (Call 'GET' '/products/galaxy-a55-5g-8-128gb' $null $null $null).json.data.product.id
Check 'GET /orders items have the productSlug too' (Call 'GET' '/orders?limit=1' $u1 $null $null).json.data[0].items[0].productSlug 'galaxy-a55-5g-8-128gb'

# ---- 3. same key, different data ----
Check 'same key with other data: 422' (Call 'POST' '/checkout' $u1 $other $k).status 422

# ---- 4. another user with the same key is independent ----
$u2 = NewCustomer
AddToCart $u2 | Out-Null
$c = Call 'POST' '/checkout' $u2 $body $k
Check 'another user with the same key places their own order' $c.status 201
Check 'it is not a replay of the first user' (($c.replayed -ne 'true') -and ($c.json.data.checkoutId -ne $a.json.data.checkoutId)) $true

# ---- 5. a failed checkout frees the key ----
$u3 = NewCustomer
$k3 = [guid]::NewGuid().ToString()
$f = Call 'POST' '/checkout' $u3 $body $k3
Check 'checkout with an empty cart fails' ($f.status -ge 400 -and $f.status -lt 500) $true
AddToCart $u3 | Out-Null
$g = Call 'POST' '/checkout' $u3 $body $k3
Check 'after fixing the cart the same key works' $g.status 201
Check 'and it is a new order, not a replay' $g.replayed ''

# ---- 6. two parallel requests with the same key ----
$u4 = NewCustomer
AddToCart $u4 | Out-Null
$k4 = [guid]::NewGuid().ToString()
$tmp = Join-Path $env:TEMP 'vh-idem'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$bodyFile = Join-Path $tmp 'body.json'
[IO.File]::WriteAllText($bodyFile, ($body | ConvertTo-Json -Depth 6 -Compress))
$codes = & curl.exe -s --parallel --parallel-immediate -w '%{http_code}\n' `
    -H "Authorization: Bearer $u4" -H "Idempotency-Key: $k4" -H 'Content-Type: application/json' `
    -X POST --data-binary "@$bodyFile" `
    "$base/checkout" -o (Join-Path $tmp 'r1.json') `
    "$base/checkout" -o (Join-Path $tmp 'r2.json')
$codes = @($codes | Where-Object { $_ -match '^\d{3}$' } | ForEach-Object { [int]$_ })
Write-Host "INFO  parallel answers: $($codes -join ', ')"
Write-Host "INFO  first answer: $(Get-Content (Join-Path $tmp 'r1.json') -Raw)"
Check 'both parallel requests were answered' $codes.Count 2
Check 'at least one of them succeeded' (@($codes | Where-Object { $_ -eq 201 }).Count -ge 1) $true
Check 'the other one succeeded too or got 409' (@($codes | Where-Object { $_ -ne 201 -and $_ -ne 409 }).Count) 0
Check 'exactly one order was created' (OrderCount $u4) 1
$h = Call 'POST' '/checkout' $u4 $body $k4
Check 'a later repeat returns the stored answer' $h.replayed 'true'

# ---- 7. without the header nothing changes ----
$u5 = NewCustomer
AddToCart $u5 | Out-Null
$n = Call 'POST' '/checkout' $u5 $body $null
Check 'checkout without the header still works' $n.status 201
Check 'and is never marked as a replay' $n.replayed ''

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"