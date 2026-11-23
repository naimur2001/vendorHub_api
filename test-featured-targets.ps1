# test-featured-targets.ps1 (GET /admin/featured: every slot carries its target)
# Run from the project root while "npm run dev" is running in another terminal (mock modes).
# Adds its own slots next to the existing ones and removes everything again at the end.
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
        return @{ status = [int]$r.StatusCode; json = ($r.Content | ConvertFrom-Json); raw = $r.Content }
    } catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { return @{ status = 0; json = $null; raw = '' } }
        $text = $_.ErrorDetails.Message
        $json = $null
        try { $json = $text | ConvertFrom-Json } catch { }
        if ($null -ne $json -and $null -ne $json.error) { $script:lastMsg = $json.error.message }
        return @{ status = [int]$resp.StatusCode; json = $json; raw = $text }
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

try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}

$since = [DateTime]::UtcNow.AddSeconds(-2).ToString('o')
$admin = Login 'admin@vendorshub.test'
$owner = Login 'owner1@vendorshub.test'
$script:slots = @()
$script:shopOff = $null
$script:ids = @()

function Cleanup {
    foreach ($id in $script:slots) { Call 'DELETE' "/admin/featured/$id" $admin $null | Out-Null }
    if ($script:shopOff) { Call 'PATCH' "/admin/shops/$($script:shopOff)/status" $admin @{ isActive = $true; reason = 'Test finished' } | Out-Null }
    if ($script:ids.Count -gt 0) {
        return (node --env-file=.env scripts/featured-test-helper.mjs cleanup $since @($script:ids + $script:slots) | Select-Object -Last 1 | ConvertFrom-Json)
    }
}
function Need($value, $what) {
    if (-not $value) {
        Write-Host "Cannot continue: $what failed. Server said: $($script:lastMsg)" -ForegroundColor Red
        Cleanup | Out-Null
        exit 1
    }
}
function Feature($kind, $targetId, $startsAt) {
    $body = @{ kind = $kind; targetId = $targetId }
    if ($startsAt) { $body.startsAt = $startsAt }
    $r = Call 'POST' '/admin/featured' $admin $body
    Need ($r.status -eq 201) "featuring a $kind"
    $script:slots += $r.json.data.id
    return $r.json.data
}
function Slot($id) { return @((Call 'GET' '/admin/featured' $admin $null).json.data | Where-Object { $_.id -eq $id })[0] }

# ---- pick targets that are not featured yet ----
$existing = @((Call 'GET' '/admin/featured' $admin $null).json.data)
$taken = @($existing | ForEach-Object { $_.targetId })
Need ((@($existing | Where-Object { $_.kind -eq 'SHOP' }).Count -le 10) -and (@($existing | Where-Object { $_.kind -eq 'PRODUCT' }).Count -le 10)) 'room for 2 more slots of each kind'
$shops = @((Call 'GET' '/admin/shops?isActive=true&limit=50' $admin $null).json.data | Where-Object { $taken -notcontains $_.id })
Need ($shops.Count -ge 2) 'finding 2 active shops that are not featured'
$shopLive = $shops[0]; $shopInactive = $shops[1]
$prods = @((Call 'GET' '/products?limit=50&sort=oldest' $null $null).json.data | Where-Object { $taken -notcontains $_.id })
Need ($prods.Count -ge 1) 'finding a product that is not featured'
$prodSched = $prods[0]
$script:ids = @($shopInactive.id)

# a product that will be deleted (its slot then has target null)
$cat = @((Call 'GET' '/categories' $null $null).json.data)[0].id
$techId = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id
$np = Call 'POST' "/shops/$techId/products" $owner @{ title = "Featuredcheck $(Get-Date -Format 'yyyyMMddHHmmss')"; categoryId = $cat; listing = @{ price = 1200; stockQty = 3 } }
Need ($np.status -eq 201) 'creating a product to delete'
$goneId = $np.json.data.product.id
$script:ids += @($goneId, $np.json.data.listing.id)
Need ((Call 'POST' "/admin/moderation/products/$goneId/approve" $admin $null).status -eq 200) 'approving it'

# ---- 1. a live SHOP slot ----
$s1 = Feature 'SHOP' $shopLive.id $null
Check 'the create answer carries the target' $s1.target.slug $shopLive.slug
$g1 = Slot $s1.id
Check 'live shop slot: liveNow' $g1.liveNow $true
Check 'live shop slot: target fields' ((@($g1.target.PSObject.Properties.Name) | Sort-Object) -join ',') 'isActive,name,slug'
Check 'live shop slot: name / slug / isActive' "$($g1.target.name)/$($g1.target.slug)/$($g1.target.isActive)" "$($shopLive.name)/$($shopLive.slug)/True"
Check 'existing fields kept' ((@($g1.PSObject.Properties.Name) | Sort-Object) -join ',') 'createdAt,endsAt,id,kind,liveNow,sortOrder,startsAt,target,targetId'

# ---- 2. a scheduled PRODUCT slot ----
$s2 = Feature 'PRODUCT' $prodSched.id ([DateTime]::UtcNow.AddDays(2).ToString('o'))
$g2 = Slot $s2.id
Check 'scheduled product slot: not live' $g2.liveNow $false
Check 'scheduled product slot: target fields' ((@($g2.target.PSObject.Properties.Name) | Sort-Object) -join ',') 'isActive,moderationStatus,name,slug'
Check 'scheduled product slot: name is the title' $g2.target.name $prodSched.title
Check 'scheduled product slot: slug / isActive / moderationStatus' "$($g2.target.slug)/$($g2.target.isActive)/$($g2.target.moderationStatus)" "$($prodSched.slug)/True/APPROVED"
Check 'the scheduled product is not on the public list' (@((Call 'GET' '/featured?kind=PRODUCT' $null $null).json.data | Where-Object { $_.product.id -eq $prodSched.id }).Count) 0

# ---- 3. a SHOP slot whose shop is inactive ----
$s3 = Feature 'SHOP' $shopInactive.id $null
Need ((Call 'PATCH' "/admin/shops/$($shopInactive.id)/status" $admin @{ isActive = $false; reason = 'Featured targets test' }).status -eq 200) 'deactivating the shop'
$script:shopOff = $shopInactive.id
$g3 = Slot $s3.id
Check 'inactive shop slot: still in the admin list' ($null -ne $g3) $true
Check 'inactive shop slot: target.isActive false' $g3.target.isActive $false
Check 'inactive shop slot: name still shown' $g3.target.name $shopInactive.name
$pubShops = @((Call 'GET' '/featured?kind=SHOP' $null $null).json.data)
Check 'public: the inactive shop is left out' (@($pubShops | Where-Object { $_.shop.id -eq $shopInactive.id }).Count) 0
Check 'public: the live shop is there' (@($pubShops | Where-Object { $_.shop.id -eq $shopLive.id }).Count) 1
Check 'public items have no target field (unchanged)' ((@($pubShops | Where-Object { $_.PSObject.Properties.Name -contains 'target' })).Count) 0

# ---- 4. a deleted product: target null ----
$s4 = Feature 'PRODUCT' $goneId $null
node --env-file=.env scripts/featured-test-helper.mjs delete-product $goneId | Out-Null
$g4 = Slot $s4.id
Check 'deleted product slot: still listed' ($null -ne $g4) $true
Check 'deleted product slot: target null' $g4.target $null
Check 'deleted product slot: the field is there (null, not missing)' ($g4.PSObject.Properties.Name -contains 'target') $true

# ---- 5. every slot has a target field; kind filter; access ----
$all = @((Call 'GET' '/admin/featured' $admin $null).json.data)
Check 'every slot has the target field' (@($all | Where-Object { $_.PSObject.Properties.Name -notcontains 'target' }).Count) 0
$onlyP = @((Call 'GET' '/admin/featured?kind=PRODUCT' $admin $null).json.data)
Check 'kind=PRODUCT: product targets only' (@($onlyP | Where-Object { $_.kind -ne 'PRODUCT' }).Count) 0
Check 'shop owner -> 403' (Call 'GET' '/admin/featured' $owner $null).status 403

# ---- 6. cleanup ----
$out = Cleanup
$after = @((Call 'GET' '/admin/featured' $admin $null).json.data)
Check 'our slots are gone' (@($after | Where-Object { $script:slots -contains $_.id }).Count) 0
Check 'the other slots are untouched' $after.Count $existing.Count
Check 'the shop is active again' (@((Call 'GET' "/admin/shops?isActive=true&limit=50" $admin $null).json.data | Where-Object { $_.id -eq $shopInactive.id }).Count) 1
Check 'the audit entries are removed' ($out.auditLogs -ge 1) $true

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
