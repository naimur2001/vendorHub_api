# test-shop-hours.ps1
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

# ---- 1. openNow edge cases at fixed moments (midnight, 24:00, holiday, Asia/Dhaka) ----
foreach ($row in @(node scripts/check-opening-hours.mjs | ForEach-Object { $_ | ConvertFrom-Json })) {
    Check "unit: $($row.name)" "$($row.got)" "$($row.expected)"
}

# ---- setup ----
$store = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data
$shopId = $store.id
$marketSlug = $store.market.slug
$marketId = (Call 'GET' "/markets/$marketSlug" $null $null).json.data.id
$today = [int][DateTime]::UtcNow.AddHours(6).DayOfWeek   # today in Dhaka, 0 = Sunday
$other = ($today + 3) % 7
function Week($open, $close) { return @(0..6 | ForEach-Object { @{ day = $_; open = $open; close = $close; closed = $false } }) }
$always = Week '00:00' '24:00'
function Put($token, $body) { return Call 'PUT' "/shops/$shopId/hours" $token $body }
function Store { return (Call 'GET' '/shops/techzone-electronics' $null $null).json.data }
function SearchCard { return @((Call 'GET' '/shops?q=TechZone' $null $null).json.data | Where-Object { $_.id -eq $shopId })[0] }
function MarketCard { return @((Call 'GET' "/markets/$marketSlug" $null $null).json.data.shops | Where-Object { $_.id -eq $shopId })[0] }
Call 'PATCH' "/admin/markets/$marketId" $admin @{ weeklyHoliday = $null } | Out-Null

# ---- 2. no hours yet ----
Put $owner @{ hours = $null } | Out-Null
$s = Store
Check 'storefront has hours field' ($s.PSObject.Properties.Name -contains 'hours') $true
Check 'no hours -> openNow null' $s.openNow $null
Check 'no hours -> hours null' $s.hours $null

# ---- 3. who can edit ----
Check 'no token -> 401' (Call 'PUT' "/shops/$shopId/hours" $null @{ hours = $always }).status 401
Check 'customer -> 403' (Put $cust @{ hours = $always }).status 403
Check 'another shop owner -> 403' (Put $owner3 @{ hours = $always }).status 403
Check 'unknown shop -> 404' (Call 'PUT' "/shops/$([guid]::NewGuid())/hours" $owner @{ hours = $always }).status 404
Check 'admin -> 403 (shop team only)' (Put $admin @{ hours = $null }).status 403

# staff of the shop may edit: invite a fresh user as staff
$staffEmail = "hours-$([guid]::NewGuid().ToString('N').Substring(0, 8))@vendorshub.test"
Need ((Call 'POST' '/auth/register' $null @{ name = 'Hours Staff'; email = $staffEmail; password = 'Password123!' }).status -eq 201) 'registering the staff user'
$inv = Call 'POST' "/shops/$shopId/staff" $owner @{ email = $staffEmail }
Check 'owner adds staff' ($inv.status -in 200, 201) $true
$staff = Login $staffEmail
Check 'staff may edit' (Put $staff @{ hours = $null }).status 200

# ---- 4. validation ----
Check '6 days -> 400' (Put $owner @{ hours = @($always[0..5]) }).status 400
$dup = @($always[0..5]) + @(@{ day = 0; open = '10:00'; close = '20:00'; closed = $false })
Check 'duplicate day -> 400' (Put $owner @{ hours = $dup }).status 400
$late = Week '10:00' '01:00'
$r = Put $owner @{ hours = $late }
Check 'overnight 10:00-01:00 accepted' $r.status 200
Check 'overnight close stored' (@($r.json.data.hours)[0].close) '01:00'
$bad = Week '10:00' '10:00'
Check 'close equal to open -> 400' (Put $owner @{ hours = $bad }).status 400
$bad = Week '9:00' '20:00'
Check 'bad time format -> 400' (Put $owner @{ hours = $bad }).status 400
$bad = Week '10:00' '25:00'
Check '25:00 -> 400' (Put $owner @{ hours = $bad }).status 400
Check 'weeklyHoliday 7 -> 400' (Put $owner @{ hours = $always; weeklyHoliday = 7 }).status 400
Check 'hours missing -> 400' (Put $owner @{ weeklyHoliday = 1 }).status 400

# ---- 5. open all day, every day ----
$r = Put $owner @{ hours = $always }
Check 'owner sets hours' $r.status 200
Check 'answer: openNow true' $r.json.data.openNow $true
Check 'answer: 7 days' @($r.json.data.hours).Count 7
Check 'storefront openNow true' (Store).openNow $true
Check 'search card openNow true' (SearchCard).openNow $true
Check 'market card openNow true' (MarketCard).openNow $true
Check 'closed day stored without times' (@((Put $owner @{ hours = @($always[0..5]) + @(@{ day = 6; open = '10:00'; close = '11:00'; closed = $true }) }).json.data.hours)[6].open) $null
Put $owner @{ hours = $always } | Out-Null

# ---- 6. weekly holidays ----
$r = Put $owner @{ hours = $always; weeklyHoliday = $today }
Check 'own holiday today -> closed' $r.json.data.openNow $false
Check 'storefront weeklyHoliday' (Store).weeklyHoliday $today
Check 'storefront closed on holiday' (Store).openNow $false
Check 'search card closed on holiday' (SearchCard).openNow $false
Put $owner @{ hours = $always; weeklyHoliday = $other } | Out-Null
Check 'own holiday another day -> open' (Store).openNow $true

Put $owner @{ hours = $always; weeklyHoliday = $null } | Out-Null
Check 'admin sets market holiday' (Call 'PATCH' "/admin/markets/$marketId" $admin @{ weeklyHoliday = $today }).status 200
Check 'bad market holiday -> 400' (Call 'PATCH' "/admin/markets/$marketId" $admin @{ weeklyHoliday = 9 }).status 400
$s = Store
Check 'market holiday used' $s.weeklyHoliday $today
Check 'closed on the market holiday' $s.openNow $false
Check 'market card closed too' (MarketCard).openNow $false
$r = Put $owner @{ hours = $always; weeklyHoliday = $other }
Check 'own holiday overrides the market' $r.json.data.openNow $true
Check 'ownWeeklyHoliday returned' $r.json.data.ownWeeklyHoliday $other

# ---- cleanup ----
Put $owner @{ hours = $null } | Out-Null
Call 'PATCH' "/admin/markets/$marketId" $admin @{ weeklyHoliday = $null } | Out-Null

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
if ($script:fail -gt 0) { exit 1 }
