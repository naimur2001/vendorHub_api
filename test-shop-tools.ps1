# test-shop-tools.ps1
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
$admin = Login 'admin@vendorshub.test'
$tmp = Join-Path $env:TEMP 'vh-shop-tools'
New-Item -ItemType Directory -Force $tmp | Out-Null

$techId = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id
$mine = @((Call 'GET' "/shops/$techId/listings" $owner $null).json.data | Where-Object { $_.isActive -ne $false })
$l = $mine[0]; $lid = $l.id; $slug = $l.product.slug
function Stats($range) { return (Call 'GET' "/shops/$techId/analytics?range=$range" $owner $null).json.data }
function Order($qty) {
    Call 'DELETE' '/cart' $cust $null | Out-Null
    Need ((Call 'POST' '/cart/items' $cust @{ listingId = $lid; quantity = $qty }).status -eq 200) 'adding to the cart'
    $r = Call 'POST' '/checkout' $cust @{ shops = @(@{ shopId = $techId; deliveryMethod = 'VENDOR_DELIVERY'; paymentMethod = 'CASH_ON_DELIVERY'; deliveryAddress = 'House 12, Road 5, Dhanmondi, Dhaka' }) }
    Need ($r.status -eq 201) 'the checkout'
    return $r.json.data.orders[0]
}
function LowNotes { return @((Call 'GET' '/notifications?limit=50' $owner $null).json.data | Where-Object { $_.type -eq 'LOW_STOCK' -and $_.data.listingId -eq $lid }).Count }
function LowList { return @((Call 'GET' "/shops/$techId/listings?lowStock=true" $owner $null).json.data | ForEach-Object { $_.id }) }
# multipart upload of one file with curl.exe
function Upload($token, $file) {
    $out = Join-Path $tmp 'resp.json'
    if (Test-Path $out) { Remove-Item $out }
    $cargs = @('-s', '-o', $out, '-w', '%{http_code}', '-X', 'POST')
    if ($token) { $cargs += @('-H', "Authorization: Bearer $token") }
    $cargs += @('-F', "file=@$(Join-Path $tmp $file);type=text/csv")
    $code = & curl.exe @cargs "$base/shops/$techId/listings/import"
    $json = $null
    if (Test-Path $out) { try { $json = Get-Content $out -Raw | ConvertFrom-Json } catch { } }
    return @{ status = [int]$code; json = $json }
}
function WriteCsv($name, $text) { [IO.File]::WriteAllText((Join-Path $tmp $name), $text, (New-Object System.Text.UTF8Encoding $false)) }
Check 'listing prepared' (Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ availability = 'IN_STOCK'; stockQty = 50; lowStockAt = 3 }).status 200

# ---- 1. analytics ----
$a0 = Stats '7d'
Check 'analytics -> 7 days' @($a0.days).Count 7
Check 'time zone' $a0.timeZone 'Asia/Dhaka'
Check 'last day is today in Dhaka' $a0.to ([DateTime]::UtcNow.AddHours(6).ToString('yyyy-MM-dd'))
Check '30d -> 30 days' @((Stats '30d').days).Count 30
Check 'bad range -> 400' (Call 'GET' "/shops/$techId/analytics?range=90d" $owner $null).status 400
Check 'other shop owner -> 403' (Call 'GET' "/shops/$techId/analytics" $owner3 $null).status 403
Check 'customer -> 403' (Call 'GET' "/shops/$techId/analytics" $cust $null).status 403
Check 'admin -> 403 (owner tools)' (Call 'GET' "/shops/$techId/analytics" $admin $null).status 403

# two fresh visitors (never seen today), each opening the page twice
$viewers = foreach ($n in 1, 2) {
    $e = "view$n-$([guid]::NewGuid().ToString('N').Substring(0, 8))@vendorshub.test"
    Need ((Call 'POST' '/auth/register' $null @{ name = "Viewer $n"; email = $e; password = 'Password123!' }).status -eq 201) 'registering a viewer'
    Login $e
}
foreach ($v in $viewers) { 1..2 | ForEach-Object { Call 'GET' "/products/${slug}?listingId=$lid" $v $null | Out-Null } }
Start-Sleep -Milliseconds 500
$a1 = Stats '7d'
Check 'one view per visitor per day (2 visitors x 2 opens = 2)' ($a1.totals.views - $a0.totals.views) 2
$o = Order 1
Start-Sleep -Milliseconds 500
$a2 = Stats '7d'
Check 'add to cart counted' ($a2.totals.addToCarts - $a1.totals.addToCarts) 1
Check 'order counted' ($a2.totals.orders - $a1.totals.orders) 1
Check 'revenue counted' ($a2.totals.revenue - $a1.totals.revenue) $o.total
Check 'today carries the new order' ($a2.days[-1].orders -ge 1) $true
$top = @($a2.topListings | Where-Object { $_.listingId -eq $lid })[0]
Check 'the listing is in the top 5' ($null -ne $top) $true
Check 'top listing has a title' ($top.productTitle.Length -gt 0) $true
Check 'top listing units sold' ($top.unitsSold -ge 1) $true
Check 'win rate field present' ($a2.totals.PSObject.Properties.Name -contains 'bargainWinRate') $true
Call 'POST' "/orders/$($o.id)/cancel" $cust @{ reason = 'Test' } | Out-Null
Check 'a cancelled order leaves the counts' ((Stats '7d').totals.orders - $a1.totals.orders) 0

# ---- 2. low stock ----
Check 'set stock 5, alert at 3' (Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ stockQty = 5; lowStockAt = 3 }).status 200
Check 'not low yet' ((LowList) -contains $lid) $false
$n0 = LowNotes
$o = Order 2   # 5 -> 3
Check 'stock at the threshold: notified' (LowNotes) ($n0 + 1)
Check 'listed as low stock' ((LowList) -contains $lid) $true
$o2 = Order 1  # 3 -> 2
Check 'still only one notification' (LowNotes) ($n0 + 1)
Check 'restock above the threshold' (Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ stockQty = 4 }).status 200
Check 'no longer low' ((LowList) -contains $lid) $false
$o3 = Order 1  # 4 -> 3
Check 'low again after a restock: notified again' (LowNotes) ($n0 + 2)
Check 'alert off (null) -> not listed' ((Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ lowStockAt = $null }).status -eq 200 -and -not ((LowList) -contains $lid)) $true
Check 'negative lowStockAt -> 400' (Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ lowStockAt = -1 }).status 400
foreach ($x in $o, $o2, $o3) { Call 'POST' "/orders/$($x.id)/cancel" $cust @{ reason = 'Test' } | Out-Null }

# ---- 3. CSV import ----
# a product with NO listing at this shop (inactive ones included, e.g. left by an earlier run)
$listedIds = @((Call 'GET' "/shops/$techId/listings" $owner $null).json.data | ForEach-Object { $_.product.id })
$newP = @((Call 'GET' '/products?limit=50' $null $null).json.data | Where-Object { $listedIds -notcontains $_.id })[0]
Need $newP 'a product TechZone does not sell yet'
$titleP = (Call 'GET' "/products/$($mine[1].product.slug)" $null $null).json.data.product
$price0 = $l.price

WriteCsv 'good.csv' ("productSlug,price,stockQty,availability`r`n$slug,12345,7,`r`n$($newP.slug),999,,AVAILABLE`r`n")
$r = Upload $owner 'good.csv'
Check 'good CSV -> 200' $r.status 200
Check 'one created' $r.json.data.created 1
Check 'one updated' $r.json.data.updated 1
Check 'no errors' @($r.json.data.errors).Count 0
$after = @((Call 'GET' "/shops/$techId/listings" $owner $null).json.data)
$u = @($after | Where-Object { $_.id -eq $lid })[0]
Check 'price updated' $u.price 12345
Check 'stock updated' $u.stockQty 7
Check 'availability derived from stock' $u.availability 'IN_STOCK'
$c = @($after | Where-Object { $_.product.id -eq $newP.id })[0]
Check 'new listing created' "$($c.price)/$($c.availability)" '999/AVAILABLE'

# title + category, quoted field, BOM, LF line ends, columns in another order
$q = $titleP.title.Replace('"', '""')
WriteCsv 'title.csv' ([char]0xFEFF + "Price,Title,Category`n""2,500"",""$q"",$($titleP.category.slug)`n")
$r = Upload $owner 'title.csv'
Check 'a quoted price with a comma is not a number -> 422' $r.status 422
WriteCsv 'title.csv' ([char]0xFEFF + "Price,Title,Category`n2500,""$q"",$($titleP.category.slug)`n")
$r = Upload $owner 'title.csv'
Check 'title + category CSV -> 200' $r.status 200
Check 'title row updated' $r.json.data.updated 1

# bad rows: every row is reported, nothing is saved
WriteCsv 'bad.csv' ("productSlug,price,stockQty,availability`n$slug,555,1,`nno-such-product,100,,`n$slug,600,,`n$($newP.slug),abc,,`n$($newP.slug),100,-1,`n,100,,`n$($mine[1].product.slug),100,,SOMETIMES`n")
$r = Upload $owner 'bad.csv'
Check 'bad CSV -> 422' $r.status 422
$errs = @($r.json.error.details.errors)
Check 'six bad rows reported' $errs.Count 6
Check 'row numbers are spreadsheet rows' (($errs | ForEach-Object { $_.row }) -join ',') '3,4,5,6,7,8'
Check 'duplicate product reported' (@($errs | Where-Object { $_.message -like '*already in row 2*' }).Count) 1
Check 'counts are zero' "$($r.json.error.details.created)/$($r.json.error.details.updated)" '0/0'
Check 'nothing saved (price unchanged)' (@((Call 'GET' "/shops/$techId/listings" $owner $null).json.data | Where-Object { $_.id -eq $lid })[0].price) 12345

WriteCsv 'unknown.csv' "productSlug,price,colour`n$slug,100,red`n"
Check 'unknown column -> 400' (Upload $owner 'unknown.csv').status 400
WriteCsv 'noprice.csv' "productSlug,stockQty`n$slug,1`n"
Check 'no price column -> 400' (Upload $owner 'noprice.csv').status 400
WriteCsv 'header.csv' "productSlug,price`n"
Check 'header only -> 400' (Upload $owner 'header.csv').status 400
WriteCsv 'quote.csv' "productSlug,price`n""$slug,100`n"
Check 'unclosed quote -> 400' (Upload $owner 'quote.csv').status 400
$many = "productSlug,price`n" + ((1..501 | ForEach-Object { "p-$_,100" }) -join "`n")
WriteCsv 'many.csv' $many
Check '501 rows -> 413' (Upload $owner 'many.csv').status 413
[IO.File]::WriteAllBytes((Join-Path $tmp 'binary.csv'), [byte[]](0x89, 0x50, 0x4E, 0x47, 0x00, 0x01, 0x02))
Check 'binary file -> 400' (Upload $owner 'binary.csv').status 400
[IO.File]::WriteAllText((Join-Path $tmp 'big.csv'), ("productSlug,price`n" + ('x' * 1100000)))
Check 'over 1 MB -> 413' (Upload $owner 'big.csv').status 413
Check 'other shop owner -> 403' (Upload $owner3 'good.csv').status 403
Check 'customer -> 403' (Upload $cust 'good.csv').status 403
Check 'no token -> 401' (Upload $null 'good.csv').status 401

# ---- cleanup ----
Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ price = $price0; stockQty = 50; lowStockAt = 3 } | Out-Null
if ($c) { Call 'DELETE' "/shops/$techId/listings/$($c.id)" $owner $null | Out-Null }
Call 'DELETE' '/cart' $cust $null | Out-Null
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
if ($script:fail -gt 0) { exit 1 }
