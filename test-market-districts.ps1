# test-market-districts.ps1 (markets by district: the field, the district and q filters, admin create and edit, audit)
# Run from the project root while "npm run dev" is running in another terminal.
# Needs the seed data (node --env-file=.env prisma/seed.js): two markets in dhaka, one each in chattogram, sylhet, rajshahi.
$base = 'http://localhost:4000/api/v1'
$script:pass = 0
$script:fail = 0
$script:lastMsg = ''
$script:lastRaw = ''

function Call($method, $path, $token, $body) {
    $script:lastMsg = ''
    $script:lastRaw = ''
    $params = @{ Method = $method; Uri = "$base$path"; UseBasicParsing = $true }
    if ($token) { $params.Headers = @{ Authorization = "Bearer $token" } }
    if ($null -ne $body) {
        $params.ContentType = 'application/json'
        $params.Body = ($body | ConvertTo-Json -Depth 6 -Compress)
    }
    try {
        $r = Invoke-WebRequest @params
        $script:lastRaw = $r.Content
        return @{ status = [int]$r.StatusCode; json = ($r.Content | ConvertFrom-Json); raw = $r.Content }
    } catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { return @{ status = 0; json = $null; raw = '' } }
        $json = $null
        $text = [string]$_.ErrorDetails.Message
        $script:lastRaw = $text
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

function Need($value, $what) {
    if (-not $value) {
        Write-Host "Cannot continue: $what failed. Server said: $($script:lastMsg)" -ForegroundColor Red
        exit 1
    }
}

function Keys($obj) { return (@($obj.PSObject.Properties.Name) | Sort-Object) -join ',' }
# GET /markets with a query string; always an array (PowerShell 5.1 unwraps one-item results)
function Markets($query) { return @((Call 'GET' "/markets$query" $null $null).json.data) }
function Slugs($list) { return (@($list | ForEach-Object { $_.slug })) -join ',' }

try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}

$admin = Login 'admin@vendorshub.test'
$cust = Login 'customer@vendorshub.test'
$stamp = Get-Date -Format 'yyyyMMddHHmmss'

# ---- 1. the field is on both public reads ----
$r = Call 'GET' '/markets' $null $null
Check 'the market list works' $r.status 200
$all = @($r.json.data)
Need ($all.Count -ge 5) 'reading the seed markets (reseed first)'
Check 'a list item has the same fields as before plus district' (Keys $all[0]) 'address,city,district,id,image,name,shopCount,slug'
Check 'every market has a district' (@($all | Where-Object { -not $_.district }).Count) 0
$bySlug = @{}
foreach ($m in $all) { $bySlug[$m.slug] = $m }
Check 'Jamuna Future Park is in dhaka' $bySlug['jamuna-future-park'].district 'dhaka'
Check 'Bashundhara City is in dhaka' $bySlug['bashundhara-city'].district 'dhaka'
Check 'Sanmar Ocean City is in chattogram' $bySlug['sanmar-ocean-city'].district 'chattogram'
Check 'Blue Water Shopping City is in sylhet' $bySlug['blue-water-shopping-city'].district 'sylhet'
Check 'Theme Omor Plaza is in rajshahi' $bySlug['theme-omor-plaza'].district 'rajshahi'
Check 'the list still starts with Bashundhara City (order by name)' $all[0].slug 'bashundhara-city'
Check 'a seeded market keeps its shop count' ($bySlug['jamuna-future-park'].shopCount -ge 2) $true

$d = Call 'GET' '/markets/jamuna-future-park' $null $null
Check 'the market page works' $d.status 200
Check 'the market page has the district' $d.json.data.district 'dhaka'
Check 'the market page still has its shops' (@($d.json.data.shops).Count -ge 2) $true
$d = Call 'GET' '/markets/sanmar-ocean-city' $null $null
Check 'a market in another district has its page' $d.status 200
Check 'with its district' $d.json.data.district 'chattogram'

$shop = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data
Check 'the small market object of a shop is unchanged' (Keys $shop.market) 'id,name,slug'
$card = @((Call 'GET' '/shops?q=TechZone' $null $null).json.data | Where-Object { $_.slug -eq 'techzone-electronics' })[0]
Check 'the small market object in the shop search is unchanged' (Keys $card.market) 'id,name,slug'

# ---- 2. the district filter ----
$ctg = @(Markets '?district=chattogram')
Check 'district=chattogram finds Sanmar Ocean City' (@($ctg | Where-Object { $_.slug -eq 'sanmar-ocean-city' }).Count) 1
Check 'district=chattogram keeps only that district' (@($ctg | Where-Object { $_.district -ne 'chattogram' }).Count) 0
$dhaka = @(Markets '?district=dhaka')
Check 'district=dhaka is the dhaka part of the full list, in the same order' (Slugs $dhaka) (Slugs @($all | Where-Object { $_.district -eq 'dhaka' }))
Check 'a filtered item has the same fields' (Keys $dhaka[0]) 'address,city,district,id,image,name,shopCount,slug'
$r = Call 'GET' '/markets?district=barguna' $null $null
Check 'a district without markets answers 200' $r.status 200
Check 'with an empty list' (@($r.json.data).Count) 0
Check 'a key with a hyphen is accepted (coxs-bazar)' (Call 'GET' '/markets?district=coxs-bazar' $null $null).status 200

# ---- 3. the q filter (name contains, case-insensitive, trimmed) ----
Check 'q=jamuna finds Jamuna Future Park' (Slugs (Markets '?q=jamuna')) 'jamuna-future-park'
Check 'q is case-insensitive' (Slugs (Markets '?q=JAMUNA')) 'jamuna-future-park'
Check 'q matches inside the name' (Slugs (Markets '?q=future')) 'jamuna-future-park'
Check 'q is trimmed' (Slugs (Markets '?q=%20%20jamuna%20%20')) 'jamuna-future-park'
$city = @(Markets '?q=city')
Check 'q=city is the matching part of the full list, in the same order' (Slugs $city) (Slugs @($all | Where-Object { $_.name -like '*city*' }))
Check 'q=city finds markets in three districts' (@($city | ForEach-Object { $_.district } | Select-Object -Unique).Count -ge 3) $true
Check 'a q that matches nothing answers an empty list' @(Markets '?q=no-such-market-zzz').Count 0
Check 'an empty q means no filter' (Slugs (Markets '?q=')) (Slugs $all)
Check 'a percent sign is a normal character' @(Markets '?q=%25').Count 0
Check 'an underscore is a normal character' @(Markets '?q=_').Count 0
Check 'a q of 100 characters is accepted' (Call 'GET' "/markets?q=$('a' * 100)" $null $null).status 200
Check 'a q of 101 characters: 400' (Call 'GET' "/markets?q=$('a' * 101)" $null $null).status 400

# ---- 4. both filters together ----
Check 'district=dhaka and q=city finds only Bashundhara City' (Slugs (Markets '?district=dhaka&q=city')) (Slugs @($all | Where-Object { $_.district -eq 'dhaka' -and $_.name -like '*city*' }))
Check 'district=sylhet and q=water finds Blue Water Shopping City' (Slugs (Markets '?district=sylhet&q=water')) 'blue-water-shopping-city'
Check 'district=sylhet and q=jamuna finds nothing' @(Markets '?district=sylhet&q=jamuna').Count 0

# ---- 5. an unknown district ----
$r = Call 'GET' '/markets?district=atlantis' $null $null
Check 'an unknown district: 400' $r.status 400
Check 'in the usual shape (success false)' $r.json.success $false
Check 'with the message Validation failed' $r.json.error.message 'Validation failed'
Check 'and details.district' (@($r.json.error.details.district).Count -ge 1) $true
Check 'the answer does not repeat the value' ($r.raw -like '*atlantis*') $false
Check 'keys are lowercase only (Dhaka): 400' (Call 'GET' '/markets?district=Dhaka' $null $null).status 400
Check 'an empty district: 400' (Call 'GET' '/markets?district=' $null $null).status 400
Check 'two districts in one request: 400' (Call 'GET' '/markets?district=dhaka&district=sylhet' $null $null).status 400
Check 'an unknown district with a good q: still 400' (Call 'GET' '/markets?district=atlantis&q=city' $null $null).status 400

# ---- 6. admin creates a market with and without a district ----
$r = Call 'POST' '/admin/markets' $admin @{ name = "District Test $stamp"; city = 'Khulna'; district = 'khulna'; address = 'Test Road, Khulna' }
Check 'admin creates a market with a district' $r.status 201
$withId = $r.json.data.id
$withSlug = $r.json.data.slug
Need $withId 'creating the market with a district'
Check 'the answer has the district' $r.json.data.district 'khulna'
Check 'district=khulna shows the new market' (@(Markets '?district=khulna' | Where-Object { $_.id -eq $withId }).Count) 1
Check 'its public page has the district' (Call 'GET' "/markets/$withSlug" $null $null).json.data.district 'khulna'
Check 'district and q together find it' (@(Markets "?district=khulna&q=test%20$stamp" | Where-Object { $_.id -eq $withId }).Count) 1

$r = Call 'POST' '/admin/markets' $admin @{ name = "District Default $stamp" }
Check 'admin creates a market without a district (the current form)' $r.status 201
$defId = $r.json.data.id
Need $defId 'creating the market without a district'
Check 'the district defaults to dhaka' $r.json.data.district 'dhaka'
Check 'the city still defaults to Dhaka' $r.json.data.city 'Dhaka'
Check 'district=dhaka shows it' (@(Markets '?district=dhaka' | Where-Object { $_.id -eq $defId }).Count) 1

$r = Call 'POST' '/admin/markets' $admin @{ name = "District Bad $stamp"; district = 'atlantis' }
Check 'creating with an unknown district: 400' $r.status 400
Check 'create: success false' $r.json.success $false
Check 'create: the message is Validation failed' $r.json.error.message 'Validation failed'
Check 'create: details.district is a list of messages' (@($r.json.error.details.district).Count -ge 1) $true
Check 'create: the answer does not repeat the value' ($r.raw -like '*atlantis*') $false
Check 'creating with an uppercase key: 400' (Call 'POST' '/admin/markets' $admin @{ name = "District Bad $stamp"; district = 'Dhaka' }).status 400
Check 'creating with district null: 400' (Call 'POST' '/admin/markets' $admin @{ name = "District Bad $stamp"; district = $null }).status 400
Check 'creating with a number as district: 400' (Call 'POST' '/admin/markets' $admin @{ name = "District Bad $stamp"; district = 5 }).status 400
Check 'no market was created by the rejected calls' @(Markets "?q=District%20Bad%20$stamp").Count 0
Check 'a customer cannot create a market: 403' (Call 'POST' '/admin/markets' $cust @{ name = "District Nope $stamp"; district = 'dhaka' }).status 403

# ---- 7. admin changes the district ----
$r = Call 'PATCH' "/admin/markets/$withId" $admin @{ district = 'cumilla' }
Check 'admin changes the district' $r.status 200
Check 'the answer has the new district' $r.json.data.district 'cumilla'
Check 'the slug did not change' $r.json.data.slug $withSlug
Check 'district=cumilla shows the market' (@(Markets '?district=cumilla' | Where-Object { $_.id -eq $withId }).Count) 1
Check 'district=khulna does not show it any more' (@(Markets '?district=khulna' | Where-Object { $_.id -eq $withId }).Count) 0
$r = Call 'PATCH' "/admin/markets/$withId" $admin @{ district = 'atlantis' }
Check 'changing to an unknown district: 400' $r.status 400
Check 'patch: details.district is a list of messages' (@($r.json.error.details.district).Count -ge 1) $true
Check 'changing to district null: 400' (Call 'PATCH' "/admin/markets/$withId" $admin @{ district = $null }).status 400
$r = Call 'PATCH' "/admin/markets/$withId" $admin @{ address = 'Another Road, Cumilla' }
Check 'an edit without district works as before' $r.status 200
Check 'and keeps the district' $r.json.data.district 'cumilla'
Check 'the public page shows the district after the rejected and other edits' (Call 'GET' "/markets/$withSlug" $null $null).json.data.district 'cumilla'
Check 'a customer cannot change a district: 403' (Call 'PATCH' "/admin/markets/$withId" $cust @{ district = 'dhaka' }).status 403
Check 'an unknown market: 404' (Call 'PATCH' '/admin/markets/00000000-0000-4000-8000-000000000000' $admin @{ district = 'dhaka' }).status 404

# ---- 8. the audit log has the district ----
$a = Call 'GET' "/admin/audit-logs?entityType=Market&entityId=$withId&limit=50" $admin $null
Check 'the audit log works' $a.status 200
$createdLog = @($a.json.data | Where-Object { $_.action -eq 'catalog.market_created' })[0]
Check 'the create entry has the district' $createdLog.meta.district 'khulna'
$districtEdits = @($a.json.data | Where-Object { $_.action -eq 'catalog.market_updated' -and $_.meta.district })
Check 'one update entry has a district (rejected edits are not recorded)' $districtEdits.Count 1
Check 'the update entry has the new district' $districtEdits[0].meta.district 'cumilla'
$a = Call 'GET' "/admin/audit-logs?entityType=Market&entityId=$defId&limit=50" $admin $null
$createdLog = @($a.json.data | Where-Object { $_.action -eq 'catalog.market_created' })[0]
Check 'a create without district records the default (dhaka)' $createdLog.meta.district 'dhaka'

# ---- 9. the shared list: 64 keys, all accepted, the same list in the docs ----
$keys = @((& node --input-type=module -e "import { DISTRICTS } from './src/lib/districts.js'; console.log(DISTRICTS.join(','))") -split ',')
Check 'the shared list has 64 keys' $keys.Count 64
Check 'no key is listed twice' (@($keys | Select-Object -Unique).Count) 64
Check 'every key is lowercase and URL-safe' (@($keys | Where-Object { $_ -cnotmatch '^[a-z]+(-[a-z]+)*$' }).Count) 0
$rejected = 0
foreach ($k in $keys) { if ((Call 'GET' "/markets?district=$k" $null $null).status -ne 200) { $rejected++ } }
Check 'the district filter accepts every one of the 64 keys' $rejected 0
$spec = (Invoke-WebRequest -Uri 'http://localhost:4000/api/openapi.json' -UseBasicParsing).Content | ConvertFrom-Json
Check 'the docs list the same 64 keys' (@($spec.components.schemas.District.enum) -join ',') ($keys -join ',')
Check 'the docs require district on a market' (@($spec.components.schemas.Market.required) -contains 'district') $true
$params = @($spec.paths.'/api/v1/markets'.get.parameters | ForEach-Object { $_.name }) -join ','
Check 'the docs describe the two query parameters' $params 'district,q'

# ---- cleanup: the two test markets are deleted ----
Check 'the first test market is deleted' (Call 'DELETE' "/admin/markets/$withId" $admin $null).status 200
Check 'the second test market is deleted' (Call 'DELETE' "/admin/markets/$defId" $admin $null).status 200
Check 'after cleanup the list is as before' (Slugs (Markets '')) (Slugs $all)

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
