# test-catalog-list.ps1 (GET /products: filters, sorts, paging, escaping, market prices)
# Run from the project root on the normal seed data while "npm run dev" is running.
$base = 'http://localhost:4000/api/v1'
$script:pass = 0
$script:fail = 0
$script:lastMsg = ''

function Call($path) {
    $script:lastMsg = ''
    try {
        $r = Invoke-WebRequest -Uri "$base$path" -UseBasicParsing
        return @{ status = [int]$r.StatusCode; json = ($r.Content | ConvertFrom-Json) }
    } catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { return @{ status = 0; json = $null } }
        $json = $null
        try { $json = $_.ErrorDetails.Message | ConvertFrom-Json } catch { }
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

function Items($path) { return @((Call $path).json.data) }
function Sorted($values, $descending) {
    for ($i = 1; $i -lt $values.Count; $i++) {
        if ($descending -and $values[$i] -gt $values[$i - 1]) { return $false }
        if (-not $descending -and $values[$i] -lt $values[$i - 1]) { return $false }
    }
    return $true
}

try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}

$a55 = 'galaxy-a55-5g-8-128gb'
$cardKeys = 'availability,bargainAvailable,brand,category,createdAt,highestPrice,id,image,lowestPrice,msrp,shopCount,slug,thumbnail,title'

# ---- 1. the full list, the card fields, the default page size ----
$all = Call '/products?limit=50'
Check 'the list works' $all.status 200
$total = $all.json.meta.pagination.total
if ($total -gt 50) {
    Write-Host "STOP: $total products found. This test expects the normal seed data." -ForegroundColor Red
    Write-Host 'Run: node --env-file=.env prisma/seed.js   then run this test again.' -ForegroundColor Red
    exit 1
}
$full = @($all.json.data)
Check 'with limit 50 everything fits on one page' $full.Count $total
Check 'only the card fields are returned (no stockQty, no minOfferPercent)' ((@($full[0].PSObject.Properties.Name) | Sort-Object) -join ',') $cardKeys
$d = Call '/products'
Check 'the default page size is 12' $d.json.meta.pagination.limit 12

# ---- 2. limits ----
Check 'limit 51 is rejected' (Call '/products?limit=51').status 400
Check 'limit 0 is rejected' (Call '/products?limit=0').status 400
Check 'page 0 is rejected' (Call '/products?page=0').status 400

# ---- 3. sorts ----
$newest = Items '/products?limit=50&sort=newest'
Check 'newest: newest first' (Sorted @($newest | ForEach-Object { [datetime]$_.createdAt }) $true) $true
$asc = Items '/products?limit=50&sort=price_asc'
Check 'price_asc: cheapest first' (Sorted @($asc | ForEach-Object { $_.lowestPrice }) $false) $true
$desc = Items '/products?limit=50&sort=price_desc'
Check 'price_desc: most expensive first' (Sorted @($desc | ForEach-Object { $_.lowestPrice }) $true) $true

# ---- 4. pages add up, without overlaps ----
$pages = [math]::Ceiling($total / 5)
$slugs = @()
for ($p = 1; $p -le $pages; $p++) {
    $r = Call "/products?limit=5&sort=price_asc&page=$p"
    if ($p -eq 1) { Check 'totalPages is right' $r.json.meta.pagination.totalPages $pages }
    $slugs += @($r.json.data | ForEach-Object { $_.slug })
}
Check 'the pages add up to the full list' ($slugs -join ',') (($asc | ForEach-Object { $_.slug }) -join ',')
Check 'no product appears twice' (@($slugs | Select-Object -Unique).Count) $slugs.Count
$past = Call "/products?limit=5&page=$($pages + 1)"
Check 'a page past the end is empty' @($past.json.data).Count 0
Check 'and still reports the total' $past.json.meta.pagination.total $total

# ---- 5. text search ----
Check 'q is case-insensitive' (@(Items '/products?q=GALAXY&limit=50' | Where-Object { $_.slug -eq $a55 }).Count) 1
Check 'q % is a normal character' (Call '/products?q=%25').json.meta.pagination.total 0
Check 'q _ is a normal character' (Call '/products?q=_').json.meta.pagination.total 0
Check 'q a5_ does not match A55 (no wildcard)' (Call '/products?q=a5_').json.meta.pagination.total 0
Check 'q a55 matches the A55' (@(Items '/products?q=a55&limit=50' | Where-Object { $_.slug -eq $a55 }).Count) 1

# ---- 6. category and brand ----
$a55card = @($full | Where-Object { $_.slug -eq $a55 })[0]
$cat = Items "/products?category=$($a55card.category.slug)&limit=50"
Check 'the category filter finds the A55' (@($cat | Where-Object { $_.slug -eq $a55 }).Count) 1
Check 'the category filter keeps only that category' (@($cat | Where-Object { $_.category.slug -ne $a55card.category.slug }).Count) 0
$cats = @((Call '/categories').json.data)
$child = @($cats | Where-Object { $_.parentId -and $_.productCount -gt 0 })[0]
if ($child) {
    $parent = @($cats | Where-Object { $_.id -eq $child.parentId })[0]
    $viaParent = Items "/products?category=$($parent.slug)&limit=50"
    Check 'a parent category includes its subcategories' (@($viaParent | Where-Object { $_.category.slug -eq $child.slug }).Count -ge 1) $true
} else {
    Write-Host 'INFO  the seed has no subcategory with products; parent check skipped'
}
Check 'an unknown category gives an empty list' (Call '/products?category=no-such-category').json.meta.pagination.total 0
$brand = Items '/products?brand=samsung&limit=50'
Check 'the brand filter ignores letter case' (@($brand | Where-Object { $_.slug -eq $a55 }).Count) 1
Check 'the brand filter keeps only that brand' (@($brand | Where-Object { $_.brand.name -ne 'Samsung' }).Count) 0

# ---- 7. listing filters: price, availability, shop ----
$range = Items '/products?minPrice=20000&maxPrice=40000&limit=50'
Check 'prices respect minPrice' (@($range | Where-Object { $_.lowestPrice -lt 20000 }).Count) 0
Check 'prices respect maxPrice' (@($range | Where-Object { $_.highestPrice -gt 40000 }).Count) 0
$avail = Items '/products?availableOnly=true&limit=50'
Check 'availableOnly hides out-of-stock products' (@($avail | Where-Object { $_.availability -eq 'OUT_OF_STOCK' }).Count) 0
$techId = (Call '/shops/techzone-electronics').json.data.id
$shopList = Items "/products?shopId=$techId&limit=50"
Check 'the shop filter returns products' ($shopList.Count -ge 1) $true
Check 'with a shop filter every product counts one shop' (@($shopList | Where-Object { $_.shopCount -ne 1 }).Count) 0

# ---- 8. marketId changes the price to that market's price ----
$listings = @((Call "/products/$a55/listings").json.data)
Check 'the A55 lowest price is the cheapest of all its shops' $a55card.lowestPrice ((@($listings | ForEach-Object { $_.price }) | Measure-Object -Minimum).Minimum)
$markets = @($listings | Where-Object { $_.shop.market } | ForEach-Object { $_.shop.market.id } | Select-Object -Unique)
foreach ($m in $markets) {
    $expected = (@($listings | Where-Object { $_.shop.market.id -eq $m } | ForEach-Object { $_.price }) | Measure-Object -Minimum).Minimum
    $inMarket = @(Items "/products?marketId=$m&limit=50" | Where-Object { $_.slug -eq $a55 })[0]
    Check "with a market filter the A55 shows that market's lowest price ($m)" $inMarket.lowestPrice $expected
}

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"