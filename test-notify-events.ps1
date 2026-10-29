# test-notify-events.ps1 (notifications part 2: bargains and verification)
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

function Latest($token) { return @((Call 'GET' '/notifications?limit=5' $token $null).json.data)[0] }
function Unread($token) { return (Call 'GET' '/notifications/unread-count' $token $null).json.data.unread }

$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$script:n = 0
function NewUser($role) {
    $script:n++
    $email = "notify$($script:n)x$stamp@vendorshub.test"
    $r = Call 'POST' '/auth/register' $null @{ name = "Notify Test $($script:n)"; email = $email; password = 'Password123!'; role = $role }
    Need ($r.status -eq 201) "registering a $role"
    return @{ token = $r.json.data.accessToken; id = $r.json.data.user.id }
}

try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path 'scripts/expire-bargain.mjs')) {
    Write-Host 'Missing scripts/expire-bargain.mjs (from the bargain step).' -ForegroundColor Red
    exit 1
}

$owner = Login 'owner1@vendorshub.test'    # TechZone owner
$staff = Login 'owner2@vendorshub.test'    # staff at TechZone
$admin = Login 'admin@vendorshub.test'
foreach ($t in @($owner, $staff, $admin)) { Call 'POST' '/notifications/read-all' $t $null | Out-Null }

# ---- setup: TechZone A55 open for bargaining, shop minimum 95 percent ----
$p = Call 'GET' '/products/galaxy-a55-5g-8-128gb' $null $null
$all = @($p.json.data.selectedListing) + @($p.json.data.otherListings)
$listing = @($all | Where-Object { $_.shop.slug -eq 'techzone-electronics' })[0]
Need $listing 'finding the TechZone listing'
$techId = $listing.shop.id
$lid = $listing.id
$prep = Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ bargainEnabled = $true; minOfferPercent = 95; availability = 'IN_STOCK'; stockQty = 20 }
Need ($prep.status -eq 200) 'preparing the listing'
$price = [int]$prep.json.data.price
$low = [int][math]::Ceiling($price * 0.80)
$shopCounter = [int][math]::Floor($price * 0.90)
$custCounter = [int][math]::Floor($price * 0.85)
$autoOffer = [int][math]::Ceiling($price * 0.97)

function Offer($token, $amount) {
    $r = Call 'POST' '/bargains' $token @{ listingId = $lid; offer = $amount }
    Need ($r.status -eq 201) 'making an offer'
    return $r.json.data.id
}

# ---- 1. offer, counters, accept ----
$c1 = NewUser 'CUSTOMER'
$b1 = Offer $c1.token $low
Check 'the shop owner is told about a new offer' (Latest $owner).type 'BARGAIN_OFFER'
Check 'shop staff are told too' (Latest $staff).type 'BARGAIN_OFFER'
Check 'the customer is not told about their own offer' (Unread $c1.token) 0
$r = Call 'POST' "/bargains/$b1/counter" $owner @{ amount = $shopCounter }
Check 'the shop counters' $r.status 200
Check 'the customer is told about the counter' (Latest $c1.token).type 'BARGAIN_COUNTERED'
$r = Call 'POST' "/bargains/$b1/counter" $c1.token @{ amount = $custCounter }
Check 'the customer counters back' $r.status 200
Check 'the shop is told about the counter' (Latest $owner).type 'BARGAIN_COUNTERED'
$r = Call 'POST' "/bargains/$b1/accept" $owner $null
Check 'the shop accepts' $r.status 200
$n1 = Latest $c1.token
Check 'the customer is told it was accepted' $n1.type 'BARGAIN_ACCEPTED'
Check 'the alert points to the negotiation' $n1.data.bargainId $b1

# ---- 2. the shop declines ----
$c2 = NewUser 'CUSTOMER'
$b2 = Offer $c2.token $low
$r = Call 'POST' "/bargains/$b2/decline" $owner $null
Check 'the shop declines' $r.status 200
Check 'the customer is told about the decline' (Latest $c2.token).type 'BARGAIN_DECLINED'

# ---- 3. the customer withdraws ----
$c3 = NewUser 'CUSTOMER'
$b3 = Offer $c3.token $low
$r = Call 'POST' "/bargains/$b3/decline" $c3.token $null
Check 'the customer withdraws' $r.status 200
Check 'the shop is told about the withdrawal' (Latest $owner).type 'BARGAIN_WITHDRAWN'

# ---- 4. automatic acceptance ----
$c4 = NewUser 'CUSTOMER'
$b4 = Offer $c4.token $autoOffer
Check 'the shop is told about the automatic acceptance' (Latest $owner).type 'BARGAIN_AUTO_ACCEPTED'

# ---- 5. expiry (both sides, once) ----
$c5 = NewUser 'CUSTOMER'
$b5 = Offer $c5.token $low
& node --env-file=.env scripts/expire-bargain.mjs $b5 | Out-Null
Call 'GET' "/bargains/$b5" $c5.token $null | Out-Null
Check 'the customer is told it expired' (Latest $c5.token).type 'BARGAIN_EXPIRED'
Check 'the shop is told it expired' (Latest $owner).type 'BARGAIN_EXPIRED'
$before = Unread $c5.token
Call 'GET' "/bargains/$b5" $c5.token $null | Out-Null
Check 'reading it again does not alert twice' (Unread $c5.token) $before

# ---- 6. verification ----
$o = NewUser 'SHOP_OWNER'
$s = Call 'POST' '/shops' $o.token @{ name = "Notify Test Shop $stamp"; addressLine = 'Level 2, Shop 10, Bashundhara City, Dhaka' }
Need ($s.status -eq 201) 'creating a shop'
$shopId = $s.json.data.id
$docs = @(
    @{ type = 'TRADE_LICENSE'; fileUrl = 'https://example.com/trade-license.pdf' },
    @{ type = 'NID'; fileUrl = 'https://example.com/nid.pdf' }
)
$r = Call 'POST' "/shops/$shopId/verifications" $o.token @{ targetLevel = 'DOCUMENTS_VERIFIED'; documents = $docs }
Need ($r.status -eq 201) 'submitting a verification request'
$v1 = $r.json.data.id
$na = Latest $admin
Check 'admins are told about a new request' $na.type 'VERIFICATION_SUBMITTED'
Check 'the alert names the level' ($na.title -like '*Documents Verified*') $true

$d = Call 'GET' "/admin/verifications/$v1" $admin $null
$nidDoc = @($d.json.data.documents | Where-Object { $_.type -eq 'NID' })[0].id
Need $nidDoc 'finding the NID document'
$r = Call 'POST' "/admin/verifications/$v1/request-correction" $admin @{ note = 'The NID photo is blurry, please upload it again.'; documentIds = @($nidDoc) }
Check 'the admin asks for a correction' $r.status 200
$no = Latest $o.token
Check 'the owner is told about the correction' $no.type 'VERIFICATION_CORRECTION'
Check 'the admin note is included' ($no.body -like '*blurry*') $true

$r = Call 'POST' "/verifications/$v1/resubmit" $o.token @{ documents = @(@{ type = 'NID'; fileUrl = 'https://example.com/nid-new.pdf' }) }
Check 'the owner resubmits' $r.status 200
Check 'admins are told about the corrected documents' (Latest $admin).type 'VERIFICATION_RESUBMITTED'

$r = Call 'POST' "/admin/verifications/$v1/reject" $admin @{ reason = 'The trade license number does not match.' }
Check 'the admin rejects' $r.status 200
$no = Latest $o.token
Check 'the owner is told about the rejection' $no.type 'VERIFICATION_REJECTED'
Check 'the reason is included' ($no.body -like '*does not match*') $true

$r = Call 'POST' "/shops/$shopId/verifications" $o.token @{ targetLevel = 'DOCUMENTS_VERIFIED'; documents = $docs }
Need ($r.status -eq 201) 'submitting a second request'
$v2 = $r.json.data.id
$d = Call 'GET' "/admin/verifications/$v2" $admin $null
foreach ($doc in @($d.json.data.documents)) {
    Call 'PATCH' "/admin/verifications/$v2/documents/$($doc.id)" $admin @{ reviewed = $true } | Out-Null
}
$r = Call 'POST' "/admin/verifications/$v2/approve" $admin $null
Check 'the admin approves' $r.status 200
$no = Latest $o.token
Check 'the owner is told about the approval' $no.type 'VERIFICATION_APPROVED'
Check 'the alert names the new level' ($no.title -like '*Documents Verified*') $true

$r = Call 'POST' "/admin/shops/$shopId/revoke" $admin @{ reason = 'The shop closed permanently, confirmed by a visit.' }
Check 'the admin revokes' $r.status 200
Check 'the owner is told about the revocation' (Latest $o.token).type 'VERIFICATION_REVOKED'

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
Write-Host 'Test users and a test shop were created. run-all-tests.ps1 reseeds the demo data first.'