# test-shop-location.ps1
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
$jamuna = @{ lat = 23.8133; lng = 90.4246 }   # Jamuna Future Park (2 seed shops)
function Near($q) { return Call 'GET' "/shops/near?$q" $null $null }
$bash = (Call 'GET' '/markets/bashundhara-city' $null $null).json.data

# ---- 1. coordinates are public ----
$m = @((Call 'GET' '/markets' $null $null).json.data | Where-Object { $_.slug -eq 'jamuna-future-park' })[0]
Check 'market list has latitude' $m.latitude 23.8133
Check 'market list has longitude' $m.longitude 90.4246
Check 'market detail has latitude' $bash.latitude 23.7512
$card = @((Call 'GET' '/shops?q=TechZone' $null $null).json.data)[0]
Check 'shop card market has coordinates' "$($card.market.latitude),$($card.market.longitude)" '23.8133,90.4246'
Check 'storefront market has coordinates' ((Call 'GET' '/shops/techzone-electronics' $null $null).json.data.market.latitude) 23.8133

# ---- 2. ordering and radius ----
$r = Near "lat=$($jamuna.lat)&lng=$($jamuna.lng)&radiusKm=20"
Check 'near -> 200' $r.status 200
$d = @($r.json.data)
Check 'three Dhaka shops within 20 km' $d.Count 3
$dist = @($d | ForEach-Object { [double]$_.distanceKm })
Check 'sorted nearest first' (($dist -join ',') -eq ((@($dist | Sort-Object) -join ','))) $true
Check 'shops in the same market are at 0 km' $dist[0] 0
Check 'Bashundhara shop is last' $d[2].market.slug 'bashundhara-city'
Check 'distance rounded to 0.1' ([math]::Round($dist[2] * 10) -eq ($dist[2] * 10)) $true
Check 'Bashundhara is about 7.7 km away' $dist[2] 7.7
$r = Near "lat=$($jamuna.lat)&lng=$($jamuna.lng)&radiusKm=5"
Check 'radius 5 km leaves Bashundhara out' (@($r.json.data | Where-Object { $_.market.slug -eq 'bashundhara-city' }).Count) 0
Check 'radius 5 km keeps Jamuna shops' @($r.json.data).Count 2
Check 'default radius is 5 km' @((Near "lat=$($jamuna.lat)&lng=$($jamuna.lng)").json.data).Count 2
Check 'limit 1' @((Near "lat=$($jamuna.lat)&lng=$($jamuna.lng)&radiusKm=20&limit=1").json.data).Count 1
Check 'far away (Sylhet): nothing' @((Near 'lat=24.8967&lng=91.8687&radiusKm=20').json.data).Count 0

# ---- 3. invalid input -> 400 ----
Check 'lat 91 -> 400' (Near 'lat=91&lng=90').status 400
Check 'lat -91 -> 400' (Near 'lat=-91&lng=90').status 400
Check 'lng 181 -> 400' (Near 'lat=23&lng=181').status 400
Check 'lat missing -> 400' (Near 'lng=90').status 400
Check 'lat not a number -> 400' (Near 'lat=abc&lng=90').status 400
Check 'radius 21 -> 400' (Near 'lat=23&lng=90&radiusKm=21').status 400
Check 'radius 0 -> 400' (Near 'lat=23&lng=90&radiusKm=0').status 400
Check 'limit 21 -> 400' (Near 'lat=23&lng=90&limit=21').status 400

# ---- 4. markets without coordinates are left out ----
Check 'admin clears Bashundhara coordinates' (Call 'PATCH' "/admin/markets/$($bash.id)" $admin @{ latitude = $null; longitude = $null }).status 200
$r = Near "lat=$($jamuna.lat)&lng=$($jamuna.lng)&radiusKm=20"
Check 'its shop is left out' (@($r.json.data | Where-Object { $_.market.slug -eq 'bashundhara-city' }).Count) 0
Check 'the others stay' @($r.json.data).Count 2

# ---- 5. distance on a product's listings ----
$slug = 'galaxy-a55-5g-8-128gb'
$p = (Call 'GET' "/products/${slug}?lat=23.75&lng=90.39" $null $null).json.data
$ls = @(@($p.selectedListing) + @($p.otherListings))
Check 'every listing has distanceKm' (@($ls | Where-Object { $_.PSObject.Properties.Name -notcontains 'distanceKm' }).Count) 0
Check 'market without coordinates -> distanceKm null' (@($ls | Where-Object { $_.shop.market.slug -eq 'bashundhara-city' })[0].distanceKm) $null
Check 'Jamuna listing ~7.9 km' (@($ls | Where-Object { $_.shop.market.slug -eq 'jamuna-future-park' })[0].distanceKm) 7.9
$p = (Call 'GET' "/products/$slug" $null $null).json.data
Check 'no point -> no distanceKm' ($p.selectedListing.PSObject.Properties.Name -contains 'distanceKm') $false
Check 'lat without lng -> 400' (Call 'GET' "/products/${slug}?lat=23.75" $null $null).status 400
Check 'compare table with point' (@((Call 'GET' "/products/$slug/listings?lat=23.81&lng=90.42" $null $null).json.data | Where-Object { $_.distanceKm -ne $null }).Count -ge 1) $true

# ---- cleanup ----
Call 'PATCH' "/admin/markets/$($bash.id)" $admin @{ latitude = 23.7512; longitude = 90.3908 } | Out-Null
Check 'coordinates restored' ((Call 'GET' '/markets/bashundhara-city' $null $null).json.data.latitude) 23.7512

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
if ($script:fail -gt 0) { exit 1 }
