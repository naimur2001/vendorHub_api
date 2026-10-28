# test-catalog-admin.ps1
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

$cust = Login 'customer@vendorshub.test'
$admin = Login 'admin@vendorshub.test'
$owner = Login 'owner1@vendorshub.test'
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$techId = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id
$ghost = '00000000-0000-4000-8000-000000000000'

# ---- 1. categories ----
$r = Call 'POST' '/admin/categories' $cust @{ name = "Cat $stamp" }
Check 'a customer cannot create a category' $r.status 403
$r = Call 'POST' '/admin/categories' $admin @{ name = "Cat $stamp" }
Check 'admin creates a root category' $r.status 201
$catId = $r.json.data.id
$catSlug = $r.json.data.slug
Need $catId 'the root category'
Check 'the slug is generated' ($catSlug -like 'cat-*') $true
$r = Call 'POST' '/admin/categories' $admin @{ name = "CAT $stamp" }
Check 'a duplicate name is rejected' $r.status 409
$r = Call 'POST' '/admin/categories' $admin @{ name = "Child $stamp"; parentId = $catId }
Check 'admin creates a subcategory' $r.status 201
$childId = $r.json.data.id
Need $childId 'the subcategory'
$r = Call 'POST' '/admin/categories' $admin @{ name = "Grandchild $stamp"; parentId = $childId }
Check 'a third level is rejected' $r.status 400
$r = Call 'POST' '/admin/categories' $admin @{ name = "Orphan $stamp"; parentId = $ghost }
Check 'an unknown parent is rejected' $r.status 404
$pub = Call 'GET' '/categories' $null $null
Check 'the public list shows the new category' @($pub.json.data | Where-Object { $_.id -eq $catId }).Count 1
$r = Call 'PATCH' "/admin/categories/$catId" $admin @{ name = "Cat Renamed $stamp" }
Check 'admin renames the category' $r.status 200
Check 'the slug does not change' $r.json.data.slug $catSlug
$r = Call 'PATCH' "/admin/categories/$catId" $admin @{ parentId = $catId }
Check 'a category cannot be its own parent' $r.status 400
$r = Call 'PATCH' "/admin/categories/$catId" $admin @{ parentId = $childId }
Check 'a parent cannot move under its own child' $r.status 409
$r = Call 'PATCH' "/admin/categories/$catId" $admin @{}
Check 'an empty update is rejected' $r.status 400
$r = Call 'DELETE' "/admin/categories/$catId" $admin $null
Check 'a category with a subcategory cannot be deleted' $r.status 409
$r = Call 'DELETE' "/admin/categories/$childId" $admin $null
Check 'the subcategory is deleted' $r.status 200
$r = Call 'DELETE' "/admin/categories/$catId" $admin $null
Check 'the empty root category is deleted' $r.status 200

# ---- 2. brands ----
$r = Call 'POST' '/admin/brands' $admin @{ name = "Brand $stamp" }
Check 'admin creates a brand' $r.status 201
$brandId = $r.json.data.id
Need $brandId 'the brand'
$r = Call 'POST' '/admin/brands' $admin @{ name = "BRAND $stamp" }
Check 'a duplicate brand name is rejected (any case)' $r.status 409
$r = Call 'PATCH' "/admin/brands/$brandId" $admin @{ name = "Brand Two $stamp" }
Check 'admin renames the brand' $r.status 200
$r = Call 'POST' '/admin/brands' $cust @{ name = "Nope $stamp" }
Check 'a customer cannot create a brand' $r.status 403
$r = Call 'DELETE' "/admin/brands/$brandId" $admin $null
Check 'the empty brand is deleted' $r.status 200
$r = Call 'DELETE' "/admin/brands/$brandId" $admin $null
Check 'deleting it again returns 404' $r.status 404

# ---- 3. markets ----
$r = Call 'POST' '/admin/markets' $admin @{ name = "Market $stamp"; city = 'Dhaka'; latitude = 23.75; longitude = 90.39 }
Check 'admin creates a market' $r.status 201
$marketId = $r.json.data.id
Need $marketId 'the market'
$pub = Call 'GET' '/markets' $null $null
Check 'the public list shows the new market' @($pub.json.data | Where-Object { $_.id -eq $marketId }).Count 1
$r = Call 'POST' '/admin/markets' $admin @{ name = "Bad Market $stamp"; latitude = 123 }
Check 'an impossible latitude is rejected' $r.status 400
$r = Call 'PATCH' "/admin/markets/$marketId" $admin @{ address = 'Updated address, Dhaka' }
Check 'admin edits the market' $r.status 200
$r = Call 'DELETE' "/admin/markets/$marketId" $admin $null
Check 'the empty market is deleted' $r.status 200
$jamuna = @($pub.json.data | Where-Object { $_.slug -eq 'jamuna-future-park' })[0].id
$r = Call 'DELETE' "/admin/markets/$jamuna" $admin $null
Check 'a market with shops cannot be deleted' $r.status 409

# ---- 4. products ----
$r = Call 'POST' '/admin/categories' $admin @{ name = "ProdCat $stamp" }
$pcat = $r.json.data.id
Need $pcat 'the product category'
$r = Call 'POST' '/admin/brands' $admin @{ name = "ProdBrand $stamp" }
$pbrand = $r.json.data.id
Need $pbrand 'the product brand'

$title = "Test Phone $stamp"
$r = Call 'POST' '/admin/products' $cust @{ title = $title; categoryId = $pcat }
Check 'a customer cannot create a product' $r.status 403
$r = Call 'POST' '/admin/products' $admin @{ title = 'AB'; categoryId = $pcat }
Check 'a too-short title is rejected' $r.status 400
$r = Call 'POST' '/admin/products' $admin @{ title = $title; categoryId = $ghost }
Check 'an unknown category is rejected' $r.status 400
$r = Call 'POST' '/admin/products' $admin @{ title = $title; categoryId = $pcat; brandId = $ghost }
Check 'an unknown brand is rejected' $r.status 400
$r = Call 'POST' '/admin/products' $admin @{ title = $title; categoryId = $pcat; brandId = $pbrand; description = 'A test product.'; specs = @{ ram = '4GB'; storage = '64GB' }; msrp = 15000; images = @('https://example.com/p1.jpg') }
Check 'admin creates a product' $r.status 201
$prodId = $r.json.data.id
$slug = $r.json.data.slug
Need $prodId 'the product'
Check 'the product keeps its specs' $r.json.data.specs.ram '4GB'

$r = Call 'GET' "/products/$slug" $null $null
Check 'the public product page works' $r.status 200
Check 'no shop sells it yet' ($null -eq $r.json.data.selectedListing) $true
$qs = [uri]::EscapeDataString($title)
$r = Call 'GET' "/admin/products?q=$qs" $admin $null
Check 'the admin product list finds it' @($r.json.data | Where-Object { $_.id -eq $prodId }).Count 1
Check 'it has no active listings yet' @($r.json.data | Where-Object { $_.id -eq $prodId })[0].activeListings 0
$r = Call 'GET' '/admin/products' $cust $null
Check 'a customer cannot open the admin product list' $r.status 403

# a shop lists the new product, end to end
$r = Call 'POST' "/shops/$techId/listings" $owner @{ productId = $prodId; price = 14000 }
Check 'a shop lists the new product' $r.status 201
$r = Call 'GET' "/products?q=$qs" $null $null
Check 'the public product list now shows it' @($r.json.data | Where-Object { $_.id -eq $prodId }).Count 1

$r = Call 'PATCH' "/admin/products/$prodId" $admin @{ title = "Test Phone Renamed $stamp"; msrp = 16000 }
Check 'admin edits the product' $r.status 200
Check 'the slug does not change when the title does' $r.json.data.slug $slug
$r = Call 'PATCH' "/admin/products/$prodId" $admin @{ brandId = $ghost }
Check 'an unknown brand on edit is rejected' $r.status 400
$r = Call 'DELETE' "/admin/products/$prodId" $cust $null
Check 'a customer cannot deactivate a product' $r.status 403
$r = Call 'DELETE' "/admin/products/$prodId" $admin $null
Check 'admin deactivates the product' $r.status 200
$r = Call 'GET' "/products/$slug" $null $null
Check 'the public product page is gone' $r.status 404
$r = Call 'GET' "/products?q=$qs" $null $null
Check 'the public list no longer shows it' @($r.json.data | Where-Object { $_.id -eq $prodId }).Count 0
$rows = @((Call 'GET' "/shops/$techId/listings" $owner $null).json.data)
$mine = @($rows | Where-Object { $_.product.id -eq $prodId })[0]
Check 'its listing was deactivated too' $mine.isActive $false
$r = Call 'GET' '/admin/products?isActive=false&limit=50' $admin $null
Check 'the inactive filter lists it' @($r.json.data | Where-Object { $_.id -eq $prodId }).Count 1
$r = Call 'DELETE' "/admin/categories/$pcat" $admin $null
Check 'a category that holds a product cannot be deleted' $r.status 409
$r = Call 'DELETE' "/admin/brands/$pbrand" $admin $null
Check 'a brand that holds a product cannot be deleted' $r.status 409

# ---- audit ----
$a = Call 'GET' "/admin/audit-logs?entityType=Product&entityId=$prodId" $admin $null
Check 'the product changes are audited' (@($a.json.data).Count -ge 3) $true

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
Write-Host 'Run "node --env-file=.env prisma/seed.js" to reset the demo data.'