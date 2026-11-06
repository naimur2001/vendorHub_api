# test-shop-products.ps1 (shop-made products: create, similar, edit rules, photos, lock, merge, limits)
# Run from the project root on FRESH seed data while "npm run dev" is running. Uses curl.exe.
$base = 'http://localhost:4000/api/v1'
$script:pass = 0
$script:fail = 0
$script:lastMsg = ''

function Check($name, $actual, $expected) {
    if ($actual -eq $expected) { Write-Host "PASS  $name" -ForegroundColor Green; $script:pass++ }
    else {
        $extra = ''; if ($script:lastMsg) { $extra = " | server said: $($script:lastMsg)" }
        Write-Host "FAIL  $name (got '$actual', expected '$expected')$extra" -ForegroundColor Red; $script:fail++
    }
}
function Call($method, $path, $token, $body) {
    $script:lastMsg = ''
    $p = @{ Method = $method; Uri = "$base$path"; UseBasicParsing = $true }
    if ($token) { $p.Headers = @{ Authorization = "Bearer $token" } }
    if ($null -ne $body) { $p.ContentType = 'application/json'; $p.Body = ($body | ConvertTo-Json -Depth 6 -Compress) }
    try { $r = Invoke-WebRequest @p; return @{ status = [int]$r.StatusCode; json = ($r.Content | ConvertFrom-Json) } }
    catch {
        if (-not $_.Exception.Response) { return @{ status = 0; json = $null } }
        $j = $null; try { $j = $_.ErrorDetails.Message | ConvertFrom-Json } catch { }
        if ($j -and $j.error) { $script:lastMsg = $j.error.message }
        return @{ status = [int]$_.Exception.Response.StatusCode; json = $j }
    }
}
function Login($email) {
    $r = Call 'POST' '/auth/login' $null @{ email = $email; password = 'Password123!' }
    if ($r.status -ne 200) { Write-Host "Login failed for $email" -ForegroundColor Red; exit 1 }
    return $r.json.data.accessToken
}
function Need($ok, $what) { if (-not $ok) { Write-Host "Cannot continue: $what failed. $($script:lastMsg)" -ForegroundColor Red; exit 1 } }

try { Invoke-WebRequest 'http://localhost:4000/health' -UseBasicParsing | Out-Null } catch { Write-Host 'The API is not running.' -ForegroundColor Red; exit 1 }

$tmp = Join-Path $env:TEMP 'vh-shop-products'
node scripts/make-image-fixtures.mjs $tmp | Out-Null
function Photo($token, $path, $file, $type) {
    $out = Join-Path $tmp 'resp.json'; if (Test-Path $out) { Remove-Item $out }
    $cargs = @('-s', '-o', $out, '-w', '%{http_code}', '-X', 'PUT', '-F', "image=@$(Join-Path $tmp $file);type=$type")
    if ($token) { $cargs += @('-H', "Authorization: Bearer $token") }
    $code = & curl.exe @cargs "$base$path"
    $json = $null; if (Test-Path $out) { try { $json = Get-Content $out -Raw | ConvertFrom-Json } catch { } }
    return @{ status = [int]$code; json = $json }
}

$admin = Login 'admin@vendorshub.test'
$owner1 = Login 'owner1@vendorshub.test'   # TechZone (verified)
$owner2 = Login 'owner2@vendorshub.test'   # Dhaka Mobile House (verified)
$owner3 = Login 'owner3@vendorshub.test'   # Gadget Galaxy (another shop)
$customer = Login 'customer@vendorshub.test'
$tech = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id
$dhaka = (Call 'GET' '/shops/dhaka-mobile-house' $null $null).json.data.id
$cat = @((Call 'GET' '/categories' $null $null).json.data)[0].id
$a55 = (Call 'GET' '/products/galaxy-a55-5g-8-128gb' $null $null).json.data.product.id
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
function NewProduct($token, $shopId, $title) {
    return Call 'POST' "/shops/$shopId/products" $token @{ title = $title; categoryId = $cat; specs = @{ capacity = '20000 mAh' }; listing = @{ price = 2500; stockQty = 10 } }
}

# ---- 1. similar search ----
$sim = @((Call 'GET' "/shops/$tech/products/similar?title=galaxy" $owner1 $null).json.data)
Check 'similar search finds the A55' (@($sim | Where-Object { $_.id -eq $a55 }).Count) 1
Check 'it says TechZone already lists it' (@($sim | Where-Object { $_.id -eq $a55 })[0].alreadyListedByYou) $true
Check 'a 1-character title is rejected' (Call 'GET' "/shops/$tech/products/similar?title=x" $owner1 $null).status 400
Check 'a customer cannot search for a shop' (Call 'GET' "/shops/$tech/products/similar?title=galaxy" $customer $null).status 403

# ---- 2. create product + listing (live at once) ----
$title = "Power Bank Test $stamp"
$c = NewProduct $owner1 $tech $title
Check 'a verified shop creates a product with its listing' $c.status 201
Need ($c.status -eq 201) 'creating the product'
$prod = $c.json.data.product
Check 'the product is marked SHOP' $prod.source 'SHOP'
Check 'the listing is created too' $c.json.data.listing.price 2500
Check 'the product is in the public search at once' (Call 'GET' "/products?q=$stamp" $null $null).json.meta.pagination.total 1
Check 'its product page shows the TechZone offer' (Call 'GET' "/products/$($prod.slug)" $null $null).json.data.selectedListing.shop.slug 'techzone-electronics'
Check 'a customer cannot create products' (NewProduct $customer $tech "X $stamp").status 403
Check 'another shop owner cannot create for TechZone' (NewProduct $owner3 $tech "Y $stamp").status 403
$reg = Call 'POST' '/auth/register' $null @{ name = 'New Owner'; email = "np$stamp@vendorshub.test"; password = 'Password123!'; role = 'SHOP_OWNER' }
$newOwner = $reg.json.data.accessToken
$newShop = (Call 'POST' '/shops' $newOwner @{ name = "Unverified $stamp"; addressLine = 'Level 2, Shop 3, Test Plaza, Dhaka' }).json.data.id
Check 'an UNVERIFIED shop cannot create products' (NewProduct $newOwner $newShop "Z $stamp").status 403

# ---- 3. input rules ----
$specs21 = @{}; 1..21 | ForEach-Object { $specs21["k$_"] = 'v' }
$bad = @(
    @('21 specs', @{ title = "Bad $stamp"; categoryId = $cat; specs = $specs21; listing = @{ price = 1 } }),
    @('a spec value over 100 characters', @{ title = "Bad $stamp"; categoryId = $cat; specs = @{ a = ('x' * 101) }; listing = @{ price = 1 } }),
    @('a number as spec value', @{ title = "Bad $stamp"; categoryId = $cat; specs = @{ a = 5 }; listing = @{ price = 1 } }),
    @('a 2-character title', @{ title = 'ab'; categoryId = $cat; listing = @{ price = 1 } }),
    @('an unknown field (source)', @{ title = "Bad $stamp"; categoryId = $cat; source = 'ADMIN'; listing = @{ price = 1 } }),
    @('availability together with stockQty', @{ title = "Bad $stamp"; categoryId = $cat; listing = @{ price = 1; stockQty = 3; availability = 'IN_STOCK' } }),
    @('an unknown category', @{ title = "Bad $stamp"; categoryId = '00000000-0000-4000-8000-000000000000'; listing = @{ price = 1 } }),
    @('a price of 0', @{ title = "Bad $stamp"; categoryId = $cat; listing = @{ price = 0 } })
)
foreach ($b in $bad) { Check "rejected: $($b[0])" (Call 'POST' "/shops/$tech/products" $owner1 $b[1]).status 400 }

# ---- 4. photos (same pipeline as market photos) ----
$pp = "/shops/$tech/products/$($prod.id)/images"
$ph = Photo $owner1 $pp 'valid.jpg' 'image/jpeg'
Check 'the shop adds a photo' $ph.status 200
Check 'the photo URL is on /media' ($ph.json.data.images[0] -like 'http://localhost:4000/media/*.webp') $true
Check 'an SVG is rejected' (Photo $owner1 $pp 'script.svg' 'image/svg+xml').status 400
Check 'a fake JPG is rejected' (Photo $owner1 $pp 'code.jpg' 'image/jpeg').status 400
Check 'a 6 MB file is rejected' (Photo $owner1 $pp 'huge.jpg' 'image/jpeg').status 413
Check 'another shop cannot add photos' (Photo $owner3 $pp 'valid.jpg' 'image/jpeg').status 403
Check 'a customer cannot add photos' (Photo $customer $pp 'valid.jpg' 'image/jpeg').status 403
for ($i = 2; $i -le 6; $i++) { $last = Photo $owner1 $pp 'valid.png' 'image/png' }
Check 'six photos are allowed' @($last.json.data.images).Count 6
Check 'a seventh photo is refused' (Photo $owner1 $pp 'valid.webp' 'image/webp').status 409
$photoId = $last.json.data.photos[0].id
Check 'the shop removes a photo' @((Call 'DELETE' "$pp/$photoId" $owner1 $null).json.data.images).Count 5
Check 'the product page shows thumbnails' @((Call 'GET' "/products/$($prod.slug)" $null $null).json.data.product.thumbnails).Count 5

# ---- 5. edit rules ----
$e = "/shops/$tech/products/$($prod.id)"
Check 'the shop edits its description' (Call 'PATCH' $e $owner1 @{ description = 'Fast charging.' }).status 200
Check 'the shop changes its title while it is the only seller' (Call 'PATCH' $e $owner1 @{ title = "$title v2" }).status 200
Check 'another shop cannot edit it' (Call 'PATCH' "/shops/$tech/products/$($prod.id)" $owner3 @{ description = 'x' }).status 403
$adminProd = Call 'PATCH' "/shops/$tech/products/$a55" $owner1 @{ description = 'x' }
Check 'a shop cannot edit an ADMIN product' $adminProd.status 403
Check 'with the Vendors Hub message' $script:lastMsg 'Only Vendors Hub can change this product now'
Check 'another shop lists the product' (Call 'POST' "/shops/$dhaka/listings" $owner2 @{ productId = $prod.id; price = 2400 }).status 201
Check 'now the title can no longer change' (Call 'PATCH' $e $owner1 @{ title = "$title v3" }).status 403
Check 'but the description still can' (Call 'PATCH' $e $owner1 @{ description = 'Fast charging, 2 ports.' }).status 200
Check 'the admin locks the product' (Call 'POST' "/admin/products/$($prod.id)/lock" $admin $null).status 200
Check 'a locked product cannot be edited by the shop' (Call 'PATCH' $e $owner1 @{ description = 'y' }).status 403
Check 'nor get new photos' (Photo $owner1 $pp 'valid.jpg' 'image/jpeg').status 403
Check 'the admin unlocks it' (Call 'POST' "/admin/products/$($prod.id)/unlock" $admin $null).status 200
Check 'then the shop can edit again' (Call 'PATCH' $e $owner1 @{ description = 'Unlocked again.' }).status 200

# ---- 6. merge ----
$dup = (NewProduct $owner1 $tech "Duplicate $stamp").json.data
$target = (NewProduct $owner2 $dhaka "Target $stamp").json.data
Need ($dup -and $target) 'creating the merge products'
Check 'Dhaka also lists the duplicate' (Call 'POST' "/shops/$dhaka/listings" $owner2 @{ productId = $dup.product.id; price = 2300 }).status 201
Check 'a customer has the duplicate in the cart' (Call 'POST' '/cart/items' $customer @{ listingId = $dup.listing.id; quantity = 1 }).status 200
$m = Call 'POST' "/admin/products/$($dup.product.id)/merge" $admin @{ intoProductId = $target.product.id }
Check 'the admin merges the duplicate' $m.status 200
Check 'one listing moved (TechZone)' $m.json.data.moved 1
Check 'one listing deactivated (Dhaka already lists the target)' $m.json.data.deactivated 1
Check 'the duplicate is gone from the public site' (Call 'GET' "/products/$($dup.product.slug)" $null $null).status 404
Check 'the target now has both shops' @((Call 'GET' "/products/$($target.product.slug)/listings" $null $null).json.data).Count 2
$cart = Call 'GET' '/cart' $customer $null
Check 'the cart still works' $cart.status 200
Check 'the cart still holds the moved listing' (($cart.json | ConvertTo-Json -Depth 10) -like "*$($dup.listing.id)*") $true
Check 'merging into an inactive product: 409' (Call 'POST' "/admin/products/$($target.product.id)/merge" $admin @{ intoProductId = $dup.product.id }).status 409
Check 'the merged target is locked for its shop' (Call 'PATCH' "/shops/$dhaka/products/$($target.product.id)" $owner2 @{ description = 'x' }).status 403

# ---- 7. admin list and audit ----
$rows = @((Call 'GET' '/admin/products?source=SHOP&limit=50' $admin $null).json.data)
Check 'the SHOP filter returns shop products' ($rows.Count -ge 3) $true
Check 'only SHOP products' (@($rows | Where-Object { $_.source -ne 'SHOP' }).Count) 0
Check 'each row shows the creating shop' (@($rows | Where-Object { -not $_.createdByShop.slug }).Count) 0
$acts = @((Call 'GET' "/admin/audit-logs?entityType=Product&entityId=$($prod.id)&limit=50" $admin $null).json.data | ForEach-Object { $_.action })
foreach ($a in @('catalog.shop_product_created', 'catalog.shop_product_updated', 'catalog.product_photo_added', 'catalog.product_photo_removed', 'catalog.product_locked')) {
    Check "audit log has $a" ($acts -contains $a) $true
}
Check 'audit log has the merge' (@((Call 'GET' "/admin/audit-logs?entityType=Product&entityId=$($dup.product.id)&limit=50" $admin $null).json.data | Where-Object { $_.action -eq 'catalog.product_merged' }).Count) 1

# ---- 8. 20 new products per shop per 24 hours (Dhaka already made 1 above) ----
$made = 0
$limited = $false
for ($i = 1; $i -le 25 -and -not $limited; $i++) {
    $s = (NewProduct $owner2 $dhaka "Limit $stamp $i").status
    if ($s -eq 201) { $made++ } elseif ($s -eq 429) { $limited = $true }
}
Check 'the shop could add 19 more (20 in total)' $made 19
Check 'the next one is refused with 429' $limited $true

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"