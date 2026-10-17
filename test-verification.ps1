# test-verification.ps1
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
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $text = $reader.ReadToEnd()
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
        Write-Host "Cannot continue: $what was not created. Server said: $($script:lastMsg)" -ForegroundColor Red
        exit 1
    }
}

try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}

$admin = Login 'admin@vendorshub.test'
$cust = Login 'customer@vendorshub.test'
$other = Login 'owner1@vendorshub.test'

# ---- setup: a fresh shop owner and two fresh shops ----
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$reg = Call 'POST' '/auth/register' $null @{ name = 'Verify Owner'; email = "vtest$stamp@vendorshub.test"; password = 'Password123!'; role = 'SHOP_OWNER' }
$own = $reg.json.data.accessToken
Need $own 'the test shop owner'
$market = Call 'GET' '/markets' $null $null
$marketId = $market.json.data[0].id

$nameA = "Verify A $stamp"
$nameB = "Verify B $stamp"
$r = Call 'POST' '/shops' $own @{ name = $nameA; addressLine = 'Level 1, Shop 10, Test Mall, Dhaka'; marketId = $marketId; latitude = 23.8; longitude = 90.4 }
$shopA = $r.json.data.id
$slugA = $r.json.data.slug
Need $shopA 'test shop A'
$r = Call 'POST' '/shops' $own @{ name = $nameB; addressLine = 'Road 3, Test Area, Dhaka' }
$shopB = $r.json.data.id
Need $shopB 'test shop B'
Write-Host "Created test shops: $nameA and $nameB"

$tl = @{ type = 'TRADE_LICENSE'; fileUrl = 'https://example.com/docs/trade-license.pdf' }
$nid = @{ type = 'NID'; fileUrl = 'https://example.com/docs/nid.jpg' }
$nid2 = @{ type = 'NID'; fileUrl = 'https://example.com/docs/nid-clear.jpg' }
$photo = @{ type = 'SHOP_PHOTO'; fileUrl = 'https://example.com/docs/shop.jpg' }
$qA = [uri]::EscapeDataString($nameA)

# ---- 1. submit rules ----
$r = Call 'POST' "/shops/$shopA/verifications" $own @{ targetLevel = 'PHYSICAL_SHOP_VERIFIED'; documents = @($tl, $nid, $photo) }
Check 'skipping a level is rejected' $r.status 400
$r = Call 'POST' "/shops/$shopA/verifications" $own @{ targetLevel = 'DOCUMENTS_VERIFIED'; documents = @($tl) }
Check 'missing required documents are rejected' $r.status 400
$r = Call 'POST' "/shops/$shopA/verifications" $own @{ targetLevel = 'DOCUMENTS_VERIFIED'; documents = @($tl, $nid, $nid2) }
Check 'two documents of the same type are rejected' $r.status 400
$r = Call 'POST' "/shops/$shopA/verifications" $cust @{ targetLevel = 'DOCUMENTS_VERIFIED'; documents = @($tl, $nid) }
Check 'a customer cannot request verification' $r.status 403
$r = Call 'POST' "/shops/$shopA/verifications" $other @{ targetLevel = 'DOCUMENTS_VERIFIED'; documents = @($tl, $nid) }
Check 'another shop owner cannot request it' $r.status 403

$r = Call 'POST' "/shops/$shopA/verifications" $own @{ targetLevel = 'DOCUMENTS_VERIFIED'; documents = @($tl, $nid) }
Check 'valid request is created' $r.status 201
$vA = $r.json.data.id
Need $vA 'the verification request for shop A'
Check 'score 80 means PENDING' $r.json.data.status 'PENDING'
Check 'two documents stored' @($r.json.data.documents).Count 2
$r = Call 'POST' "/shops/$shopA/verifications" $own @{ targetLevel = 'DOCUMENTS_VERIFIED'; documents = @($tl, $nid) }
Check 'a second open request is rejected' $r.status 409

$r = Call 'POST' "/shops/$shopB/verifications" $own @{ targetLevel = 'DOCUMENTS_VERIFIED'; documents = @($tl, $nid) }
Check 'request for shop B is created' $r.status 201
$vB = $r.json.data.id
Check 'score 55 means AUTO_FLAGGED' $r.json.data.status 'AUTO_FLAGGED'

# ---- 2. the admin queue ----
$r = Call 'GET' '/admin/verifications' $cust $null
Check 'a customer cannot open the admin queue' $r.status 403
$r = Call 'GET' '/admin/verifications' $own $null
Check 'a shop owner cannot open the admin queue' $r.status 403
$r = Call 'GET' "/admin/verifications?status=ALL&q=$qA" $admin $null
Check 'admin queue works' $r.status 200
$rowA = @($r.json.data | Where-Object { $_.id -eq $vA })[0]
Check 'shop A is in the queue' ($null -ne $rowA) $true
Check 'shop A score is 80' $rowA.precheckScore 80
Check 'shop A band is AMBER' $rowA.scoreBand 'AMBER'
Check 'approve is disabled before review' $rowA.actions.approve $false
Check 'queue has stats' ($r.json.meta.stats.pendingReview -ge 1) $true
$r = Call 'GET' '/admin/verifications?status=AUTO_FLAGGED&limit=50' $admin $null
$rowB = @($r.json.data | Where-Object { $_.id -eq $vB })[0]
Check 'shop B is in the auto-flagged list' ($null -ne $rowB) $true
Check 'shop B band is RED' $rowB.scoreBand 'RED'

# ---- 3. detail drawer ----
$d = Call 'GET' "/admin/verifications/$vA" $admin $null
Check 'detail works' $d.status 200
Check 'pre-check score in the detail' $d.json.data.precheck.score 80
Check 'stepper shows the target level as current' (@($d.json.data.stepper | Where-Object { $_.level -eq 'DOCUMENTS_VERIFIED' })[0].state) 'current'
Check 'stepper shows UNVERIFIED as completed' (@($d.json.data.stepper | Where-Object { $_.level -eq 'UNVERIFIED' })[0].state) 'completed'
$n = Call 'PATCH' "/admin/verifications/$vA/notes" $admin @{ notes = 'Looks consistent so far.' }
Check 'internal notes can be saved' $n.status 200

# ---- 4. approve rules and approval ----
$r = Call 'POST' "/admin/verifications/$vA/approve" $admin $null
Check 'approve before reviewing documents is blocked' $r.status 409
foreach ($doc in @($d.json.data.documents)) {
    Call 'PATCH' "/admin/verifications/$vA/documents/$($doc.id)" $admin @{ reviewed = $true } | Out-Null
}
$d = Call 'GET' "/admin/verifications/$vA" $admin $null
Check 'approve is enabled after review' $d.json.data.actions.approve $true
$r = Call 'POST' "/admin/verifications/$vA/approve" $admin $null
Check 'approve works' $r.status 200
Check 'status is APPROVED' $r.json.data.status 'APPROVED'
$s = Call 'GET' "/shops/$slugA" $null $null
Check 'the storefront shows the new level' $s.json.data.verification.level 'DOCUMENTS_VERIFIED'
$r = Call 'POST' "/admin/verifications/$vA/approve" $admin $null
Check 'approving twice is blocked' $r.status 409

# ---- 5. a correction cycle (BUSINESS_VERIFIED) ----
$r = Call 'POST' "/shops/$shopA/verifications" $own @{ targetLevel = 'BUSINESS_VERIFIED'; documents = @($tl, $nid) }
Check 'request for the next level' $r.status 201
$v2 = $r.json.data.id
Need $v2 'the business-level request'
$d = Call 'GET' "/admin/verifications/$v2" $admin $null
foreach ($doc in @($d.json.data.documents)) {
    Call 'PATCH' "/admin/verifications/$v2/documents/$($doc.id)" $admin @{ reviewed = $true } | Out-Null
}
$nidDoc = @($d.json.data.documents | Where-Object { $_.type -eq 'NID' })[0]
$note = 'The NID photo is blurry, please upload a clear copy.'
$r = Call 'POST' "/admin/verifications/$v2/request-correction" $admin @{ note = $note; documentIds = @($nidDoc.id) }
Check 'correction request works' $r.status 200
Check 'status is CORRECTION_REQUESTED' $r.json.data.status 'CORRECTION_REQUESTED'
$view = Call 'GET' "/shops/$shopA/verifications" $own $null
$mine = @($view.json.data.requests | Where-Object { $_.id -eq $v2 })[0]
Check 'the owner sees the admin note' $mine.message $note
Check 'the owner sees the flagged document' (@($mine.documents | Where-Object { $_.type -eq 'NID' })[0].needsReupload) $true
Check 'the owner view has no score' ($null -eq $mine.precheckScore) $true
$r = Call 'POST' "/admin/verifications/$v2/approve" $admin $null
Check 'approve is blocked while waiting for the owner' $r.status 409
$r = Call 'POST' "/verifications/$v2/resubmit" $own @{ documents = @($tl) }
Check 'resubmit without the flagged document is rejected' $r.status 400
$r = Call 'POST' "/verifications/$v2/resubmit" $own @{ documents = @($nid2) }
Check 'resubmit with a new NID works' $r.status 200
Check 'the request is back in the queue' $r.json.data.status 'PENDING'
$r = Call 'POST' "/admin/verifications/$v2/approve" $admin $null
Check 'the new NID still needs a review' $r.status 409
$d = Call 'GET' "/admin/verifications/$v2" $admin $null
foreach ($doc in @($d.json.data.documents)) {
    Call 'PATCH' "/admin/verifications/$v2/documents/$($doc.id)" $admin @{ reviewed = $true } | Out-Null
}
$r = Call 'POST' "/admin/verifications/$v2/approve" $admin $null
Check 'approve after the correction' $r.status 200
$s = Call 'GET' "/shops/$slugA" $null $null
Check 'the storefront shows BUSINESS_VERIFIED' $s.json.data.verification.level 'BUSINESS_VERIFIED'

# ---- 6. rejection (PHYSICAL_SHOP_VERIFIED) ----
$r = Call 'POST' "/shops/$shopA/verifications" $own @{ targetLevel = 'PHYSICAL_SHOP_VERIFIED'; documents = @($tl, $nid, $photo) }
Check 'request for the physical level' $r.status 201
$v3 = $r.json.data.id
Need $v3 'the physical-level request'
$d = Call 'GET' "/admin/verifications/$v3" $admin $null
Check 'a complete shop scores 100' $d.json.data.precheck.score 100
Check 'a complete shop is GREEN' $d.json.data.precheck.band 'GREEN'
$reason = 'The photo does not show the shop sign.'
$r = Call 'POST' "/admin/verifications/$v3/reject" $admin @{ reason = $reason }
Check 'reject works' $r.status 200
Check 'status is REJECTED' $r.json.data.status 'REJECTED'
$view = Call 'GET' "/shops/$shopA/verifications" $own $null
$mine = @($view.json.data.requests | Where-Object { $_.id -eq $v3 })[0]
Check 'the owner sees the rejection reason' $mine.message $reason
$s = Call 'GET' "/shops/$slugA" $null $null
Check 'the level did not change' $s.json.data.verification.level 'BUSINESS_VERIFIED'
$r = Call 'POST' "/admin/verifications/$v3/reject" $admin @{ reason = $reason }
Check 'rejecting twice is blocked' $r.status 409

# ---- 7. revoke ----
$r = Call 'POST' "/admin/shops/$shopA/revoke" $own @{ reason = 'Trying to revoke myself' }
Check 'an owner cannot revoke' $r.status 403
$r = Call 'POST' "/admin/shops/$shopA/revoke" $admin @{ reason = 'Documents were found to be forged.' }
Check 'admin can revoke' $r.status 200
$s = Call 'GET' "/shops/$slugA" $null $null
Check 'the level is back to UNVERIFIED' $s.json.data.verification.level 'UNVERIFIED'
$r = Call 'POST' "/admin/shops/$shopA/revoke" $admin @{ reason = 'Documents were found to be forged.' }
Check 'revoking an unverified shop is blocked' $r.status 409

# ---- 8. the seeded pending request (Dhaka Mobile House) ----
$r = Call 'GET' "/admin/verifications?status=OPEN&q=$([uri]::EscapeDataString('Dhaka Mobile House'))" $admin $null
$seeded = @($r.json.data)[0]
Check 'the seeded request is in the queue' ($null -ne $seeded) $true
if ($null -ne $seeded) {
    Check 'its approve button is disabled' $seeded.actions.approve $false
    $r = Call 'POST' "/admin/verifications/$($seeded.id)/approve" $admin $null
    Check 'it cannot be approved yet' $r.status 409
}

# ---- 9. audit logs ----
$r = Call 'GET' "/admin/audit-logs?entityType=ShopVerification&entityId=$vA" $admin $null
Check 'audit log works' $r.status 200
Check 'audit log has submitted and approved' (@($r.json.data).Count -ge 2) $true
Check 'the approval is recorded' (@($r.json.data | Where-Object { $_.action -eq 'verification.approved' }).Count -ge 1) $true
$r = Call 'GET' '/admin/audit-logs' $cust $null
Check 'a customer cannot read the audit log' $r.status 403
$r = Call 'GET' "/admin/audit-logs?entityType=Shop&entityId=$shopA" $admin $null
Check 'the revocation is recorded' (@($r.json.data | Where-Object { $_.action -eq 'shop.verification_revoked' }).Count -ge 1) $true

# ---- cleanup: leave the queue tidy ----
Call 'POST' "/admin/verifications/$vB/reject" $admin @{ reason = 'Test shop, closing the request.' } | Out-Null

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
Write-Host 'Test shops and a test owner were created. Run "npx prisma db seed" to reset the demo data.'